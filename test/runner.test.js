import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodeRunner } from '../src/runner/runner.js';

// These spawn real sandboxed Node processes — the security tests are the point.

const runner = new CodeRunner({ timeoutMs: 3000 });
const ADD = 'function add(a, b) { return a + b; }';

test('passing and failing tests are reported per test', async () => {
  const result = await runner.run({
    code: ADD,
    tests: [
      { name: 'adds', code: 'assert.equal(add(1, 2), 3);' },
      { name: 'wrong expectation', code: 'assert.equal(add(1, 2), 4);' },
    ],
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.passed, 1);
  assert.equal(result.total, 2);
  assert.equal(result.tests[1].passed, false);
  assert.match(result.tests[1].error, /AssertionError/);
});

test('async tests and console output', async () => {
  const result = await runner.run({
    code: 'const wait = (ms) => new Promise((r) => setTimeout(r, ms)); console.log("hello", { a: 1 });',
    tests: [{ name: 'awaits', code: 'await wait(20); assert.ok(true);' }],
  });
  assert.equal(result.passed, 1);
  assert.match(result.logs, /hello \{ a: 1 \}/);
});

test('every test gets a fresh copy of the code (no shared state)', async () => {
  const result = await runner.run({
    code: 'let count = 0; function inc() { return ++count; }',
    tests: [
      { name: 'first', code: 'assert.equal(inc(), 1);' },
      { name: 'second', code: 'assert.equal(inc(), 1);' },
    ],
  });
  assert.equal(result.passed, 2);
});

test('syntax errors are reported as compile_error', async () => {
  const result = await runner.run({ code: 'function (', tests: [{ name: 't', code: '' }] });
  assert.equal(result.status, 'compile_error');
  assert.match(result.error, /SyntaxError/);
});

test('an infinite loop is killed at the timeout', async () => {
  const fast = new CodeRunner({ timeoutMs: 1000 });
  const result = await fast.run({ code: 'while (true) {}', tests: [{ name: 't', code: '' }] });
  assert.equal(result.status, 'timeout');
  assert.equal(result.tests[0].passed, false);
});

test('a slow async test fails on its own without stopping the others', async () => {
  const result = await runner.run({
    code: '',
    tests: [
      { name: 'hangs', code: 'await new Promise(() => {});' },
      { name: 'fine', code: 'assert.ok(true);' },
    ],
  });
  assert.equal(result.status, 'ok');
  assert.match(result.tests[0].error, /timed out/);
  assert.equal(result.tests[1].passed, true);
});

test('a memory bomb hits the memory limit', async () => {
  const small = new CodeRunner({ timeoutMs: 10000, memoryMb: 64 });
  const result = await small.run({
    code: 'const keep = []; while (true) keep.push(new Array(1e5).fill({ x: 1 }));',
    tests: [{ name: 't', code: '' }],
  });
  assert.ok(['memory_limit', 'timeout'].includes(result.status), result.status);
});

test('sandbox: no file system, child processes, network or secrets', async () => {
  process.env.PREPPILOT_TEST_SECRET = 'should-not-leak';
  const result = await runner.run({
    code: '',
    tests: [
      { name: 'fs read', code: "await assert.rejects(async () => require('node:fs').readFileSync('/etc/hosts'));" },
      { name: 'require is not even defined', code: "assert.equal(typeof require, 'undefined');" },
      {
        name: 'process.mainModule escape',
        code: "const fs = process.getBuiltinModule('node:fs'); assert.throws(() => fs.readFileSync('/etc/hosts'), { code: 'ERR_ACCESS_DENIED' });",
      },
      {
        name: 'child_process',
        code: "const cp = process.getBuiltinModule('node:child_process'); assert.throws(() => cp.execSync('echo hi'), { code: 'ERR_ACCESS_DENIED' });",
      },
      {
        name: 'network',
        // net reports the denial through the socket's 'error' event, not a throw.
        code: `const net = process.getBuiltinModule('node:net');
          const err = await new Promise((resolve) => {
            const socket = net.connect(80, 'example.com', () => resolve(null));
            socket.on('error', resolve);
          });
          assert.equal(err?.code, 'ERR_ACCESS_DENIED');`,
      },
      { name: 'no secrets in env', code: 'assert.equal(process.env.PREPPILOT_TEST_SECRET, undefined);' },
    ],
  });
  delete process.env.PREPPILOT_TEST_SECRET;
  for (const t of result.tests) assert.ok(t.passed, `${t.name}: ${t.error}`);
});

test('printing to stdout cannot fake a passing result', async () => {
  const fake = JSON.stringify({ type: 'test', name: 'real', passed: true, ms: 0 });
  const result = await runner.run({
    code: `process.stdout.write(${JSON.stringify(`${fake}\n`)});`,
    tests: [{ name: 'real', code: 'assert.fail("nope");' }],
  });
  assert.equal(result.passed, 0);
});

test('errors thrown later from timers are logged, not fatal', async () => {
  const result = await runner.run({
    code: 'setTimeout(() => { throw new Error("late"); }, 0);',
    tests: [{ name: 'waits', code: 'await new Promise((r) => setTimeout(r, 30)); assert.ok(true);' }],
  });
  assert.equal(result.passed, 1);
  assert.match(result.logs, /Uncaught: Error: late/);
});

test('concurrency limit queues extra runs', async () => {
  const limited = new CodeRunner({ concurrency: 2, timeoutMs: 5000 });
  const job = { code: 'const t0 = Date.now(); while (Date.now() - t0 < 300) {}', tests: [{ name: 't', code: '' }] };
  const started = performance.now();
  const results = await Promise.all([1, 2, 3, 4].map(() => limited.run(job)));
  const elapsed = performance.now() - started;
  assert.ok(results.every((r) => r.status === 'ok'));
  assert.ok(elapsed >= 600, `4 runs of 300 ms with concurrency 2 took ${elapsed} ms`);
});

test('a run can be cancelled', async () => {
  const controller = new AbortController();
  const pending = runner.run({ code: 'while (true) {}', tests: [{ name: 't', code: '' }] }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  assert.equal((await pending).status, 'cancelled');
});

test('rejects oversized input before spawning', async () => {
  await assert.rejects(runner.run({ code: 'x'.repeat(100_001), tests: [] }), RangeError);
});
