import { chromium, type BrowserContext, type Page } from 'playwright';
import { config } from '../config.js';
import { Mutex } from '../lib/mutex.js';
import { selectors } from './selectors.js';
import { StableSnapshot } from './snapshot.js';
import {
  composerTextMatches,
  describeComposerMismatch,
  splitInsertionText,
  submitWithRecovery,
} from './submission.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const RESPONSE_STABLE_MS = 750;
const FAST_CHAT_RESET_TIMEOUT_MS = 1_500;
const LARGE_PROMPT_CHARACTERS = 8_000;

export interface BrowserStatus {
  started: boolean;
  ready: boolean;
  busy: boolean;
  phase?: string;
  promptCharacters?: number;
  lastResetMode?: 'already_fresh' | 'client_router' | 'navigation_fallback';
  lastResetMs?: number;
  url?: string;
  error?: string;
}

export class ChatGPTBrowser {
  private context?: BrowserContext;
  private page?: Page;
  private readonly mutex = new Mutex();
  private busy = false;
  private phase?: string;
  private promptCharacters?: number;
  private lastResetMode?: BrowserStatus['lastResetMode'];
  private lastResetMs?: number;
  private lastError?: string;

  async start(): Promise<void> {
    if (this.context) return;

    this.context = await chromium.launchPersistentContext(config.profileDir, {
      headless: config.headless,
      viewport: { width: 1440, height: 1000 },
    });

    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    try {
      await this.ensureReady();
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = undefined;
    this.page = undefined;
    this.busy = false;
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
      lastResetMode: this.lastResetMode,
      lastResetMs: this.lastResetMs,
      url: this.page?.url(),
      error: ready ? undefined : this.lastError,
    };
  }

  async *generate(prompt: string, signal?: AbortSignal): AsyncGenerator<string> {
    const release = await this.mutex.acquire();
    this.busy = true;
    this.phase = 'starting';
    this.promptCharacters = prompt.length;

    try {
      if (signal?.aborted) throw new Error('Request aborted');
      await this.start();
      const page = this.requirePage();
      this.phase = 'opening_chat';
      await this.openFreshChat(page);

      const assistant = page.locator(selectors.assistantMessage);
      const initialCount = await assistant.count();
      this.phase = 'submitting_prompt';
      await this.submitPrompt(page, prompt, signal);
      this.phase = 'waiting_for_response';
      await page.waitForFunction(
        ({ selector, count }) => document.querySelectorAll(selector).length > count,
        { selector: selectors.assistantMessage, count: initialCount },
        { timeout: 60_000 },
      );

      const snapshot = new StableSnapshot(RESPONSE_STABLE_MS);
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
        const completed = snapshot.observe(current);
        const generationActive = await page.locator(selectors.stopButton).first().isVisible().catch(() => false);
        sawGenerationControl ||= generationActive;

        // The stop control disappearing is ChatGPT's strongest UI-level completion
        // signal. Stable text remains the fallback for very short responses where
        // the control can appear and disappear between polling intervals.
        if (current.trimEnd() && ((sawGenerationControl && !generationActive) || completed !== undefined)) {
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
      release();
    }
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('ChatGPT browser has not started');
    return this.page;
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

  private async submitPrompt(page: Page, prompt: string, signal?: AbortSignal): Promise<void> {
    const fillAndSend = async () => {
      this.phase = 'filling_prompt';
      const composer = page.locator(selectors.composer).first();
      await composer.waitFor({ state: 'visible', timeout: config.composerTimeoutMs });
      await composer.fill(prompt, { timeout: config.composerTimeoutMs });
      this.phase = 'sending_prompt';
      await this.sendPrompt(page, composer);
    };

    const insertAndSend = async () => {
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
      reset: () => this.openFreshChat(page),
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
