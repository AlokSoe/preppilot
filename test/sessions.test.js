import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemorySessionStore } from '../src/server/sessions.js';

function clock(start = 0) {
  let time = start;
  const now = () => time;
  now.advance = (ms) => (time += ms);
  return now;
}

test('create and get', () => {
  const store = new MemorySessionStore();
  const session = store.create({ mode: 'ask' });
  assert.equal(store.get(session.id), session);
  assert.deepEqual(session.messages, []);
  assert.equal(store.get('missing'), undefined);
});

test('idle sessions expire after the TTL; touch() keeps them alive', () => {
  const now = clock();
  const store = new MemorySessionStore({ ttlMs: 100, now });
  const kept = store.create({ mode: 'ask' });
  const dropped = store.create({ mode: 'ask' });
  now.advance(60);
  store.touch(kept);
  now.advance(60);
  assert.ok(store.get(kept.id));
  assert.equal(store.get(dropped.id), undefined);
});

test('when full, the least recently used idle session is evicted — never a busy one', () => {
  const store = new MemorySessionStore({ maxSessions: 2 });
  const busy = store.create({ mode: 'ask' });
  busy.busy = true;
  const idle = store.create({ mode: 'ask' });
  const fresh = store.create({ mode: 'ask' });

  assert.ok(store.get(busy.id), 'busy session survives');
  assert.equal(store.get(idle.id), undefined);
  assert.ok(store.get(fresh.id));
  assert.equal(store.size, 2);
});
