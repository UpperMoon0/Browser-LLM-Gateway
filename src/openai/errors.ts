import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { UnsupportedInputError } from './prompt.js';

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param?: string | null;
    code?: string | null;
  };
}

export function errorBody(
  message: string,
  type = 'invalid_request_error',
  code: string | null = 'invalid_request',
  param?: string | null,
): OpenAIErrorBody {
  return { error: { message, type, code, ...(param !== undefined ? { param } : {}) } };
}

export function sendKnownError(reply: FastifyReply, error: unknown): FastifyReply | undefined {
  if (error instanceof ZodError) {
    return reply.code(400).send(errorBody(
      error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; '),
    ));
  }

  if (error instanceof UnsupportedInputError) {
    return reply.code(400).send(errorBody(error.message, 'invalid_request_error', 'unsupported_feature'));
  }

  return undefined;
}
