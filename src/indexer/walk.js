import { readdir } from 'node:fs/promises';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', '.github', '.vscode', 'dist', 'coverage']);
const EXTENSIONS = new Set(['.md', '.js']);
const SKIP_FILES = /(^|\.)config\.js$|\.min\.js$/;

/**
 * Recursively yield indexable files under `root`, in a stable (sorted) order.
 * We walk manually instead of `readdir({ recursive: true })` so we never
 * descend into node_modules at all.
 * @param {string} root
 * @returns {AsyncGenerator<string>} absolute file paths
 */
export async function* walk(root) {
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) yield* walk(full);
    } else if (EXTENSIONS.has(path.extname(entry.name)) && !SKIP_FILES.test(entry.name)) {
      yield full;
    }
  }
}
