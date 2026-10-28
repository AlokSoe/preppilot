'use strict';
/**
 * Runs INSIDE the sandboxed child process (see runner.js). Passed to
 * `node --permission -e`, so the child never needs to read a file.
 *
 * Protocol:
 *   stdin  ← JSON { code, tests: [{ name, code }] }
 *   fd 3   → NDJSON, one line per finished test, then a final line:
 *            { type: 'test', name, passed, error?, ms }
 *            { type: 'done', status: 'ok' | 'compile_error', error?, logs }
 * stdout/stderr are left to the user's code. Results go over a separate pipe
 * so printing to stdout can't fake a passing result.
 *
 * Each test runs the user's code fresh, followed by the test body, inside an
 * async function with `assert` (node:assert/strict) and a capturing `console`.
 */
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { inspect } = require('node:util');

// `node -e` exposes require/module/exports as globals. The harness has what it
// needs, so hide them from user code (defence in depth: the permission model
// already blocks what they could load).
for (const name of ['require', 'module', 'exports', '__filename', '__dirname']) delete globalThis[name];

const AsyncFunction = (async () => {}).constructor;
const TEST_TIMEOUT_MS = 2000;
const MAX_LOG_CHARS = 16 * 1024;
const MAX_ERROR_CHARS = 2000;

let logs = '';
function record(...args) {
  if (logs.length >= MAX_LOG_CHARS) return;
  logs += `${args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 4 }))).join(' ')}\n`;
  if (logs.length >= MAX_LOG_CHARS) logs = `${logs.slice(0, MAX_LOG_CHARS)}\n[logs truncated]\n`;
}
const sandboxConsole = { log: record, info: record, warn: record, error: record, debug: record };

// Errors thrown later from timers or unawaited promises shouldn't kill the run.
process.on('uncaughtException', (err) => record(`Uncaught: ${formatError(err)}`));
process.on('unhandledRejection', (err) => record(`Unhandled rejection: ${formatError(err)}`));

function emit(message) {
  fs.writeSync(3, `${JSON.stringify(message)}\n`);
}

function formatError(err) {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : `Thrown value: ${inspect(err)}`;
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Test timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { code, tests } = JSON.parse(input);

  try {
    new AsyncFunction('assert', 'console', code); // syntax check only
  } catch (err) {
    emit({ type: 'done', status: 'compile_error', error: formatError(err), logs });
    process.exit(0);
  }

  for (const test of tests) {
    const started = performance.now();
    try {
      const run = new AsyncFunction('assert', 'console', `${code}\n;\n${test.code}`);
      await withTimeout(run(assert, sandboxConsole), TEST_TIMEOUT_MS);
      emit({ type: 'test', name: test.name, passed: true, ms: Math.round(performance.now() - started) });
    } catch (err) {
      emit({
        type: 'test',
        name: test.name,
        passed: false,
        error: formatError(err),
        ms: Math.round(performance.now() - started),
      });
    }
  }
  emit({ type: 'done', status: 'ok', logs });
  process.exit(0); // don't wait for timers the user's code left running
}

main().catch((err) => {
  emit({ type: 'done', status: 'crashed', error: formatError(err), logs });
  process.exit(1);
});
