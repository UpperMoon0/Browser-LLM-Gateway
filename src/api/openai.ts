import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ChatGPTBrowser } from '../chatgpt/browser.js';
import { acceptsModel, advertisedModels, config } from '../config.js';
import { errorBody, sendKnownError } from '../openai/errors.js';
import { normalizeJsonText, parseControlledOutput, type ParsedAssistantOutput } from '../openai/output.js';
import {
  effectiveChatToolChoice,
  normalizeChatTools,
  responseFormat,
  responseTools,
  serializeMessages,
  serializeResponsesInput,
  UnsupportedInputError,
  withGenerationContract,
} from '../openai/prompt.js';
import { ResponseStore } from '../openai/store.js';
import { StopFilter } from '../openai/stop.js';
import {
  chatCompletionRequestSchema,
  completionRequestSchema,
  responseRequestSchema,
  type ChatCompletionRequest,
  type ResponseRequest,
} from '../openai/types.js';

const OWNER = 'browser-llm-gateway';
const store = new ResponseStore();

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function modelObject(id: string) {
  return { id, object: 'model', created: 0, owned_by: OWNER };
}

function ensureModel(model: string): void {
  if (!acceptsModel(model)) {
    throw new UnsupportedInputError(`Model '${model}' is not available. Available models: ${advertisedModels().join(', ')}`);
  }
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil([...text].length / 4));
}

function usage(prompt: string, output: string) {
  const promptTokens = estimateTokens(prompt);
  const completionTokens = estimateTokens(output);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function applyStop(text: string, stop?: string | string[]): string {
  const stops = (Array.isArray(stop) ? stop : stop ? [stop] : []).filter(Boolean);
  let end = text.length;
  for (const marker of stops) {
    const index = text.indexOf(marker);
    if (index >= 0) end = Math.min(end, index);
  }
  return text.slice(0, end);
}

function requestAbortSignal(request: FastifyRequest, reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  request.raw.once('aborted', () => controller.abort());
  reply.raw.once('close', () => {
    if (!reply.raw.writableEnded) controller.abort();
  });
  return controller.signal;
}

function clientDisconnected(request: FastifyRequest, reply: FastifyReply): boolean {
  return request.raw.aborted || reply.raw.destroyed;
}


function bindStreamingAbort(request: FastifyRequest, reply: FastifyReply, controller: AbortController): void {
  request.raw.once('aborted', () => controller.abort());
  reply.raw.once('close', () => {
    if (!reply.raw.writableEnded) controller.abort();
  });
}

async function collect(browser: ChatGPTBrowser, prompt: string, signal?: AbortSignal): Promise<string> {
  let output = '';
  for await (const delta of browser.generate(prompt, signal)) output += delta;
  return output;
}

function jsonFormatForChat(request: ChatCompletionRequest): { jsonSchema?: unknown; jsonObject?: boolean } {
  if (request.response_format?.type === 'json_object') return { jsonObject: true };
  if (request.response_format?.type === 'json_schema') return { jsonSchema: request.response_format.json_schema.schema };
  return {};
}

function validateChatRequest(request: ChatCompletionRequest): void {
  ensureModel(request.model);
  if (request.n !== undefined && request.n !== 1) throw new UnsupportedInputError('Only n=1 is supported');
  if (request.logprobs) throw new UnsupportedInputError('logprobs are not available from the ChatGPT web UI');
  if (request.modalities?.some((mode) => mode !== 'text') || request.audio !== undefined) {
    throw new UnsupportedInputError('Audio output is not supported by this gateway');
  }
}

function requiresToolCall(choice: ChatCompletionRequest['tool_choice'] | ResponseRequest['tool_choice']): boolean {
  if (choice === 'required') return true;
  if (!choice || choice === 'auto' || choice === 'none') return false;
  return typeof choice === 'object';
}

function requiredToolName(choice: ChatCompletionRequest['tool_choice'] | ResponseRequest['tool_choice']): string | undefined {
  if (!choice || typeof choice !== 'object') return undefined;
  const record = choice as Record<string, unknown>;
  const nested = record.function;
  if (nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>).name === 'string') {
    return (nested as Record<string, unknown>).name as string;
  }
  return typeof record.name === 'string' ? record.name : undefined;
}

function prepareChat(request: ChatCompletionRequest): {
  prompt: string;
  toolsEnabled: boolean;
  structured: boolean;
} {
  validateChatRequest(request);
  const tools = normalizeChatTools(request);
  const toolChoice = effectiveChatToolChoice(request);
  if (requiresToolCall(toolChoice) && tools.length === 0) throw new UnsupportedInputError('A tool/function call was required but no tools/functions were provided');
  const requiredName = requiredToolName(toolChoice);
  if (requiredName && !tools.some((tool) => tool.name === requiredName)) throw new UnsupportedInputError(`Required tool/function '${requiredName}' was not provided`);
  const toolsEnabled = tools.length > 0 && toolChoice !== 'none';
  const format = jsonFormatForChat(request);
  const structured = format.jsonObject === true || format.jsonSchema !== undefined;
  const prompt = withGenerationContract(serializeMessages(request.messages), {
    tools: toolsEnabled ? tools : [],
    toolChoice,
    parallelToolCalls: request.parallel_tool_calls,
    ...format,
  });
  return { prompt, toolsEnabled, structured };
}

function finalizeControlledOutput(
  raw: string,
  toolsEnabled: boolean,
  structured: boolean,
  request: ChatCompletionRequest | ResponseRequest,
): ParsedAssistantOutput {
  const parsed = parseControlledOutput(raw, toolsEnabled);
  const choice = 'function_call' in request && request.function_call !== undefined
    ? effectiveChatToolChoice(request as ChatCompletionRequest)
    : request.tool_choice;
  if (requiresToolCall(choice) && parsed.kind !== 'tool_calls') {
    throw new Error('ChatGPT did not produce the required tool call');
  }

  if (parsed.kind === 'tool_calls') {
    const tools = 'messages' in request
      ? normalizeChatTools(request as ChatCompletionRequest)
      : responseTools(request as ResponseRequest);
    const allowed = new Set(tools.map((tool) => tool.name));
    for (const call of parsed.toolCalls) {
      if (!allowed.has(call.name)) throw new Error(`ChatGPT attempted to call undeclared tool '${call.name}'`);
    }
    const parallel = request.parallel_tool_calls;
    if (parallel === false && parsed.toolCalls.length > 1) {
      throw new Error('ChatGPT produced multiple tool calls while parallel_tool_calls=false');
    }
    const requiredName = requiredToolName(choice);
    if (requiredName && parsed.toolCalls.some((call) => call.name !== requiredName)) {
      throw new Error(`ChatGPT called a tool other than the required tool '${requiredName}'`);
    }
  }

  if (parsed.kind === 'text' && structured) {
    return { kind: 'text', content: normalizeJsonText(parsed.content) };
  }
  return parsed;
}

function chatChoice(output: ParsedAssistantOutput, legacyFunctions = false) {
  if (output.kind === 'tool_calls' && legacyFunctions) {
    const first = output.toolCalls[0];
    if (!first) throw new Error('Empty function call output');
    return {
      index: 0,
      message: { role: 'assistant', content: null, function_call: { name: first.name, arguments: first.arguments } },
      finish_reason: 'function_call',
    };
  }

  if (output.kind === 'tool_calls') {
    return {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: output.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      },
      finish_reason: 'tool_calls',
    };
  }

  return {
    index: 0,
    message: { role: 'assistant', content: output.content },
    finish_reason: 'stop',
  };
}

async function handleChatCompletion(
  request: FastifyRequest,
  reply: FastifyReply,
  browser: ChatGPTBrowser,
): Promise<unknown> {
  try {
    const body = chatCompletionRequestSchema.parse(request.body);
    const prepared = prepareChat(body);

    if (body.stream) return streamChatCompletion(request, reply, browser, body, prepared);

    const raw = await collect(browser, prepared.prompt, requestAbortSignal(request, reply));
    const output = finalizeControlledOutput(raw, prepared.toolsEnabled, prepared.structured, body);
    if (output.kind === 'text') output.content = applyStop(output.content, body.stop);

    const completionText = output.kind === 'text'
      ? output.content
      : output.toolCalls.map((call) => call.arguments).join('');

    return reply.send({
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: now(),
      model: body.model,
      system_fingerprint: 'browser-llm-gateway',
      choices: [chatChoice(output, Boolean(body.functions?.length && !body.tools?.length))],
      usage: usage(prepared.prompt, completionText),
    });
  } catch (error) {
    if (clientDisconnected(request, reply)) return;
    const known = sendKnownError(reply, error);
    if (known) return known;
    request.log.error(error);
    return reply.code(502).send(errorBody(
      error instanceof Error ? error.message : 'ChatGPT browser request failed',
      'server_error',
      'browser_error',
    ));
  }
}

async function streamChatCompletion(
  request: FastifyRequest,
  reply: FastifyReply,
  browser: ChatGPTBrowser,
  body: ChatCompletionRequest,
  prepared: { prompt: string; toolsEnabled: boolean; structured: boolean },
): Promise<void> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = now();
  const abort = new AbortController();
  bindStreamingAbort(request, reply, abort);

  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-browser-llm-usage': 'estimated',
  });

  const send = (payload: unknown) => reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: body.model,
    system_fingerprint: 'browser-llm-gateway',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

  send(chunk({ role: 'assistant', content: '' }));
  let finalText = '';

  try {
    // Tool calls and structured JSON are buffered because the control envelope must
    // be parsed/validated before exposing OpenAI-shaped deltas.
    if (prepared.toolsEnabled || prepared.structured) {
      const raw = await collect(browser, prepared.prompt, abort.signal);
      const output = finalizeControlledOutput(raw, prepared.toolsEnabled, prepared.structured, body);

      if (output.kind === 'tool_calls') {
        const legacyFunctions = Boolean(body.functions?.length && !body.tools?.length);
        if (legacyFunctions) {
          const first = output.toolCalls[0];
          if (!first) throw new Error('Empty function call output');
          send(chunk({ function_call: { name: first.name, arguments: first.arguments } }));
          finalText = first.arguments;
          send(chunk({}, 'function_call'));
        } else {
          for (const [index, call] of output.toolCalls.entries()) {
            send(chunk({
              tool_calls: [{
                index,
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              }],
            }));
            finalText += call.arguments;
          }
          send(chunk({}, 'tool_calls'));
        }
      } else {
        output.content = applyStop(output.content, body.stop);
        finalText = output.content;
        if (output.content) send(chunk({ content: output.content }));
        send(chunk({}, 'stop'));
      }
    } else {
      const filter = new StopFilter(body.stop);
      for await (const delta of browser.generate(prepared.prompt, abort.signal)) {
        const filtered = filter.push(delta);
        if (filtered.text) {
          finalText += filtered.text;
          send(chunk({ content: filtered.text }));
        }
      }
      const tail = filter.flush();
      if (tail) {
        finalText += tail;
        send(chunk({ content: tail }));
      }
      send(chunk({}, 'stop'));
    }

    if (body.stream_options?.include_usage) {
      send({
        id,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        system_fingerprint: 'browser-llm-gateway',
        choices: [],
        usage: usage(prepared.prompt, finalText),
      });
    }
    reply.raw.write('data: [DONE]\n\n');
  } catch (error) {
    if (!abort.signal.aborted) send(errorBody(
      error instanceof Error ? error.message : 'ChatGPT browser request failed',
      'server_error',
      'browser_error',
    ));
  } finally {
    reply.raw.end();
  }
}

function completionPrompts(prompt: string | string[]): string[] {
  const prompts = Array.isArray(prompt) ? prompt : [prompt];
  if (!prompts.length) throw new UnsupportedInputError('prompt must not be empty');
  if (prompts.length > 16) throw new UnsupportedInputError('At most 16 prompts are supported per request');
  return prompts;
}

function legacyPrompt(prompt: string): string {
  return [
    'Complete the text below. Return only the continuation, without commentary or quotation marks.',
    '',
    prompt,
  ].join('\n');
}

async function handleCompletion(request: FastifyRequest, reply: FastifyReply, browser: ChatGPTBrowser): Promise<unknown> {
  try {
    const body = completionRequestSchema.parse(request.body);
    ensureModel(body.model);
    const prompts = completionPrompts(body.prompt);
    if (body.stream) return streamLegacyCompletion(request, reply, browser, body.model, prompts, body.stop, body.echo ?? false);

    const choices: Array<Record<string, unknown>> = [];
    let promptText = '';
    let outputText = '';
    for (const [index, value] of prompts.entries()) {
      const prompt = legacyPrompt(value);
      let text = applyStop(await collect(browser, prompt, requestAbortSignal(request, reply)), body.stop);
      if (body.echo) text = value + text;
      choices.push({ text, index, logprobs: null, finish_reason: 'stop' });
      promptText += value;
      outputText += text;
    }

    return reply.send({
      id: `cmpl-${randomUUID()}`,
      object: 'text_completion',
      created: now(),
      model: body.model,
      choices,
      usage: usage(promptText, outputText),
    });
  } catch (error) {
    if (clientDisconnected(request, reply)) return;
    const known = sendKnownError(reply, error);
    if (known) return known;
    request.log.error(error);
    return reply.code(502).send(errorBody(error instanceof Error ? error.message : 'ChatGPT browser request failed', 'server_error', 'browser_error'));
  }
}

async function streamLegacyCompletion(
  request: FastifyRequest,
  reply: FastifyReply,
  browser: ChatGPTBrowser,
  model: string,
  prompts: string[],
  stop: string | string[] | undefined,
  echo: boolean,
): Promise<void> {
  const id = `cmpl-${randomUUID()}`;
  const created = now();
  const abort = new AbortController();
  bindStreamingAbort(request, reply, abort);
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (payload: unknown) => reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);

  try {
    for (const [index, value] of prompts.entries()) {
      if (echo) send({ id, object: 'text_completion', created, model, choices: [{ text: value, index, logprobs: null, finish_reason: null }] });
      const filter = new StopFilter(stop);
      for await (const delta of browser.generate(legacyPrompt(value), abort.signal)) {
        const filtered = filter.push(delta);
        if (filtered.text) send({ id, object: 'text_completion', created, model, choices: [{ text: filtered.text, index, logprobs: null, finish_reason: null }] });
      }
      const tail = filter.flush();
      if (tail) send({ id, object: 'text_completion', created, model, choices: [{ text: tail, index, logprobs: null, finish_reason: null }] });
      send({ id, object: 'text_completion', created, model, choices: [{ text: '', index, logprobs: null, finish_reason: 'stop' }] });
    }
    reply.raw.write('data: [DONE]\n\n');
  } catch (error) {
    if (!abort.signal.aborted) send(errorBody(error instanceof Error ? error.message : 'ChatGPT browser request failed', 'server_error', 'browser_error'));
  } finally {
    reply.raw.end();
  }
}

function normalizedResponseInputItems(body: ResponseRequest): unknown[] {
  if (Array.isArray(body.input)) return body.input;
  return [{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: body.input }],
  }];
}

function prepareResponse(body: ResponseRequest): {
  prompt: string;
  contextText: string;
  toolsEnabled: boolean;
  structured: boolean;
} {
  ensureModel(body.model);
  if (body.background) throw new UnsupportedInputError('background Responses are not supported');

  let priorContext = '';
  if (body.previous_response_id) {
    const previous = store.get(body.previous_response_id);
    if (!previous) throw new UnsupportedInputError(`previous_response_id '${body.previous_response_id}' was not found in this gateway process`);
    priorContext = previous.contextText;
  }

  const input = serializeResponsesInput(body.input);
  const base = [
    'Continue the following conversation as the assistant.',
    'Return only the next assistant response.',
    body.instructions ? `<INSTRUCTIONS>\n${body.instructions}\n</INSTRUCTIONS>` : '',
    priorContext,
    input,
  ].filter(Boolean).join('\n\n');

  const tools = responseTools(body);
  if (requiresToolCall(body.tool_choice) && tools.length === 0) throw new UnsupportedInputError('A tool call was required but no function tools were provided');
  const requiredName = requiredToolName(body.tool_choice);
  if (requiredName && !tools.some((tool) => tool.name === requiredName)) throw new UnsupportedInputError(`Required tool '${requiredName}' was not provided`);
  const toolsEnabled = tools.length > 0 && body.tool_choice !== 'none';
  const format = responseFormat(body);
  const structured = format.jsonObject === true || format.jsonSchema !== undefined;
  const prompt = withGenerationContract(base, {
    tools: toolsEnabled ? tools : [],
    toolChoice: body.tool_choice,
    parallelToolCalls: body.parallel_tool_calls,
    ...format,
  });
  return { prompt, contextText: [priorContext, input].filter(Boolean).join('\n\n'), toolsEnabled, structured };
}

function responseOutputItems(output: ParsedAssistantOutput): { items: Record<string, unknown>[]; outputText: string } {
  if (output.kind === 'tool_calls') {
    return {
      items: output.toolCalls.map((call) => ({
        id: `fc_${randomUUID().replaceAll('-', '')}`,
        type: 'function_call',
        status: 'completed',
        arguments: call.arguments,
        call_id: call.id,
        name: call.name,
      })),
      outputText: '',
    };
  }

  return {
    items: [{
      id: `msg_${randomUUID().replaceAll('-', '')}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', annotations: [], logprobs: [], text: output.content }],
    }],
    outputText: output.content,
  };
}

function responseObject(
  id: string,
  body: ResponseRequest,
  output: ParsedAssistantOutput,
  prompt: string,
  status: 'completed' | 'in_progress' = 'completed',
): Record<string, unknown> {
  const converted = responseOutputItems(output);
  return {
    id,
    object: 'response',
    created_at: now(),
    status,
    background: false,
    error: null,
    incomplete_details: null,
    instructions: body.instructions ?? null,
    max_output_tokens: body.max_output_tokens ?? null,
    model: body.model,
    output: status === 'completed' ? converted.items : [],
    output_text: status === 'completed' ? converted.outputText : '',
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    previous_response_id: body.previous_response_id ?? null,
    reasoning: body.reasoning ?? null,
    store: body.store ?? true,
    temperature: body.temperature ?? 1,
    text: body.text ?? { format: { type: 'text' } },
    tool_choice: body.tool_choice ?? 'auto',
    tools: body.tools ?? [],
    top_p: body.top_p ?? 1,
    truncation: body.truncation ?? 'disabled',
    usage: status === 'completed' ? (() => {
      const outputForUsage = converted.outputText || (output.kind === 'tool_calls' ? JSON.stringify(output) : '');
      const inputTokens = estimateTokens(prompt);
      const outputTokens = estimateTokens(outputForUsage);
      return {
        input_tokens: inputTokens,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: outputTokens,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: inputTokens + outputTokens,
      };
    })() : null,
    metadata: body.metadata ?? {},
  };
}

function appendAssistantContext(contextText: string, output: ParsedAssistantOutput): string {
  if (output.kind === 'text') return `${contextText}\n\n<ASSISTANT>\n${output.content}\n</ASSISTANT>`;
  return `${contextText}\n\n<ASSISTANT_TOOL_CALLS>\n${JSON.stringify(output.toolCalls)}\n</ASSISTANT_TOOL_CALLS>`;
}

async function handleResponse(request: FastifyRequest, reply: FastifyReply, browser: ChatGPTBrowser): Promise<unknown> {
  try {
    const body = responseRequestSchema.parse(request.body);
    const prepared = prepareResponse(body);
    if (body.stream) return streamResponse(request, reply, browser, body, prepared);

    const raw = await collect(browser, prepared.prompt, requestAbortSignal(request, reply));
    const output = finalizeControlledOutput(raw, prepared.toolsEnabled, prepared.structured, body);
    const id = `resp_${randomUUID().replaceAll('-', '')}`;
    const response = responseObject(id, body, output, prepared.prompt);

    if (body.store !== false) {
      store.set({
        id,
        response,
        inputItems: normalizedResponseInputItems(body),
        contextText: appendAssistantContext(prepared.contextText, output),
        createdAt: now(),
      });
    }
    return reply.send(response);
  } catch (error) {
    if (clientDisconnected(request, reply)) return;
    const known = sendKnownError(reply, error);
    if (known) return known;
    request.log.error(error);
    return reply.code(502).send(errorBody(error instanceof Error ? error.message : 'ChatGPT browser request failed', 'server_error', 'browser_error'));
  }
}

function writeResponseEvent(reply: FastifyReply, type: string, data: Record<string, unknown>): void {
  reply.raw.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

async function streamResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  browser: ChatGPTBrowser,
  body: ResponseRequest,
  prepared: { prompt: string; contextText: string; toolsEnabled: boolean; structured: boolean },
): Promise<void> {
  const id = `resp_${randomUUID().replaceAll('-', '')}`;
  const abort = new AbortController();
  bindStreamingAbort(request, reply, abort);
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-browser-llm-usage': 'estimated',
  });

  let sequence = 0;
  const inProgress: ParsedAssistantOutput = { kind: 'text', content: '' };
  writeResponseEvent(reply, 'response.created', {
    sequence_number: sequence++,
    response: responseObject(id, body, inProgress, prepared.prompt, 'in_progress'),
  });

  try {
    if (prepared.toolsEnabled) {
      const raw = await collect(browser, prepared.prompt, abort.signal);
      const output = finalizeControlledOutput(raw, true, prepared.structured, body);
      if (output.kind === 'tool_calls') {
        for (const [outputIndex, call] of output.toolCalls.entries()) {
          const itemId = `fc_${randomUUID().replaceAll('-', '')}`;
          const item = { id: itemId, type: 'function_call', status: 'in_progress', arguments: '', call_id: call.id, name: call.name };
          writeResponseEvent(reply, 'response.output_item.added', { sequence_number: sequence++, output_index: outputIndex, item });
          if (call.arguments) writeResponseEvent(reply, 'response.function_call_arguments.delta', {
            sequence_number: sequence++, item_id: itemId, output_index: outputIndex, delta: call.arguments,
          });
          writeResponseEvent(reply, 'response.function_call_arguments.done', {
            sequence_number: sequence++, item_id: itemId, output_index: outputIndex, arguments: call.arguments,
          });
          writeResponseEvent(reply, 'response.output_item.done', {
            sequence_number: sequence++, output_index: outputIndex,
            item: { ...item, status: 'completed', arguments: call.arguments },
          });
        }
        const completed = responseObject(id, body, output, prepared.prompt);
        writeResponseEvent(reply, 'response.completed', { sequence_number: sequence++, response: completed });
        if (body.store !== false) store.set({
          id,
          response: completed,
          inputItems: normalizedResponseInputItems(body),
          contextText: appendAssistantContext(prepared.contextText, output),
          createdAt: now(),
        });
        return;
      }

      sequence = streamBufferedResponseText(reply, output.content, sequence);
      const completedOutput: ParsedAssistantOutput = { kind: 'text', content: output.content };
      const completed = responseObject(id, body, completedOutput, prepared.prompt);
      writeResponseEvent(reply, 'response.completed', { sequence_number: sequence++, response: completed });
      if (body.store !== false) store.set({
        id,
        response: completed,
        inputItems: normalizedResponseInputItems(body),
        contextText: appendAssistantContext(prepared.contextText, completedOutput),
        createdAt: now(),
      });
      return;
    }

    const messageId = `msg_${randomUUID().replaceAll('-', '')}`;
    const baseItem = { id: messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] };
    writeResponseEvent(reply, 'response.output_item.added', { sequence_number: sequence++, output_index: 0, item: baseItem });
    writeResponseEvent(reply, 'response.content_part.added', {
      sequence_number: sequence++, item_id: messageId, output_index: 0, content_index: 0,
      part: { type: 'output_text', annotations: [], logprobs: [], text: '' },
    });

    let text = '';
    if (prepared.structured) {
      const raw = await collect(browser, prepared.prompt, abort.signal);
      const output = finalizeControlledOutput(raw, false, true, body);
      if (output.kind !== 'text') throw new Error('Structured response unexpectedly produced a tool call');
      text = output.content;
      if (text) writeResponseEvent(reply, 'response.output_text.delta', {
        sequence_number: sequence++, item_id: messageId, output_index: 0, content_index: 0, delta: text,
      });
    } else {
      for await (const delta of browser.generate(prepared.prompt, abort.signal)) {
        text += delta;
        writeResponseEvent(reply, 'response.output_text.delta', {
          sequence_number: sequence++, item_id: messageId, output_index: 0, content_index: 0, delta,
        });
      }
    }

    writeResponseEvent(reply, 'response.output_text.done', {
      sequence_number: sequence++, item_id: messageId, output_index: 0, content_index: 0, text,
    });
    const part = { type: 'output_text', annotations: [], logprobs: [], text };
    writeResponseEvent(reply, 'response.content_part.done', {
      sequence_number: sequence++, item_id: messageId, output_index: 0, content_index: 0, part,
    });
    const item = { ...baseItem, status: 'completed', content: [part] };
    writeResponseEvent(reply, 'response.output_item.done', { sequence_number: sequence++, output_index: 0, item });
    const output: ParsedAssistantOutput = { kind: 'text', content: text };
    const completed = responseObject(id, body, output, prepared.prompt);
    writeResponseEvent(reply, 'response.completed', { sequence_number: sequence++, response: completed });

    if (body.store !== false) store.set({
      id,
      response: completed,
      inputItems: normalizedResponseInputItems(body),
      contextText: appendAssistantContext(prepared.contextText, output),
      createdAt: now(),
    });
  } catch (error) {
    if (!abort.signal.aborted) {
      const apiError = errorBody(error instanceof Error ? error.message : 'ChatGPT browser request failed', 'server_error', 'browser_error').error;
      writeResponseEvent(reply, 'error', { sequence_number: sequence++, ...apiError });
    }
  } finally {
    reply.raw.end();
  }
}

function streamBufferedResponseText(
  reply: FastifyReply,
  text: string,
  sequenceStart: number,
): number {
  let sequence = sequenceStart;
  const messageId = `msg_${randomUUID().replaceAll('-', '')}`;
  const baseItem = { id: messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] };
  writeResponseEvent(reply, 'response.output_item.added', { sequence_number: sequence++, output_index: 0, item: baseItem });
  writeResponseEvent(reply, 'response.content_part.added', {
    sequence_number: sequence++, item_id: messageId, output_index: 0, content_index: 0,
    part: { type: 'output_text', annotations: [], logprobs: [], text: '' },
  });
  if (text) writeResponseEvent(reply, 'response.output_text.delta', {
    sequence_number: sequence++, item_id: messageId, output_index: 0, content_index: 0, delta: text,
  });
  writeResponseEvent(reply, 'response.output_text.done', {
    sequence_number: sequence++, item_id: messageId, output_index: 0, content_index: 0, text,
  });
  const part = { type: 'output_text', annotations: [], logprobs: [], text };
  writeResponseEvent(reply, 'response.content_part.done', {
    sequence_number: sequence++, item_id: messageId, output_index: 0, content_index: 0, part,
  });
  writeResponseEvent(reply, 'response.output_item.done', {
    sequence_number: sequence++, output_index: 0,
    item: { ...baseItem, status: 'completed', content: [part] },
  });
  return sequence;
}

function responseNotFound(reply: FastifyReply, id: string) {
  return reply.code(404).send(errorBody(`Response '${id}' was not found`, 'invalid_request_error', 'response_not_found', 'response_id'));
}

function registerUnsupportedFallback(app: FastifyInstance): void {
  app.all('/v1/*', async (request, reply) => reply.code(501).send(errorBody(
    `Endpoint '${request.method} ${request.url}' is not implementable through the ChatGPT web text UI. Supported generation endpoints are /v1/responses, /v1/chat/completions, /v1/completions, and /v1/models.`,
    'invalid_request_error',
    'unsupported_endpoint',
  )));
}

export async function registerOpenAIRoutes(app: FastifyInstance, browser: ChatGPTBrowser): Promise<void> {
  app.get('/v1/models', async () => ({ object: 'list', data: advertisedModels().map(modelObject) }));

  app.get<{ Params: { model: string } }>('/v1/models/:model', async (request, reply) => {
    if (!acceptsModel(request.params.model)) return reply.code(404).send(errorBody(
      `Model '${request.params.model}' is not available`, 'invalid_request_error', 'model_not_found', 'model',
    ));
    return modelObject(request.params.model);
  });

  app.post('/v1/chat/completions', (request, reply) => handleChatCompletion(request, reply, browser));
  app.post('/v1/completions', (request, reply) => handleCompletion(request, reply, browser));
  app.post('/v1/responses', (request, reply) => handleResponse(request, reply, browser));

  app.get<{ Params: { responseId: string } }>('/v1/responses/:responseId', async (request, reply) => {
    const value = store.get(request.params.responseId);
    return value ? reply.send(value.response) : responseNotFound(reply, request.params.responseId);
  });

  app.delete<{ Params: { responseId: string } }>('/v1/responses/:responseId', async (request, reply) => {
    if (!store.delete(request.params.responseId)) return responseNotFound(reply, request.params.responseId);
    return reply.send({ id: request.params.responseId, object: 'response.deleted', deleted: true });
  });

  app.post<{ Params: { responseId: string } }>('/v1/responses/:responseId/cancel', async (request, reply) => {
    const value = store.get(request.params.responseId);
    if (!value) return responseNotFound(reply, request.params.responseId);
    // Browser-backed responses are synchronous; by the time an ID is retrievable it is already complete.
    return reply.send(value.response);
  });

  app.get<{ Params: { responseId: string } }>('/v1/responses/:responseId/input_items', async (request, reply) => {
    const value = store.get(request.params.responseId);
    if (!value) return responseNotFound(reply, request.params.responseId);
    return reply.send({ object: 'list', data: value.inputItems, first_id: null, last_id: null, has_more: false });
  });

  registerUnsupportedFallback(app);
}
