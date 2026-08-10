// Keep all fragile ChatGPT UI selectors in one place.
// These are intentionally easy to update when chatgpt.com changes.
export const selectors = {
  composer: '#prompt-textarea',
  sendButton: 'button[data-testid="send-button"]',
  stopButton: 'button[data-testid="stop-button"]',
  assistantMessage: '[data-message-author-role="assistant"]',
  loginButtonText: /log in/i,
} as const;
