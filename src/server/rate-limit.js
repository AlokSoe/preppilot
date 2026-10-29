/**
 * Fixed-window rate limiter, in memory: at most `limit` hits per key per
 * window. Good enough for one instance; with several instances this moves
 * to Redis (INCR + EXPIRE does the same thing).
 */
export class RateLimiter {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  #windows = new Map();

  /** @param {{ now?: () => number }} [options] */
  constructor({ now = Date.now } = {}) {
    this.now = now;
  }

  /**
   * @param {string} key e.g. "login:203.0.113.7"
   * @param {number} limit
   * @param {number} windowMs
   * @returns {{ ok: boolean, retryAfterSec: number }}
   */
  hit(key, limit, windowMs) {
    const now = this.now();
    if (this.#windows.size > 10_000) this.#prune(now);
    let window = this.#windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + windowMs };
      this.#windows.set(key, window);
    }
    window.count++;
    return { ok: window.count <= limit, retryAfterSec: Math.ceil((window.resetAt - now) / 1000) };
  }

  #prune(now) {
    for (const [key, window] of this.#windows) if (window.resetAt <= now) this.#windows.delete(key);
  }
}
