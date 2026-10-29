import { mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { USER_CONFIG } from '../config.js';

/**
 * `preppilot init --notes <folders>`: save which note folders to use, in
 * ~/.config/preppilot/config.json, so `npx preppilot` works from anywhere.
 * @param {string | undefined} notes comma-separated folders
 */
export async function initConfig(notes) {
  if (!notes) throw new Error('Usage: preppilot init --notes ~/notes/javascript,~/notes/interviews');
  const sources = notes.split(',').map((p) => path.resolve(p.trim().replace(/^~(?=$|\/)/, homedir())));
  for (const dir of sources) {
    const isDir = await stat(dir).then((s) => s.isDirectory(), () => false);
    if (!isDir) throw new Error(`Not a folder: ${dir}`);
  }
  await mkdir(path.dirname(USER_CONFIG), { recursive: true });
  await writeFile(USER_CONFIG, `${JSON.stringify({ sources }, null, 2)}\n`);
  console.log(`Saved ${sources.length} note folder(s) to ${USER_CONFIG}`);
  console.log('Next: export ANTHROPIC_API_KEY=sk-ant-... and run: preppilot ask "what is a closure?"');
}
