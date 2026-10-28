import { readSse } from './sse.js';
import { renderMarkdown } from './markdown.js';

const DRAFT_PREFIX = 'preppilot.draft.';
const STAGES = {
  generating: 'Writing a new problem…',
  verifying: "Checking the problem's tests against a reference solution…",
  fixing: 'The first draft had a problem. Fixing it…',
};

const $ = (id) => /** @type {any} */ (document.getElementById(id));
const els = {
  form: $('generate-form'),
  topic: $('topic'),
  topicList: $('topic-list'),
  difficulty: $('difficulty'),
  generate: $('generate'),
  picker: $('problem-picker'),
  status: $('code-status'),
  workspace: $('workspace'),
  title: $('problem-title'),
  meta: $('problem-meta'),
  statement: $('problem-statement'),
  visibleTests: $('visible-tests'),
  editor: /** @type {HTMLTextAreaElement} */ ($('editor')),
  reset: $('reset'),
  run: $('run'),
  submit: $('submit'),
  results: $('results'),
  review: $('review'),
};

/** @type {any} */
let problem = null;
let busy = false;

init();

async function init() {
  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    generate();
  });
  els.picker.addEventListener('change', () => els.picker.value && openProblem(els.picker.value));
  els.run.addEventListener('click', run);
  els.submit.addEventListener('click', submit);
  els.reset.addEventListener('click', () => {
    if (problem && confirm('Replace your code with the starter code?')) {
      els.editor.value = problem.starterCode;
      saveDraft();
    }
  });
  els.editor.addEventListener('input', saveDraft);
  els.editor.addEventListener('keydown', (event) => {
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      els.editor.setRangeText('  ', els.editor.selectionStart, els.editor.selectionEnd, 'end');
      saveDraft();
    }
  });

  const [{ topics }] = await Promise.all([getJson('/api/topics').catch(() => ({ topics: [] })), loadProblemList()]);
  for (const topic of topics) els.topicList.append(new Option(topic));
}

async function loadProblemList() {
  const { problems } = await getJson('/api/problems').catch(() => ({ problems: [] }));
  els.picker.length = 1; // keep the placeholder
  for (const p of problems) els.picker.append(new Option(`${p.title} · ${p.topic} · ${p.difficulty}`, p.id));
}

async function generate() {
  if (busy) return;
  setBusy(true);
  setStatus(STAGES.generating);
  try {
    const res = await postJson('/api/problems', { topic: els.topic.value, difficulty: els.difficulty.value });
    if (!res.ok) return setStatus(await errorMessage(res), true);
    for await (const { event, data } of readSse(res.body)) {
      if (event === 'progress') setStatus(STAGES[data.stage] ?? 'Working…');
      else if (event === 'problem') {
        setStatus('');
        show(data);
        await loadProblemList();
        els.picker.value = data.id;
      } else if (event === 'error') setStatus(data.message, true);
    }
  } catch {
    setStatus('Connection lost while generating. Try again.', true);
  } finally {
    setBusy(false);
  }
}

/** @param {string} id */
async function openProblem(id) {
  try {
    show(await getJson(`/api/problems/${encodeURIComponent(id)}`));
    setStatus('');
  } catch {
    setStatus('Could not load that problem.', true);
  }
}

function show(p) {
  problem = p;
  els.workspace.hidden = false;
  els.title.textContent = p.title;
  els.meta.textContent = `${p.topic} · ${p.difficulty} · ${p.visibleTests.length} visible tests, ${p.hiddenTestCount} hidden`;
  els.statement.replaceChildren(renderMarkdown(p.statement));
  els.visibleTests.replaceChildren(
    renderMarkdown(p.visibleTests.map((t) => `**${t.name}**\n\`\`\`js\n${t.code}\n\`\`\``).join('\n\n')),
  );
  els.editor.value = loadDraft(p.id) ?? p.starterCode;
  els.results.replaceChildren();
  els.review.replaceChildren();
}

async function run() {
  if (!problem || busy) return;
  setBusy(true);
  els.review.replaceChildren();
  els.results.replaceChildren(el('p', 'note', 'Running visible tests…'));
  try {
    const res = await postJson(`/api/problems/${problem.id}/run`, { code: els.editor.value });
    if (!res.ok) return els.results.replaceChildren(el('p', 'error', await errorMessage(res)));
    renderResults(await res.json());
  } catch {
    els.results.replaceChildren(el('p', 'error', 'Connection lost. Try again.'));
  } finally {
    setBusy(false);
  }
}

async function submit() {
  if (!problem || busy) return;
  setBusy(true);
  els.results.replaceChildren(el('p', 'note', 'Running all tests…'));
  els.review.replaceChildren();
  let review = '';
  let frame = 0;
  const paint = () => {
    frame = 0;
    els.review.replaceChildren(renderMarkdown(review));
  };
  try {
    const res = await postJson(`/api/problems/${problem.id}/submit`, { code: els.editor.value });
    if (!res.ok) return els.results.replaceChildren(el('p', 'error', await errorMessage(res)));
    for await (const { event, data } of readSse(res.body)) {
      if (event === 'result') {
        renderResults(data);
        els.review.replaceChildren(el('p', 'note', 'Reviewing your code…'));
      } else if (event === 'text') {
        review += data.delta;
        frame ||= requestAnimationFrame(paint);
      } else if (event === 'error') {
        els.review.append(el('p', 'error', data.message));
      }
    }
  } catch {
    els.review.append(el('p', 'error', 'Connection lost. Try again.'));
  } finally {
    if (frame) cancelAnimationFrame(frame);
    if (review) paint();
    setBusy(false);
  }
}

function renderResults(result) {
  const summary = el('p', `summary ${result.passed === result.total && result.status === 'ok' ? 'pass' : 'fail'}`);
  summary.textContent = `${result.passed}/${result.total} tests passed · ${result.durationMs} ms`;
  const nodes = [summary];
  if (result.status !== 'ok') nodes.push(el('p', 'error', `${labelFor(result.status)}${result.error ? `: ${result.error}` : ''}`));

  const list = el('ul', 'tests');
  for (const t of result.tests) {
    const item = el('li', t.passed ? 'ok' : 'failed', t.name);
    if (t.hidden) item.append(el('span', 'tag', 'hidden'));
    if (t.error) item.append(el('pre', 'test-error', t.error));
    list.append(item);
  }
  nodes.push(list);
  if (result.logs) {
    const details = el('details');
    details.append(el('summary', '', 'Console output'), el('pre', '', result.logs));
    nodes.push(details);
  }
  els.results.replaceChildren(...nodes);
}

function labelFor(status) {
  return (
    { compile_error: 'Syntax error', timeout: 'Timed out', memory_limit: 'Memory limit', crashed: 'Crashed' }[status] ??
    status
  );
}

function setBusy(value) {
  busy = value;
  for (const button of [els.generate, els.run, els.submit, els.reset]) button.disabled = value;
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

function saveDraft() {
  if (!problem) return;
  try {
    localStorage.setItem(DRAFT_PREFIX + problem.id, els.editor.value);
  } catch {
    // storage unavailable: drafts just aren't kept
  }
}

function loadDraft(id) {
  try {
    return localStorage.getItem(DRAFT_PREFIX + id);
  } catch {
    return null;
  }
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function postJson(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function errorMessage(res) {
  const body = await res.json().catch(() => null);
  return body?.error?.message ?? `Request failed (HTTP ${res.status}).`;
}

function el(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
