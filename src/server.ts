import Fastify from 'fastify';
import { registerOpenAIRoutes } from './api/openai.js';
import { ChatGPTBrowser } from './chatgpt/browser.js';
import { config } from './config.js';

const app = Fastify({ logger: true });
const browser = new ChatGPTBrowser();

app.addHook('onRequest', async (request, reply) => {
  if (!config.gatewayApiKey) return;

  const authorization = request.headers.authorization;
  if (authorization !== `Bearer ${config.gatewayApiKey}`) {
    return reply.code(401).send({
      error: {
        message: 'Invalid API key',
        type: 'authentication_error',
        code: 'invalid_api_key',
      },
    });
  }
});

app.get('/health', async () => ({ status: 'ok' }));
await registerOpenAIRoutes(app, browser);

const shutdown = async () => {
  await app.close();
  await browser.close();
};

process.on('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().finally(() => process.exit(0)));

try {
  await browser.start();
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await shutdown();
  process.exit(1);
}
