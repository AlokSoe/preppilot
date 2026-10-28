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

/**
 * Knowledge-base folders to index.
 * `PREPPILOT_SOURCES` (comma-separated) overrides `preppilot.config.json`.
 * @returns {Promise<string[]>} absolute paths
 */
export async function loadSources() {
  if (process.env.PREPPILOT_SOURCES) {
    return process.env.PREPPILOT_SOURCES.split(',').map((s) => resolvePath(s.trim()));
  }
  const raw = await readFile(path.join(ROOT, 'preppilot.config.json'), 'utf8');
  return JSON.parse(raw).sources.map(resolvePath);
}
