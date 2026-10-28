import { ClaudeProvider } from './claude.js';

export const PROVIDERS = ['claude'];

/**
 * Create a provider adapter by name. New providers (OpenAI, Gemini) plug in
 * here in milestone M9; nothing else in the app changes.
 * @param {{ provider?: string, apiKey?: string, model?: string }} [options]
 * @returns {import('./provider.js').LLMProvider}
 */
export function createProvider({ provider = 'claude', apiKey, model } = {}) {
  switch (provider) {
    case 'claude':
      return new ClaudeProvider({ apiKey, model });
    default:
      throw new Error(`Unknown provider "${provider}". Supported: ${PROVIDERS.join(', ')}`);
  }
}
