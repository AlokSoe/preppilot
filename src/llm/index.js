import { ClaudeProvider } from './claude.js';
import { DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_MODEL, GEMINI_BASE_URL, OpenAICompatibleProvider } from './openai.js';

export const PROVIDERS = ['claude', 'openai', 'gemini'];

/**
 * Create a provider adapter by name. Nothing else in the app knows which
 * provider it's talking to (design doc §9.8).
 * @param {{ provider?: string, apiKey?: string, model?: string }} [options]
 *   model: Claude model override (PREPPILOT_MODEL). OpenAI and Gemini read
 *   OPENAI_MODEL / GEMINI_MODEL instead, since model IDs aren't portable.
 * @returns {import('./provider.js').LLMProvider}
 */
export function createProvider({ provider = 'claude', apiKey, model } = {}) {
  switch (provider) {
    case 'claude':
      return new ClaudeProvider({ apiKey, model });
    case 'openai':
      return new OpenAICompatibleProvider({
        name: 'openai',
        apiKey: apiKey ?? process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
      });
    case 'gemini':
      return new OpenAICompatibleProvider({
        name: 'gemini',
        apiKey: apiKey ?? process.env.GEMINI_API_KEY,
        baseURL: GEMINI_BASE_URL,
        model: process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
        // The compatibility layer's handling of reasoning_effort varies by model; leave it out.
        sendEffort: false,
      });
    default:
      throw new Error(`Unknown provider "${provider}". Supported: ${PROVIDERS.join(', ')}`);
  }
}
