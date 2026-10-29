import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Expand a leading `~` and resolve relative paths against the project root. */
function resolvePath(p) {
  if (p === '~' || p.startsWith('~/')) p = path.join(homedir(), p.slice(1));
  return path.resolve(ROOT, p);
}

/** Per-user config written by `preppilot init`. */
export const USER_CONFIG = path.join(homedir(), '.config', 'preppilot', 'config.json');

/** SQLite file. `DATABASE_PATH` overrides; default ~/.preppilot/preppilot.db (works for npm installs too). */
export function databasePath() {
  return process.env.DATABASE_PATH ? resolvePath(process.env.DATABASE_PATH) : path.join(homedir(), '.preppilot', 'preppilot.db');
}

/**
 * Knowledge-base folders to index, first match wins:
 *   1. PREPPILOT_SOURCES env (comma-separated)
 *   2. ./preppilot.config.json in the current directory
 *   3. ~/.config/preppilot/config.json (written by `preppilot init`)
 *   4. preppilot.config.json shipped in the project
 * @returns {Promise<string[]>} absolute paths
 */
export async function loadSources() {
  if (process.env.PREPPILOT_SOURCES) {
    return process.env.PREPPILOT_SOURCES.split(',').map((s) => resolvePath(s.trim()));
  }
  for (const file of [path.resolve('preppilot.config.json'), USER_CONFIG, path.join(ROOT, 'preppilot.config.json')]) {
    try {
      return JSON.parse(await readFile(file, 'utf8')).sources.map(resolvePath);
    } catch {
      // try the next location
    }
  }
  throw new Error('No notes configured. Run: preppilot init --notes <folder>[,<folder>...]');
}
