import { z } from 'zod';

const textPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const messageSchema = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(textPartSchema)]),
  name: z.string().optional(),
});

export const chatCompletionRequestSchema = z.object({
  model: z.string().default('chatgpt-web'),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().default(false),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  user: z.string().optional(),
  n: z.number().int().min(1).max(1).optional(),
});

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
