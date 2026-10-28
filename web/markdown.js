/**
 * Small, XSS-safe markdown renderer for model output.
 *
 * parseMarkdown() turns text into a plain-object tree (pure, testable in
 * Node). renderMarkdown() builds DOM nodes from that tree with createElement
 * and textContent only. Nothing is ever assigned to innerHTML, so text like
 * "<img onerror=...>" from the model is displayed, never executed.
 *
 * Supported: fenced code, headings, paragraphs, bullet/numbered lists,
 * blockquotes, rules, and inline `code`, **bold**, *italic*, [links](https://...).
 * Unclosed code fences run to the end, which suits streaming text.
 */

const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?/;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+(.*)$/;

/** @param {string} source */
export function parseMarkdown(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++; // closing fence (or past the end)
      blocks.push({ type: 'code', lang: fence[2], text: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2]) });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(QUOTE, ''));
      blocks.push({ type: 'quote', children: parseInline(body.join('\n')) });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[1]);
      const items = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (m && /\d/.test(m[1]) === ordered) {
          items.push(m[2]);
          i++;
        } else if (items.length && /^\s{2,}\S/.test(lines[i])) {
          items[items.length - 1] += `\n${lines[i].trim()}`; // continuation line
          i++;
        } else break;
      }
      blocks.push({ type: 'list', ordered, items: items.map(parseInline) });
      continue;
    }

    const body = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) body.push(lines[i++]);
    blocks.push({ type: 'paragraph', children: parseInline(body.join('\n')) });
  }
  return blocks;
}

function isBlockStart(line) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);
}

const INLINE =
  /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|\*([^*\s](?:[^*\n]*[^*\s])?)\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

/** @param {string} text */
export function parseInline(text) {
  const nodes = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) nodes.push({ type: 'text', text: text.slice(last, m.index) });
    if (m[1] !== undefined) nodes.push({ type: 'code', text: m[1] });
    else if (m[2] !== undefined) nodes.push({ type: 'strong', text: m[2] });
    else if (m[3] !== undefined) nodes.push({ type: 'em', text: m[3] });
    else nodes.push({ type: 'link', text: m[4], href: m[5] });
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) });
  return nodes;
}

/**
 * @param {string} source
 * @param {Document} [doc]
 * @returns {DocumentFragment}
 */
export function renderMarkdown(source, doc = document) {
  const el = (tag, className) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    return node;
  };
  const inline = (parent, nodes) => {
    for (const node of nodes) {
      if (node.type === 'text') {
        parent.append(node.text);
        continue;
      }
      const tag = { code: 'code', strong: 'strong', em: 'em', link: 'a' }[node.type];
      const child = el(tag);
      child.textContent = node.text;
      if (node.type === 'link') {
        child.href = node.href;
        child.target = '_blank';
        child.rel = 'noopener noreferrer';
      }
      parent.append(child);
    }
    return parent;
  };

  const fragment = doc.createDocumentFragment();
  for (const block of parseMarkdown(source)) {
    switch (block.type) {
      case 'code': {
        const pre = el('pre');
        const code = el('code');
        if (block.lang) code.dataset.lang = block.lang;
        code.textContent = block.text;
        pre.append(code);
        fragment.append(pre);
        break;
      }
      case 'heading':
        // Answers live inside a page that already has an h1, so shift levels down.
        fragment.append(inline(el(`h${Math.min(block.level + 2, 6)}`), block.children));
        break;
      case 'rule':
        fragment.append(el('hr'));
        break;
      case 'quote':
        fragment.append(inline(el('blockquote'), block.children));
        break;
      case 'list': {
        const list = el(block.ordered ? 'ol' : 'ul');
        for (const item of block.items) list.append(inline(el('li'), item));
        fragment.append(list);
        break;
      }
      default:
        fragment.append(inline(el('p'), block.children));
    }
  }
  return fragment;
}
