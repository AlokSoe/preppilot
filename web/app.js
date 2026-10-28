import { readSse } from './sse.js';
import { renderMarkdown } from './markdown.js';

const STORAGE_KEY = 'preppilot.sessionId';
const EXAMPLES = [
  'Explain microtasks vs macrotasks with an example',
  'How does event delegation work, and when would you use it?',
  'What should I say when asked to implement an LRU cache?',
  'Debounce vs throttle: differences and use cases',
];

const els = {
  log: /** @type {HTMLElement} */ (document.getElementById('log')),
  empty: /** @type {HTMLElement} */ (document.getElementById('empty')),
  examples: /** @type {HTMLElement} */ (document.getElementById('examples')),
  form: /** @type {HTMLFormElement} */ (document.getElementById('composer')),
  input: /** @type {HTMLTextAreaElement} */ (document.getElementById('input')),
  send: /** @type {HTMLButtonElement} */ (document.getElementById('send')),
  stop: /** @type {HTMLButtonElement} */ (document.getElementById('stop')),
  newChat: /** @type {HTMLButtonElement} */ (document.getElementById('new-chat')),
};

/** @type {string | null} */
let sessionId = null;
/** @type {AbortController | null} */
let inFlight = null;

init();

/** #ask / #code in the URL picks the view, so the back button and reloads work. */
function showView() {
  const view = location.hash === '#code' ? 'code' : 'ask';
  for (const name of ['ask', 'code']) {
    /** @type {HTMLElement} */ (document.getElementById(`${name}-view`)).hidden = name !== view;
  }
  for (const tab of document.querySelectorAll('.tabs a')) {
    if (/** @type {HTMLElement} */ (tab).dataset.view === view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  els.newChat.hidden = view !== 'ask';
}

async function init() {
  window.addEventListener('hashchange', showView);
  showView();

  for (const text of EXAMPLES) {
    const button = el('button', 'example', text);
    button.type = 'button';
    button.addEventListener('click', () => send(text));
    els.examples.append(button);
  }

  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = els.input.value.trim();
    if (!text) return;
    els.input.value = '';
    autoResize();
    send(text);
  });
  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      els.form.requestSubmit();
    }
  });
  els.input.addEventListener('input', autoResize);
  els.stop.addEventListener('click', () => inFlight?.abort());
  els.newChat.addEventListener('click', () => newSession());

  const saved = storage('get');
  if (saved && (await restoreSession(saved))) return;
  await newSession();
}

/** Reload the conversation after a page refresh. @param {string} id */
async function restoreSession(id) {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
    if (!res.ok) return false;
    const { messages } = await res.json();
    sessionId = id;
    for (const message of messages) {
      if (message.role === 'user') {
        addUserMessage(message.text);
      } else {
        const view = createAssistantMessage();
        message.tools.forEach((tool, i) => {
          view.toolStart({ id: String(i), name: tool.name, input: tool.input });
          view.toolEnd({ id: String(i), ok: true, summary: '' });
        });
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

async function newSession() {
  inFlight?.abort();
  try {
    const res = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sessionId = (await res.json()).id;
    storage('set', sessionId);
  } catch {
    sessionId = null;
    showBanner('Could not reach the PrepPilot server. Is it running?');
  }
  for (const node of [...els.log.querySelectorAll('.message, .banner')]) node.remove();
  updateEmptyState();
  els.input.focus();
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
      if (res.status === 404) {
        view.error('This conversation expired. Start a new chat and send your question again.');
      } else {
        view.error(body?.error?.message ?? `Request failed (HTTP ${res.status}).`);
      }
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
    els.input.focus();
  }
}

/** @param {string} text */
function addUserMessage(text) {
  const message = el('article', 'message user');
  message.append(el('p', 'bubble', text));
  appendMessage(message);
}

/**
 * The assistant's answer: tool activity, the streamed markdown, and a footer.
 * Markdown is re-rendered at most once per animation frame while streaming.
 */
function createAssistantMessage() {
  const message = el('article', 'message assistant');
  message.setAttribute('aria-busy', 'true');
  const activity = el('ul', 'activity');
  const body = el('div', 'markdown');
  const footer = el('p', 'meta');
  message.append(activity, body, footer);
  appendMessage(message);

  let latest = '';
  let frame = 0;
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
    toolStart({ id, name, input }) {
      const item = el('li', 'running', describeTool(name, input));
      item.dataset.id = id;
      activity.append(item);
    },
    toolEnd({ id, ok, summary }) {
      const item = activity.querySelector(`li[data-id="${CSS.escape(id)}"]`);
      if (!item) return;
      item.className = ok ? 'ok' : 'failed';
      if (summary) item.append(el('span', 'summary', ` · ${summary}`));
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

function describeTool(name, input) {
  if (name === 'search_notes') {
    const topic = input?.topic ? ` in ${input.topic}` : '';
    return `Searched notes for “${input?.query ?? ''}”${topic}`;
  }
  if (name === 'list_topics') return 'Listed topics';
  return `Used ${name}`;
}

/** @param {HTMLElement} message */
function appendMessage(message) {
  els.log.append(message);
  updateEmptyState();
  scrollToBottom();
}

/** @param {string} text */
function showBanner(text) {
  els.log.append(el('p', 'banner', text));
}

function updateEmptyState() {
  els.empty.hidden = els.log.querySelector('.message') !== null;
}

/** @param {boolean} busy */
function setBusy(busy) {
  els.send.hidden = busy;
  els.stop.hidden = !busy;
  els.input.placeholder = busy ? 'Answering…' : 'Ask about closures, the event loop, an LRU cache…';
}

function autoResize() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
}

function isPinnedToBottom() {
  return els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 80;
}

function scrollToBottom() {
  els.log.scrollTop = els.log.scrollHeight;
}

/** @param {string} tag @param {string} [className] @param {string} [text] */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** sessionStorage can throw (private mode, blocked storage); the app works without it. */
function storage(action, value) {
  try {
    if (action === 'get') return sessionStorage.getItem(STORAGE_KEY);
    sessionStorage.setItem(STORAGE_KEY, value);
  } catch {
    return null;
  }
  return null;
}
