/**
 * Progress tracking and spaced repetition (design doc §9.7).
 *
 * Every graded interview answer and every code submission is an attempt
 * scored 1-10. Per (user, topic) we keep a mastery score and an SM-2 style
 * review schedule: strong answers push the next review further out, weak
 * ones bring the topic back tomorrow.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const PASSING_SCORE = 7; // "solid, would pass a mid-to-senior loop" in the rubric

/**
 * The two note repos name some topics differently. Map them to one name so
 * progress isn't split across duplicates.
 */
const TOPIC_ALIASES = {
  'scope-and-closures': 'closures',
  'this-keyword': 'this',
  'prototypes-and-inheritance': 'objects-prototypes',
  'async-await': 'promises',
  'asynchronous-javascript': 'promises',
  'advanced-async': 'promises',
  'memory-and-garbage-collection': 'memory-management',
  'performance': 'performance-v8',
  'dom': 'dom-browser-events',
  'browser-apis': 'networking-storage',
  'arrays-and-objects': 'arrays',
  'higher-order-functions': 'functions-currying',
  'functions': 'functions-currying',
  'basics': 'fundamentals',
  'control-flow': 'fundamentals',
};

/** @param {string} topic */
export function canonicalTopic(topic) {
  const normalized = topic.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return TOPIC_ALIASES[normalized] ?? normalized;
}

/**
 * @typedef {{ mastery: number, ease: number, intervalDays: number, repetitions: number,
 *             attempts: number, lastScore: number }} MasteryState
 */

/**
 * Pure SM-2-style update. Score 1-10 maps to SM-2 quality 0-5.
 * @param {MasteryState | undefined} state
 * @param {number} score 1-10
 * @returns {MasteryState}
 */
export function nextMastery(state, score) {
  const s = state ?? { mastery: 0, ease: 2.5, intervalDays: 0, repetitions: 0, attempts: 0, lastScore: 0 };
  const quality = score / 2;

  let { intervalDays, repetitions } = s;
  if (score >= PASSING_SCORE) {
    repetitions += 1;
    intervalDays = repetitions === 1 ? 1 : repetitions === 2 ? 3 : Math.round(s.intervalDays * s.ease);
  } else {
    repetitions = 0;
    intervalDays = 1; // weak: see it again tomorrow
  }
  const ease = Math.max(1.3, s.ease + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  // Exponential moving average on a 0-100 scale; the first attempt sets it directly.
  const mastery = s.attempts === 0 ? score * 10 : Math.round(0.7 * s.mastery + 0.3 * score * 10);

  return { mastery, ease: Number(ease.toFixed(2)), intervalDays, repetitions, attempts: s.attempts + 1, lastScore: score };
}

export class ProgressStore {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {{ now?: () => number }} [options]
   */
  constructor(db, { now = Date.now } = {}) {
    this.db = db;
    this.now = now;
  }

  /**
   * Record a scored attempt and update that topic's schedule, atomically.
   * @param {{ userId: string, kind: 'interview' | 'code', topic: string, score: number,
   *           question?: string, feedback?: string }} attempt
   */
  record({ userId, kind, topic, score, question = '', feedback = '' }) {
    const canonical = canonicalTopic(topic);
    const clamped = Math.min(10, Math.max(1, Math.round(score)));
    const now = this.now();
    const iso = new Date(now).toISOString();

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO attempts (user_id, kind, topic, score, question, feedback, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(userId, kind, canonical, clamped, question.slice(0, 2000), feedback.slice(0, 2000), iso);

      const row = this.db.prepare('SELECT * FROM mastery WHERE user_id = ? AND topic = ?').get(userId, canonical);
      const next = nextMastery(row ? toState(row) : undefined, clamped);
      this.db
        .prepare(
          `INSERT INTO mastery (user_id, topic, mastery, ease, interval_days, repetitions, attempts, last_score, due_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, topic) DO UPDATE SET
             mastery = excluded.mastery, ease = excluded.ease, interval_days = excluded.interval_days,
             repetitions = excluded.repetitions, attempts = excluded.attempts, last_score = excluded.last_score,
             due_at = excluded.due_at, updated_at = excluded.updated_at`,
        )
        .run(
          userId,
          canonical,
          next.mastery,
          next.ease,
          next.intervalDays,
          next.repetitions,
          next.attempts,
          next.lastScore,
          new Date(now + next.intervalDays * DAY_MS).toISOString(),
          iso,
        );
      this.db.exec('COMMIT');
      return { topic: canonical, ...next };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Everything the Progress page needs.
   * @param {string} userId
   * @param {{ allTopics?: string[] }} [options] topics from the notes, to suggest untried ones
   */
  summary(userId, { allTopics = [] } = {}) {
    const now = this.now();
    const topics = this.db
      .prepare('SELECT * FROM mastery WHERE user_id = ? ORDER BY mastery ASC, topic ASC')
      .all(userId)
      .map((row) => ({
        topic: String(row.topic),
        ...toState(row),
        dueAt: String(row.due_at),
        due: Date.parse(String(row.due_at)) <= now,
      }));

    // Next up: overdue topics first (most overdue, then weakest), then the
    // rest by weakest mastery (their exact due times don't matter yet).
    const byPriority = [...topics].sort((a, b) => {
      if (a.due !== b.due) return a.due ? -1 : 1;
      if (a.due) return Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.mastery - b.mastery;
      return a.mastery - b.mastery;
    });
    const tried = new Set(topics.map((t) => t.topic));
    const untried = [...new Set(allTopics.map(canonicalTopic))].filter((t) => !tried.has(t)).sort();

    const recent = this.db
      .prepare('SELECT kind, topic, score, question, feedback, created_at FROM attempts WHERE user_id = ? ORDER BY id DESC LIMIT 20')
      .all(userId)
      .map((r) => ({
        kind: String(r.kind),
        topic: String(r.topic),
        score: Number(r.score),
        question: String(r.question),
        feedback: String(r.feedback),
        createdAt: String(r.created_at),
      }));

    const totals = this.db
      .prepare('SELECT COUNT(*) AS attempts, AVG(score) AS average FROM attempts WHERE user_id = ?')
      .get(userId);

    return {
      topics,
      next: byPriority.slice(0, 3).map((t) => t.topic),
      untried: untried.slice(0, 10),
      recent,
      attempts: Number(totals?.attempts ?? 0),
      averageScore: totals?.average == null ? null : Number(Number(totals.average).toFixed(1)),
    };
  }
}

/** @returns {MasteryState} */
function toState(row) {
  return {
    mastery: Number(row.mastery),
    ease: Number(row.ease),
    intervalDays: Number(row.interval_days),
    repetitions: Number(row.repetitions),
    attempts: Number(row.attempts),
    lastScore: Number(row.last_score),
  };
}
