import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { SecretBox, hashPassword, verifyPassword } from '../src/auth/crypto.js';
import { AccountError, AccountStore } from '../src/auth/accounts.js';
import { openDatabase } from '../src/db/database.js';
import { RateLimiter } from '../src/server/rate-limit.js';
import { UsageStore } from '../src/server/usage.js';
import { createApp, redact } from '../src/server/app.js';
import { MemorySessionStore } from '../src/server/sessions.js';
import { ProblemStore } from '../src/problems/store.js';
import { ProgressStore } from '../src/progress/progress.js';
import { CodeRunner } from '../src/runner/runner.js';
import { InvalidKeyError } from '../src/llm/provider.js';
import { readSse } from '../web/sse.js';

const SECRET = 'x'.repeat(40);
const GOOD_KEY = 'sk-ant-test-good-key-0123456789abcd';

// ---- Units ---------------------------------------------------------------------

test('passwords: scrypt hash with per-user salt, verified in constant time', async () => {
  const a = await hashPassword('correct horse');
  const b = await hashPassword('correct horse');
  assert.notEqual(a, b, 'random salt');
  assert.match(a, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(await verifyPassword('correct horse', a), true);
  assert.equal(await verifyPassword('wrong', a), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('SecretBox: AES-256-GCM round trip, random IV, tampering detected', () => {
  const box = new SecretBox(SECRET);
  const sealed = box.encrypt(GOOD_KEY);
  assert.equal(box.decrypt(sealed), GOOD_KEY);
  assert.notEqual(box.encrypt(GOOD_KEY).iv, sealed.iv);
  assert.doesNotMatch(JSON.stringify(sealed), /sk-ant/);

  const tampered = { ...sealed, ciphertext: Buffer.from('tampered!').toString('base64') };
  assert.throws(() => box.decrypt(tampered));
  assert.throws(() => new SecretBox(SECRET.replace('x', 'y')).decrypt(sealed), 'a different server secret cannot decrypt');
  assert.throws(() => new SecretBox('short'), /at least 32/);
});

test('AccountStore: sign up, log in, sessions stored hashed and expiring', async () => {
  let now = 0;
  const db = openDatabase(':memory:');
  const store = new AccountStore(db, new SecretBox(SECRET), { now: () => now });
  const user = await store.signUp('  Alice@Example.com ', 'longpassword');
  assert.equal(user.email, 'alice@example.com');
  await assert.rejects(store.signUp('alice@example.com', 'longpassword'), (e) => e instanceof AccountError && e.code === 'email_taken');
  await assert.rejects(store.signUp('not-an-email', 'longpassword'), { code: 'invalid_email' });
  await assert.rejects(store.signUp('bob@example.com', 'short'), { code: 'weak_password' });

  assert.deepEqual(await store.logIn('ALICE@example.com', 'longpassword'), user);
  assert.equal(await store.logIn('alice@example.com', 'wrong'), null);
  assert.equal(await store.logIn('nobody@example.com', 'whatever1'), null);

  const token = store.createSession(user.id);
  assert.deepEqual(store.resolveSession(token), user);
  const stored = db.prepare('SELECT token_hash FROM auth_sessions').get();
  assert.notEqual(stored.token_hash, token, 'only the hash is stored');

  now += 31 * 24 * 60 * 60 * 1000;
  assert.equal(store.resolveSession(token), null, 'expired after 30 days');
});

test('AccountStore: keys are encrypted at rest and listed by last 4 only', async () => {
  const db = openDatabase(':memory:');
  const store = new AccountStore(db, new SecretBox(SECRET));
  const user = await store.signUp('a@b.co', 'longpassword');
  store.setApiKey(user.id, 'claude', GOOD_KEY);

  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM api_keys').all()), /sk-ant-test/);
  assert.deepEqual(store.getApiKey(user.id), { provider: 'claude', apiKey: GOOD_KEY });
  const [listed] = store.listKeys(user.id);
  assert.equal(listed.last4, 'abcd');
  assert.doesNotMatch(JSON.stringify(store.listKeys(user.id)), /sk-ant/);
  store.deleteKey(user.id, 'claude');
  assert.equal(store.getApiKey(user.id), null);
});

test('RateLimiter: fixed window per key', () => {
  let now = 0;
  const limiter = new RateLimiter({ now: () => now });
  for (let i = 0; i < 3; i++) assert.equal(limiter.hit('k', 3, 1000).ok, true);
  const blocked = limiter.hit('k', 3, 1000);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryAfterSec, 1);
  assert.equal(limiter.hit('other', 3, 1000).ok, true);
  now = 1000;
  assert.equal(limiter.hit('k', 3, 1000).ok, true, 'new window');
});

test('UsageStore: per user, per tier, per day', () => {
  let now = Date.parse('2026-01-01T10:00:00Z');
  const usage = new UsageStore(openDatabase(':memory:'), { now: () => now });
  usage.countRequest('u', 'demo');
  usage.addTokens('u', 'demo', { input: 100, output: 50 });
  usage.addTokens('v', 'demo', { input: 10, output: 5 });
  usage.addTokens('u', 'own', { input: 1, output: 1 });
  assert.deepEqual(usage.today('u').demo, { requests: 1, input: 100, output: 50 });
  assert.equal(usage.demoTokensToday(), 165);
  now += 24 * 60 * 60 * 1000;
  assert.equal(usage.demoTokensToday(), 0, 'a new day');
});

test('redact: secret fields and key-shaped strings never reach logs', () => {
  const out = redact({
    password: 'hunter22',
    nested: { apiKey: 'abc', note: `failed with ${GOOD_KEY} in it` },
    list: [GOOD_KEY],
    input: 120,
  });
  assert.deepEqual(out, { password: '[redacted]', nested: { apiKey: '[redacted]', note: 'failed with [redacted] in it' }, list: ['[redacted]'], input: 120 });
});

// ---- Over HTTP ----------------------------------------------------------------------

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };

function fakeProvider(label, calls) {
  return {
    name: label,
    async *streamTurn() {
      calls.push(label);
      yield { type: 'text', delta: `answer from ${label}` };
      return { content: [{ type: 'text', text: `answer from ${label}` }], stopReason: 'end', usage };
    },
    async generateJson() {
      throw new Error('not used');
    },
    async validateKey() {},
  };
}

let server;
let baseUrl;
let calls;
let logs;

before(async () => {
  calls = [];
  logs = [];
  const db = openDatabase(':memory:');
  const handler = createApp({
    kb: /** @type {any} */ ({ stats: {}, topics: () => [], search: () => [] }),
    provider: /** @type {any} */ (fakeProvider('demo', calls)),
    sessions: new MemorySessionStore(),
    runner: new CodeRunner(),
    problems: new ProblemStore(db),
    progress: new ProgressStore(db),
    interview: { rounds: [], rubric: '' },
    accounts: {
      store: new AccountStore(db, new SecretBox(SECRET)),
      usage: new UsageStore(db),
      providerFor: ({ apiKey }) => {
        const own = fakeProvider('own', calls);
        own.validateKey = async () => {
          if (apiKey !== GOOD_KEY) throw new InvalidKeyError('bad key');
        };
        return /** @type {any} */ (own);
      },
      demoProvider: /** @type {any} */ (fakeProvider('demo', calls)),
      limits: { demoMessagesPerUser: 2, demoDailyTokens: 1_000_000 },
      cookieSecure: false,
    },
    log: (entry) => logs.push(entry),
  });
  server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

/** A tiny client that keeps its cookie, like a browser tab. */
function client() {
  let cookie = '';
  const request = async (method, url, body, headers = {}) => {
    const res = await fetch(baseUrl + url, {
      method,
      headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return res;
  };
  return {
    get: (url) => request('GET', url),
    post: (url, body, headers) => request('POST', url, body ?? {}, headers),
    del: (url) => request('DELETE', url),
    setCookieHeader: () => cookie,
  };
}

async function signUp(email) {
  const c = client();
  const res = await c.post('/api/auth/signup', { email, password: 'longpassword' });
  assert.equal(res.status, 201);
  return c;
}

async function chat(c, text = 'hi') {
  const { id } = await (await c.post('/api/sessions', { mode: 'ask' })).json();
  const res = await c.post(`/api/sessions/${id}/messages`, { text });
  if (!res.ok) return { status: res.status, error: (await res.json()).error };
  const events = [];
  for await (const e of readSse(res.body)) events.push(e);
  return { status: res.status, events };
}

test('signup sets an HttpOnly session cookie; /api/me reflects the user and tier', async () => {
  const c = client();
  const res = await c.post('/api/auth/signup', { email: 'me@example.com', password: 'longpassword' });
  assert.equal(res.status, 201);
  assert.match(res.headers.get('set-cookie'), /pp_session=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000/);
  const me = await (await c.get('/api/me')).json();
  assert.equal(me.user.email, 'me@example.com');
  assert.equal(me.tier, 'demo');
  assert.equal(me.demo.messagesLeft, 2);
});

test('API routes need a login; health and the login itself do not', async () => {
  const anonymous = client();
  assert.equal((await anonymous.post('/api/sessions', { mode: 'ask' })).status, 401);
  assert.equal((await anonymous.get('/api/progress')).status, 401);
  assert.equal((await anonymous.get('/healthz')).status, 200);
  assert.deepEqual(await (await anonymous.get('/api/me')).json(), { accounts: true, user: null });
});

test('login: wrong password is 401, right one works; logout ends the session', async () => {
  await signUp('login@example.com');
  const c = client();
  assert.equal((await c.post('/api/auth/login', { email: 'login@example.com', password: 'nope-nope' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { email: 'login@example.com', password: 'longpassword' })).status, 200);
  assert.equal((await c.get('/api/progress')).status, 200);
  await c.post('/api/auth/logout');
  // The old token no longer works even if a client kept it.
  assert.equal((await c.get('/api/progress')).status, 401);
});

test('users cannot see each other’s sessions', async () => {
  const alice = await signUp('alice2@example.com');
  const bob = await signUp('bob2@example.com');
  const { id } = await (await alice.post('/api/sessions', { mode: 'ask' })).json();
  assert.equal((await bob.get(`/api/sessions/${id}`)).status, 404);
  assert.equal((await alice.get(`/api/sessions/${id}`)).status, 200);
});

test('demo tier: limited messages per day, expensive features blocked', async () => {
  const c = await signUp('demo@example.com');
  calls.length = 0;
  assert.equal((await chat(c)).status, 200);
  assert.equal((await chat(c)).status, 200);
  const third = await chat(c);
  assert.equal(third.status, 429);
  assert.equal(third.error.code, 'demo_limit');
  assert.deepEqual(calls, ['demo', 'demo']);

  const { id } = await (await c.post('/api/sessions', { mode: 'build' })).json();
  const build = await c.post(`/api/sessions/${id}/messages`, { text: 'build x' });
  assert.equal(build.status, 403);
  assert.equal((await build.json()).error.code, 'demo_feature');
  assert.equal((await c.post('/api/problems', { topic: 'arrays' })).status, 403);
});

test('adding a key: validated first, stored encrypted, then the user’s own key is used', async () => {
  const c = await signUp('owner@example.com');
  const bad = await c.post('/api/keys', { provider: 'claude', apiKey: 'sk-ant-this-key-is-not-valid-xyz' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'invalid_key');
  assert.equal((await c.post('/api/keys', { provider: 'claude', apiKey: 'short' })).status, 400);

  const ok = await c.post('/api/keys', { provider: 'claude', apiKey: GOOD_KEY });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(body.keys.map((k) => [k.provider, k.last4]), [['claude', 'abcd']]);
  assert.doesNotMatch(JSON.stringify(body), /sk-ant/);

  const me = await (await c.get('/api/me')).json();
  assert.equal(me.tier, 'own');
  assert.doesNotMatch(JSON.stringify(me), /sk-ant/);

  calls.length = 0;
  for (let i = 0; i < 3; i++) assert.equal((await chat(c)).status, 200); // beyond the demo limit
  assert.deepEqual(calls, ['own', 'own', 'own']);
  const usageNow = (await (await c.get('/api/me')).json()).usage.own;
  assert.deepEqual(usageNow, { requests: 3, input: 30, output: 15 });

  assert.equal((await c.del('/api/keys/claude')).status, 200);
  assert.equal((await (await c.get('/api/me')).json()).tier, 'demo');
});

test('CSRF: state-changing requests from another origin are refused', async () => {
  const c = await signUp('csrf@example.com');
  const evil = await c.post('/api/sessions', { mode: 'ask' }, { Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal((await evil.json()).error.code, 'bad_origin');
  const same = await c.post('/api/sessions', { mode: 'ask' }, { Origin: baseUrl });
  assert.equal(same.status, 201);
});

test('login attempts are rate limited per IP', async () => {
  const c = client();
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    const res = await c.post('/api/auth/login', { email: 'x@example.com', password: 'wrong-pass' });
    statuses.push(res.status);
  }
  assert.ok(statuses.includes(429), statuses.join(','));
});

test('no API key or password ever appears in the logs', () => {
  assert.ok(logs.length > 0);
  assert.doesNotMatch(JSON.stringify(logs), /sk-ant|longpassword/);
});
