import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/search/tokenize.js';

test('lower-cases and drops stop words', () => {
  assert.deepEqual(tokenize('What is the Event Loop?'), ['event', 'loop']);
});

test('keeps dotted identifiers whole and adds their parts', () => {
  const terms = tokenize('Promise.allSettled');
  for (const t of ['promise.allsettled', 'promise', 'allsettled', 'all', 'settled']) {
    assert.ok(terms.includes(t), `missing "${t}" in ${JSON.stringify(terms)}`);
  }
});

test('splits camelCase identifiers but keeps the whole word', () => {
  const terms = tokenize('addEventListener');
  for (const t of ['addeventlistener', 'add', 'event', 'listener']) assert.ok(terms.includes(t));
});

test('splits acronyms in identifiers', () => {
  const terms = tokenize('JSONParse');
  assert.ok(terms.includes('jsonparse') && terms.includes('json') && terms.includes('parse'));
});

test('drops single characters but keeps numbers with 2+ digits', () => {
  assert.deepEqual(tokenize('a b 1 42 x'), ['42']);
});

test('the same identifier in a question and in notes produces overlapping terms', () => {
  const question = new Set(tokenize('how does allSettled work'));
  const notes = tokenize('Promise.allSettled waits for every promise');
  assert.ok(notes.some((t) => question.has(t)));
});
