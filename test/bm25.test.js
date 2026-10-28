import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BM25 } from '../src/search/bm25.js';

/** Reference formula, written out so the expected numbers are explainable. */
function expectedScore({ tf, len, avgLen, N, df, k1 = 1.2, b = 0.75 }) {
  const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
  return idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / avgLen)));
}

function indexOf(docs, options) {
  const bm25 = new BM25(options);
  for (const [id, terms] of Object.entries(docs)) bm25.add(id, terms);
  return bm25;
}

const CORPUS = {
  d1: ['closure', 'scope', 'closure'],
  d2: ['scope', 'hoisting'],
  d3: ['event', 'loop', 'microtask', 'event'],
};

test('empty index returns no results', () => {
  assert.deepEqual(new BM25().search(['closure']), []);
});

test('size counts added documents', () => {
  assert.equal(indexOf(CORPUS).size, 3);
});

test('adding the same id twice throws', () => {
  const bm25 = indexOf(CORPUS);
  assert.throws(() => bm25.add('d1', ['x']));
});

test('only documents containing a query term are returned', () => {
  const ids = indexOf(CORPUS).search(['closure']).map((r) => r.id);
  assert.deepEqual(ids, ['d1']);
});

test('score matches the BM25 formula for a single term', () => {
  const [hit] = indexOf(CORPUS).search(['closure']);
  const expected = expectedScore({ tf: 2, len: 3, avgLen: 3, N: 3, df: 1 });
  assert.ok(Math.abs(hit.score - expected) < 1e-9, `got ${hit.score}, expected ${expected}`);
});

test('scores for multiple query terms are summed', () => {
  const [hit] = indexOf(CORPUS).search(['closure', 'scope']);
  const expected =
    expectedScore({ tf: 2, len: 3, avgLen: 3, N: 3, df: 1 }) +
    expectedScore({ tf: 1, len: 3, avgLen: 3, N: 3, df: 2 });
  assert.equal(hit.id, 'd1');
  assert.ok(Math.abs(hit.score - expected) < 1e-9, `got ${hit.score}, expected ${expected}`);
});

test('a rare term outweighs a common one', () => {
  const bm25 = indexOf({
    a: ['function', 'function', 'function'],
    b: ['function', 'weakref', 'other'],
    c: ['function', 'other', 'other'],
  });
  assert.equal(bm25.search(['function', 'weakref'])[0].id, 'b');
});

test('a match in a shorter document ranks higher (length normalisation)', () => {
  const bm25 = indexOf({
    long: ['promise', 'a', 'b', 'c', 'd', 'e', 'f', 'g'],
    short: ['promise', 'a'],
  });
  assert.deepEqual(bm25.search(['promise']).map((r) => r.id), ['short', 'long']);
});

test('with b = 0, document length does not matter', () => {
  const bm25 = indexOf({ long: ['promise', 'a', 'b', 'c', 'd', 'e'], short: ['promise', 'a'] }, { b: 0 });
  const [first, second] = bm25.search(['promise']);
  assert.ok(Math.abs(first.score - second.score) < 1e-9);
});

test('term frequency saturates: 10 matches score less than 2.2x one match', () => {
  const bm25 = indexOf({
    many: Array(10).fill('closure'),
    one: ['closure', ...Array(9).fill('filler')],
  });
  const scores = Object.fromEntries(bm25.search(['closure']).map((r) => [r.id, r.score]));
  const ratio = scores.many / scores.one;
  assert.ok(ratio > 1 && ratio < 2.2, `ratio was ${ratio}`);
});

test('with k1 = 0, term frequency does not matter', () => {
  const bm25 = indexOf({ many: ['x', 'x', 'x'], one: ['x', 'y', 'z'] }, { k1: 0 });
  const [first, second] = bm25.search(['x']);
  assert.ok(Math.abs(first.score - second.score) < 1e-9);
});

test('repeated query terms count once', () => {
  const bm25 = indexOf(CORPUS);
  assert.deepEqual(bm25.search(['closure', 'closure']), bm25.search(['closure']));
});

test('unknown terms are ignored and an empty query returns nothing', () => {
  const bm25 = indexOf(CORPUS);
  assert.deepEqual(bm25.search(['nonexistent', 'closure']), bm25.search(['closure']));
  assert.deepEqual(bm25.search([]), []);
});

test('limit caps the number of results (default 10)', () => {
  const docs = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`doc${String(i).padStart(2, '0')}`, ['js']]));
  const bm25 = indexOf(docs);
  assert.equal(bm25.search(['js']).length, 10);
  assert.equal(bm25.search(['js'], { limit: 3 }).length, 3);
});

test('ties are broken by id, ascending', () => {
  const bm25 = indexOf({ zeta: ['map'], alpha: ['map'], mid: ['map'] });
  assert.deepEqual(bm25.search(['map']).map((r) => r.id), ['alpha', 'mid', 'zeta']);
});
