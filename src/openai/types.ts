import { z } from 'zod';

export const textPartSchema = z.object({
  type: z.enum(['text', 'input_text', 'output_text']),
  text: z.string(),
}).passthrough();

export const imagePartSchema = z.object({
  type: z.enum(['image_url', 'input_image']),
}).passthrough();

const contentPartSchema = z.union([textPartSchema, imagePartSchema, z.object({ type: z.string() }).passthrough()]);

const functionCallSchema = z.object({
  name: z.string(),
  arguments: z.string(),
}).passthrough();

export const chatToolCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal('function').default('function'),
  function: functionCallSchema,
}).passthrough();

export const chatMessageSchema = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool', 'function']),
  content: z.union([z.string(), z.array(contentPartSchema), z.null()]).optional().default(''),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(chatToolCallSchema).optional(),
  function_call: functionCallSchema.optional(),
}).passthrough();

export const functionToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }).passthrough(),
}).passthrough();

const legacyFunctionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const chatToolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({ name: z.string().min(1) }).passthrough(),
  }).passthrough(),
]);

export const chatResponseFormatSchema = z.union([
  z.object({ type: z.literal('text') }).passthrough(),
  z.object({ type: z.literal('json_object') }).passthrough(),
  z.object({
    type: z.literal('json_schema'),
    json_schema: z.object({
      name: z.string().optional(),
      description: z.string().optional(),
      schema: z.record(z.string(), z.unknown()),
      strict: z.boolean().optional(),
    }).passthrough(),
  }).passthrough(),
]);

export const chatCompletionRequestSchema = z.object({
  model: z.string().min(1).default('chatgpt-web'),
  messages: z.array(chatMessageSchema).min(1),
  stream: z.boolean().default(false),
  stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  user: z.string().optional(),
  n: z.number().int().min(1).max(1).optional(),
  tools: z.array(functionToolSchema).optional(),
  tool_choice: chatToolChoiceSchema.optional(),
  functions: z.array(legacyFunctionSchema).optional(),
  function_call: z.union([z.enum(['none', 'auto']), z.object({ name: z.string().min(1) }).passthrough()]).optional(),
  parallel_tool_calls: z.boolean().optional(),
  response_format: chatResponseFormatSchema.optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  seed: z.number().int().optional(),
  logprobs: z.boolean().optional(),
  top_logprobs: z.number().int().optional(),
  modalities: z.array(z.string()).optional(),
  audio: z.unknown().optional(),
}).passthrough();

export const completionRequestSchema = z.object({
  model: z.string().min(1).default('chatgpt-web'),
  prompt: z.union([z.string(), z.array(z.string())]),
  stream: z.boolean().default(false),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  n: z.number().int().min(1).max(1).optional(),
  echo: z.boolean().optional(),
  user: z.string().optional(),
}).passthrough();

const responseFunctionToolSchema = z.object({
  type: z.literal('function'),
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  strict: z.boolean().optional(),
}).passthrough();

export const responseToolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    name: z.string().min(1),
  }).passthrough(),
]);

export const responseTextFormatSchema = z.union([
  z.object({ type: z.literal('text') }).passthrough(),
  z.object({ type: z.literal('json_object') }).passthrough(),
  z.object({
    type: z.literal('json_schema'),
    name: z.string().optional(),
    description: z.string().optional(),
    schema: z.record(z.string(), z.unknown()),
    strict: z.boolean().optional(),
  }).passthrough(),
]);

export const responseRequestSchema = z.object({
  model: z.string().min(1).default('chatgpt-web'),
  input: z.union([z.string(), z.array(z.unknown())]),
  instructions: z.string().optional(),
  stream: z.boolean().default(false),
  tools: z.array(z.union([responseFunctionToolSchema, z.object({ type: z.string() }).passthrough()])).optional(),
  tool_choice: responseToolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
  text: z.object({ format: responseTextFormatSchema.optional() }).passthrough().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  previous_response_id: z.string().optional(),
  store: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  user: z.string().optional(),
  truncation: z.string().optional(),
  reasoning: z.unknown().optional(),
  background: z.boolean().optional(),
}).passthrough();

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
export type CompletionRequest = z.infer<typeof completionRequestSchema>;
export type ResponseRequest = z.infer<typeof responseRequestSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type FunctionTool = z.infer<typeof functionToolSchema>;

export interface NormalizedFunctionTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}
