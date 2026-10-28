import { randomUUID } from 'node:crypto';

/**
 * @typedef {{
 *   id: string,
 *   mode: 'ask' | 'interview' | 'build',
 *   roundId: number | null,
 *   messages: import('../llm/provider.js').Message[],
 *   busy: boolean,
 *   createdAt: number,
 *   lastActiveAt: number,
 * }} Session
 */

const TTL_MS = 6 * 60 * 60 * 1000; // idle sessions expire after 6 hours
const MAX_SESSIONS = 1000;

/**
 * In-memory session store. Same interface the SQLite store will have
 * (create / get / touch), so swapping it later doesn't touch the routes.
 */
export class MemorySessionStore {
  /** @type {Map<string, Session>} insertion order = oldest first */
  #sessions = new Map();

  constructor({ ttlMs = TTL_MS, maxSessions = MAX_SESSIONS, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxSessions = maxSessions;
    this.now = now;
  }

  /** @param {{ mode: Session['mode'], roundId?: number | null }} init */
  create({ mode, roundId = null }) {
    this.#evict();
    const time = this.now();
    /** @type {Session} */
    const session = { id: randomUUID(), mode, roundId, messages: [], busy: false, createdAt: time, lastActiveAt: time };
    this.#sessions.set(session.id, session);
    return session;
  }

  /** @param {string} id @returns {Session | undefined} */
  get(id) {
    const session = this.#sessions.get(id);
    if (session && this.now() - session.lastActiveAt > this.ttlMs) {
      this.#sessions.delete(id);
      return undefined;
    }
    return session;
  }

  /** Mark a session as used: moves it to the "newest" end. @param {Session} session */
  touch(session) {
    session.lastActiveAt = this.now();
    this.#sessions.delete(session.id);
    this.#sessions.set(session.id, session);
  }

  get size() {
    return this.#sessions.size;
  }

  /** Drop expired sessions, then the least recently used if still full (never a busy one). */
  #evict() {
    const time = this.now();
    for (const [id, session] of this.#sessions) {
      if (time - session.lastActiveAt > this.ttlMs && !session.busy) this.#sessions.delete(id);
    }
    for (const [id, session] of this.#sessions) {
      if (this.#sessions.size < this.maxSessions) break;
      if (!session.busy) this.#sessions.delete(id);
    }
  }
}
