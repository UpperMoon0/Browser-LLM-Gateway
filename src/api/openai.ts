import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { ChatGPTBrowser } from '../chatgpt/browser.js';
import { chatCompletionRequestSchema } from '../openai/types.js';
import { serializeMessages } from '../openai/prompt.js';

const MODEL_ID = 'chatgpt-web';

export async function registerOpenAIRoutes(app: FastifyInstance, browser: ChatGPTBrowser): Promise<void> {
  app.get('/v1/models', async () => ({
    object: 'list',
    data: [
      {
        id: MODEL_ID,
        object: 'model',
        created: 0,
        owned_by: 'browser-llm-gateway',
      },
    ],
  }));

  app.post('/v1/chat/completions', async (request, reply) => {
    try {
      const body = chatCompletionRequestSchema.parse(request.body);

      if (body.model !== MODEL_ID) {
        return reply.code(404).send({
          error: {
            message: `Model '${body.model}' is not available. Use '${MODEL_ID}'.`,
            type: 'invalid_request_error',
            param: 'model',
            code: 'model_not_found',
          },
        });
      }

      const prompt = serializeMessages(body.messages);
      if (body.stream) {
        return streamCompletion(request, reply, browser, prompt, body.model);
      }

      let content = '';
      for await (const delta of browser.generate(prompt)) content += delta;

      const now = Math.floor(Date.now() / 1000);
      return reply.send({
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: now,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
      });
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.code(400).send({
          error: {
            message: error.issues.map((issue) => issue.message).join('; '),
            type: 'invalid_request_error',
            code: 'invalid_request',
          },
        });
      }

      request.log.error(error);
      return reply.code(502).send({
        error: {
          message: error instanceof Error ? error.message : 'ChatGPT browser request failed',
          type: 'browser_error',
          code: 'browser_error',
        },
      });
    }
  });
}

async function streamCompletion(
  request: FastifyRequest,
  reply: FastifyReply,
  browser: ChatGPTBrowser,
  prompt: string,
  model: string,
): Promise<void> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const abort = new AbortController();

  request.raw.once('close', () => abort.abort());

  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });

  const send = (payload: unknown) => reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);

  send({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });

  try {
    for await (const delta of browser.generate(prompt, abort.signal)) {
      send({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      });
    }

    send({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    reply.raw.write('data: [DONE]\n\n');
  } catch (error) {
    if (!abort.signal.aborted) {
      send({
        error: {
          message: error instanceof Error ? error.message : 'ChatGPT browser request failed',
          type: 'browser_error',
          code: 'browser_error',
        },
      });
    }
  } finally {
    reply.raw.end();
  }
}
