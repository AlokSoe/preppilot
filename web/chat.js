import { readSse } from './sse.js';
import { renderMarkdown } from './markdown.js';
import { toRunnableFile } from './runnable.js';

/**
 * A chat view (used by Ask and Interview): message log, composer, streaming,
 * session restore. Builds its own DOM inside `root`.
 *
 * @param {HTMLElement} root
 * @param {{
 *   mode: 'ask' | 'interview' | 'build',
 *   newLabel: string,
 *   placeholder: string,
 *   renderEmpty: (start: (sessionOptions?: object, firstMessage?: string) => Promise<void>, send: (text: string) => void) => Node,
 * }} options
 */
export function createChatView(root, { mode, newLabel, placeholder, renderEmpty }) {
  const storageKey = `preppilot.session.${mode}`;
  const log = el('main', 'log');
  log.setAttribute('role', 'log');
  const empty = el('section', 'empty');
  const toolbar = el('div', 'chat-toolbar');
  const sessionLabel = el('span', 'session-label');
  const newButton = el('button', 'ghost', newLabel);
  newButton.type = 'button';
  toolbar.append(sessionLabel, newButton);

  const form = el('form', 'composer');
  const label = el('label', 'visually-hidden', 'Your message');
  const input = /** @type {HTMLTextAreaElement} */ (el('textarea'));
  input.id = `${mode}-input`;
  label.htmlFor = input.id;
  input.rows = 1;
  input.maxLength = 4000;
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  const sendButton = el('button', '', 'Send');
  sendButton.type = 'submit';
  const stopButton = el('button', 'danger', 'Stop');
  stopButton.type = 'button';
  stopButton.hidden = true;
  form.append(label, input, sendButton, stopButton);
  const hint = el('p', 'hint', 'Enter to send · Shift+Enter for a new line');

  log.append(empty);
  root.append(toolbar, log, form, hint);

  /** @type {string | null} */
  let sessionId = null;
  /** @type {AbortController | null} */
  let inFlight = null;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autoResize();
    send(text);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  input.addEventListener('input', autoResize);
  stopButton.addEventListener('click', () => inFlight?.abort());
  newButton.addEventListener('click', () => reset());

  restoreOrReset();

  async function restoreOrReset() {
    const saved = storage('get');
    if (saved && (await restore(saved))) return;
    // Interview waits for a round to be picked; the other modes start right away.
    if (mode === 'interview') showEmpty();
    else await start();
  }

  /** Reload the conversation after a page refresh. @param {string} id */
  async function restore(id) {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
      if (!res.ok) return false;
      const session = await res.json();
      sessionId = id;
      setLabel(session);
      for (const message of session.messages) {
        if (message.role === 'user') {
          addUserMessage(message.text);
        } else {
          const view = createAssistantMessage();
          message.tools.forEach((tool, i) => {
            view.toolStart({ id: String(i), name: tool.name, input: tool.input });
            view.toolEnd({ id: String(i), ok: true, summary: '' });
          });
          for (const score of message.scores ?? []) view.score(score);
          view.setText(message.text);
          view.finish();
        }
      }
      updateEmptyState();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a session, then optionally send a first message.
   * @param {object} [sessionOptions] e.g. { round: 4 }
   * @param {string} [firstMessage]
   */
  async function start(sessionOptions = {}, firstMessage) {
    clearLog();
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, ...sessionOptions }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const session = await res.json();
      sessionId = session.id;
      storage('set', sessionId);
      setLabel(session);
    } catch {
      sessionId = null;
      log.append(el('p', 'banner', 'Could not reach the PrepPilot server. Is it running?'));
      return;
    }
    updateEmptyState();
    if (firstMessage) await send(firstMessage);
    input.focus();
  }

  async function reset() {
    inFlight?.abort();
    sessionId = null;
    storage('remove');
    clearLog();
    if (mode === 'interview') showEmpty();
    else await start();
  }

  function showEmpty() {
    clearLog();
    setLabel(null);
  }

  function clearLog() {
    for (const node of [...log.querySelectorAll('.message, .banner')]) node.remove();
    empty.replaceChildren(renderEmpty(start, (text) => send(text)));
    updateEmptyState();
  }

  function setLabel(session) {
    sessionLabel.textContent = session?.round ? `Round ${session.round}` : '';
    form.hidden = mode === 'interview' && !session;
    hint.hidden = form.hidden;
  }

  /** @param {string} text */
  async function send(text) {
    if (!sessionId || inFlight) return;
    addUserMessage(text);
    const view = createAssistantMessage();
    inFlight = new AbortController();
    setBusy(true);

    let answer = '';
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: inFlight.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        view.error(
          res.status === 404
            ? `This conversation expired. Click "${newLabel}" to start again.`
            : (body?.error?.message ?? `Request failed (HTTP ${res.status}).`),
        );
        return;
      }
      for await (const { event, data } of readSse(/** @type {ReadableStream} */ (res.body))) {
        switch (event) {
          case 'text':
            answer += data.delta;
            view.setText(answer);
            break;
          case 'tool_start':
            view.toolStart(data);
            break;
          case 'tool_end':
            view.toolEnd(data);
            break;
          case 'score':
            view.score(data);
            break;
          case 'retry':
            view.note('Retrying a step…');
            break;
          case 'done':
            view.done(data);
            break;
          case 'error':
            view.error(data.message);
            break;
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') view.note('Stopped.');
      else view.error('Connection lost. Check that the server is running and try again.');
    } finally {
      inFlight = null;
      setBusy(false);
      view.finish();
      input.focus();
    }
  }

  /** @param {string} text */
  function addUserMessage(text) {
    const message = el('article', 'message user');
    message.append(el('p', 'bubble', text));
    appendMessage(message);
  }

  /**
   * One answer: tool activity, score cards, streamed markdown and a footer.
   * Markdown is re-rendered at most once per animation frame.
   */
  function createAssistantMessage() {
    const message = el('article', 'message assistant');
    message.setAttribute('aria-busy', 'true');
    const activity = el('ul', 'activity');
    const scores = el('div', 'scores');
    const body = el('div', 'markdown');
    const footer = el('p', 'meta');
    message.append(activity, scores, body, footer);
    appendMessage(message);

    let latest = '';
    let frame = 0;
    /** run_code inputs by tool id, so a passing run can be downloaded */
    const runs = new Map();
    const render = () => {
      frame = 0;
      const pinned = isPinnedToBottom();
      body.replaceChildren(renderMarkdown(latest));
      if (pinned) scrollToBottom();
    };

    return {
      /** @param {string} text */
      setText(text) {
        latest = text;
        if (!frame) frame = requestAnimationFrame(render);
      },
      toolStart({ id, name, input: toolInput }) {
        const item = el('li', 'running', describeTool(name, toolInput));
        item.dataset.id = id;
        activity.append(item);
        if (name === 'run_code') runs.set(id, toolInput);
      },
      toolEnd({ id, ok, summary }) {
        const item = activity.querySelector(`li[data-id="${CSS.escape(id)}"]`);
        if (!item) return;
        item.className = ok ? 'ok' : 'failed';
        if (summary && !item.textContent?.startsWith('Graded')) item.append(el('span', 'summary', ` · ${summary}`));
        // A run where every test passed (or a restored one) can be downloaded.
        const run = runs.get(id);
        const counts = /(\d+)\/(\d+)/.exec(summary ?? '');
        if (run && ok && (!summary || (counts && counts[1] === counts[2]))) {
          item.append(' ', downloadButton(run));
        }
      },
      score(grade) {
        scores.append(renderScoreCard(grade));
      },
      done({ status, usage }) {
        const notes = {
          refused: 'The model declined to answer this. Try rephrasing.',
          truncated: 'The answer was cut off at the maximum length.',
          iteration_limit: 'Stopped after too many steps.',
        };
        if (notes[status]) this.note(notes[status]);
        const cached = usage.cacheRead ? ` · ${usage.cacheRead.toLocaleString()} cached` : '';
        footer.textContent = `${usage.input.toLocaleString()} in${cached} · ${usage.output.toLocaleString()} out tokens`;
      },
      /** @param {string} text */
      error(text) {
        message.append(el('p', 'error', text));
      },
      /** @param {string} text */
      note(text) {
        message.append(el('p', 'note', text));
      },
      finish() {
        if (frame) cancelAnimationFrame(frame);
        render();
        message.removeAttribute('aria-busy');
        for (const item of activity.querySelectorAll('li.running')) item.className = 'failed';
      },
    };
  }

  /** @param {HTMLElement} message */
  function appendMessage(message) {
    log.append(message);
    updateEmptyState();
    scrollToBottom();
  }

  function updateEmptyState() {
    empty.hidden = log.querySelector('.message') !== null;
  }

  /** @param {boolean} busy */
  function setBusy(busy) {
    sendButton.hidden = busy;
    stopButton.hidden = !busy;
    newButton.disabled = busy;
  }

  function autoResize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }

  function isPinnedToBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  }

  function scrollToBottom() {
    log.scrollTop = log.scrollHeight;
  }

  /** sessionStorage can throw (private mode, blocked storage); the app works without it. */
  function storage(action, value) {
    try {
      if (action === 'get') return sessionStorage.getItem(storageKey);
      if (action === 'remove') sessionStorage.removeItem(storageKey);
      else sessionStorage.setItem(storageKey, value);
    } catch {
      return null;
    }
    return null;
  }

  return { focus: () => input.focus() };
}

/** A button that saves the code and its tests as one runnable file. */
function downloadButton({ code, tests }) {
  const button = el('button', 'link-button', 'Download code + tests');
  button.type = 'button';
  button.addEventListener('click', () => {
    const blob = new Blob([toRunnableFile(code, tests)], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement('a'), { href: url, download: 'preppilot-build.js' });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  return button;
}

function describeTool(name, input) {
  if (name === 'search_notes') {
    const topic = input?.topic ? ` in ${input.topic}` : '';
    return `Searched notes for “${input?.query ?? ''}”${topic}`;
  }
  if (name === 'list_topics') return 'Listed topics';
  if (name === 'grade_answer') return `Graded your answer (${input?.topic ?? 'topic'})`;
  if (name === 'run_code') return `Ran ${input?.tests?.length ?? 0} tests in the sandbox`;
  return `Used ${name}`;
}

const CRITERIA = [
  ['correctness', 'Correctness'],
  ['depth', 'Depth'],
  ['clarity', 'Clarity'],
  ['internals', 'Internals'],
  ['seniority', 'Senior thinking'],
];

/** The grader's result as a card: score, verdict, criteria, feedback. */
export function renderScoreCard(grade) {
  const band = grade.score >= 9 ? 'great' : grade.score >= 7 ? 'good' : grade.score >= 4 ? 'fair' : 'weak';
  const card = el('section', `score-card ${band}`);
  const head = el('div', 'score-head');
  head.append(el('span', 'score-value', `${grade.score}/10`), el('span', 'score-verdict', grade.verdict ?? ''));
  card.append(head);

  if (grade.criteria) {
    const bars = el('dl', 'criteria');
    for (const [key, name] of CRITERIA) {
      const value = Number(grade.criteria[key] ?? 0);
      const meter = el('meter');
      Object.assign(meter, { min: 0, max: 10, low: 4, high: 7, optimum: 10, value });
      meter.setAttribute('aria-label', `${name} ${value} out of 10`);
      const dd = el('dd');
      dd.append(meter, el('span', '', String(value)));
      bars.append(el('dt', '', name), dd);
    }
    card.append(bars);
  }

  const list = (title, items, className) => {
    if (!items?.length) return;
    const section = el('div', className);
    const ul = el('ul');
    for (const item of items) ul.append(el('li', '', item));
    section.append(el('h4', '', title), ul);
    card.append(section);
  };
  list('What you got right', grade.strengths, 'strengths');
  list('What was missing', grade.gaps, 'gaps');
  list('Incorrect claims', grade.misconceptions, 'misconceptions');

  if (grade.idealAnswer) {
    const details = el('details');
    const body = el('div', 'markdown');
    body.append(renderMarkdown(grade.idealAnswer));
    details.append(el('summary', '', 'Ideal answer'), body);
    if (grade.score <= 6) details.open = true;
    card.append(details);
  }
  return card;
}

/** @param {string} tag @param {string} [className] @param {string} [text] */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
