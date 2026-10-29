/**
 * Daily usage per user and tier ("demo" = the owner's key, "own" = the
 * user's key). Feeds the demo limits and the usage shown in Settings.
 */
export class UsageStore {
  /** @param {import('node:sqlite').DatabaseSync} db @param {{ now?: () => number }} [options] */
  constructor(db, { now = Date.now } = {}) {
    this.db = db;
    this.now = now;
  }

  #day() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /** One user action (a message, a submission). @param {string} userId @param {'demo' | 'own'} tier */
  countRequest(userId, tier) {
    this.#upsert(userId, tier, 1, 0, 0);
  }

  /** Tokens from one model call. @param {string} userId @param {'demo' | 'own'} tier @param {{ input: number, output: number }} usage */
  addTokens(userId, tier, usage) {
    this.#upsert(userId, tier, 0, usage.input, usage.output);
  }

  #upsert(userId, tier, requests, input, output) {
    this.db
      .prepare(
        `INSERT INTO usage_daily (user_id, day, tier, requests, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, day, tier) DO UPDATE SET
           requests = requests + excluded.requests,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens`,
      )
      .run(userId, this.#day(), tier, requests, input, output);
  }

  /** @param {string} userId */
  today(userId) {
    const rows = this.db.prepare('SELECT * FROM usage_daily WHERE user_id = ? AND day = ?').all(userId, this.#day());
    const empty = { requests: 0, input: 0, output: 0 };
    const out = { demo: { ...empty }, own: { ...empty } };
    for (const r of rows) {
      out[/** @type {'demo' | 'own'} */ (String(r.tier))] = {
        requests: Number(r.requests),
        input: Number(r.input_tokens),
        output: Number(r.output_tokens),
      };
    }
    return out;
  }

  /** Total demo tokens today across all users (the global demo cap). */
  demoTokensToday() {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total FROM usage_daily WHERE tier = 'demo' AND day = ?")
      .get(this.#day());
    return Number(row?.total ?? 0);
  }
}
