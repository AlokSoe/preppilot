import { randomUUID } from 'node:crypto';

/**
 * @typedef {{ name: string, code: string }} TestCase
 * @typedef {{
 *   id: string,
 *   source: 'generated' | 'repo',
 *   topic: string,
 *   difficulty: 'easy' | 'medium' | 'hard',
 *   title: string,
 *   statement: string,
 *   starterCode: string,
 *   referenceSolution: string,
 *   visibleTests: TestCase[],
 *   hiddenTests: TestCase[],
 *   verifiedAt: string,
 *   createdAt: string,
 * }} Problem
 */

/** Problems are shared by all users: each one costs model tokens only once. */
export class ProblemStore {
  /** @param {import('node:sqlite').DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }

  /** @param {Omit<Problem, 'id' | 'createdAt' | 'verifiedAt'>} problem @returns {Problem} */
  insert(problem) {
    const now = new Date().toISOString();
    const row = { ...problem, id: randomUUID(), createdAt: now, verifiedAt: now };
    this.db
      .prepare(
        `INSERT INTO problems (id, source, topic, difficulty, title, statement, starter_code, reference_solution,
                               visible_tests, hidden_tests, verified_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.source,
        row.topic,
        row.difficulty,
        row.title,
        row.statement,
        row.starterCode,
        row.referenceSolution,
        JSON.stringify(row.visibleTests),
        JSON.stringify(row.hiddenTests),
        row.verifiedAt,
        row.createdAt,
      );
    return row;
  }

  /** @param {string} id @returns {Problem | undefined} */
  get(id) {
    const row = this.db.prepare('SELECT * FROM problems WHERE id = ?').get(id);
    return row ? fromRow(row) : undefined;
  }

  /** @param {{ topic?: string }} [filter] */
  list({ topic } = {}) {
    const rows = topic
      ? this.db.prepare('SELECT * FROM problems WHERE topic = ? ORDER BY created_at DESC').all(topic)
      : this.db.prepare('SELECT * FROM problems ORDER BY created_at DESC LIMIT 200').all();
    return rows.map(fromRow);
  }

  /** Titles already generated for a topic, so the generator can avoid repeats. @param {string} topic */
  titles(topic) {
    return this.db
      .prepare('SELECT title FROM problems WHERE topic = ? ORDER BY created_at DESC LIMIT 50')
      .all(topic)
      .map((r) => String(r.title));
  }
}

/** What users may see: no reference solution, no hidden test code. @param {Problem} p */
export function publicProblem(p) {
  return {
    id: p.id,
    source: p.source,
    topic: p.topic,
    difficulty: p.difficulty,
    title: p.title,
    statement: p.statement,
    starterCode: p.starterCode,
    visibleTests: p.visibleTests,
    hiddenTestCount: p.hiddenTests.length,
    createdAt: p.createdAt,
  };
}

/** @returns {Problem} */
function fromRow(row) {
  return {
    id: String(row.id),
    source: row.source,
    topic: String(row.topic),
    difficulty: row.difficulty,
    title: String(row.title),
    statement: String(row.statement),
    starterCode: String(row.starter_code),
    referenceSolution: String(row.reference_solution),
    visibleTests: JSON.parse(String(row.visible_tests)),
    hiddenTests: JSON.parse(String(row.hidden_tests)),
    verifiedAt: String(row.verified_at),
    createdAt: String(row.created_at),
  };
}
