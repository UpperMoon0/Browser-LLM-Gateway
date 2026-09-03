import { isIP } from 'node:net';
import { resolve } from 'node:path';

function bool(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean value (true/false, 1/0, yes/no, on/off)`);
}

function int(
  name: string,
  value: string | undefined,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined || !value.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function csv(value: string | undefined): string[] {
  return (value ?? '').split(',').map((part) => part.trim()).filter(Boolean);
}

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: int('PORT', process.env.PORT, 11436, 1, 65_535),
  headless: bool('HEADLESS', process.env.HEADLESS, false),
  browserChannel: process.env.CHATGPT_BROWSER_CHANNEL?.trim() || 'chrome',
  chatgptBaseUrl: process.env.CHATGPT_BASE_URL ?? 'https://chatgpt.com',
  profileDir: resolve(process.env.CHATGPT_PROFILE_DIR ?? '.data/chatgpt-profile'),
  cookieFile: resolve(process.env.CHATGPT_COOKIE_FILE ?? 'cookies.txt'),
  gatewayApiKey: process.env.GATEWAY_API_KEY?.trim() || undefined,
  modelId: process.env.MODEL_ID?.trim() || 'chatgpt-web',
  modelAliases: csv(process.env.MODEL_ALIASES),
  strictModelNames: bool('STRICT_MODEL_NAMES', process.env.STRICT_MODEL_NAMES, false),
  navigationTimeoutMs: int('CHATGPT_NAVIGATION_TIMEOUT_MS', process.env.CHATGPT_NAVIGATION_TIMEOUT_MS, 30_000),
  composerTimeoutMs: int('COMPOSER_TIMEOUT_MS', process.env.COMPOSER_TIMEOUT_MS, 10_000),
  browserTimeoutMs: int('BROWSER_TIMEOUT_MS', process.env.BROWSER_TIMEOUT_MS, 10 * 60_000),
};

export function advertisedModels(): string[] {
  return [...new Set([config.modelId, ...config.modelAliases])];
}

export function acceptsModel(model: string): boolean {
  if (!config.strictModelNames) return Boolean(model);
  return advertisedModels().includes(model);
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/u, '$1');
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (isIP(normalized) === 4) return normalized.startsWith('127.');
  return isIP(normalized) === 6 && normalized.startsWith('::ffff:127.');
}

export function assertSecureBindConfiguration(
  host = config.host,
  gatewayApiKey = config.gatewayApiKey,
): void {
  if (gatewayApiKey || isLoopbackHost(host)) return;
  throw new Error(
    `Refusing to bind Browser-LLM-Gateway to non-loopback host '${host}' without GATEWAY_API_KEY. `
    + 'Set a strong GATEWAY_API_KEY or bind HOST to localhost/127.0.0.1.',
  );
}
