import { readFile } from 'node:fs/promises';
import type { BrowserContext, Page } from 'playwright';

type BrowserCookie = Parameters<BrowserContext['addCookies']>[0][number];

export interface ParsedCookieFile {
  cookies: BrowserCookie[];
  expired: number;
  invalid: number;
}

export interface SessionProbe {
  status: number;
  authenticated: boolean;
}

export async function probeChatGPTSession(page: Page): Promise<SessionProbe> {
  return page.evaluate(async () => {
    const response = await fetch('/api/auth/session', { credentials: 'include' });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    return {
      status: response.status,
      authenticated: Boolean(body?.user && typeof body.user === 'object'),
    };
  });
}

export function parseNetscapeCookies(text: string, nowSeconds = Math.floor(Date.now() / 1_000)): ParsedCookieFile {
  const cookies: BrowserCookie[] = [];
  let expired = 0;
  let invalid = 0;

  for (const sourceLine of text.split(/\r?\n/u)) {
    let line = sourceLine;
    if (!line.trim()) continue;

    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) {
      httpOnly = true;
      line = line.slice('#HttpOnly_'.length);
    } else if (line.startsWith('#')) {
      continue;
    }

    const fields = line.split('\t');
    if (fields.length < 7) {
      invalid += 1;
      continue;
    }

    const [domainValue, includeSubdomainsValue, pathValue, secureValue, expiresValue, name] = fields;
    const value = fields.slice(6).join('\t');
    const expires = Number.parseInt(expiresValue ?? '', 10);
    const domain = domainValue?.trim() ?? '';
    const path = pathValue?.trim() || '/';

    if (!domain || !name || !Number.isFinite(expires) || expires < 0) {
      invalid += 1;
      continue;
    }
    if (expires > 0 && expires <= nowSeconds) {
      expired += 1;
      continue;
    }

    const secure = secureValue?.toUpperCase() === 'TRUE';
    const includeSubdomains = includeSubdomainsValue?.toUpperCase() === 'TRUE' || domain.startsWith('.');
    const cookie: BrowserCookie = {
      name,
      value,
      secure,
      httpOnly,
      ...(expires > 0 ? { expires } : {}),
    };

    if (includeSubdomains) {
      cookie.domain = domain.startsWith('.') ? domain : `.${domain}`;
      cookie.path = path;
    } else {
      // A URL creates a host-only cookie. This is required for __Host- cookies,
      // which Chromium rejects when they are set with an explicit Domain field.
      const host = domain.replace(/^\./u, '');
      cookie.url = `https://${host}${path.startsWith('/') ? path : `/${path}`}`;
    }

    cookies.push(cookie);
  }

  return { cookies, expired, invalid };
}

export async function importNetscapeCookies(
  context: BrowserContext,
  filePath: string,
): Promise<ParsedCookieFile> {
  return applyNetscapeCookies(context, await readFile(filePath, 'utf8'));
}

export async function applyNetscapeCookies(
  context: BrowserContext,
  text: string,
): Promise<ParsedCookieFile> {
  const parsed = parseNetscapeCookies(text);
  if (!parsed.cookies.length) {
    throw new Error('Cookie input contains no usable, unexpired cookies');
  }

  // This is a dedicated ChatGPT profile. Clearing it prevents stale session and
  // anti-bot cookies from overriding or conflicting with the exported file.
  await context.clearCookies();
  await context.addCookies(parsed.cookies);
  return parsed;
}
