import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

async function injectCookies() {
  const userDataDir = path.resolve('.data/chatgpt-profile');
  console.log('Loading profile at', userDataDir);
  
  if (!fs.existsSync('cookies.txt')) {
    console.error('cookies.txt not found!');
    process.exit(1);
  }

  const lines = fs.readFileSync('cookies.txt', 'utf8').split('\n');
  const playwrightCookies = [];

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;

    const [domain, includeSub, pathVal, secure, expiry, name, value] = parts;
    playwrightCookies.push({
      name: name,
      value: value,
      domain: domain,
      path: pathVal,
      secure: secure.toUpperCase() === 'TRUE',
      httpOnly: name.includes('Secure-') || name === '__cf_bm' || name === '_uasid' || name === '_umsid' || name === '__cflb' || name.includes('csrf-token') || name === '__oailb' || name === 'cf_clearance',
      sameSite: 'Lax',
      expires: parseInt(expiry, 10)
    });
  }

  const browser = await chromium.launchPersistentContext(userDataDir, {
    headless: true
  });
  
  console.log(`Injecting ${playwrightCookies.length} cookies...`);
  await browser.addCookies(playwrightCookies);
  
  console.log('Cookies injected successfully! Saving profile...');
  await browser.close();
  console.log('Done.');
}

injectCookies().catch(console.error);
