/**
 * Decorator: wraps any provider and reports the token usage of every model
 * call. Usage gets counted wherever the provider is used (chat turns, the
 * grader inside a tool, the problem generator) without those modules
 * knowing about metering.
 *
 * @param {import('./provider.js').LLMProvider} provider
 * @param {(usage: import('./provider.js').Usage) => void} onUsage
 * @returns {import('./provider.js').LLMProvider}
 */
export function withMetering(provider, onUsage) {
  return {
    name: provider.name,
    async *streamTurn(args) {
      const turn = yield* provider.streamTurn(args);
      onUsage(turn.usage);
      return turn;
    },
    async generateJson(args) {
      const result = await provider.generateJson(args);
      onUsage(result.usage);
      return result;
    },
    validateKey: () => provider.validateKey(),
  };
}
