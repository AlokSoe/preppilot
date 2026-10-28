/**
 * Provider-neutral types and errors (design doc §9.8).
 *
 * The agent loop only ever sees these shapes, never a provider SDK's types.
 * Each adapter (src/llm/claude.js, later openai.js / gemini.js) converts
 * to and from them.
 *
 * @typedef {{ type: 'text', text: string, hidden?: boolean }} TextBlock
 *   `hidden`: sent to the model but not shown in the UI (e.g. round briefings).
 * @typedef {{ type: 'tool_call', id: string, name: string, input: unknown }} ToolCallBlock
 * @typedef {{ type: 'tool_result', id: string, output: string, isError?: boolean }} ToolResultBlock
 * @typedef {TextBlock | ToolCallBlock | ToolResultBlock} Block
 *
 * @typedef {{
 *   role: 'user' | 'assistant',
 *   content: Block[],
 *   raw?: { provider: string, content: unknown },
 * }} Message
 *   `raw` holds the provider's exact assistant content (e.g. Claude's thinking
 *   blocks). The adapter that produced it sends it back unchanged, so
 *   provider-specific state survives the round trip; other adapters ignore it.
 *
 * @typedef {{ name: string, description: string, inputSchema: object }} ToolSpec
 *
 * @typedef {{ input: number, output: number, cacheRead: number, cacheWrite: number }} Usage
 *
 * @typedef {{
 *   content: Block[],
 *   stopReason: 'end' | 'tool_calls' | 'max_tokens' | 'refused',
 *   usage: Usage,
 *   raw?: { provider: string, content: unknown },
 * }} Turn
 *
 * @typedef {'low' | 'medium' | 'high'} Effort
 *
 * @typedef {{
 *   name: string,
 *   streamTurn(args: {
 *     system: string,
 *     messages: Message[],
 *     tools: ToolSpec[],
 *     effort?: Effort,
 *     signal?: AbortSignal,
 *   }): AsyncGenerator<{ type: 'text', delta: string }, Turn>,
 *   generateJson(args: {
 *     system: string,
 *     messages: Message[],
 *     schema: object,
 *     effort?: Effort,
 *     signal?: AbortSignal,
 *   }): Promise<{ data: any, text: string, usage: Usage, raw?: Message['raw'] }>,
 *   validateKey(): Promise<void>,
 * }} LLMProvider
 */

export class ProviderError extends Error {
  /** @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The API key is missing, invalid or revoked. */
export class InvalidKeyError extends ProviderError {}
/** The key hit its rate limit; retry later. */
export class RateLimitedError extends ProviderError {}
/** The provider is down or overloaded, or the network failed. */
export class ProviderDownError extends ProviderError {}
/** The model declined the request (safety), so there is no usable output. */
export class RefusedError extends ProviderError {}
/** The request was cancelled by the caller (AbortSignal). */
export class AbortedError extends ProviderError {}
/**
 * The model streamed a tool call whose input could not be parsed.
 * The turn is safe to re-issue.
 */
export class MalformedToolInputError extends ProviderError {}
