import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createBuildTools } from '../src/agent/tools.js';
import { CodeRunner } from '../src/runner/runner.js';
import { createApp } from '../src/server/app.js';
import { MemorySessionStore } from '../src/server/sessions.js';
import { openDatabase } from '../src/db/database.js';
import { ProblemStore } from '../src/problems/store.js';
import { ProgressStore } from '../src/progress/progress.js';
import { toRunnableFile } from '../web/runnable.js';
import { readSse } from '../web/sse.js';

const runner = new CodeRunner();
const kb = /** @type {any} */ ({ stats: {}, topics: () => [], search: () => [] });

const CODE = 'function clamp(x, lo, hi) { if (lo > hi) throw new RangeError("lo > hi"); return Math.min(hi, Math.max(lo, x)); }';
const TESTS = [
  { name: 'clamps high values', code: 'assert.equal(clamp(15, 0, 10), 10);' },
  { name: 'rejects lo > hi', code: 'assert.throws(() => clamp(1, 5, 0), RangeError);' },
];

test('run_code reports pass/fail per test for the model', async () => {
  const runCode = createBuildTools({ kb, runner }).find((t) => t.name === 'run_code');
  const output = await runCode.run({ code: CODE, tests: TESTS }, {});
  assert.match(output, /status: ok/);
  assert.match(output, /passed: 2\/2/);
  assert.equal(runCode.summarize({}, output), '2/2 tests passed');

  const failing = await runCode.run({ code: 'function clamp() { return 0; }', tests: TESTS }, {});
  assert.match(failing, /passed: 0\/2/);
  assert.match(failing, /FAIL clamps high values — AssertionError/);
});

test('run_code is limited per turn; a new turn gets a fresh budget', async () => {
  const runCode = createBuildTools({ kb, runner }).find((t) => t.name === 'run_code');
  const job = { code: 'const x = 1;', tests: [{ name: 't', code: 'assert.ok(true);' }] };
  for (let i = 0; i < 6; i++) await runCode.run(job, {});
  await assert.rejects(runCode.run(job, {}), /Run limit reached/);

  const nextTurn = createBuildTools({ kb, runner }).find((t) => t.name === 'run_code');
  assert.match(await nextTurn.run(job, {}), /passed: 1\/1/);
});

test('the downloadable file runs with plain `node` and its tests pass', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'preppilot-build-'));
  try {
    const file = path.join(dir, 'build.js');
    await writeFile(file, toRunnableFile(CODE, TESTS, 'clamp'));
    // Run it like a user would. Without clearing NODE_TEST_CONTEXT, a child of
    // `node --test` reports in node:test's binary IPC format instead of text.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const { stdout } = await promisify(execFile)(process.execPath, ['--test-reporter=tap', file], { env });
    assert.match(stdout, /# pass 2/);
    assert.match(stdout, /# fail 0/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- Build mode over HTTP ----------------------------------------------------

let server;
let baseUrl;
let seen;

before(async () => {
  seen = [];
  let step = 0;
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
  const provider = {
    name: 'fake',
    async *streamTurn(args) {
      seen.push({ system: args.system, tools: args.tools.map((t) => t.name), effort: args.effort });
      if (step++ === 0) {
        return {
          content: [{ type: 'tool_call', id: 'r1', name: 'run_code', input: { code: CODE, tests: TESTS } }],
          stopReason: 'tool_calls',
          usage,
        };
      }
      yield { type: 'text', delta: '5. Explain: done.' };
      return { content: [{ type: 'text', text: '5. Explain: done.' }], stopReason: 'end', usage };
    },
    async validateKey() {},
  };
  const db = openDatabase(':memory:');
  server = createServer(
    createApp({
      kb,
      provider: /** @type {any} */ (provider),
      sessions: new MemorySessionStore(),
      runner,
      problems: new ProblemStore(db),
      progress: new ProgressStore(db),
      interview: { rounds: [], rubric: '' },
      log: () => {},
    }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('build mode: build prompt, run_code tool, high effort, real sandbox run', async () => {
  const post = (url, body) =>
    fetch(baseUrl + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const { id } = await (await post('/api/sessions', { mode: 'build' })).json();

  const events = [];
  for await (const e of readSse((await post(`/api/sessions/${id}/messages`, { text: 'Build clamp(x, lo, hi)' })).body)) {
    events.push(e);
  }
  assert.match(seen[0].system, /Build mode/);
  assert.ok(seen[0].tools.includes('run_code'));
  assert.equal(seen[0].effort, 'high');
  const toolEnd = events.find((e) => e.event === 'tool_end');
  assert.equal(toolEnd.data.summary, '2/2 tests passed');
  assert.equal(events.at(-1).event, 'done');
});
