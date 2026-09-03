import { resolve } from 'node:path';

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function csv(value: string | undefined): string[] {
  return (value ?? '').split(',').map((part) => part.trim()).filter(Boolean);
}

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: int(process.env.PORT, 11436),
  headless: bool(process.env.HEADLESS, false),
  browserChannel: process.env.CHATGPT_BROWSER_CHANNEL?.trim() || 'chrome',
  chatgptBaseUrl: process.env.CHATGPT_BASE_URL ?? 'https://chatgpt.com',
  profileDir: resolve(process.env.CHATGPT_PROFILE_DIR ?? '.data/chatgpt-profile'),
  cookieFile: resolve(process.env.CHATGPT_COOKIE_FILE ?? 'cookies.txt'),
  gatewayApiKey: process.env.GATEWAY_API_KEY?.trim() || undefined,
  modelId: process.env.MODEL_ID?.trim() || 'chatgpt-web',
  modelAliases: csv(process.env.MODEL_ALIASES),
  strictModelNames: bool(process.env.STRICT_MODEL_NAMES, false),
  navigationTimeoutMs: int(process.env.CHATGPT_NAVIGATION_TIMEOUT_MS, 30_000),
  composerTimeoutMs: int(process.env.COMPOSER_TIMEOUT_MS, 10_000),
  browserTimeoutMs: int(process.env.BROWSER_TIMEOUT_MS, 10 * 60_000),
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
  if (/^127(?:\.\d{1,3}){3}$/u.test(normalized)) return true;
  return /^::ffff:127(?:\.\d{1,3}){3}$/u.test(normalized);
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
