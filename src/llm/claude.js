import Anthropic from '@anthropic-ai/sdk';
import {
  AbortedError,
  InvalidKeyError,
  MalformedToolInputError,
  ProviderDownError,
  ProviderError,
  RateLimitedError,
} from './provider.js';

/** @typedef {import('./provider.js').Message} Message */
/** @typedef {import('./provider.js').ToolSpec} ToolSpec */
/** @typedef {import('./provider.js').Turn} Turn */

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

// Server-side refusal fallback: if the model declines a request, the API
// re-runs it on Anthropic's recommended fallback model inside the same call.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** @type {Record<string, Turn['stopReason']>} */
const STOP_REASONS = {
  end_turn: 'end',
  stop_sequence: 'end',
  tool_use: 'tool_calls',
  max_tokens: 'max_tokens',
  refusal: 'refused',
};

/** @implements {import('./provider.js').LLMProvider} */
export class ClaudeProvider {
  name = 'claude';

  /**
   * @param {{ apiKey?: string, model?: string, maxTokens?: number, client?: Anthropic }} [options]
   *   apiKey: omit to let the SDK resolve credentials (ANTHROPIC_API_KEY, `ant auth login`, ...)
   *   client: inject a client (tests)
   */
  constructor({ apiKey, model = DEFAULT_CLAUDE_MODEL, maxTokens = 64000, client } = {}) {
    this.model = model;
    this.maxTokens = maxTokens;
    this.client = client ?? new Anthropic(apiKey ? { apiKey } : {});
  }

  /**
   * Stream one model turn: yields text deltas, returns the complete Turn.
   * @param {{ system: string, messages: Message[], tools: ToolSpec[],
   *           effort?: import('./provider.js').Effort, signal?: AbortSignal }} args
   * @returns {AsyncGenerator<{ type: 'text', delta: string }, Turn>}
   */
  async *streamTurn({ system, messages, tools, effort = 'medium', signal }) {
    try {
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          system,
          tools: tools.map(toClaudeTool),
          messages: toClaudeMessages(messages),
          output_config: { effort },
          // Caches the longest stable prefix (tools + system + history so far).
          cache_control: { type: 'ephemeral' },
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
        },
        { signal },
      );

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text', delta: event.delta.text };
        }
      }
      return fromClaudeMessage(await stream.finalMessage());
    } catch (err) {
      throw toProviderError(err);
    }
  }

  /** Cheap check that the key works: listing models costs no tokens. */
  async validateKey() {
    try {
      await this.client.models.list({ limit: 1 });
    } catch (err) {
      throw toProviderError(err);
    }
  }
}

/** @param {ToolSpec} tool */
export function toClaudeTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    // Stream tool input as it is generated (matters for large inputs like code).
    // The API then no longer validates it, so the agent validates every input.
    eager_input_streaming: true,
  };
}

/**
 * Neutral history → Anthropic messages. Assistant turns that Claude produced
 * are sent back byte-for-byte (`raw`), which keeps thinking blocks valid and
 * the cached prefix stable.
 * @param {Message[]} messages
 */
export function toClaudeMessages(messages) {
  return messages.map((message) => {
    if (message.role === 'assistant' && message.raw?.provider === 'claude') {
      return { role: 'assistant', content: message.raw.content };
    }
    return {
      role: message.role,
      content: message.content.map((block) => {
        switch (block.type) {
          case 'text':
            return { type: 'text', text: block.text };
          case 'tool_call':
            return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
          case 'tool_result':
            return {
              type: 'tool_result',
              tool_use_id: block.id,
              content: block.output,
              ...(block.isError && { is_error: true }),
            };
        }
      }),
    };
  });
}

/**
 * Anthropic message → neutral Turn. Block types the agent doesn't act on
 * (thinking, fallback markers) are kept only in `raw`.
 * @param {any} message  Anthropic (beta) Message
 * @returns {Turn}
 */
export function fromClaudeMessage(message) {
  /** @type {import('./provider.js').Block[]} */
  const content = [];
  for (const block of message.content) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text });
    else if (block.type === 'tool_use') {
      content.push({ type: 'tool_call', id: block.id, name: block.name, input: block.input });
    }
  }
  return {
    content,
    stopReason: STOP_REASONS[message.stop_reason] ?? 'end',
    usage: {
      input: message.usage?.input_tokens ?? 0,
      output: message.usage?.output_tokens ?? 0,
      cacheRead: message.usage?.cache_read_input_tokens ?? 0,
      cacheWrite: message.usage?.cache_creation_input_tokens ?? 0,
    },
    raw: { provider: 'claude', content: message.content },
  };
}

/** Map SDK errors (most specific first) to provider-neutral ones. */
export function toProviderError(err) {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new AbortedError('Request cancelled', { cause: err });
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new InvalidKeyError('Your Anthropic API key is invalid or revoked.', { cause: err });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new RateLimitedError('Your Anthropic API key hit its rate limit. Try again in a minute.', { cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.InternalServerError) {
    return new ProviderDownError('Could not reach Anthropic, or it is overloaded. Try again shortly.', { cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    return new ProviderError(`Anthropic API error ${err.status ?? ''}: ${err.message}`, { cause: err });
  }
  // The next two cases have no dedicated SDK error class (both arrive as a
  // base AnthropicError or plain Error), so they match on the SDK's message.
  if (!(err instanceof Error)) return err;
  // No credentials configured at all.
  if (err.message.startsWith('Could not resolve authentication method')) {
    return new InvalidKeyError('No Anthropic API key found. Set ANTHROPIC_API_KEY.', { cause: err });
  }
  // With eager input streaming, a streamed tool input that isn't parseable
  // JSON. Safe to re-issue the turn.
  if (err instanceof Anthropic.AnthropicError && err.message.startsWith('Unable to parse tool parameter JSON')) {
    return new MalformedToolInputError(err.message, { cause: err });
  }
  if (err instanceof Anthropic.AnthropicError) return new ProviderError(err.message, { cause: err });
  return err;
}
