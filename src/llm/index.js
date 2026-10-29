import { ClaudeProvider } from './claude.js';
import { DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_MODEL, GEMINI_BASE_URL, OpenAICompatibleProvider } from './openai.js';
import { InvalidKeyError } from './provider.js';

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
        // Any OpenAI-compatible server works too, e.g. Ollama on your own
        // machine: OPENAI_BASE_URL=http://localhost:11434/v1
        baseURL: process.env.OPENAI_BASE_URL,
        model: process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
        // reasoning_effort is OpenAI-specific; other servers may reject it.
        sendEffort: !process.env.OPENAI_BASE_URL,
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

/** The key each provider reads from the environment. */
const KEY_ENV = { claude: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };

/**
 * The provider for local use (CLI, single-user server, demo tier):
 * PREPPILOT_PROVIDER picks it (default claude), its key comes from the env.
 * @param {{ model?: string }} [options] Claude model override
 */
export function defaultProvider({ model } = {}) {
  const provider = defaultProviderName();
  // The Anthropic SDK resolves credentials itself (env, `ant auth login`) and
  // reports a missing key on first use. The OpenAI SDK throws while being
  // constructed, so for those providers report the right variable instead.
  if (provider !== 'claude' && !hasDefaultKey()) return missingKeyProvider(provider);
  return createProvider({ provider, model: provider === 'claude' ? model : undefined });
}

/** A provider whose every call explains which key to set. @param {string} provider */
function missingKeyProvider(provider) {
  const fail = () => {
    throw new InvalidKeyError(`No API key found for ${provider}. Set ${KEY_ENV[provider]}.`);
  };
  return {
    name: provider,
    // eslint-disable-next-line require-yield
    async *streamTurn() {
      fail();
    },
    generateJson: async () => fail(),
    validateKey: async () => fail(),
  };
}

export function defaultProviderName() {
  const name = process.env.PREPPILOT_PROVIDER ?? 'claude';
  if (!PROVIDERS.includes(name)) throw new Error(`PREPPILOT_PROVIDER must be one of ${PROVIDERS.join(', ')}`);
  return name;
}

/** Whether the default provider has a key configured (Ollama ignores the key, but the SDK needs one set). */
export function hasDefaultKey() {
  return Boolean(process.env[KEY_ENV[defaultProviderName()]]);
}
