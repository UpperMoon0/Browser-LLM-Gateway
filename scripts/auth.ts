import { access } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import { config } from '../src/config.js';
import { importNetscapeCookies, probeChatGPTSession } from '../src/chatgpt/cookies.js';
import { selectors } from '../src/chatgpt/selectors.js';

async function authenticationState(page: Page): Promise<{ authenticated: boolean; composerReady: boolean; status: number }> {
  const composerReady = await page.locator(selectors.composer).first()
    .waitFor({ state: 'visible', timeout: config.navigationTimeoutMs })
    .then(() => true)
    .catch(() => false);
  const session = await probeChatGPTSession(page).catch(() => ({ status: 0, authenticated: false }));
  return { authenticated: session.authenticated, composerReady, status: session.status };
}

async function main(): Promise<void> {
  const context = await chromium.launchPersistentContext(config.profileDir, {
    headless: false,
    channel: config.browserChannel,
    viewport: { width: 1440, height: 1000 },
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const cookieFileExists = await access(config.cookieFile).then(() => true).catch(() => false);
    if (cookieFileExists) {
      const result = await importNetscapeCookies(context, config.cookieFile);
      console.log(`Imported ${result.cookies.length} unexpired cookies from ${config.cookieFile}.`);
    }
    await page.goto(config.chatgptBaseUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.navigationTimeoutMs,
    });

    if (cookieFileExists) {
      const state = await authenticationState(page);
      if (state.composerReady && state.authenticated) {
        console.log(`Cookie authentication verified and saved in ${config.profileDir}`);
        return;
      }
      console.error(`Imported cookies were not authenticated (session HTTP ${state.status}). Export a fresh cookies.txt file.`);
    }

    console.log('Sign in to ChatGPT in the opened browser.');
    console.log('When the normal ChatGPT composer is visible, return here and press Enter.');

    process.stdin.resume();
    await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
    process.stdin.pause();

    const state = await authenticationState(page);
    if (!state.authenticated || !state.composerReady) {
      throw new Error(
        `ChatGPT authentication was not verified after interactive sign-in `
        + `(session HTTP ${state.status}, composer visible: ${state.composerReady}).`,
      );
    }

    console.log(`Authentication verified and browser profile saved in ${config.profileDir}`);
  } finally {
    await context.close();
  }
}

await main();
