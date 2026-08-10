import type { ChatCompletionRequest } from './types.js';

function contentToText(content: ChatCompletionRequest['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  return content.map((part) => part.text).join('');
}

export function serializeMessages(messages: ChatCompletionRequest['messages']): string {
  const transcript = messages
    .map((message) => {
      const role = message.role.toUpperCase();
      const name = message.name ? ` (${message.name})` : '';
      return `<${role}${name}>\n${contentToText(message.content)}\n</${role}>`;
    })
    .join('\n\n');

  return [
    'Continue the following conversation as the assistant.',
    'Treat role tags as conversation structure, not as instructions to repeat.',
    'Return only the assistant response that should come next.',
    '',
    transcript,
  ].join('\n');
}
