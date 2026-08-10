import { chromium } from 'playwright';
import { config } from '../src/config.js';

const context = await chromium.launchPersistentContext(config.profileDir, {
  headless: false,
  viewport: { width: 1440, height: 1000 },
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(config.chatgptBaseUrl, { waitUntil: 'domcontentloaded' });

console.log('Sign in to ChatGPT in the opened browser.');
console.log('When the normal ChatGPT composer is visible, return here and press Enter.');

process.stdin.resume();
await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
await context.close();
console.log(`Saved browser profile in ${config.profileDir}`);
