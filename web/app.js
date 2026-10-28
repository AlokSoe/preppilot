import { createChatView, el } from './chat.js';
import { showProgress } from './progress.js';

const ASK_EXAMPLES = [
  'Explain microtasks vs macrotasks with an example',
  'How does event delegation work, and when would you use it?',
  'What should I say when asked to implement an LRU cache?',
  'Debounce vs throttle: differences and use cases',
];

const VIEWS = ['ask', 'interview', 'code', 'progress'];

// ---- Ask -------------------------------------------------------------------
createChatView(/** @type {HTMLElement} */ (document.getElementById('ask-view')), {
  mode: 'ask',
  newLabel: 'New chat',
  placeholder: 'Ask about closures, the event loop, an LRU cache…',
  renderEmpty: (start, send) => {
    const fragment = document.createDocumentFragment();
    const examples = el('div', 'examples');
    for (const text of ASK_EXAMPLES) {
      const button = el('button', 'example', text);
      button.type = 'button';
      button.addEventListener('click', () => send(text));
      examples.append(button);
    }
    fragment.append(
      el('h1', '', 'Ask anything about JavaScript'),
      el('p', '', 'Answers come from your own notes, with the file and section they came from.'),
      examples,
    );
    return fragment;
  },
});

// ---- Interview -------------------------------------------------------------
/** @type {Promise<{ id: number, name: string, minutes: number | null, topics: string[] }[]>} */
const roundsPromise = fetch('/api/rounds')
  .then((res) => (res.ok ? res.json() : { rounds: [] }))
  .then((body) => body.rounds)
  .catch(() => []);

createChatView(/** @type {HTMLElement} */ (document.getElementById('interview-view')), {
  mode: 'interview',
  newLabel: 'New interview',
  placeholder: 'Type your answer… (say "I don\'t know" if you don\'t)',
  renderEmpty: (start) => {
    const fragment = document.createDocumentFragment();
    const grid = el('div', 'rounds');
    fragment.append(
      el('h1', '', 'Mock interview'),
      el('p', '', 'Pick a round. Questions come one at a time; every answer is scored 1–10 against your rubric.'),
      grid,
    );
    roundsPromise.then((rounds) => {
      if (!rounds.length) grid.append(el('p', 'error', 'Could not load interview rounds.'));
      for (const round of rounds) {
        const card = el('button', 'round');
        card.type = 'button';
        card.append(
          el('strong', '', `Round ${round.id} · ${round.name}`),
          el('span', 'meta', `${round.minutes ? `~${round.minutes} min · ` : ''}${round.topics.join(', ')}`),
        );
        card.addEventListener('click', () => start({ round: round.id }, 'Start the interview.'));
        grid.append(card);
      }
    });
    return fragment;
  },
});

// ---- Navigation --------------------------------------------------------------
/** #ask / #interview / #code / #progress in the URL picks the view, so back and reload work. */
function showView() {
  const requested = location.hash.slice(1);
  const view = VIEWS.includes(requested) ? requested : 'ask';
  for (const name of VIEWS) {
    /** @type {HTMLElement} */ (document.getElementById(`${name}-view`)).hidden = name !== view;
  }
  for (const tab of document.querySelectorAll('.tabs a')) {
    if (/** @type {HTMLElement} */ (tab).dataset.view === view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  if (view === 'progress') showProgress(/** @type {HTMLElement} */ (document.getElementById('progress-view')));
}

window.addEventListener('hashchange', showView);
showView();
