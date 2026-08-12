import { chromium } from 'playwright';
import { config } from '../src/config.js';
import { importNetscapeCookies, probeChatGPTSession } from '../src/chatgpt/cookies.js';
import { selectors } from '../src/chatgpt/selectors.js';

const browser = await chromium.launch({ headless: false, channel: config.browserChannel });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const imported = await importNetscapeCookies(context, config.cookieFile);
  const page = await context.newPage();
  await page.goto(config.chatgptBaseUrl, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs });

  const session = await probeChatGPTSession(page);
  const composerVisible = await page.locator(selectors.composer).first().isVisible().catch(() => false);

  console.log(JSON.stringify({
    importedCookies: imported.cookies.length,
    expiredCookies: imported.expired,
    invalidCookies: imported.invalid,
    session,
    composerVisible,
    finalOrigin: new URL(page.url()).origin,
  }, null, 2));
  process.exitCode = session.authenticated ? 0 : 1;
} finally {
  await browser.close();
}
