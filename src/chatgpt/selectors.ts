// Keep all fragile ChatGPT UI selectors in one place.
// Prefer stable data-testid/role attributes and keep fallbacks comma-separated.
export const selectors = {
  composer: '#prompt-textarea, [data-testid="composer-input"]',
  newChatButton: '[data-testid="create-new-chat-button"]:visible, a[aria-label*="New chat" i]:visible',
  sendButton: 'button[data-testid="send-button"], button[aria-label*="Send" i]',
  stopButton: 'button[data-testid="stop-button"]',
  assistantMessage: '[data-message-author-role="assistant"]',
  // This excludes status controls such as the transient "Thinking" label that
  // can appear inside the outer assistant message container.
  assistantContent: '.markdown, [class~="prose"]',
} as const;
