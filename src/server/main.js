import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { databasePath, loadSources } from '../config.js';
import { KnowledgeBase } from '../search/knowledge-base.js';
import { createProvider, defaultProvider, hasDefaultKey } from '../llm/index.js';
import { openDatabase } from '../db/database.js';
import { CodeRunner } from '../runner/runner.js';
import { RemoteRunner } from '../runner/service.js';
import { ProblemStore } from '../problems/store.js';
import { ProgressStore } from '../progress/progress.js';
import { loadRounds } from '../interview/rounds.js';
import { AccountStore } from '../auth/accounts.js';
import { SecretBox } from '../auth/crypto.js';
import { UsageStore } from './usage.js';
import { createApp } from './app.js';
import { MemorySessionStore } from './sessions.js';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');

/**
 * Build everything and start listening. Stops cleanly on SIGINT / SIGTERM:
 * stop accepting connections, cancel in-flight streams, then exit.
 * @param {{ port?: number, host?: string }} [options]
 */
export async function startServer({ port = 8080, host = '127.0.0.1' } = {}) {
  const sources = await loadSources();
  const kb = await KnowledgeBase.build(sources);
  const db = openDatabase(databasePath());
  const env = process.env;
  const model = env.PREPPILOT_MODEL;
  // The server's own key: every request in single-user mode, the demo tier with accounts.
  // PREPPILOT_PROVIDER picks it (claude, openai, gemini); its key comes from the env.
  const ownerProvider = hasDefaultKey() ? defaultProvider({ model }) : null;

  // AUTH=accounts: sign-up/login, users bring their own keys, demo tier on the owner's key.
  const accounts =
    env.AUTH === 'accounts'
      ? {
          store: new AccountStore(db, new SecretBox(env.KEY_ENCRYPTION_SECRET ?? '')),
          usage: new UsageStore(db),
          providerFor: ({ provider, apiKey }) => createProvider({ provider, apiKey, model }),
          demoProvider: env.DEMO_ENABLED === 'false' ? null : ownerProvider,
          limits: {
            demoMessagesPerUser: Number(env.DEMO_MESSAGES_PER_USER ?? 10),
            demoDailyTokens: Number(env.DEMO_DAILY_TOKENS ?? 400_000),
          },
          cookieSecure: env.COOKIE_SECURE !== 'false',
        }
      : undefined;

  const handler = createApp({
    kb,
    provider: ownerProvider ?? defaultProvider({ model }),
    accounts,
    trustProxy: env.TRUST_PROXY === 'true',
    sessions: new MemorySessionStore(),
    // Production: a separate, network-isolated runner container. Local: in-process pool.
    runner: env.RUNNER_URL
      ? new RemoteRunner({ url: env.RUNNER_URL, token: env.RUNNER_TOKEN ?? '' })
      : new CodeRunner({ concurrency: Number(env.RUNNER_CONCURRENCY ?? 4) }),
    problems: new ProblemStore(db),
    progress: new ProgressStore(db),
    interview: await loadRounds(sources),
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
      auth: accounts ? 'accounts' : 'single-user',
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
