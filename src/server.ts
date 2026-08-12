import Fastify from 'fastify';
import { registerOpenAIRoutes } from './api/openai.js';
import { ChatGPTBrowser } from './chatgpt/browser.js';
import { config } from './config.js';
import { errorBody } from './openai/errors.js';

const app = Fastify({ logger: true, bodyLimit: 32 * 1024 * 1024 });
const browser = new ChatGPTBrowser();

app.addHook('onRequest', async (request, reply) => {
  if (request.url === '/health' || request.url === '/v1/health') return;
  if (!config.gatewayApiKey) return;

  const authorization = request.headers.authorization;
  if (authorization !== `Bearer ${config.gatewayApiKey}`) {
    return reply.code(401).send(errorBody('Invalid API key', 'authentication_error', 'invalid_api_key'));
  }
});

app.get('/', async () => ({
  name: 'Browser-LLM-Gateway',
  openai_compatible: true,
  endpoints: ['/v1/models', '/v1/chat/completions', '/v1/completions', '/v1/responses'],
}));

const health = async () => {
  const status = await browser.status(false);
  return {
    status: status.ready ? 'ok' : 'degraded',
    browser: status,
  };
};
app.get('/health', health);
app.get('/v1/health', health);

app.post('/v1/auth/cookies', async (request, reply) => {
  const body = request.body;
  const cookieText = typeof body === 'string'
    ? body
    : body && typeof body === 'object' && 'cookies' in body
      ? (body as { cookies?: unknown }).cookies
      : undefined;

  if (typeof cookieText !== 'string' || !cookieText.trim()) {
    return reply.code(400).send(errorBody(
      'Send the Netscape cookie file as text/plain or as a JSON object with a non-empty cookies string.',
      'invalid_request_error',
      'invalid_cookie_file',
      'cookies',
    ));
  }

  try {
    const result = await browser.replaceCookies(cookieText);
    return reply.send({ object: 'chatgpt.cookie_reload', status: 'ok', ...result });
  } catch (error) {
    return reply.code(400).send(errorBody(
      error instanceof Error ? error.message : 'Cookie replacement failed',
      'invalid_request_error',
      'cookie_authentication_failed',
      'cookies',
    ));
  }
});

await registerOpenAIRoutes(app, browser);

app.setNotFoundHandler(async (request, reply) => reply.code(404).send(errorBody(
  `Route '${request.method} ${request.url}' was not found`, 'invalid_request_error', 'not_found',
)));

const shutdown = async () => {
  await app.close();
  await browser.close();
};

process.on('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().finally(() => process.exit(0)));

try {
  await app.listen({ host: config.host, port: config.port });
  // Warm the browser after the HTTP server is listening. Authentication problems are
  // reflected through /health and generation errors rather than crashing the gateway.
  void browser.start().catch((error) => app.log.warn({ error }, 'ChatGPT browser is not ready; run npm run auth'));
} catch (error) {
  app.log.error(error);
  await shutdown();
  process.exit(1);
}
