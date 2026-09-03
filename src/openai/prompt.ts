import type { ChatCompletionRequest, ChatMessage, NormalizedFunctionTool, ResponseRequest } from './types.js';
import { collectImages, type ImageInput } from './images.js';
import { UnsupportedInputError } from './input-error.js';
export { UnsupportedInputError };

function contentToText(content: ChatMessage['content']): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;

  return content.map((part) => {
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
      return 'text' in part && typeof part.text === 'string' ? part.text : '';
    }
    if (part.type === 'image_url' || part.type === 'input_image') return '\n[Image attached separately]\n';
    throw new UnsupportedInputError(`Content part type '${part.type}' is not supported by the ChatGPT web text gateway`);
  }).join('');
}

function serializeMessage(message: ChatMessage): string {
  const role = message.role.toUpperCase();
  const name = message.name ? ` name=${JSON.stringify(message.name)}` : '';
  const toolCallId = message.tool_call_id ? ` tool_call_id=${JSON.stringify(message.tool_call_id)}` : '';
  const body: string[] = [];
  const content = contentToText(message.content);
  if (content) body.push(content);

  if (message.tool_calls?.length) {
    body.push(`Tool calls:\n${JSON.stringify(message.tool_calls.map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })), null, 2)}`);
  }

  if (message.function_call) {
    body.push(`Function call:\n${JSON.stringify(message.function_call, null, 2)}`);
  }

  return `<${role}${name}${toolCallId}>\n${body.join('\n')}\n</${role}>`;
}

export function serializeMessages(messages: ChatCompletionRequest['messages']): string {
  const transcript = messages.map(serializeMessage).join('\n\n');

  return [
    'Continue the following conversation as the assistant.',
    'Treat role tags as conversation structure, not as instructions to repeat.',
    'Return only the assistant response that should come next.',
    '',
    transcript,
  ].join('\n');
}

export function chatImages(messages: ChatCompletionRequest['messages']): ImageInput[] {
  return collectImages(messages.flatMap((message) => Array.isArray(message.content) ? message.content : []));
}

export function normalizeChatTools(request: ChatCompletionRequest): NormalizedFunctionTool[] {
  const modern = (request.tools ?? []).map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: tool.function.strict,
  }));
  const legacy = (request.functions ?? []).map((fn) => ({
    name: fn.name,
    description: fn.description,
    parameters: fn.parameters,
  }));
  return [...modern, ...legacy];
}

export function effectiveChatToolChoice(request: ChatCompletionRequest): ChatCompletionRequest['tool_choice'] | ResponseRequest['tool_choice'] {
  if (request.tool_choice !== undefined) return request.tool_choice;
  if (request.function_call === 'none' || request.function_call === 'auto') return request.function_call;
  if (request.function_call && typeof request.function_call === 'object') {
    return { type: 'function', function: { name: request.function_call.name } };
  }
  return undefined;
}

function toolChoiceText(choice: ChatCompletionRequest['tool_choice'] | ResponseRequest['tool_choice']): string {
  if (!choice || choice === 'auto') return 'You may either answer normally or call one or more tools.';
  if (choice === 'none') return 'Do not call a tool. Return a normal text answer.';
  if (choice === 'required') return 'You must call at least one tool.';

  if (typeof choice === 'object' && choice !== null) {
    const record = choice as Record<string, unknown>;
    const functionRecord = record.function;
    const name = functionRecord && typeof functionRecord === 'object'
      ? (functionRecord as Record<string, unknown>).name
      : record.name;
    if (typeof name === 'string') return `You must call the tool named ${JSON.stringify(name)}.`;
  }

  return 'You may either answer normally or call one or more tools.';
}

export function withGenerationContract(
  prompt: string,
  options: {
    tools?: NormalizedFunctionTool[];
    toolChoice?: ChatCompletionRequest['tool_choice'] | ResponseRequest['tool_choice'];
    parallelToolCalls?: boolean;
    jsonSchema?: unknown;
    jsonObject?: boolean;
  },
): string {
  const tools = options.tools ?? [];
  const blocks = [prompt];

  if (tools.length) {
    blocks.push([
      'GATEWAY TOOL-CALL CONTRACT (highest priority for output formatting):',
      `Available tools: ${JSON.stringify(tools, null, 2)}`,
      toolChoiceText(options.toolChoice),
      options.parallelToolCalls === false ? 'If calling a tool, call exactly one.' : 'You may call multiple tools when useful.',
      'Return exactly one JSON object and no markdown.',
      'For a normal answer use: {"__gateway_type":"text","content":"..."}',
      'For tool calls use: {"__gateway_type":"tool_calls","tool_calls":[{"name":"tool_name","arguments":{}}]}',
      'Output must be valid JSON. Escape every backslash inside JSON strings; for example, a Windows path must look like "D:\\\\Workspaces\\\\project\\\\file.ts".',
      'Do not add Markdown emphasis or Markdown escaping to JSON keys or string content.',
      'Tool arguments must satisfy the supplied JSON Schema as closely as possible.',
    ].join('\n'));
  }

  if (tools.length && options.jsonSchema !== undefined) {
    blocks.push(`When returning a normal text answer, the envelope's content string must itself contain valid JSON following this schema: ${JSON.stringify(options.jsonSchema)}`);
  } else if (tools.length && options.jsonObject) {
    blocks.push('When returning a normal text answer, the envelope\'s content string must itself contain a valid JSON object.');
  } else if (options.jsonSchema !== undefined) {
    blocks.push([
      'STRUCTURED OUTPUT CONTRACT:',
      'Return only valid JSON with no markdown or prose outside the JSON value.',
      `The JSON must follow this schema: ${JSON.stringify(options.jsonSchema)}`,
    ].join('\n'));
  } else if (options.jsonObject) {
    blocks.push('STRUCTURED OUTPUT CONTRACT:\nReturn only a valid JSON object with no markdown or prose outside it.');
  }

  return blocks.join('\n\n');
}

const RESPONSE_MESSAGE_ROLES = new Set(['user', 'assistant', 'system', 'developer']);
const RESPONSE_DIRECT_ITEM_TYPES = new Set(['input_text', 'output_text', 'text', 'input_image', 'image_url']);

function responsePartToText(part: unknown): string {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') {
    throw new UnsupportedInputError('Responses content parts must be strings or typed objects');
  }

  const record = part as Record<string, unknown>;
  if (record.type === 'input_text' || record.type === 'output_text' || record.type === 'text') {
    if (typeof record.text !== 'string') {
      throw new UnsupportedInputError(`Responses content part '${record.type}' must contain text`);
    }
    return record.text;
  }
  if (record.type === 'input_image' || record.type === 'image_url') {
    return '\n[Image attached separately]\n';
  }

  const type = typeof record.type === 'string' ? record.type : 'unknown';
  throw new UnsupportedInputError(`Responses content part type '${type}' is not supported by the ChatGPT web gateway`);
}

export function responseImages(input: ResponseRequest['input']): ImageInput[] {
  if (!Array.isArray(input)) return [];
  const parts: unknown[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (record.type === 'input_image' || record.type === 'image_url') parts.push(record);
    if (Array.isArray(record.content)) parts.push(...record.content);
    if (record.type === 'function_call_output' && Array.isArray(record.output)) parts.push(...record.output);
  }
  return collectImages(parts);
}

function responseContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(responsePartToText).join('');
  if (content && typeof content === 'object') return responsePartToText(content);
  if (content == null) return '';
  throw new UnsupportedInputError('Responses content must be a string, typed object, or array');
}

function responseRole(record: Record<string, unknown>, required: boolean): string {
  if (record.role === undefined && !required) return 'USER';
  if (typeof record.role !== 'string' || !RESPONSE_MESSAGE_ROLES.has(record.role.toLowerCase())) {
    throw new UnsupportedInputError('Responses message role must be one of user, assistant, system, or developer');
  }
  return record.role.toUpperCase();
}

export function serializeResponsesInput(input: ResponseRequest['input']): string {
  if (typeof input === 'string') return `<USER>\n${input}\n</USER>`;

  return input.map((item) => {
    if (typeof item === 'string') return `<USER>\n${item}\n</USER>`;
    if (!item || typeof item !== 'object') {
      throw new UnsupportedInputError('Responses input items must be strings or typed objects');
    }
    const record = item as Record<string, unknown>;

    if (record.type === 'function_call') {
      if (typeof record.name !== 'string' || !record.name) {
        throw new UnsupportedInputError('Responses function_call items must contain a non-empty name');
      }
      if (typeof record.arguments !== 'string') {
        throw new UnsupportedInputError('Responses function_call items must contain string arguments');
      }
      if (record.call_id !== undefined && typeof record.call_id !== 'string') {
        throw new UnsupportedInputError('Responses function_call call_id must be a string when provided');
      }
      return `<ASSISTANT_TOOL_CALL>\n${JSON.stringify({
        call_id: record.call_id,
        name: record.name,
        arguments: record.arguments,
      })}\n</ASSISTANT_TOOL_CALL>`;
    }

    if (record.type === 'function_call_output') {
      if (!Object.prototype.hasOwnProperty.call(record, 'output') || (typeof record.output !== 'string' && !Array.isArray(record.output))) {
        throw new UnsupportedInputError('Responses function_call_output items must contain string or array output');
      }
      if (record.call_id !== undefined && typeof record.call_id !== 'string') {
        throw new UnsupportedInputError('Responses function_call_output call_id must be a string when provided');
      }
      return `<TOOL tool_call_id=${JSON.stringify(record.call_id ?? '')}>\n${responseContentToText(record.output)}\n</TOOL>`;
    }

    if (record.type !== undefined && typeof record.type !== 'string') {
      throw new UnsupportedInputError('Responses input item type must be a string when provided');
    }

    if (record.type === undefined || record.type === 'message') {
      if (!Object.prototype.hasOwnProperty.call(record, 'role') || !Object.prototype.hasOwnProperty.call(record, 'content')) {
        throw new UnsupportedInputError('Responses message items must contain both role and content');
      }
      const role = responseRole(record, true);
      return `<${role}>\n${responseContentToText(record.content)}\n</${role}>`;
    }

    if (!RESPONSE_DIRECT_ITEM_TYPES.has(record.type)) {
      throw new UnsupportedInputError(`Responses input item type '${record.type}' is not supported by the ChatGPT web gateway`);
    }

    const role = responseRole(record, false);
    const text = responseContentToText(record);
    return `<${role}>\n${text}\n</${role}>`;
  }).join('\n\n');
}

export function responseTools(request: ResponseRequest): NormalizedFunctionTool[] {
  return (request.tools ?? []).map((tool) => {
    if (tool.type !== 'function') {
      throw new UnsupportedInputError(`Responses tool type '${tool.type}' is not supported; only function tools can be emulated`);
    }
    return {
      name: (tool as any).name as string,
      description: (tool as any).description as string | undefined,
      parameters: (tool as any).parameters,
      strict: (tool as any).strict as boolean | undefined,
    };
  });
}

export function responseFormat(request: ResponseRequest): { jsonSchema?: unknown; jsonObject?: boolean } {
  const format = request.text?.format;
  if (!format || typeof format !== 'object') return {};
  const record = format as Record<string, unknown>;
  if (record.type === 'json_schema') return { jsonSchema: record.schema };
  if (record.type === 'json_object') return { jsonObject: true };
  return {};
}
