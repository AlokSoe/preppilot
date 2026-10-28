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
