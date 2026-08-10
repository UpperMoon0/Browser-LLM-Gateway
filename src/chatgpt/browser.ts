import { chromium, type BrowserContext, type Page } from 'playwright';
import { config } from '../config.js';
import { Mutex } from '../lib/mutex.js';
import { selectors } from './selectors.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ChatGPTBrowser {
  private context?: BrowserContext;
  private page?: Page;
  private readonly mutex = new Mutex();

  async start(): Promise<void> {
    if (this.context) return;

    this.context = await chromium.launchPersistentContext(config.profileDir, {
      headless: config.headless,
      viewport: { width: 1440, height: 1000 },
    });

    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    await this.ensureReady();
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = undefined;
    this.page = undefined;
  }

  async *generate(prompt: string, signal?: AbortSignal): AsyncGenerator<string> {
    const release = await this.mutex.acquire();

    try {
      await this.start();
      const page = this.requirePage();
      await this.openFreshChat(page);

      const assistant = page.locator(selectors.assistantMessage);
      const initialCount = await assistant.count();
      await this.submitPrompt(page, prompt);
      await page.waitForFunction(
        ({ selector, count }) => document.querySelectorAll(selector).length > count,
        { selector: selectors.assistantMessage, count: initialCount },
        { timeout: 60_000 },
      );

      let emitted = '';
      let sawText = false;
      let stableSince = Date.now();
      const deadline = Date.now() + 10 * 60_000;

      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error('Request aborted');

        const last = assistant.last();
        const current = (await last.innerText().catch(() => '')).trimEnd();

        if (current.length > emitted.length && current.startsWith(emitted)) {
          const delta = current.slice(emitted.length);
          emitted = current;
          sawText = true;
          stableSince = Date.now();
          if (delta) yield delta;
        } else if (current !== emitted) {
          // ChatGPT occasionally re-renders markdown while generating. We cannot retract
          // already streamed SSE chunks, so only adopt non-prefix text once generation ends.
          stableSince = Date.now();
        }

        const stopVisible = await page.locator(selectors.stopButton).isVisible().catch(() => false);
        if (sawText && !stopVisible && Date.now() - stableSince >= 600) {
          const finalText = (await last.innerText().catch(() => emitted)).trimEnd();
          if (finalText.startsWith(emitted) && finalText.length > emitted.length) {
            yield finalText.slice(emitted.length);
          }
          return;
        }

        await sleep(100);
      }

      throw new Error('Timed out waiting for ChatGPT response');
    } finally {
      release();
    }
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('ChatGPT browser has not started');
    return this.page;
  }

  private async ensureReady(): Promise<void> {
    const page = this.requirePage();
    await page.goto(config.chatgptBaseUrl, { waitUntil: 'domcontentloaded' });

    const composer = page.locator(selectors.composer);
    if (!(await composer.isVisible().catch(() => false))) {
      throw new Error(
        `ChatGPT is not ready. Run \"npm run auth\" first and sign in using the persistent browser profile at ${config.profileDir}`,
      );
    }
  }

  private async openFreshChat(page: Page): Promise<void> {
    await page.goto(config.chatgptBaseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator(selectors.composer).waitFor({ state: 'visible', timeout: 30_000 });
  }

  private async submitPrompt(page: Page, prompt: string): Promise<void> {
    const composer = page.locator(selectors.composer);
    await composer.click();
    await composer.fill(prompt);

    const send = page.locator(selectors.sendButton);
    if (await send.isVisible().catch(() => false)) {
      await send.click();
    } else {
      await composer.press('Enter');
    }
  }
}
