import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { walk } from '../indexer/walk.js';
import { chunkFile } from '../indexer/chunk.js';
import { tokenize } from './tokenize.js';
import { BM25 } from './bm25.js';

const TOPIC_BOOST = 1.5;

/**
 * The searchable knowledge base: chunks from every source + a BM25 index.
 * Built in memory at startup (~140 files, a few thousand chunks).
 */
export class KnowledgeBase {
  /** @type {Map<string, import('../indexer/chunk.js').Chunk>} */
  #chunks = new Map();
  #index = new BM25();
  stats = { files: 0, chunks: 0, buildMs: 0 };

  /**
   * @param {string[]} sourceDirs absolute paths of repos to index
   */
  static async build(sourceDirs) {
    const kb = new KnowledgeBase();
    const started = performance.now();
    for (const dir of sourceDirs) {
      if (!(await isDirectory(dir))) {
        throw new Error(
          `Knowledge source not found: ${dir}\nEdit preppilot.config.json or set PREPPILOT_SOURCES (comma-separated paths).`,
        );
      }
      const repo = path.basename(dir);
      for await (const file of walk(dir)) {
        const content = await readFile(file, 'utf8');
        const relPath = path.relative(dir, file).split(path.sep).join('/');
        kb.stats.files++;
        for (const chunk of chunkFile({ repo, path: relPath, content })) {
          kb.#chunks.set(chunk.id, chunk);
          // Index the heading too, so a section titled "Event Delegation" matches.
          kb.#index.add(chunk.id, tokenize(`${chunk.heading}\n${chunk.text}`));
        }
      }
    }
    kb.stats.chunks = kb.#chunks.size;
    kb.stats.buildMs = Math.round(performance.now() - started);
    return kb;
  }

  /**
   * @param {string} query
   * @param {{ k?: number, topic?: string }} [options]
   *   topic: boost (not filter) chunks from this topic, e.g. "event-loop"
   * @returns {(import('../indexer/chunk.js').Chunk & { score: number })[]}
   */
  search(query, { k = 5, topic } = {}) {
    // Over-fetch so the topic boost can reorder results.
    const hits = this.#index.search(tokenize(query), { limit: topic ? k * 4 : k });
    return hits
      .map(({ id, score }) => {
        const chunk = /** @type {import('../indexer/chunk.js').Chunk} */ (this.#chunks.get(id));
        const boosted = topic && chunk.topic === topic ? score * TOPIC_BOOST : score;
        return { ...chunk, score: boosted };
      })
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, k);
  }

  /** @returns {string[]} distinct topics, sorted */
  topics() {
    return [...new Set([...this.#chunks.values()].map((c) => c.topic))].sort();
  }
}

async function isDirectory(dir) {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
