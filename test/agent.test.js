import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentTurn } from '../src/agent/agent.js';
import { MalformedToolInputError, InvalidKeyError } from '../src/llm/provider.js';

const USAGE = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 };

/**
 * A provider that replays scripted turns and records what it was sent.
 * Each script entry is a Turn plus optional `deltas`, or an Error to throw.
 */
function fakeProvider(script) {
  const calls = [];
  return {
    name: 'fake',
    calls,
    async *streamTurn(args) {
      calls.push({ ...args, messages: structuredClone(args.messages) });
      const step = script.shift();
      if (!step) throw new Error('fake provider: script exhausted');
      if (step instanceof Error) throw step;
      for (const delta of step.deltas ?? []) yield { type: 'text', delta };
      return { usage: USAGE, raw: { provider: 'fake', content: step.content }, ...step };
    },
    async validateKey() {},
  };
}

const text = (t) => ({ type: 'text', text: t });
const call = (id, name, input) => ({ type: 'tool_call', id, name, input });

function echoTool(overrides = {}) {
  return {
    name: 'echo',
    description: 'echo',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    run: ({ value }) => `echo:${value}`,
    ...overrides,
  };
}

function run(provider, overrides = {}) {
  const events = [];
  const messages = [];
  const promise = runAgentTurn({
    provider,
    system: 'sys',
    messages,
    userText: 'hello',
    tools: [echoTool()],
    onEvent: (e) => events.push(e),
    ...overrides,
  });
  return { promise, events, messages };
}

test('plain answer: streams text and appends user + assistant messages', async () => {
  const provider = fakeProvider([{ content: [text('Hi there')], stopReason: 'end', deltas: ['Hi ', 'there'] }]);
  const { promise, events, messages } = run(provider);
  const result = await promise;

  assert.equal(result.status, 'done');
  assert.equal(result.text, 'Hi there');
  assert.deepEqual(events, [{ type: 'text', delta: 'Hi ' }, { type: 'text', delta: 'there' }]);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']);
  assert.deepEqual(messages[1].raw, { provider: 'fake', content: [text('Hi there')] });
});

test('tool loop: runs the tool, sends the result back, then answers', async () => {
  const provider = fakeProvider([
    { content: [call('t1', 'echo', { value: 'a' })], stopReason: 'tool_calls' },
    { content: [text('done')], stopReason: 'end' },
  ]);
  const { promise, events, messages } = run(provider);
  const result = await promise;

  assert.equal(result.status, 'done');
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(messages[2].content, [{ type: 'tool_result', id: 't1', output: 'echo:a' }]);
  assert.deepEqual(
    events.map((e) => e.type),
    ['tool_start', 'tool_end'],
  );
  // The second request saw the tool result.
  assert.equal(provider.calls[1].messages.at(-1).content[0].output, 'echo:a');
});

test('parallel tool calls run concurrently and return in ONE message, in call order', async () => {
  let running = 0;
  let maxRunning = 0;
  const slowEcho = echoTool({
    run: async ({ value }) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, value === 'slow' ? 20 : 1));
      running--;
      return `echo:${value}`;
    },
  });
  const provider = fakeProvider([
    { content: [call('a', 'echo', { value: 'slow' }), call('b', 'echo', { value: 'fast' })], stopReason: 'tool_calls' },
    { content: [text('ok')], stopReason: 'end' },
  ]);
  const { promise, messages } = run(provider, { tools: [slowEcho] });
  await promise;

  assert.equal(maxRunning, 2);
  assert.deepEqual(
    messages[2].content.map((b) => [b.id, b.output]),
    [['a', 'echo:slow'], ['b', 'echo:fast']],
  );
});

test('invalid tool input is not run; the model gets an error result', async () => {
  let ran = false;
  const provider = fakeProvider([
    { content: [call('t1', 'echo', { value: 42 })], stopReason: 'tool_calls' },
    { content: [text('sorry')], stopReason: 'end' },
  ]);
  const { promise, messages, events } = run(provider, { tools: [echoTool({ run: () => (ran = true) })] });
  await promise;

  assert.equal(ran, false);
  const [result] = messages[2].content;
  assert.equal(result.isError, true);
  assert.match(result.output, /input\.value must be string/);
  assert.equal(events.find((e) => e.type === 'tool_end').ok, false);
});

test('unknown tool and throwing tool become error results, not crashes', async () => {
  const provider = fakeProvider([
    { content: [call('t1', 'nope', {}), call('t2', 'echo', { value: 'x' })], stopReason: 'tool_calls' },
    { content: [text('ok')], stopReason: 'end' },
  ]);
  const throwing = echoTool({
    run: () => {
      throw new Error('boom');
    },
  });
  const { promise, messages } = run(provider, { tools: [throwing] });
  const result = await promise;

  assert.equal(result.status, 'done');
  const [unknown, failed] = messages[2].content;
  assert.match(unknown.output, /Unknown tool "nope"/);
  assert.match(failed.output, /Tool failed: boom/);
  assert.ok(unknown.isError && failed.isError);
});

test('long tool output is truncated', async () => {
  const provider = fakeProvider([
    { content: [call('t1', 'echo', { value: 'x' })], stopReason: 'tool_calls' },
    { content: [text('ok')], stopReason: 'end' },
  ]);
  const { promise, messages } = run(provider, { tools: [echoTool({ run: () => 'y'.repeat(50_000) })] });
  await promise;
  assert.match(messages[2].content[0].output, /\[output truncated at 20000 characters\]$/);
});

test('refusal: nothing is appended after the user message and no tools run', async () => {
  let ran = false;
  const provider = fakeProvider([
    { content: [text('partial'), call('t1', 'echo', { value: 'a' })], stopReason: 'refused' },
  ]);
  const { promise, messages } = run(provider, { tools: [echoTool({ run: () => (ran = true) })] });
  const result = await promise;

  assert.equal(result.status, 'refused');
  assert.equal(ran, false);
  assert.deepEqual(messages.map((m) => m.role), ['user']);
});

test('max_tokens with a tool call does not run the (possibly truncated) tool', async () => {
  let ran = false;
  const provider = fakeProvider([{ content: [call('t1', 'echo', { value: 'a' })], stopReason: 'max_tokens' }]);
  const { promise } = run(provider, { tools: [echoTool({ run: () => (ran = true) })] });
  assert.equal((await promise).status, 'truncated');
  assert.equal(ran, false);
});

test('iteration cap stops a model that never stops calling tools', async () => {
  const loops = Array.from({ length: 3 }, (_, i) => ({
    content: [call(`t${i}`, 'echo', { value: 'again' })],
    stopReason: 'tool_calls',
  }));
  const { promise } = run(fakeProvider(loops), { maxIterations: 3 });
  assert.equal((await promise).status, 'iteration_limit');
});

test('malformed tool input from the stream is re-issued, at most twice', async () => {
  const provider = fakeProvider([
    new MalformedToolInputError('bad json'),
    { content: [text('ok')], stopReason: 'end' },
  ]);
  const { promise, events } = run(provider);
  assert.equal((await promise).status, 'done');
  assert.equal(events.filter((e) => e.type === 'retry').length, 1);

  const alwaysBad = fakeProvider([1, 2, 3].map(() => new MalformedToolInputError('bad json')));
  await assert.rejects(run(alwaysBad).promise, MalformedToolInputError);
  assert.equal(alwaysBad.calls.length, 3);
});

test('provider errors like an invalid key are not retried', async () => {
  const provider = fakeProvider([new InvalidKeyError('bad key')]);
  await assert.rejects(run(provider).promise, InvalidKeyError);
  assert.equal(provider.calls.length, 1);
});

test('usage is summed across iterations', async () => {
  const provider = fakeProvider([
    { content: [call('t1', 'echo', { value: 'a' })], stopReason: 'tool_calls' },
    { content: [text('ok')], stopReason: 'end' },
  ]);
  const { usage } = await run(provider).promise;
  assert.deepEqual(usage, { input: 20, output: 10, cacheRead: 4, cacheWrite: 2 });
});

test('history is append-only across turns (earlier messages never change)', async () => {
  const provider = fakeProvider([
    { content: [call('t1', 'echo', { value: 'a' })], stopReason: 'tool_calls' },
    { content: [text('first')], stopReason: 'end' },
    { content: [text('second')], stopReason: 'end' },
  ]);
  const messages = [];
  const base = { provider, system: 'sys', messages, tools: [echoTool()] };
  await runAgentTurn({ ...base, userText: 'one' });
  const snapshot = structuredClone(messages);
  await runAgentTurn({ ...base, userText: 'two' });

  assert.deepEqual(messages.slice(0, snapshot.length), snapshot);
  assert.deepEqual(provider.calls[2].messages.slice(0, snapshot.length), snapshot);
});
