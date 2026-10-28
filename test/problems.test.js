import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db/database.js';
import { ProblemStore, publicProblem } from '../src/problems/store.js';
import { GenerationError, PROBLEM_SCHEMA, generateProblem, verify } from '../src/problems/generator.js';
import { publicResult } from '../src/problems/review.js';
import { CodeRunner } from '../src/runner/runner.js';
import { toApiSchema } from '../src/llm/claude.js';
import { createApp } from '../src/server/app.js';
import { MemorySessionStore } from '../src/server/sessions.js';
import { readSse } from '../web/sse.js';
import { ProgressStore } from '../src/progress/progress.js';

const runner = new CodeRunner();

/** A valid problem, as the model would return it. */
const CHUNK = {
  title: 'Chunk an array',
  statement: 'Implement `chunk(arr, size)` that splits an array into groups of `size`. Throw a RangeError if size < 1.',
  starterCode: '/** @param {any[]} arr @param {number} size */\nfunction chunk(arr, size) {\n  throw new Error("Not implemented");\n}',
  referenceSolution:
    'function chunk(arr, size) {\n  if (size < 1) throw new RangeError("size must be >= 1");\n  const out = [];\n  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));\n  return out;\n}',
  visibleTests: [
    { name: 'splits evenly', code: 'assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);' },
    { name: 'keeps the remainder', code: 'assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);' },
  ],
  hiddenTests: [
    { name: 'empty array', code: 'assert.deepEqual(chunk([], 3), []);' },
    { name: 'size larger than array', code: 'assert.deepEqual(chunk([1], 5), [[1]]);' },
    { name: 'rejects size 0', code: 'assert.throws(() => chunk([1], 0), RangeError);' },
  ],
};

function fakeProvider(responses) {
  const calls = [];
  return {
    name: 'fake',
    calls,
    async generateJson(args) {
      calls.push(structuredClone(args.messages));
      const data = responses.shift();
      return { data, text: JSON.stringify(data), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, raw: undefined };
    },
    async *streamTurn() {
      yield { type: 'text', delta: 'Looks good.' };
      return { content: [{ type: 'text', text: 'Looks good.' }], stopReason: 'end', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
    },
    async validateKey() {},
  };
}

test('migrations run once and the store round-trips problems', () => {
  const db = openDatabase(':memory:');
  const store = new ProblemStore(db);
  const saved = store.insert({ ...CHUNK, source: 'generated', topic: 'arrays', difficulty: 'easy' });
  assert.deepEqual(store.get(saved.id), saved);
  assert.deepEqual(store.titles('arrays'), ['Chunk an array']);
  assert.equal(store.list({ topic: 'other' }).length, 0);
});

test('publicProblem hides the solution and hidden tests', () => {
  const store = new ProblemStore(openDatabase(':memory:'));
  const view = publicProblem(store.insert({ ...CHUNK, source: 'generated', topic: 'arrays', difficulty: 'easy' }));
  assert.equal('referenceSolution' in view, false);
  assert.equal('hiddenTests' in view, false);
  assert.equal(view.hiddenTestCount, 3);
});

test('toApiSchema strips unsupported constraints but keeps property names', () => {
  const api = toApiSchema({
    type: 'object',
    properties: { minimum: { type: 'string', minLength: 1 }, list: { type: 'array', items: { type: 'integer', maximum: 3 }, minItems: 2 } },
    required: ['minimum'],
    additionalProperties: false,
  });
  assert.deepEqual(api, {
    type: 'object',
    properties: { minimum: { type: 'string' }, list: { type: 'array', items: { type: 'integer' } } },
    required: ['minimum'],
    additionalProperties: false,
  });
  // The real problem schema converts without leftovers.
  assert.doesNotMatch(JSON.stringify(toApiSchema(PROBLEM_SCHEMA)), /minLength|minItems|maxLength/);
});

test('verify accepts a correct problem', async () => {
  assert.equal(await verify(runner, CHUNK), null);
});

test('verify rejects a wrong reference solution and tests that check nothing', async () => {
  const broken = { ...CHUNK, referenceSolution: 'function chunk(arr) { return [arr]; }' };
  assert.match(await verify(runner, broken), /reference solution does not pass/);

  const toothless = {
    ...CHUNK,
    starterCode: 'function chunk() {}',
    visibleTests: [{ name: 'a', code: 'assert.ok(true);' }],
    hiddenTests: [{ name: 'b', code: 'assert.ok(true);' }],
  };
  assert.match(await verify(runner, toothless), /tests check nothing/);
});

test('generateProblem retries with feedback until the problem verifies, then saves it', async () => {
  const store = new ProblemStore(openDatabase(':memory:'));
  const broken = { ...CHUNK, referenceSolution: 'function chunk() { return []; }' };
  const provider = fakeProvider([broken, CHUNK]);
  const stages = [];

  const problem = await generateProblem({
    provider: /** @type {any} */ (provider),
    runner,
    store,
    topic: 'arrays',
    difficulty: 'easy',
    onProgress: (e) => stages.push(e.stage),
  });

  assert.equal(problem.title, 'Chunk an array');
  assert.ok(store.get(problem.id));
  assert.deepEqual(stages, ['generating', 'verifying', 'fixing', 'verifying']);
  // The second request contained the failing test output as feedback.
  assert.match(provider.calls[1].at(-1).content[0].text, /reference solution does not pass/);
});

test('generateProblem gives up after 3 failed attempts', async () => {
  const store = new ProblemStore(openDatabase(':memory:'));
  const bad = { ...CHUNK, visibleTests: [] }; // fails the schema (minItems)
  await assert.rejects(
    generateProblem({ provider: /** @type {any} */ (fakeProvider([bad, bad, bad])), runner, store, topic: 'arrays', difficulty: 'easy' }),
    GenerationError,
  );
  assert.equal(store.list().length, 0);
});

test('publicResult hides error details of hidden tests', () => {
  const problem = /** @type {any} */ ({ hiddenTests: [{ name: 'secret', code: '' }] });
  const view = publicResult(problem, /** @type {any} */ ({
    status: 'ok',
    tests: [
      { name: 'visible', passed: false, error: 'expected 3', ms: 1 },
      { name: 'secret', passed: false, error: 'expected [[1]]', ms: 1 },
    ],
  }));
  assert.equal(view.tests[0].error, 'expected 3');
  assert.deepEqual(view.tests[1], { name: 'secret', passed: false, hidden: true, ms: 1 });
});

// ---- HTTP endpoints -------------------------------------------------------

let server;
let baseUrl;
let store;

before(async () => {
  store = new ProblemStore(openDatabase(':memory:'));
  const handler = createApp({
    kb: /** @type {any} */ ({ stats: {}, topics: () => [], search: () => [] }),
    provider: /** @type {any} */ (fakeProvider([CHUNK])),
    sessions: new MemorySessionStore(),
    runner,
    problems: store,
    progress: new ProgressStore(openDatabase(':memory:')),
    interview: { rounds: [], rubric: '' },
    log: () => {},
  });
  server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const post = (url, body) =>
  fetch(baseUrl + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function events(res) {
  const out = [];
  for await (const e of readSse(res.body)) out.push(e);
  return out;
}

test('POST /api/problems streams progress, then the public problem', async () => {
  const stream = await events(await post('/api/problems', { topic: 'Arrays', difficulty: 'easy' }));
  const problem = stream.at(-1);
  assert.equal(problem.event, 'problem');
  assert.equal(problem.data.topic, 'arrays');
  assert.equal(problem.data.referenceSolution, undefined);
  assert.ok(stream.some((e) => e.event === 'progress' && e.data.stage === 'verifying'));

  const list = await (await fetch(`${baseUrl}/api/problems?topic=arrays`)).json();
  assert.equal(list.problems[0].id, problem.data.id);
});

test('topic and difficulty are validated', async () => {
  assert.equal((await post('/api/problems', { topic: '../etc', difficulty: 'easy' })).status, 400);
  assert.equal((await post('/api/problems', { topic: 'arrays', difficulty: 'insane' })).status, 400);
});

test('run checks visible tests only; submit runs all tests then streams a review', async () => {
  const problem = store.insert({ ...CHUNK, source: 'generated', topic: 'arrays', difficulty: 'easy' });

  const run = await (await post(`/api/problems/${problem.id}/run`, { code: CHUNK.referenceSolution })).json();
  assert.equal(run.total, 2);
  assert.equal(run.passed, 2);

  // This solution passes the visible tests but forgets the RangeError.
  const almost = 'function chunk(arr, size) { const o = []; for (let i = 0; i < arr.length; i += size) o.push(arr.slice(i, i + size)); return o; }';
  const stream = await events(await post(`/api/problems/${problem.id}/submit`, { code: almost }));
  const result = stream.find((e) => e.event === 'result').data;
  assert.equal(result.total, 5);
  assert.equal(result.passed, 4);
  const failed = result.tests.find((t) => !t.passed);
  assert.equal(failed.hidden, true);
  assert.equal(failed.error, undefined);
  assert.ok(stream.some((e) => e.event === 'text'));
  assert.equal(stream.at(-1).event, 'done');
});

test('unknown problem → 404', async () => {
  assert.equal((await post('/api/problems/nope/run', { code: 'x' })).status, 404);
});
