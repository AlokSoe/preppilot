import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server/app.js';
import { MemorySessionStore } from '../src/server/sessions.js';
import { CodeRunner } from '../src/runner/runner.js';
import { ProblemStore } from '../src/problems/store.js';
import { openDatabase } from '../src/db/database.js';
import { AbortedError, InvalidKeyError } from '../src/llm/provider.js';
import { readSse } from '../web/sse.js';

// Integration test: the real HTTP server on a random port, a fake provider,
// and a stub knowledge base. No network beyond localhost, no API key.

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');

const kb = /** @type {any} */ ({
  stats: { files: 1, chunks: 1, buildMs: 0 },
  topics: () => ['closures'],
  search: () => [{ repo: 'notes', path: 'a.md', heading: 'Closures', topic: 'closures', text: 'A closure...' }],
});

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

/** The behaviour for the next call to streamTurn, set per test. */
let script;

const provider = {
  name: 'fake',
  async *streamTurn(args) {
    // `yield*` evaluates to the delegate's return value (the Turn); pass it on.
    return yield* script(args);
  },
  async validateKey() {},
};

let server;
let baseUrl;

before(async () => {
  const handler = createApp({
    kb,
    provider,
    sessions: new MemorySessionStore(),
    runner: new CodeRunner(),
    problems: new ProblemStore(openDatabase(':memory:')),
    staticDir: WEB_DIR,
    log: () => {},
  });
  server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const post = (url, body, headers = { 'Content-Type': 'application/json' }) =>
  fetch(baseUrl + url, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

async function newSession() {
  const res = await post('/api/sessions', {});
  assert.equal(res.status, 201);
  return (await res.json()).id;
}

async function collect(res) {
  const events = [];
  for await (const event of readSse(res.body)) events.push(event);
  return events;
}

test('health and readiness', async () => {
  assert.deepEqual(await (await fetch(`${baseUrl}/healthz`)).json(), { ok: true });
  assert.equal((await (await fetch(`${baseUrl}/readyz`)).json()).chunks, 1);
});

test('a message streams tool activity, text and done over SSE', async () => {
  let step = 0;
  script = async function* () {
    if (step++ === 0) {
      return {
        content: [{ type: 'tool_call', id: 't1', name: 'search_notes', input: { query: 'closure' } }],
        stopReason: 'tool_calls',
        usage,
      };
    }
    yield { type: 'text', delta: 'A closure ' };
    yield { type: 'text', delta: 'remembers.' };
    return { content: [{ type: 'text', text: 'A closure remembers.' }], stopReason: 'end', usage };
  };

  const id = await newSession();
  const res = await post(`/api/sessions/${id}/messages`, { text: 'what is a closure?' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const events = await collect(res);
  assert.deepEqual(
    events.map((e) => e.event),
    ['tool_start', 'tool_end', 'text', 'text', 'done'],
  );
  assert.equal(events[1].data.summary, '1 results');
  assert.deepEqual(events.at(-1).data, { status: 'done', usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 } });

  // History endpoint shows the conversation without tool results.
  const history = await (await fetch(`${baseUrl}/api/sessions/${id}`)).json();
  assert.deepEqual(history.messages, [
    { role: 'user', text: 'what is a closure?' },
    { role: 'assistant', text: 'A closure remembers.', tools: [{ name: 'search_notes', input: { query: 'closure' } }] },
  ]);
});

test('provider errors become an SSE error event with a stable code', async () => {
  script = async function* () {
    throw new InvalidKeyError('Your Anthropic API key is invalid or revoked.');
  };
  const id = await newSession();
  const events = await collect(await post(`/api/sessions/${id}/messages`, { text: 'hi' }));
  assert.deepEqual(events, [
    { event: 'error', data: { code: 'invalid_key', message: 'Your Anthropic API key is invalid or revoked.' } },
  ]);
});

test('unexpected errors do not leak details to the client', async () => {
  script = async function* () {
    throw new TypeError('secret internal detail');
  };
  const id = await newSession();
  const events = await collect(await post(`/api/sessions/${id}/messages`, { text: 'hi' }));
  assert.equal(events[0].data.code, 'internal');
  assert.doesNotMatch(JSON.stringify(events), /secret internal detail/);
});

test('a second message while one is streaming gets 409; closing the client aborts the model call', async () => {
  let signalSeen;
  let started;
  const startedPromise = new Promise((resolve) => (started = resolve));
  const abortedPromise = new Promise((resolve) => {
    script = async function* ({ signal }) {
      signalSeen = signal;
      started();
      yield { type: 'text', delta: 'thinking…' };
      await new Promise((_, reject) =>
        signal.addEventListener('abort', () => {
          resolve(undefined);
          reject(new AbortedError('cancelled'));
        }),
      );
    };
  });

  const id = await newSession();
  const controller = new AbortController();
  const first = await fetch(`${baseUrl}/api/sessions/${id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'long question' }),
    signal: controller.signal,
  });
  await startedPromise;

  const second = await post(`/api/sessions/${id}/messages`, { text: 'again' });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error.code, 'busy');

  controller.abort(); // like pressing Stop / closing the tab
  await first.body?.cancel().catch(() => {});
  await abortedPromise;
  assert.equal(signalSeen.aborted, true);

  // The session is usable again afterwards.
  script = async function* () {
    return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end', usage };
  };
  for (let i = 0; i < 20; i++) {
    const res = await post(`/api/sessions/${id}/messages`, { text: 'next' });
    if (res.status !== 409) {
      assert.equal(res.status, 200);
      await collect(res);
      return;
    }
    await res.json();
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('session stayed busy after the client disconnected');
});

test('request validation: bad JSON, wrong content type, empty and too-long messages, unknown session', async () => {
  const id = await newSession();
  const errorCode = async (res) => [res.status, (await res.json()).error.code];

  assert.deepEqual(await errorCode(await post(`/api/sessions/${id}/messages`, '{nope')), [400, 'invalid_json']);
  assert.deepEqual(
    await errorCode(await post(`/api/sessions/${id}/messages`, 'hi', { 'Content-Type': 'text/plain' })),
    [415, 'unsupported_media_type'],
  );
  assert.deepEqual(await errorCode(await post(`/api/sessions/${id}/messages`, { text: '  ' })), [400, 'empty_text']);
  assert.deepEqual(
    await errorCode(await post(`/api/sessions/${id}/messages`, { text: 'x'.repeat(4001) })),
    [400, 'text_too_long'],
  );
  assert.deepEqual(await errorCode(await post('/api/sessions/nope/messages', { text: 'hi' })), [404, 'session_not_found']);
  assert.deepEqual(await errorCode(await post('/api/sessions', 'x'.repeat(70_000))), [413, 'payload_too_large']);
});

test('wrong method → 405 with Allow; unknown API route → 404', async () => {
  const res = await fetch(`${baseUrl}/api/sessions`);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST');
  await res.json();
  assert.equal((await fetch(`${baseUrl}/api/nothing`)).status, 404);
});

test('serves the web app with security headers and a request id', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('x-request-id'));
  assert.match(await res.text(), /<title>PrepPilot<\/title>/);
  assert.match((await fetch(`${baseUrl}/app.js`)).headers.get('content-type'), /javascript/);
});

test('static files cannot escape the web directory', async () => {
  for (const attempt of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json']) {
    const res = await fetch(baseUrl + attempt);
    assert.equal(res.status, 404, attempt);
    await res.text();
  }
});
