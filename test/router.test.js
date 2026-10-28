import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/server/router.js';
import { HttpError, compose } from '../src/server/http.js';

const noop = () => {};

test('matches paths and extracts decoded params', () => {
  const handler = () => 'h';
  const router = new Router().get('/api/sessions/:id/messages', handler);
  const found = router.match('GET', '/api/sessions/a%20b/messages');
  assert.equal(found.handler, handler);
  assert.deepEqual(found.params, { id: 'a b' });
});

test('trailing slash is optional; HEAD matches GET', () => {
  const router = new Router().get('/healthz', noop);
  assert.ok(router.match('GET', '/healthz/'));
  assert.ok(router.match('HEAD', '/healthz'));
});

test('unknown path → null (404); known path, wrong method → allowed list (405)', () => {
  const router = new Router().get('/api/x', noop).post('/api/x', noop).post('/api/y', noop);
  assert.equal(router.match('GET', '/api/nope'), null);
  assert.deepEqual(router.match('DELETE', '/api/x'), { allowed: ['GET', 'POST'] });
});

test('params never match across a slash', () => {
  const router = new Router().get('/api/sessions/:id', noop);
  assert.equal(router.match('GET', '/api/sessions/a/b'), null);
});

test('malformed percent-encoding is a 400, not a crash', () => {
  const router = new Router().get('/api/sessions/:id', noop);
  assert.throws(() => router.match('GET', '/api/sessions/%E0%A4%A'), (err) => err instanceof HttpError && err.status === 400);
});

test('compose runs middleware as an onion', async () => {
  const order = [];
  const run = compose([
    async (ctx, next) => {
      order.push('a-in');
      await next();
      order.push('a-out');
    },
    async (ctx, next) => {
      order.push('b-in');
      await next();
      order.push('b-out');
    },
    () => order.push('handler'),
  ]);
  await run(/** @type {any} */ ({}));
  assert.deepEqual(order, ['a-in', 'b-in', 'handler', 'b-out', 'a-out']);
});

test('compose propagates errors (sync or async) to earlier middleware', async () => {
  let caught;
  const run = compose([
    async (ctx, next) => {
      try {
        await next();
      } catch (err) {
        caught = err.message;
      }
    },
    () => {
      throw new Error('sync boom');
    },
  ]);
  await run(/** @type {any} */ ({}));
  assert.equal(caught, 'sync boom');
});

test('calling next() twice is rejected', async () => {
  const run = compose([
    async (ctx, next) => {
      await next();
      await next();
    },
  ]);
  await assert.rejects(run(/** @type {any} */ ({})), /next\(\) called more than once/);
});
