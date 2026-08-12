import { access } from 'node:fs/promises';
import { chromium } from 'playwright';
import { config } from '../src/config.js';
import { importNetscapeCookies, probeChatGPTSession } from '../src/chatgpt/cookies.js';
import { selectors } from '../src/chatgpt/selectors.js';

const context = await chromium.launchPersistentContext(config.profileDir, {
  headless: false,
  channel: config.browserChannel,
  viewport: { width: 1440, height: 1000 },
});

const page = context.pages()[0] ?? (await context.newPage());
const cookieFileExists = await access(config.cookieFile).then(() => true).catch(() => false);
if (cookieFileExists) {
  const result = await importNetscapeCookies(context, config.cookieFile);
  console.log(`Imported ${result.cookies.length} unexpired cookies from ${config.cookieFile}.`);
}
await page.goto(config.chatgptBaseUrl, { waitUntil: 'domcontentloaded' });

if (cookieFileExists) {
  const composerReady = await page.locator(selectors.composer).first()
    .waitFor({ state: 'visible', timeout: config.navigationTimeoutMs })
    .then(() => true)
    .catch(() => false);
  const session = await probeChatGPTSession(page).catch(() => ({ status: 0, authenticated: false }));
  if (composerReady && session.authenticated) {
    await context.close();
    console.log(`Cookie authentication verified and saved in ${config.profileDir}`);
    process.exit(0);
  }
  console.error(`Imported cookies were not authenticated (session HTTP ${session.status}). Export a fresh cookies.txt file.`);
}

console.log('Sign in to ChatGPT in the opened browser.');
console.log('When the normal ChatGPT composer is visible, return here and press Enter.');

process.stdin.resume();
await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
await context.close();
console.log(`Saved browser profile in ${config.profileDir}`);
