import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkFile, splitBySize, topicFromPath, MAX_CHARS } from '../src/indexer/chunk.js';

test('topic comes from the top-level folder name', () => {
  assert.equal(topicFromPath('14-event-loop/02-microtasks.js'), 'event-loop');
  assert.equal(topicFromPath('01-basics/10-reading-user-input/index.js'), 'basics');
  assert.equal(topicFromPath('README.md'), 'general');
});

test('markdown splits on headings and keeps the heading path', () => {
  const content = [
    '# DOM Events',
    'intro',
    '## Propagation',
    'bubbling text',
    '### Capture',
    'capture text',
    '## Delegation',
    'delegation text',
  ].join('\n');
  const chunks = chunkFile({ repo: 'r', path: '29-dom/questions.md', content });
  assert.deepEqual(
    chunks.map((c) => c.heading),
    ['DOM Events', 'DOM Events > Propagation', 'DOM Events > Propagation > Capture', 'DOM Events > Delegation'],
  );
  assert.ok(chunks.every((c) => c.topic === 'dom' && c.kind === 'markdown'));
});

test('markdown ignores "#" lines inside code fences', () => {
  const content = ['## Real heading', '```bash', '# not a heading', '```', 'after'].join('\n');
  const chunks = chunkFile({ repo: 'r', path: 'x/a.md', content });
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /# not a heading/);
});

test('js splits on block comments and uses the first title line', () => {
  const content = [
    '/**',
    ' * 04 — Closures',
    ' * ==========',
    ' * A closure is a function plus its lexical environment.',
    ' */',
    'function counter() {}',
    '',
    '/**',
    ' * Key Takeaways',
    ' * Q: what is a closure?',
    ' */',
  ].join('\n');
  const chunks = chunkFile({ repo: 'r', path: '07-scope-and-closures/04-closures.js', content });
  assert.deepEqual(chunks.map((c) => c.heading), ['04 — Closures', 'Key Takeaways']);
  assert.match(chunks[0].text, /function counter/);
  assert.doesNotMatch(chunks[0].text, /^\s*\*/m, 'comment markers should be stripped');
});

test('js code before any comment becomes its own chunk titled by file name', () => {
  const chunks = chunkFile({ repo: 'r', path: '25-polyfills/bind.js', content: 'const x = 1;\n' });
  assert.equal(chunks[0].heading, 'bind.js');
});

test('chunk ids are unique and stable', () => {
  const content = '## A\none\n## B\ntwo';
  const a = chunkFile({ repo: 'r', path: 'x/f.md', content }).map((c) => c.id);
  const b = chunkFile({ repo: 'r', path: 'x/f.md', content }).map((c) => c.id);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
});

test('long sections are split into pieces no longer than MAX_CHARS', () => {
  const paragraph = 'word '.repeat(100).trim(); // ~500 chars
  const content = `## Long\n${Array(10).fill(paragraph).join('\n\n')}`;
  const chunks = chunkFile({ repo: 'r', path: 'x/long.md', content });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.text.length <= MAX_CHARS));
  assert.match(chunks[1].heading, /\(part 2\)$/);
});

test('splitBySize hard-splits a single huge line', () => {
  const pieces = splitBySize('x'.repeat(5000), 2000);
  assert.deepEqual(pieces.map((p) => p.length), [2000, 2000, 1000]);
});
