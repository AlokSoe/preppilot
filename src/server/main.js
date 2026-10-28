import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { databasePath, loadSources } from '../config.js';
import { KnowledgeBase } from '../search/knowledge-base.js';
import { createProvider } from '../llm/index.js';
import { openDatabase } from '../db/database.js';
import { CodeRunner } from '../runner/runner.js';
import { ProblemStore } from '../problems/store.js';
import { createApp } from './app.js';
import { MemorySessionStore } from './sessions.js';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');

/**
 * Build everything and start listening. Stops cleanly on SIGINT / SIGTERM:
 * stop accepting connections, cancel in-flight streams, then exit.
 * @param {{ port?: number, host?: string }} [options]
 */
export async function startServer({ port = 8080, host = '127.0.0.1' } = {}) {
  const kb = await KnowledgeBase.build(await loadSources());
  const db = openDatabase(databasePath());
  const handler = createApp({
    kb,
    provider: createProvider({ provider: 'claude', model: process.env.PREPPILOT_MODEL }),
    sessions: new MemorySessionStore(),
    runner: new CodeRunner({ concurrency: Number(process.env.RUNNER_CONCURRENCY ?? 4) }),
    problems: new ProblemStore(db),
    staticDir: WEB_DIR,
  });

  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(undefined));
  });
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'listening',
      url: `http://${address.address}:${address.port}`,
      files: kb.stats.files,
      chunks: kb.stats.chunks,
    }),
  );

  const shutdown = (signal) => {
    console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
    server.close(() => {
      db.close();
      process.exit(0);
    });
    handler.abortAll();
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 5000).unref(); // don't hang forever
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}
