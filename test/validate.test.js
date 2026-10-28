import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/agent/validate.js';

const SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 5 },
    k: { type: 'integer', minimum: 1, maximum: 10 },
    mode: { type: 'string', enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['query'],
  additionalProperties: false,
};

test('valid input has no errors', () => {
  assert.deepEqual(validate(SCHEMA, { query: 'abc', k: 3, mode: 'a', tags: ['x'] }), []);
});

test('reports missing, wrong-typed and extra properties', () => {
  assert.deepEqual(validate(SCHEMA, { k: 1.5, extra: true }), [
    'input.query is required',
    'input.k must be integer, got number',
    'input.extra is not allowed',
  ]);
});

test('checks bounds, lengths, enums and array items', () => {
  assert.deepEqual(validate(SCHEMA, { query: 'toolong', k: 11, mode: 'c', tags: ['ok', 2] }), [
    'input.query must be at most 5 characters',
    'input.k must be <= 10',
    'input.mode must be one of "a", "b"',
    'input.tags[1] must be string, got number',
  ]);
});

test('rejects non-objects at the top level', () => {
  assert.deepEqual(validate(SCHEMA, null), ['input must be object, got null']);
  assert.deepEqual(validate(SCHEMA, []), ['input must be object, got array']);
});
