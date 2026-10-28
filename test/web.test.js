import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvent, readSse } from '../web/sse.js';
import { parseInline, parseMarkdown } from '../web/markdown.js';

/** A ReadableStream that delivers `chunks` one by one, like a slow network. */
function streamOf(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test('parseEvent reads event name and JSON data; ignores comments', () => {
  assert.deepEqual(parseEvent(': ping\nevent: text\ndata: {"delta":"hi"}'), { event: 'text', data: { delta: 'hi' } });
  assert.equal(parseEvent(': ping'), null);
});

test('readSse handles events split across network chunks', async () => {
  const wire = 'event: text\ndata: {"delta":"a"}\n\n: ping\n\nevent: done\ndata: {"status":"done"}\n\n';
  const chunks = [];
  for (let i = 0; i < wire.length; i += 7) chunks.push(wire.slice(i, i + 7));

  const events = [];
  for await (const event of readSse(streamOf(chunks))) events.push(event);
  assert.deepEqual(events, [
    { event: 'text', data: { delta: 'a' } },
    { event: 'done', data: { status: 'done' } },
  ]);
});

test('readSse accepts CRLF line endings', async () => {
  const events = [];
  for await (const event of readSse(streamOf(['event: x\r\ndata: 1\r\n\r\n']))) events.push(event);
  assert.deepEqual(events, [{ event: 'x', data: 1 }]);
});

test('markdown: blocks', () => {
  const blocks = parseMarkdown(
    ['## Title', '', 'Para line one', 'line two', '', '- a', '- b', '', '1. x', '', '```js', 'const a = 1;', '```', '> quote', '---'].join('\n'),
  );
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['heading', 'paragraph', 'list', 'list', 'code', 'quote', 'rule'],
  );
  assert.equal(blocks[2].ordered, false);
  assert.equal(blocks[3].ordered, true);
  assert.deepEqual(blocks[4], { type: 'code', lang: 'js', text: 'const a = 1;' });
});

test('markdown: an unclosed fence (mid-stream) is code to the end', () => {
  const blocks = parseMarkdown('Intro\n```js\nfunction f() {\n  return 1;');
  assert.deepEqual(blocks.at(-1), { type: 'code', lang: 'js', text: 'function f() {\n  return 1;' });
});

test('markdown: inline code, bold, italic and links', () => {
  assert.deepEqual(parseInline('Use `map` and **never** *mutate*, see [MDN](https://developer.mozilla.org)'), [
    { type: 'text', text: 'Use ' },
    { type: 'code', text: 'map' },
    { type: 'text', text: ' and ' },
    { type: 'strong', text: 'never' },
    { type: 'text', text: ' ' },
    { type: 'em', text: 'mutate' },
    { type: 'text', text: ', see ' },
    { type: 'link', text: 'MDN', href: 'https://developer.mozilla.org' },
  ]);
});

test('markdown: HTML and javascript: links stay plain text (XSS)', () => {
  const nodes = parseInline('<img src=x onerror=alert(1)> [click](javascript:alert(1))');
  assert.ok(nodes.every((n) => n.type === 'text'));
  assert.equal(nodes.map((n) => n.text).join(''), '<img src=x onerror=alert(1)> [click](javascript:alert(1))');
});

test('markdown: a * multiplication sign is not italic', () => {
  assert.deepEqual(parseInline('2 * 3 * 4'), [{ type: 'text', text: '2 * 3 * 4' }]);
});
