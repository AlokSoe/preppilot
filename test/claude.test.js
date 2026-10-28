import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import {
  ClaudeProvider,
  DEFAULT_CLAUDE_MODEL,
  fromClaudeMessage,
  toClaudeMessages,
  toProviderError,
} from '../src/llm/claude.js';
import {
  AbortedError,
  InvalidKeyError,
  MalformedToolInputError,
  ProviderDownError,
  RateLimitedError,
} from '../src/llm/provider.js';

/** A fake SDK client whose stream replays the given events and final message. */
function fakeClient({ events = [], message, error }) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        stream(params, options) {
          requests.push({ params, options });
          return {
            async *[Symbol.asyncIterator]() {
              for (const e of events) yield e;
              if (error) throw error;
            },
            finalMessage: async () => message,
          };
        },
      },
    },
  };
}

const CLAUDE_MESSAGE = {
  content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: 'Let me search.' },
    { type: 'tool_use', id: 'toolu_1', name: 'search_notes', input: { query: 'closure' } },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 },
};

async function drain(gen) {
  const deltas = [];
  for (;;) {
    const { value, done } = await gen.next();
    if (done) return { deltas, turn: value };
    deltas.push(value.delta);
  }
}

test('fromClaudeMessage maps blocks, stop reason and usage; keeps raw content', () => {
  const turn = fromClaudeMessage(CLAUDE_MESSAGE);
  assert.deepEqual(turn.content, [
    { type: 'text', text: 'Let me search.' },
    { type: 'tool_call', id: 'toolu_1', name: 'search_notes', input: { query: 'closure' } },
  ]);
  assert.equal(turn.stopReason, 'tool_calls');
  assert.deepEqual(turn.usage, { input: 100, output: 20, cacheRead: 80, cacheWrite: 0 });
  assert.equal(turn.raw.content, CLAUDE_MESSAGE.content); // thinking block preserved
});

test('stop reasons map to neutral values', () => {
  const stop = (stop_reason) => fromClaudeMessage({ content: [], stop_reason, usage: {} }).stopReason;
  assert.equal(stop('end_turn'), 'end');
  assert.equal(stop('max_tokens'), 'max_tokens');
  assert.equal(stop('refusal'), 'refused');
  assert.equal(stop('something_new'), 'end');
});

test('toClaudeMessages sends Claude-produced assistant turns back unchanged', () => {
  const turn = fromClaudeMessage(CLAUDE_MESSAGE);
  const [, assistant] = toClaudeMessages([
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: turn.content, raw: turn.raw },
  ]);
  assert.equal(assistant.content, CLAUDE_MESSAGE.content);
});

test('toClaudeMessages converts neutral blocks (e.g. from another provider)', () => {
  const converted = toClaudeMessages([
    { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'x', input: { a: 1 } }], raw: { provider: 'other', content: [] } },
    {
      role: 'user',
      content: [
        { type: 'tool_result', id: 'c1', output: 'ok' },
        { type: 'tool_result', id: 'c2', output: 'bad', isError: true },
      ],
    },
  ]);
  assert.deepEqual(converted[0].content, [{ type: 'tool_use', id: 'c1', name: 'x', input: { a: 1 } }]);
  assert.deepEqual(converted[1].content, [
    { type: 'tool_result', tool_use_id: 'c1', content: 'ok' },
    { type: 'tool_result', tool_use_id: 'c2', content: 'bad', is_error: true },
  ]);
});

test('streamTurn yields text deltas and returns the neutral turn', async () => {
  const client = fakeClient({
    events: [
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Let me ' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'search.' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"q' } },
    ],
    message: CLAUDE_MESSAGE,
  });
  const provider = new ClaudeProvider({ client: /** @type {any} */ (client) });
  const { deltas, turn } = await drain(
    provider.streamTurn({ system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] }),
  );
  assert.deepEqual(deltas, ['Let me ', 'search.']);
  assert.equal(turn.stopReason, 'tool_calls');
});

test('streamTurn builds the request: model, effort, caching, fallback, eager tool streaming, signal', async () => {
  const client = fakeClient({ message: { content: [], stop_reason: 'end_turn', usage: {} } });
  const provider = new ClaudeProvider({ client: /** @type {any} */ (client) });
  const controller = new AbortController();
  const tool = { name: 't', description: 'd', inputSchema: { type: 'object', properties: {} } };
  await drain(
    provider.streamTurn({
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [tool],
      effort: 'low',
      signal: controller.signal,
    }),
  );

  const [{ params, options }] = client.requests;
  assert.equal(params.model, DEFAULT_CLAUDE_MODEL);
  assert.equal(params.system, 'sys');
  assert.deepEqual(params.output_config, { effort: 'low' });
  assert.deepEqual(params.cache_control, { type: 'ephemeral' });
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
  assert.deepEqual(params.tools, [
    { name: 't', description: 'd', input_schema: tool.inputSchema, eager_input_streaming: true },
  ]);
  assert.equal(options.signal, controller.signal);
});

test('streamTurn maps SDK errors to neutral errors', async () => {
  const error = new Anthropic.AuthenticationError(401, { error: { message: 'bad key' } }, 'bad key', new Headers());
  const provider = new ClaudeProvider({ client: /** @type {any} */ (fakeClient({ error })) });
  await assert.rejects(drain(provider.streamTurn({ system: '', messages: [], tools: [] })), InvalidKeyError);
});

test('toProviderError: most specific SDK error wins', () => {
  const headers = new Headers();
  assert.ok(toProviderError(new Anthropic.RateLimitError(429, {}, 'slow down', headers)) instanceof RateLimitedError);
  assert.ok(toProviderError(new Anthropic.InternalServerError(529, {}, 'overloaded', headers)) instanceof ProviderDownError);
  assert.ok(toProviderError(new Anthropic.APIConnectionError({ message: 'offline' })) instanceof ProviderDownError);
  assert.ok(toProviderError(new Anthropic.APIUserAbortError()) instanceof AbortedError);
  assert.ok(
    toProviderError(new Anthropic.AnthropicError('Unable to parse tool parameter JSON from model.')) instanceof
      MalformedToolInputError,
  );
  // Missing credentials must not be mistaken for malformed tool input (and
  // retried), whichever error class the SDK wraps it in.
  for (const ErrorClass of [Error, Anthropic.AnthropicError]) {
    const err = toProviderError(new ErrorClass('Could not resolve authentication method. Expected one of apiKey'));
    assert.ok(err instanceof InvalidKeyError, `${ErrorClass.name} → ${err.constructor.name}`);
  }
  const otherSdkError = toProviderError(new Anthropic.AnthropicError('something else'));
  assert.ok(!(otherSdkError instanceof MalformedToolInputError));
  const other = new TypeError('bug');
  assert.equal(toProviderError(other), other);
});
