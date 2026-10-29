import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Schema changes, applied in order exactly once. Never edit a migration that
 * has shipped; add a new one.
 */
const MIGRATIONS = [
  `CREATE TABLE problems (
     id                 TEXT PRIMARY KEY,
     source             TEXT NOT NULL CHECK (source IN ('generated', 'repo')),
     topic              TEXT NOT NULL,
     difficulty         TEXT NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
     title              TEXT NOT NULL,
     statement          TEXT NOT NULL,
     starter_code       TEXT NOT NULL,
     reference_solution TEXT NOT NULL,
     visible_tests      TEXT NOT NULL,  -- JSON [{ name, code }]
     hidden_tests       TEXT NOT NULL,  -- JSON [{ name, code }]
     verified_at        TEXT NOT NULL,
     created_at         TEXT NOT NULL
   );
   CREATE INDEX problems_topic ON problems (topic, difficulty);`,

  `CREATE TABLE attempts (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id    TEXT NOT NULL,
     kind       TEXT NOT NULL CHECK (kind IN ('interview', 'code')),
     topic      TEXT NOT NULL,
     score      INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
     question   TEXT NOT NULL DEFAULT '',
     feedback   TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL
   );
   CREATE INDEX attempts_user ON attempts (user_id, id);
   CREATE TABLE mastery (
     user_id       TEXT NOT NULL,
     topic         TEXT NOT NULL,
     mastery       REAL NOT NULL,
     ease          REAL NOT NULL,
     interval_days REAL NOT NULL,
     repetitions   INTEGER NOT NULL,
     attempts      INTEGER NOT NULL,
     last_score    INTEGER NOT NULL,
     due_at        TEXT NOT NULL,
     updated_at    TEXT NOT NULL,
     PRIMARY KEY (user_id, topic)
   );`,

  `CREATE TABLE users (
     id            TEXT PRIMARY KEY,
     email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
     password_hash TEXT NOT NULL,
     created_at    TEXT NOT NULL
   );
   CREATE TABLE auth_sessions (
     token_hash TEXT PRIMARY KEY,  -- SHA-256 of the cookie token, never the token itself
     user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     expires_at TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX auth_sessions_user ON auth_sessions (user_id);
   CREATE TABLE api_keys (
     user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     provider     TEXT NOT NULL,
     ciphertext   TEXT NOT NULL,  -- AES-256-GCM
     iv           TEXT NOT NULL,
     auth_tag     TEXT NOT NULL,
     last4        TEXT NOT NULL,
     validated_at TEXT NOT NULL,
     created_at   TEXT NOT NULL,
     PRIMARY KEY (user_id, provider)
   );
   CREATE TABLE usage_daily (
     user_id       TEXT NOT NULL,
     day           TEXT NOT NULL,  -- YYYY-MM-DD (UTC)
     tier          TEXT NOT NULL CHECK (tier IN ('demo', 'own')),
     requests      INTEGER NOT NULL DEFAULT 0,
     input_tokens  INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (user_id, day, tier)
   );`,
];

/**
 * Open (or create) the SQLite database and bring its schema up to date.
 * @param {string} file path, or ':memory:' for tests
 */
export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db, MIGRATIONS);
  return db;
}

/**
 * @param {DatabaseSync} db
 * @param {string[]} migrations
 */
export function migrate(db, migrations) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
             version    INTEGER PRIMARY KEY,
             applied_at TEXT NOT NULL
           )`);
  const row = /** @type {{ version: number | null }} */ (db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get());
  const current = row.version ?? 0;
  for (let version = current + 1; version <= migrations.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[version - 1]);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
