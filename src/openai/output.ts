import { randomUUID } from 'node:crypto';

export type ParsedAssistantOutput =
  | { kind: 'text'; content: string }
  | { kind: 'tool_calls'; toolCalls: ParsedToolCall[] };

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: string;
}

function gatewayOutputKind(value: Record<string, unknown>): unknown {
  // The web model occasionally normalizes the private marker by removing one
  // leading underscore. Accept that observed variant, but never expose either
  // control envelope to OpenAI-compatible clients.
  return value.__gateway_type ?? value._gateway_type;
}

function stripFence(value: string): string {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

function escapeWindowsPathContent(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '\\') {
      output += character;
      continue;
    }

    if (value[index + 1] === '\\') {
      output += '\\\\';
      index += 1;
    } else {
      output += '\\\\';
    }
  }
  return output;
}

function repairWindowsPathBackslashes(value: string): string {
  let output = '';
  let index = 0;

  while (index < value.length) {
    if (value[index] !== '"') {
      output += value[index];
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    while (index < value.length) {
      if (value[index] === '\\') {
        index += 2;
        continue;
      }
      if (value[index] === '"') break;
      index += 1;
    }

    if (index >= value.length) return value;
    const content = value.slice(start + 1, index);
    const repaired = /^[A-Za-z]:\\/.test(content) ? escapeWindowsPathContent(content) : content;
    output += `"${repaired}"`;
    index += 1;
  }

  return output;
}

function parseControlledJson(candidate: string): Record<string, unknown> {
  try {
    return JSON.parse(candidate) as Record<string, unknown>;
  } catch (originalError) {
    const repaired = repairWindowsPathBackslashes(candidate);
    if (repaired === candidate) throw originalError;
    return JSON.parse(repaired) as Record<string, unknown>;
  }
}

function asArgumentString(value: unknown): string {
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify({ value });
    }
  }
  return JSON.stringify(value ?? {});
}

export function parseControlledOutput(raw: string, toolsEnabled: boolean): ParsedAssistantOutput {
  const candidate = stripFence(raw);

  if (!toolsEnabled) return { kind: 'text', content: candidate };

  try {
    const parsed = parseControlledJson(candidate);
    const kind = gatewayOutputKind(parsed);

    if (kind === 'text') {
      const content = typeof parsed.content === 'string'
        ? parsed.content
        : parsed.content === undefined ? '' : JSON.stringify(parsed.content);
      return { kind: 'text', content };
    }

    if (kind === 'tool_calls' && Array.isArray(parsed.tool_calls)) {
      const toolCalls = parsed.tool_calls.flatMap((entry): ParsedToolCall[] => {
        if (!entry || typeof entry !== 'object') return [];
        const record = entry as Record<string, unknown>;
        if (typeof record.name !== 'string' || !record.name) return [];
        return [{
          id: typeof record.id === 'string' && record.id ? record.id : `call_${randomUUID().replaceAll('-', '')}`,
          name: record.name,
          arguments: asArgumentString(record.arguments),
        }];
      });

      if (toolCalls.length) return { kind: 'tool_calls', toolCalls };
    }
  } catch {
    // Auto tool choice is allowed to fall back to a normal text answer.
  }

  return { kind: 'text', content: raw.trimEnd() };
}

export function normalizeJsonText(raw: string): string {
  const candidate = stripFence(raw);
  JSON.parse(candidate);
  return candidate;
}
