import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KnowledgeBase } from '../src/search/knowledge-base.js';

// Integration test: needs your BM25 implementation to pass.

let root;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'preppilot-kb-'));
  const repo = path.join(root, 'notes');
  await mkdir(path.join(repo, '14-event-loop'), { recursive: true });
  await mkdir(path.join(repo, '07-closures'), { recursive: true });
  await mkdir(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(
    path.join(repo, '14-event-loop', 'microtasks.md'),
    '## Microtasks vs macrotasks\nPromise callbacks run in the microtask queue before setTimeout.',
  );
  await writeFile(
    path.join(repo, '07-closures', 'closures.js'),
    '/**\n * Closures\n * A closure remembers its lexical scope.\n */\nfunction counter() {}',
  );
  await writeFile(path.join(repo, 'node_modules', 'pkg', 'index.js'), '// microtask closure promise');
});

after(() => rm(root, { recursive: true, force: true }));

test('indexes source files and skips node_modules', async () => {
  const kb = await KnowledgeBase.build([path.join(root, 'notes')]);
  assert.equal(kb.stats.files, 2);
  assert.deepEqual(kb.topics(), ['closures', 'event-loop']);
});

test('finds the right chunk with a citation', async () => {
  const kb = await KnowledgeBase.build([path.join(root, 'notes')]);
  const [top] = kb.search('microtask queue promise');
  assert.equal(top.path, '14-event-loop/microtasks.md');
  assert.equal(top.heading, 'Microtasks vs macrotasks');
  assert.equal(top.repo, 'notes');
});

test('topic boosts but does not filter', async () => {
  const kb = await KnowledgeBase.build([path.join(root, 'notes')]);
  const results = kb.search('closure promise', { topic: 'closures' });
  assert.equal(results[0].topic, 'closures');
  assert.ok(results.length >= 1);
});
