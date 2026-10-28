import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db/database.js';
import { ProgressStore, canonicalTopic, nextMastery } from '../src/progress/progress.js';
import { DEFAULT_RUBRIC, loadRounds, parseMockInterview, roundBriefing } from '../src/interview/rounds.js';
import { GRADE_SCHEMA } from '../src/interview/grader.js';
import { createApp } from '../src/server/app.js';
import { MemorySessionStore } from '../src/server/sessions.js';
import { ProblemStore } from '../src/problems/store.js';
import { CodeRunner } from '../src/runner/runner.js';
import { readSse } from '../web/sse.js';
import { validate } from '../src/agent/validate.js';

const MOCK = `# 28 — Mock Interview Script

## Round 4 — Async / Event Loop (~45 min)

Format: harder questions.
Pull from: [11-event-loop](../11-event-loop/questions.md), [12-promises](../12-promises/questions.md).
Target: 4 traces.

## Round 7 — Browser Platform: DOM & Networking (~30 min)

Pull from: [29-dom-browser-events](../29-dom-browser-events/questions.md).

---

## Scoring Rubric (used after every answer, every round)

For each answer, score 1–10 against correctness.

---

## How to start a live session
Say "start".`;

test('parses rounds, their topics and the rubric from the mock-interview script', () => {
  const { rounds, rubric } = parseMockInterview(MOCK);
  assert.deepEqual(
    rounds.map(({ id, name, minutes, topics }) => ({ id, name, minutes, topics })),
    [
      { id: 4, name: 'Async / Event Loop', minutes: 45, topics: ['event-loop', 'promises'] },
      { id: 7, name: 'Browser Platform: DOM & Networking', minutes: 30, topics: ['dom-browser-events'] },
    ],
  );
  assert.match(rubric, /score 1–10 against correctness/);
  assert.doesNotMatch(rubric, /How to start/);
  assert.match(roundBriefing(rounds[0]), /Run Round 4: Async \/ Event Loop \(~45 min\)[\s\S]*event-loop, promises/);
});

test('falls back to a default round and rubric when the notes have no script', async () => {
  const { rounds, rubric } = await loadRounds(['/nonexistent']);
  assert.equal(rounds.length, 1);
  assert.equal(rubric, DEFAULT_RUBRIC);
});

test('topic aliases merge duplicates across the two repos', () => {
  assert.equal(canonicalTopic('scope-and-closures'), 'closures');
  assert.equal(canonicalTopic('This Keyword'), 'this');
  assert.equal(canonicalTopic('event-loop'), 'event-loop');
});

test('SM-2: passing scores push the review out, a weak score brings it back tomorrow', () => {
  let s = nextMastery(undefined, 8);
  assert.deepEqual([s.intervalDays, s.repetitions, s.mastery], [1, 1, 80]);
  s = nextMastery(s, 9);
  assert.equal(s.intervalDays, 3);
  s = nextMastery(s, 9);
  assert.ok(s.intervalDays >= 7, `third pass interval ${s.intervalDays}`);
  const weak = nextMastery(s, 3);
  assert.deepEqual([weak.intervalDays, weak.repetitions], [1, 0]);
  assert.ok(weak.ease < s.ease);
  assert.ok(weak.mastery < s.mastery);
  assert.ok(nextMastery({ ...weak, ease: 1.3 }, 1).ease >= 1.3, 'ease never drops below 1.3');
});

test('ProgressStore: records attempts and orders "next up" by overdue, then weakest', () => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const store = new ProgressStore(openDatabase(':memory:'), { now: () => now });
  store.record({ userId: 'u', kind: 'interview', topic: 'promises', score: 9 });
  store.record({ userId: 'u', kind: 'interview', topic: 'scope-and-closures', score: 3 });
  store.record({ userId: 'u', kind: 'code', topic: 'event-loop', score: 6 });
  store.record({ userId: 'other', kind: 'code', topic: 'this', score: 2 });

  const today = store.summary('u', { allTopics: ['promises', 'this-keyword', 'dom'] });
  assert.deepEqual(today.topics.map((t) => t.topic), ['closures', 'event-loop', 'promises']); // weakest first
  assert.equal(today.attempts, 3);
  assert.equal(today.averageScore, 6);
  assert.deepEqual(today.untried, ['dom-browser-events', 'this']);
  assert.ok(today.topics.every((t) => !t.due));
  assert.deepEqual(today.next, ['closures', 'event-loop', 'promises'], 'nothing due yet: weakest first');


  now += 2 * 24 * 60 * 60 * 1000; // two days later: the 1-day intervals are due
  const later = store.summary('u');
  // All three became due at the same moment, so the weakest goes first.
  assert.deepEqual(later.next, ['closures', 'event-loop', 'promises']);
  assert.ok(later.topics.every((t) => t.due));
});

test('a topic that is due outranks a weaker topic that is not', () => {
  const DAY = 24 * 60 * 60 * 1000;
  let now = 0;
  const store = new ProgressStore(openDatabase(':memory:'), { now: () => now });
  store.record({ userId: 'u', kind: 'interview', topic: 'promises', score: 8 }); // due on day 1
  now = 3 * DAY;
  store.record({ userId: 'u', kind: 'interview', topic: 'closures', score: 2 }); // due on day 4
  const { next, topics } = store.summary('u');
  assert.deepEqual(next, ['promises', 'closures']);
  assert.deepEqual(topics.map((t) => [t.topic, t.due]), [['closures', false], ['promises', true]]);
});

test('scores are clamped to 1-10', () => {
  const store = new ProgressStore(openDatabase(':memory:'));
  assert.equal(store.record({ userId: 'u', kind: 'code', topic: 'x', score: 0 }).lastScore, 1);
  assert.equal(store.record({ userId: 'u', kind: 'code', topic: 'x', score: 42 }).lastScore, 10);
});

// ---- A full interview turn over HTTP, with a fake model ---------------------

const GRADE = {
  score: 6,
  criteria: { correctness: 7, depth: 5, clarity: 7, internals: 5, seniority: 4 },
  verdict: 'Correct order, but no mention of the microtask checkpoint.',
  strengths: ['Right output order'],
  gaps: ['Why microtasks drain first'],
  misconceptions: [],
  idealAnswer: 'Microtasks run after the current task, before the next macrotask.',
  followUps: ['What happens with queueMicrotask inside a microtask?'],
};

let server;
let baseUrl;
let progress;
let interviewerCalls;

before(async () => {
  const db = openDatabase(':memory:');
  progress = new ProgressStore(db);
  interviewerCalls = [];
  let step = 0;
  const provider = {
    name: 'fake',
    async *streamTurn(args) {
      interviewerCalls.push(structuredClone(args));
      step++;
      if (step === 1) {
        yield { type: 'text', delta: 'Question 1: what logs first?' };
        return { content: [{ type: 'text', text: 'Question 1: what logs first?' }], stopReason: 'end', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
      }
      if (step === 2) {
        return {
          content: [{ type: 'tool_call', id: 'g1', name: 'grade_answer', input: { question: 'What logs first?', answer: 'promise then timeout', topic: 'event-loop' } }],
          stopReason: 'tool_calls',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        };
      }
      yield { type: 'text', delta: 'Good. 6/10.' };
      return { content: [{ type: 'text', text: 'Good. 6/10.' }], stopReason: 'end', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
    },
    async generateJson() {
      return { data: GRADE, text: JSON.stringify(GRADE), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
    },
    async validateKey() {},
  };
  const { rounds, rubric } = parseMockInterview(MOCK);
  const handler = createApp({
    kb: /** @type {any} */ ({ stats: {}, topics: () => ['event-loop'], search: () => [] }),
    provider: /** @type {any} */ (provider),
    sessions: new MemorySessionStore(),
    runner: new CodeRunner(),
    problems: new ProblemStore(db),
    progress,
    interview: { rounds, rubric },
    log: () => {},
  });
  server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const post = (url, body) =>
  fetch(baseUrl + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function events(res) {
  const out = [];
  for await (const e of readSse(res.body)) out.push(e);
  return out;
}

test('GET /api/rounds lists rounds; unknown rounds are rejected', async () => {
  const { rounds } = await (await fetch(`${baseUrl}/api/rounds`)).json();
  assert.deepEqual(rounds.map((r) => r.id), [4, 7]);
  assert.equal((await post('/api/sessions', { mode: 'interview', round: 99 })).status, 400);
});

test('interview: briefing is sent hidden, answers are graded, scored and recorded', async () => {
  const { id } = await (await post('/api/sessions', { mode: 'interview', round: 4 })).json();

  await events(await post(`/api/sessions/${id}/messages`, { text: 'Start the interview.' }));
  const firstRequest = interviewerCalls[0];
  assert.match(firstRequest.system, /mock JavaScript interview/);
  const [briefing, typed] = firstRequest.messages[0].content;
  assert.equal(briefing.hidden, true);
  assert.match(briefing.text, /Run Round 4/);
  assert.equal(typed.text, 'Start the interview.');
  assert.ok(firstRequest.tools.some((t) => t.name === 'grade_answer'));

  const stream = await events(await post(`/api/sessions/${id}/messages`, { text: 'promise then timeout' }));
  const score = stream.find((e) => e.event === 'score');
  assert.equal(score.data.score, 6);
  assert.equal(score.data.topic, 'event-loop');
  assert.equal(stream.find((e) => e.event === 'tool_end').data.summary, `6/10 · ${GRADE.verdict}`);

  // The second request did NOT repeat the briefing.
  assert.equal(interviewerCalls[1].messages.at(-1).content.length, 1);

  // History hides the briefing.
  const history = await (await fetch(`${baseUrl}/api/sessions/${id}`)).json();
  assert.equal(history.messages[0].text, 'Start the interview.');
  // ...and restores the score card from the grade_answer result.
  assert.equal(history.messages.at(-1).scores[0].score, 6);

  // Progress recorded the graded answer.
  const summary = await (await fetch(`${baseUrl}/api/progress`)).json();
  assert.equal(summary.attempts, 1);
  assert.equal(summary.topics[0].topic, 'event-loop');
  assert.equal(summary.topics[0].lastScore, 6);
});

test('grade schema accepts a valid grade', () => {
  assert.deepEqual(validate(GRADE_SCHEMA, GRADE), []);
  assert.ok(validate(GRADE_SCHEMA, { ...GRADE, score: 11 }).length > 0);
});
