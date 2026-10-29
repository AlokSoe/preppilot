import { randomUUID } from 'node:crypto';
import { hashPassword, hashToken, newToken, verifyPassword } from './crypto.js';

const SESSION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A user-facing account error with a stable code (mapped to HTTP by the app). */
export class AccountError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** @typedef {{ id: string, email: string }} User */

/**
 * Users, login sessions and their encrypted API keys.
 */
export class AccountStore {
  /** A real hash to verify against when the email doesn't exist (see logIn). */
  #dummyHash = hashPassword('not-a-real-password');

  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {import('./crypto.js').SecretBox} box
   * @param {{ now?: () => number }} [options]
   */
  constructor(db, box, { now = Date.now } = {}) {
    this.db = db;
    this.box = box;
    this.now = now;
  }

  /** @param {string} email @param {string} password @returns {Promise<User>} */
  async signUp(email, password) {
    const normalized = String(email ?? '').trim().toLowerCase();
    if (!EMAIL.test(normalized) || normalized.length > 254) throw new AccountError('invalid_email', 'Enter a valid email address.');
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
      throw new AccountError('weak_password', 'Use a password of at least 8 characters.');
    }
    if (this.db.prepare('SELECT 1 FROM users WHERE email = ?').get(normalized)) {
      throw new AccountError('email_taken', 'An account with this email already exists.');
    }
    const user = { id: randomUUID(), email: normalized };
    this.db
      .prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(user.id, user.email, await hashPassword(password), new Date(this.now()).toISOString());
    return user;
  }

  /**
   * @param {string} email @param {string} password
   * @returns {Promise<User | null>}
   */
  async logIn(email, password) {
    const row = this.db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(String(email ?? '').trim().toLowerCase());
    // Always run scrypt, even for unknown emails, so response time doesn't reveal which emails exist.
    const ok = await verifyPassword(String(password ?? ''), row ? String(row.password_hash) : await this.#dummyHash);
    return row && ok ? { id: String(row.id), email: String(row.email) } : null;
  }

  /** @param {string} userId @returns {string} the token for the cookie */
  createSession(userId) {
    const token = newToken();
    const now = this.now();
    this.db
      .prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(token), userId, new Date(now + SESSION_DAYS * DAY_MS).toISOString(), new Date(now).toISOString());
    return token;
  }

  /** @param {string | undefined} token @returns {User | null} */
  resolveSession(token) {
    if (!token) return null;
    const row = this.db
      .prepare('SELECT u.id, u.email, s.expires_at FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?')
      .get(hashToken(token));
    if (!row) return null;
    if (Date.parse(String(row.expires_at)) <= this.now()) {
      this.deleteSession(token);
      return null;
    }
    return { id: String(row.id), email: String(row.email) };
  }

  /** @param {string} token */
  deleteSession(token) {
    this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(token));
  }

  /** Store (or replace) a validated key, encrypted. @param {string} userId @param {string} provider @param {string} apiKey */
  setApiKey(userId, provider, apiKey) {
    const sealed = this.box.encrypt(apiKey);
    const now = new Date(this.now()).toISOString();
    this.db
      .prepare(
        `INSERT INTO api_keys (user_id, provider, ciphertext, iv, auth_tag, last4, validated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, provider) DO UPDATE SET
           ciphertext = excluded.ciphertext, iv = excluded.iv, auth_tag = excluded.auth_tag,
           last4 = excluded.last4, validated_at = excluded.validated_at`,
      )
      .run(userId, provider, sealed.ciphertext, sealed.iv, sealed.authTag, apiKey.slice(-4), now, now);
  }

  /**
   * The user's key, decrypted in memory for one request. The most recently
   * validated key wins if they have several.
   * @param {string} userId
   * @returns {{ provider: string, apiKey: string } | null}
   */
  getApiKey(userId) {
    const row = this.db
      .prepare('SELECT provider, ciphertext, iv, auth_tag FROM api_keys WHERE user_id = ? ORDER BY validated_at DESC LIMIT 1')
      .get(userId);
    if (!row) return null;
    const apiKey = this.box.decrypt({ ciphertext: String(row.ciphertext), iv: String(row.iv), authTag: String(row.auth_tag) });
    return { provider: String(row.provider), apiKey };
  }

  /** What the UI may see: provider and last 4 characters only. @param {string} userId */
  listKeys(userId) {
    return this.db
      .prepare('SELECT provider, last4, validated_at FROM api_keys WHERE user_id = ? ORDER BY validated_at DESC')
      .all(userId)
      .map((r) => ({ provider: String(r.provider), last4: String(r.last4), validatedAt: String(r.validated_at) }));
  }

  /** @param {string} userId @param {string} provider */
  deleteKey(userId, provider) {
    this.db.prepare('DELETE FROM api_keys WHERE user_id = ? AND provider = ?').run(userId, provider);
  }
}
