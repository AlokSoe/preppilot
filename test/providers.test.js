import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { ClaudeProvider } from '../src/llm/claude.js';
import { OpenAICompatibleProvider, toOpenAIMessages } from '../src/llm/openai.js';
import { PROVIDERS, createProvider } from '../src/llm/index.js';
import { InvalidKeyError, MalformedToolInputError, RateLimitedError, RefusedError } from '../src/llm/provider.js';
import { runAgentTurn } from '../src/agent/agent.js';

// One contract every adapter must meet, run against each provider with a fake
// SDK client that speaks that provider's wire format. No network.

const TOOL = {
  name: 'search_notes',
  description: 'search',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
};

// ---- Fake clients: each scripted with two turns (tool call, then answer) ----

function fakeAnthropic() {
  const requests = [];
  const turns = [
    {
      events: [],
      message: {
        content: [{ type: 'tool_use', id: 'call_1', name: 'search_notes', input: { query: 'closure' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      events: ['A closure ', 'remembers.'].map((text) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } })),
      message: {
        content: [{ type: 'text', text: 'A closure remembers.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 7 },
      },
    },
  ];
  return {
    requests,
    models: { list: async () => ({ data: [] }) },
    beta: {
      messages: {
        stream(params) {
          requests.push(structuredClone(params));
          const turn = turns.shift();
          return {
            async *[Symbol.asyncIterator]() {
              yield* turn.events;
            },
            finalMessage: async () => turn.message,
          };
        },
      },
    },
  };
}

function fakeOpenAI({ toolArgs = ['{"query":', '"closure"}'] } = {}) {
  const requests = [];
  const chunk = (delta, finish = null, usage = undefined) => ({ choices: [{ index: 0, delta, finish_reason: finish }], usage });
  const turns = [
    [
      chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search_notes', arguments: toolArgs[0] } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: toolArgs[1] } }] }),
      chunk({}, 'tool_calls'),
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ],
    [
      chunk({ content: 'A closure ' }),
      chunk({ content: 'remembers.' }),
      chunk({}, 'stop'),
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 0 } } },
    ],
  ];
  return {
    requests,
    chat: {
      completions: {
        async create(params) {
          requests.push(structuredClone(params));
          const chunks = turns.shift();
          return (async function* () {
            yield* chunks;
          })();
        },
      },
    },
    models: { list: async () => ({ data: [] }) },
  };
}

const ADAPTERS = {
  claude: () => {
    const client = fakeAnthropic();
    return { client, provider: new ClaudeProvider({ client: /** @type {any} */ (client) }) };
  },
  openai: () => {
    const client = fakeOpenAI();
    return { client, provider: new OpenAICompatibleProvider({ name: 'openai', model: 'm', client: /** @type {any} */ (client) }) };
  },
};

for (const [name, make] of Object.entries(ADAPTERS)) {
  describe(`provider contract: ${name}`, () => {
    test('a full agent turn: tool call round trip, streamed answer, summed usage', async () => {
      const { provider } = make();
      const events = [];
      const messages = [];
      const result = await runAgentTurn({
        provider,
        system: 'sys',
        messages,
        userText: 'what is a closure?',
        tools: [{ ...TOOL, run: ({ query }) => `notes about ${query}` }],
        onEvent: (e) => events.push(e),
      });

      assert.equal(result.status, 'done');
      assert.equal(result.text, 'A closure remembers.');
      assert.deepEqual(
        events.filter((e) => e.type === 'text').map((e) => e.delta),
        ['A closure ', 'remembers.'],
      );
      assert.deepEqual(messages[1].content, [{ type: 'tool_call', id: 'call_1', name: 'search_notes', input: { query: 'closure' } }]);
      assert.deepEqual(messages[2].content, [{ type: 'tool_result', id: 'call_1', output: 'notes about closure' }]);
      assert.equal(result.usage.input, 30);
      assert.equal(result.usage.output, 12);
    });

    test('validateKey succeeds with a working client', async () => {
      await make().provider.validateKey();
    });
  });
}

// ---- OpenAI-specific mapping ------------------------------------------------------

test('OpenAI: second request carries the assistant tool call and a role:"tool" result', async () => {
  const { client, provider } = ADAPTERS.openai();
  await runAgentTurn({
    provider,
    system: 'sys',
    messages: [],
    userText: 'q',
    tools: [{ ...TOOL, run: () => 'result' }],
  });
  const second = client.requests[1];
  assert.deepEqual(second.messages.slice(0, 2), [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }]);
  assert.deepEqual(second.messages[2], {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_notes', arguments: '{"query":"closure"}' } }],
  });
  assert.deepEqual(second.messages[3], { role: 'tool', tool_call_id: 'call_1', content: 'result' });
  assert.deepEqual(second.tools, [{ type: 'function', function: { name: 'search_notes', description: 'search', parameters: TOOL.inputSchema } }]);
  assert.equal(second.reasoning_effort, 'medium');
  assert.deepEqual(second.stream_options, { include_usage: true });
});

test('OpenAI: hidden context blocks and error tool results are converted', () => {
  const out = toOpenAIMessages('', [
    { role: 'user', content: [{ type: 'text', text: 'briefing', hidden: true }, { type: 'text', text: 'start' }] },
    { role: 'user', content: [{ type: 'tool_result', id: 'c', output: 'boom', isError: true }] },
  ]);
  assert.deepEqual(out, [
    { role: 'user', content: 'briefing\n\nstart' },
    { role: 'tool', tool_call_id: 'c', content: 'Error: boom' },
  ]);
});

test('OpenAI: unparseable tool arguments → MalformedToolInputError (the agent retries)', async () => {
  const client = fakeOpenAI({ toolArgs: ['{"query":', ' oops'] });
  const provider = new OpenAICompatibleProvider({ name: 'openai', model: 'm', client: /** @type {any} */ (client) });
  const gen = provider.streamTurn({ system: '', messages: [], tools: [TOOL] });
  await assert.rejects(async () => {
    for (;;) if ((await gen.next()).done) break;
  }, MalformedToolInputError);
});

test('OpenAI: generateJson uses strict json_schema and handles refusals', async () => {
  const requests = [];
  const reply = (message, finish_reason = 'stop') => ({
    choices: [{ message, finish_reason }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  });
  const responses = [reply({ content: '{"score":7}' }), reply({ content: null, refusal: 'no' })];
  const client = {
    chat: {
      completions: {
        create: async (params) => {
          requests.push(params);
          return responses.shift();
        },
      },
    },
  };
  const provider = new OpenAICompatibleProvider({ name: 'openai', model: 'm', client: /** @type {any} */ (client) });
  const schema = { type: 'object', properties: { score: { type: 'integer', minimum: 1 } }, required: ['score'], additionalProperties: false };
  const { data } = await provider.generateJson({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], schema });
  assert.deepEqual(data, { score: 7 });
  assert.equal(requests[0].response_format.json_schema.strict, true);
  assert.equal(requests[0].response_format.json_schema.schema.properties.score.minimum, undefined, 'unsupported keywords stripped');
  await assert.rejects(provider.generateJson({ system: 's', messages: [], schema }), RefusedError);
});

test('OpenAI: SDK errors map to neutral errors', async () => {
  const failing = (error) =>
    new OpenAICompatibleProvider({
      name: 'openai',
      model: 'm',
      client: /** @type {any} */ ({ models: { list: async () => Promise.reject(error) } }),
    });
  const headers = new Headers();
  await assert.rejects(failing(new OpenAI.AuthenticationError(401, {}, 'bad', headers)).validateKey(), InvalidKeyError);
  await assert.rejects(failing(new OpenAI.RateLimitError(429, {}, 'slow', headers)).validateKey(), RateLimitedError);
});

test('factory: every listed provider can be created', () => {
  for (const name of PROVIDERS) assert.equal(createProvider({ provider: name, apiKey: 'test-key-0123456789' }).name, name);
  assert.throws(() => createProvider({ provider: 'nope' }), /Unknown provider/);
});

test('PREPPILOT_PROVIDER picks the local default provider; its own key decides availability', async () => {
  const { defaultProvider, hasDefaultKey } = await import('../src/llm/index.js');
  const saved = { ...process.env };
  try {
    delete process.env.PREPPILOT_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(defaultProvider().name, 'claude');
    assert.equal(hasDefaultKey(), false);

    process.env.PREPPILOT_PROVIDER = 'gemini';
    delete process.env.GEMINI_API_KEY;
    // No key: a clear error naming the right variable, not a crash at construction.
    await assert.rejects(defaultProvider().validateKey(), /Set GEMINI_API_KEY/);
    process.env.GEMINI_API_KEY = 'test-key-0123456789';
    assert.equal(defaultProvider().name, 'gemini');
    assert.equal(hasDefaultKey(), true);

    process.env.PREPPILOT_PROVIDER = 'openai';
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1';
    process.env.OPENAI_API_KEY = 'ollama';
    const local = defaultProvider();
    assert.equal(local.client.baseURL, 'http://localhost:11434/v1');
    assert.equal(local.sendEffort, false, 'no OpenAI-only parameters to other servers');

    process.env.PREPPILOT_PROVIDER = 'nope';
    assert.throws(() => defaultProvider(), /PREPPILOT_PROVIDER/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('Gemini: a bad key comes back as HTTP 400, still mapped to InvalidKeyError', async () => {
  // The body Google's endpoint actually returns (seen in a live check).
  const body = { error: { code: 400, message: 'Please pass a valid API key', status: 'INVALID_ARGUMENT' } };
  const error = new OpenAI.BadRequestError(400, body.error, undefined, new Headers());
  const provider = new OpenAICompatibleProvider({
    name: 'gemini',
    model: 'm',
    client: /** @type {any} */ ({ models: { list: async () => Promise.reject(error) } }),
  });
  await assert.rejects(provider.validateKey(), InvalidKeyError);
});

test('Gemini quirks: tool call without index, finish_reason "stop", thought signature echoed back', async () => {
  const requests = [];
  const turns = [
    [
      {
        choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ id: 'call_9', type: 'function', extra_content: { google: { thought_signature: 'SIG' } }, function: { name: 'search_notes', arguments: '{"query":"closure"}' } }] } }],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
    ],
    [
      { choices: [{ index: 0, delta: { content: 'Done.' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 2 } },
    ],
  ];
  const client = {
    chat: {
      completions: {
        async create(params) {
          requests.push(structuredClone(params));
          const chunks = turns.shift();
          return (async function* () {
            yield* chunks;
          })();
        },
      },
    },
  };
  const provider = new OpenAICompatibleProvider({ name: 'gemini', model: 'm', sendEffort: false, client: /** @type {any} */ (client) });
  const result = await runAgentTurn({
    provider,
    system: 's',
    messages: [],
    userText: 'q',
    tools: [{ ...TOOL, run: () => 'notes' }],
  });
  assert.equal(result.status, 'done');
  assert.equal(result.text, 'Done.');
  const echoed = requests[1].messages.find((m) => m.role === 'assistant');
  assert.deepEqual(echoed.tool_calls[0].extra_content, { google: { thought_signature: 'SIG' } });
  assert.equal(requests[1].reasoning_effort, undefined);
});
