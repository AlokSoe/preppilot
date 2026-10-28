/**
 * Split files into searchable chunks along their natural structure:
 *   - Markdown: one chunk per `##` / `###` section, keeping the heading path.
 *   - JavaScript: one chunk per `/** ... *\/` comment block plus the code
 *     that follows it (the handbook's "Definition → examples → Key
 *     Takeaways" format maps cleanly onto this).
 * Any section longer than MAX_CHARS is split on blank lines.
 *
 * @typedef {{
 *   id: string,          // "<repo>/<path>#<n>"
 *   repo: string,        // "javascript-engineering-handbook"
 *   path: string,        // "07-scope-and-closures/04-closures.js"
 *   heading: string,     // "Event Propagation > capture vs bubble"
 *   topic: string,       // "scope-and-closures"
 *   kind: 'markdown' | 'code',
 *   text: string,
 * }} Chunk
 */

export const MAX_CHARS = 2000; // ~500 tokens

/** "14-event-loop/02-microtasks.js" → "event-loop" */
export function topicFromPath(relPath) {
  const first = relPath.split('/')[0];
  if (first === relPath) return 'general'; // file at repo root, e.g. README.md
  return first.replace(/^\d+-/, '');
}

/**
 * @param {{ repo: string, path: string, content: string }} file
 * @returns {Chunk[]}
 */
export function chunkFile({ repo, path, content }) {
  const isMarkdown = path.endsWith('.md');
  const sections = isMarkdown ? splitMarkdown(content) : splitJs(content);
  const fallbackTitle = path.split('/').pop();
  const topic = topicFromPath(path);

  const chunks = [];
  for (const section of sections) {
    const parts = splitBySize(section.text.trim(), MAX_CHARS);
    parts.forEach((text, i) => {
      if (!text) return;
      const heading = section.heading || fallbackTitle;
      chunks.push({
        id: `${repo}/${path}#${chunks.length}`,
        repo,
        path,
        heading: parts.length > 1 ? `${heading} (part ${i + 1})` : heading,
        topic,
        kind: isMarkdown ? 'markdown' : 'code',
        text,
      });
    });
  }
  return chunks;
}

/**
 * @param {string} content
 * @returns {{ heading: string, text: string }[]}
 */
export function splitMarkdown(content) {
  const sections = [];
  const stack = []; // heading path, index = level - 1
  let current = { heading: '', lines: [] };
  let inFence = false;

  const flush = () => {
    if (current.lines.join('').trim()) {
      sections.push({ heading: current.heading, text: current.lines.join('\n') });
    }
  };

  for (const line of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = !inFence && /^(#{1,3})\s+(.*)$/.exec(line);
    if (match) {
      flush();
      const level = match[1].length;
      stack.length = level - 1;
      stack[level - 1] = match[2].trim();
      current = { heading: stack.filter(Boolean).join(' > '), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * @param {string} content
 * @returns {{ heading: string, text: string }[]}
 */
export function splitJs(content) {
  const sections = [];
  let current = null;
  let inComment = false;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!inComment && trimmed.startsWith('/*')) {
      if (current) sections.push(current);
      current = { heading: '', lines: [] };
      inComment = true;
    }
    current ??= { heading: '', lines: [] }; // code before any block comment

    if (inComment) {
      const text = cleanCommentLine(trimmed);
      if (!current.heading && isTitleLine(text)) current.heading = text;
      current.lines.push(text);
      if (trimmed.includes('*/')) inComment = false;
    } else {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections.map((s) => ({ heading: s.heading, text: s.lines.join('\n') }));
}

/** " * Some text" → "Some text"; drops comment delimiters. */
function cleanCommentLine(trimmed) {
  return trimmed
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '')
    .replace(/^\*\s?/, '')
    .trimEnd();
}

/** A usable title: has letters, and isn't a "=====" / "-----" rule. */
function isTitleLine(text) {
  return /[a-z]/i.test(text) && !/^[=\-_*\s]+$/.test(text);
}

/**
 * Greedily pack paragraphs (blank-line separated) into pieces of at most
 * `max` chars. A single paragraph longer than `max` is split by lines.
 * @param {string} text
 * @param {number} max
 * @returns {string[]}
 */
export function splitBySize(text, max) {
  if (text.length <= max) return [text];
  const units = text
    .split(/\n\s*\n/)
    .flatMap((p) => (p.length <= max ? [p] : hardSplit(p, max)));

  const pieces = [];
  let buf = '';
  for (const unit of units) {
    if (buf && buf.length + unit.length + 2 > max) {
      pieces.push(buf);
      buf = '';
    }
    buf = buf ? `${buf}\n\n${unit}` : unit;
  }
  if (buf) pieces.push(buf);
  return pieces;
}

function hardSplit(paragraph, max) {
  const out = [];
  let buf = '';
  for (const line of paragraph.split('\n')) {
    if (buf && buf.length + line.length + 1 > max) {
      out.push(buf);
      buf = '';
    }
    // A single line longer than max is cut at max.
    for (let i = 0; i < line.length; i += max) {
      const slice = line.slice(i, i + max);
      buf = buf ? `${buf}\n${slice}` : slice;
      if (buf.length >= max) {
        out.push(buf);
        buf = '';
      }
    }
  }
  if (buf) out.push(buf);
  return out;
}
