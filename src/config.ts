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

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: int(process.env.PORT, 11436),
  headless: bool(process.env.HEADLESS, false),
  chatgptBaseUrl: process.env.CHATGPT_BASE_URL ?? 'https://chatgpt.com',
  profileDir: resolve(process.env.CHATGPT_PROFILE_DIR ?? '.data/chatgpt-profile'),
  gatewayApiKey: process.env.GATEWAY_API_KEY?.trim() || undefined,
};
