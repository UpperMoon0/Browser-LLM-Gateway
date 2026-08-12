import { stat } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { config } from '../config.js';
import type { ImageInput } from '../openai/images.js';
import { Mutex } from '../lib/mutex.js';
import { selectors } from './selectors.js';
import { StableSnapshot } from './snapshot.js';
import { applyNetscapeCookies, importNetscapeCookies, parseNetscapeCookies, probeChatGPTSession } from './cookies.js';
import {
  composerTextMatches,
  describeComposerMismatch,
  splitInsertionText,
  submitWithRecovery,
} from './submission.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const RESPONSE_STABLE_MS = 750;
const IMAGE_RESPONSE_STABLE_MS = 3_000;
const FAST_CHAT_RESET_TIMEOUT_MS = 1_500;
const LARGE_PROMPT_CHARACTERS = 8_000;

export interface BrowserStatus {
  started: boolean;
  ready: boolean;
  busy: boolean;
  phase?: string;
  promptCharacters?: number;
  imageCount?: number;
  lastResetMode?: 'already_fresh' | 'client_router' | 'navigation_fallback';
  lastResetMs?: number;
  authSource?: 'cookie_file' | 'persistent_profile';
  importedCookies?: number;
  cookieReloads?: number;
  url?: string;
  error?: string;
}

export interface CookieReplacementResult {
  importedCookies: number;
  expiredCookies: number;
  invalidCookies: number;
  cookieReloads: number;
}

export class ChatGPTBrowser {
  private context?: BrowserContext;
  private page?: Page;
  private readonly mutex = new Mutex();
  private busy = false;
  private phase?: string;
  private promptCharacters?: number;
  private imageCount?: number;
  private lastResetMode?: BrowserStatus['lastResetMode'];
  private lastResetMs?: number;
  private authSource?: BrowserStatus['authSource'];
  private importedCookies?: number;
  private cookieFingerprint?: string;
  private cookieReloads = 0;
  private lastError?: string;

  async start(): Promise<void> {
    const browser = this.context?.browser();
    if (this.context && this.page && !this.page.isClosed() && (!browser || browser.isConnected())) return;
    await this.disposeContext();

    const context = await chromium.launchPersistentContext(config.profileDir, {
      headless: config.headless,
      channel: config.browserChannel,
      viewport: { width: 1440, height: 1000 },
    });
    this.context = context;
    context.once('close', () => {
      if (this.context !== context) return;
      this.context = undefined;
      this.page = undefined;
    });

    this.page = context.pages()[0] ?? (await context.newPage());
    try {
      await this.importCookiesWhenChanged(context);
      await this.ensureReady();
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.disposeContext();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.disposeContext();
    this.busy = false;
  }

  private async disposeContext(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    await context?.close().catch(() => undefined);
  }

  async status(probe = false): Promise<BrowserStatus> {
    if (probe && !this.context) {
      try {
        await this.start();
      } catch {
        // Expose the failure in the status object instead of throwing.
      }
    }

    // Do not enqueue another Playwright operation while a large composer action
    // is running. Health must remain responsive enough to explain the busy state.
    let ready = Boolean(this.page);
    if (!this.busy && this.page) {
      ready = await this.page.locator(selectors.composer).first().isVisible().catch(() => false);
    }
    return {
      started: Boolean(this.context),
      ready,
      busy: this.busy,
      phase: this.phase,
      promptCharacters: this.promptCharacters,
      imageCount: this.imageCount,
      lastResetMode: this.lastResetMode,
      lastResetMs: this.lastResetMs,
      authSource: this.authSource,
      importedCookies: this.importedCookies,
      cookieReloads: this.cookieReloads,
      url: this.page?.url(),
      error: ready ? undefined : this.lastError,
    };
  }

  async *generate(prompt: string, signal?: AbortSignal, images: ImageInput[] = []): AsyncGenerator<string> {
    const release = await this.mutex.acquire();
    this.busy = true;
    this.phase = 'starting';
    this.promptCharacters = prompt.length;
    this.imageCount = images.length;

    try {
      if (signal?.aborted) throw new Error('Request aborted');
      await this.start();
      const page = this.requirePage();
      if (await this.importCookiesWhenChanged(this.requireContext())) {
        this.phase = 'applying_updated_cookies';
        await this.navigateToChatGPT(page);
      }
      this.phase = 'opening_chat';
      await this.openFreshChat(page);

      const assistant = page.locator(selectors.assistantMessage);
      const initialCount = await assistant.count();
      this.phase = 'submitting_prompt';
      await this.submitPrompt(page, prompt, signal, images);
      this.phase = 'waiting_for_response';
      await page.waitForFunction(
        ({ selector, count }) => document.querySelectorAll(selector).length > count,
        { selector: selectors.assistantMessage, count: initialCount },
        { timeout: 60_000 },
      );

      // Vision turns can expose "Analyzing image" as assistant text before the
      // generation control appears. Give that transient state time to be replaced;
      // text-only requests keep the faster fallback.
      const snapshot = new StableSnapshot(images.length ? IMAGE_RESPONSE_STABLE_MS : RESPONSE_STABLE_MS);
      const deadline = Date.now() + config.browserTimeoutMs;
      let sawGenerationControl = false;

      while (Date.now() < deadline) {
        if (signal?.aborted) {
          await page.locator(selectors.stopButton).first().click().catch(() => undefined);
          throw new Error('Request aborted');
        }

        const lastMessage = page.locator(`${selectors.assistantMessage}:visible`).last();
        const content = lastMessage.locator(selectors.assistantContent).first();
        const current = await content.innerText().catch(() => '');
        const transientVisionStatus = images.length > 0 && /^Analyzing images?\s*$/i.test(current.trim());
        const completed = transientVisionStatus ? undefined : snapshot.observe(current);
        const generationActive = await page.locator(selectors.stopButton).first().isVisible().catch(() => false);
        sawGenerationControl ||= generationActive;

        // The stop control disappearing is ChatGPT's strongest UI-level completion
        // signal. Stable text remains the fallback for very short responses where
        // the control can appear and disappear between polling intervals.
        if (!transientVisionStatus && current.trimEnd() && ((sawGenerationControl && !generationActive) || completed !== undefined)) {
          yield current.trimEnd();
          this.lastError = undefined;
          return;
        }

        await sleep(100);
      }

      throw new Error('Timed out waiting for ChatGPT response');
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.busy = false;
      this.phase = undefined;
      this.promptCharacters = undefined;
      this.imageCount = undefined;
      release();
    }
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('ChatGPT browser has not started');
    return this.page;
  }

  async replaceCookies(text: string): Promise<CookieReplacementResult> {
    const parsed = parseNetscapeCookies(text);
    if (!parsed.cookies.length) throw new Error('Cookie input contains no usable, unexpired cookies');

    const release = await this.mutex.acquire();
    try {
      const existingBrowser = this.context?.browser();
      const validationBrowser = existingBrowser?.isConnected()
        ? existingBrowser
        : await chromium.launch({ headless: config.headless, channel: config.browserChannel });
      const ownsValidationBrowser = validationBrowser !== existingBrowser;

      try {
        const validationContext = await validationBrowser.newContext({ viewport: { width: 1440, height: 1000 } });
        try {
          await applyNetscapeCookies(validationContext, text);
          const page = await validationContext.newPage();
          await page.goto(config.chatgptBaseUrl, {
            waitUntil: 'domcontentloaded',
            timeout: config.navigationTimeoutMs,
          });
          const session = await probeChatGPTSession(page);
          if (!session.authenticated) {
            throw new Error(`Replacement cookies are not authenticated (session probe returned HTTP ${session.status})`);
          }
        } finally {
          await validationContext.close();
        }
      } finally {
        if (ownsValidationBrowser) await validationBrowser.close();
      }

      await writeFile(config.cookieFile, text, { encoding: 'utf8', mode: 0o600 });
      this.cookieFingerprint = 'pending-api-reload';

      await this.start();
      const context = this.requireContext();
      const reloaded = await this.importCookiesWhenChanged(context);
      if (reloaded) await this.navigateToChatGPT(this.requirePage());

      return {
        importedCookies: parsed.cookies.length,
        expiredCookies: parsed.expired,
        invalidCookies: parsed.invalid,
        cookieReloads: this.cookieReloads,
      };
    } finally {
      release();
    }
  }

  private requireContext(): BrowserContext {
    if (!this.context) throw new Error('ChatGPT browser has not started');
    return this.context;
  }

  private async importCookiesWhenChanged(context: BrowserContext): Promise<boolean> {
    const metadata = await stat(config.cookieFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!metadata) {
      this.authSource = 'persistent_profile';
      this.importedCookies = undefined;
      this.cookieFingerprint = undefined;
      return false;
    }

    const fingerprint = `${metadata.size}:${metadata.mtimeMs}`;
    if (fingerprint === this.cookieFingerprint) return false;

    const result = await importNetscapeCookies(context, config.cookieFile);
    this.authSource = 'cookie_file';
    this.importedCookies = result.cookies.length;
    if (this.cookieFingerprint !== undefined) this.cookieReloads += 1;
    this.cookieFingerprint = fingerprint;
    return true;
  }

  private async ensureReady(): Promise<void> {
    const page = this.requirePage();
    try {
      await this.navigateToChatGPT(page);
    } catch {
      throw new Error(
        `ChatGPT is not ready. Run "npm run auth" and sign in using the persistent browser profile at ${config.profileDir}`,
      );
    }
  }

  private async openFreshChat(page: Page): Promise<void> {
    const startedAt = Date.now();
    const composer = page.locator(selectors.composer).first();
    const assistant = page.locator(selectors.assistantMessage);

    // Reuse ChatGPT's loaded application and ask its client-side router for a new
    // conversation. This preserves the authenticated page while avoiding a full
    // document navigation on every gateway request.
    try {
      const alreadyFresh = new URL(page.url()).pathname === '/'
        && await assistant.count() === 0
        && await composer.isVisible();
      if (alreadyFresh) {
        this.lastResetMode = 'already_fresh';
        this.lastResetMs = Date.now() - startedAt;
        return;
      }

      const newChat = page.locator(selectors.newChatButton).first();
      await newChat.waitFor({ state: 'visible', timeout: FAST_CHAT_RESET_TIMEOUT_MS });
      // The expanded sidebar can animate a duplicate icon over the link even
      // though the link itself is ready. Force dispatches the same trusted click
      // without waiting for that cosmetic overlay to stop intercepting pointers.
      await newChat.click({ force: true, timeout: FAST_CHAT_RESET_TIMEOUT_MS });
      await page.waitForFunction(
        ({ composerSelector, assistantSelector }) => {
          const editor = document.querySelector(composerSelector);
          const visibleAssistant = [...document.querySelectorAll(assistantSelector)]
            .some((element) => element.getClientRects().length > 0);
          return window.location.pathname === '/'
            && Boolean(editor)
            && !visibleAssistant
            && !(editor?.textContent ?? '').trim();
        },
        { composerSelector: selectors.composer, assistantSelector: selectors.assistantMessage },
        { timeout: FAST_CHAT_RESET_TIMEOUT_MS },
      );
      this.lastResetMode = 'client_router';
      this.lastResetMs = Date.now() - startedAt;
      return;
    } catch {
      // UI selectors and client routing are not contractual. A full navigation is
      // slower, but remains a safe isolation fallback when the fast reset changes.
      await this.navigateToChatGPT(page);
      this.lastResetMode = 'navigation_fallback';
      this.lastResetMs = Date.now() - startedAt;
    }
  }

  private async navigateToChatGPT(page: Page): Promise<void> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // ChatGPT can postpone DOMContentLoaded while loading nonessential scripts.
        // A committed main document plus a visible composer is sufficient here.
        await page.goto(config.chatgptBaseUrl, {
          waitUntil: 'commit',
          timeout: config.navigationTimeoutMs,
        });
      await page.locator(selectors.composer).first().waitFor({
        state: 'visible',
        timeout: config.navigationTimeoutMs,
      });
      const session = await probeChatGPTSession(page);
      if (!session.authenticated) {
        throw new Error(`ChatGPT session is not authenticated (session probe returned HTTP ${session.status})`);
      }
      return;
      } catch (error) {
        lastError = error;
        if (attempt === 0) {
          await page.goto('about:blank', { waitUntil: 'commit', timeout: 5_000 }).catch(() => undefined);
        }
      }
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error');
    throw new Error(`Unable to open a ready ChatGPT page after 2 attempts: ${detail}`, { cause: lastError });
  }

  private async submitPrompt(page: Page, prompt: string, signal?: AbortSignal, images: ImageInput[] = []): Promise<void> {
    let imagesUploaded = false;
    const uploadImages = async () => {
      if (!images.length || imagesUploaded) return;
      if (signal?.aborted) throw new Error('Request aborted');
      this.phase = 'uploading_images';
      const input = page.locator(selectors.imageInput).first();
      await input.waitFor({ state: 'attached', timeout: config.composerTimeoutMs });
      const initialUploads = await page.locator(selectors.uploadedImage).count();
      await input.setInputFiles(images.map((image) => ({
        name: image.filename,
        mimeType: image.mimeType,
        buffer: image.data,
      })));
      await page.waitForFunction(
        ({ selector, count }) => document.querySelectorAll(selector).length >= count,
        { selector: selectors.uploadedImage, count: initialUploads + images.length },
        { timeout: config.navigationTimeoutMs },
      );
      imagesUploaded = true;
    };

    const fillAndSend = async () => {
      await uploadImages();
      this.phase = 'filling_prompt';
      const composer = page.locator(selectors.composer).first();
      await composer.waitFor({ state: 'visible', timeout: config.composerTimeoutMs });
      await composer.fill(prompt, { timeout: config.composerTimeoutMs });
      this.phase = 'sending_prompt';
      await this.sendPrompt(page, composer);
    };

    const insertAndSend = async () => {
      await uploadImages();
      this.phase = 'preparing_keyboard_insertion';
      const composer = page.locator(selectors.composer).first();
      await composer.waitFor({ state: 'visible', timeout: config.composerTimeoutMs });
      await composer.click({ force: true, timeout: config.composerTimeoutMs });
      await composer.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A', {
        timeout: config.composerTimeoutMs,
      });
      await composer.press('Backspace', { timeout: config.composerTimeoutMs });

      const clearedText = await composer.innerText({ timeout: config.composerTimeoutMs });
      if (clearedText.trim()) throw new Error('Could not clear stale text from the ChatGPT composer');

      const chunks = splitInsertionText(prompt);
      for (const [index, chunk] of chunks.entries()) {
        if (signal?.aborted) throw new Error('Request aborted');
        this.phase = `inserting_prompt_${index + 1}_of_${chunks.length}`;
        await page.keyboard.insertText(chunk);
        // CDP can acknowledge insertText before ProseMirror has committed its
        // transaction. Advancing immediately can cause an entire chunk to be
        // overwritten/dropped, so wait for two renderer frames between chunks.
        await composer.evaluate(() => new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
      }

      this.phase = 'verifying_prompt';
      const insertedText = await composer.innerText({ timeout: config.composerTimeoutMs });
      if (!composerTextMatches(insertedText, prompt)) {
        throw new Error(
          `Keyboard insertion produced different composer text (${describeComposerMismatch(insertedText, prompt)})`,
        );
      }
      this.phase = 'sending_prompt';
      await this.sendPrompt(page, composer);
    };

    const hydrateAndSend = async () => {
      await uploadImages();
      this.phase = 'preparing_dom_hydration';
      const composer = page.locator(selectors.composer).first();
      await composer.waitFor({ state: 'visible', timeout: config.composerTimeoutMs });
      this.phase = 'hydrating_prompt';
      await composer.evaluate((element, text) => {
        // Updating one text node avoids ProseMirror parsing the prompt as tens of
        // thousands of individual editing operations. The bubbling input event
        // lets the editor synchronize its state and enable the Send button.
        element.replaceChildren(document.createTextNode(text));
        element.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: null,
        }));
      }, prompt);
      await composer.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));

      this.phase = 'verifying_prompt';
      const editorText = await composer.innerText({ timeout: config.composerTimeoutMs });
      if (!composerTextMatches(editorText, prompt)) {
        throw new Error(
          `DOM hydration produced different composer text (${describeComposerMismatch(editorText, prompt)})`,
        );
      }
      this.phase = 'sending_prompt';
      await this.sendPrompt(page, composer);
    };

    const largePrompt = prompt.length >= LARGE_PROMPT_CHARACTERS;
    await submitWithRecovery({
      primary: largePrompt ? hydrateAndSend : fillAndSend,
      fallback: insertAndSend,
      reset: async () => {
        await this.openFreshChat(page);
        imagesUploaded = false;
      },
    });
  }

  private async sendPrompt(page: Page, composer: ReturnType<Page['locator']>): Promise<void> {
    const send = page.locator(selectors.sendButton).first();
    const sendReady = await send.waitFor({ state: 'visible', timeout: config.composerTimeoutMs })
      .then(() => true)
      .catch(() => false);
    if (sendReady) await send.click({ timeout: config.composerTimeoutMs });
    else await composer.press('Enter', { timeout: config.composerTimeoutMs });
  }
}
