import { el } from './chat.js';

/**
 * Progress page: mastery per topic, what's due for review, recent attempts.
 * Re-fetched each time the tab is opened.
 * @param {HTMLElement} root
 */
export async function showProgress(root) {
  root.replaceChildren(el('p', 'note', 'Loading progress…'));
  let data;
  try {
    const res = await fetch('/api/progress');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch {
    root.replaceChildren(el('p', 'error', 'Could not load progress.'));
    return;
  }

  const heading = el('div', 'progress-head');
  heading.append(
    el('h1', '', 'Your progress'),
    el(
      'p',
      'meta',
      data.attempts
        ? `${data.attempts} graded attempts · average ${data.averageScore}/10`
        : 'No graded attempts yet. Do a mock interview or submit a coding problem.',
    ),
  );
  const nodes = [heading];

  if (data.next.length || data.untried.length) {
    const next = el('section', 'panel next-up');
    next.append(el('h2', '', 'Study next'));
    if (data.next.length) next.append(el('p', '', `Review: ${data.next.join(', ')}`));
    if (data.untried.length) next.append(el('p', 'meta', `Not tried yet: ${data.untried.join(', ')}`));
    nodes.push(next);
  }

  if (data.topics.length) {
    const table = el('table', 'mastery-table');
    const head = el('tr');
    for (const title of ['Topic', 'Mastery', 'Last score', 'Attempts', 'Next review']) head.append(el('th', '', title));
    table.append(el('thead'), el('tbody'));
    table.tHead?.append(head);
    for (const t of data.topics) {
      const row = el('tr');
      const meter = el('meter');
      Object.assign(meter, { min: 0, max: 100, low: 40, high: 70, optimum: 100, value: t.mastery });
      meter.setAttribute('aria-label', `${t.topic} mastery ${t.mastery} of 100`);
      const masteryCell = el('td');
      masteryCell.append(meter, el('span', '', ` ${t.mastery}`));
      const review = t.due ? el('span', 'tag due', 'due now') : el('span', '', new Date(t.dueAt).toLocaleDateString());
      const reviewCell = el('td');
      reviewCell.append(review);
      row.append(el('td', '', t.topic), masteryCell, el('td', '', `${t.lastScore}/10`), el('td', '', String(t.attempts)), reviewCell);
      table.tBodies[0].append(row);
    }
    const wrap = el('div', 'table-wrap');
    wrap.append(table);
    nodes.push(wrap);
  }

  if (data.recent.length) {
    const recent = el('section', 'panel');
    recent.append(el('h2', '', 'Recent attempts'));
    const list = el('ul', 'recent');
    for (const a of data.recent) {
      const item = el('li');
      item.append(
        el('span', `tag ${a.score >= 7 ? 'good' : 'weak'}`, `${a.score}/10`),
        el('span', '', ` ${a.kind === 'code' ? 'Code' : 'Interview'} · ${a.topic} · `),
        el('span', 'meta', a.feedback || a.question),
      );
      list.append(item);
    }
    recent.append(list);
    nodes.push(recent);
  }
  root.replaceChildren(...nodes);
}
