import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { CodeRunner } from './runner.js';
import { HttpError, readJson, sendJson } from '../server/http.js';

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The code runner as its own service (design doc §9.5). In production it
 * runs in a separate container on an internal-only network: no internet,
 * read-only file system, memory and process limits, and no API keys in its
 * environment. The API calls it over HTTP with a shared token.
 *
 *   POST /run   { code, tests } → RunResult      (Authorization: Bearer <RUNNER_TOKEN>)
 *   GET  /healthz
 *
 * @param {{ host?: string, port?: number, token: string, concurrency?: number }} options
 */
export async function startRunnerService({ host = '0.0.0.0', port = 9000, token, concurrency = 4 }) {
  if (!token || token.length < 16) throw new Error('RUNNER_TOKEN must be set (16+ characters)');
  const runner = new CodeRunner({ concurrency });
  const expected = Buffer.from(`Bearer ${token}`);

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') return sendJson(res, 200, { ok: true });
      if (req.method !== 'POST' || req.url !== '/run') throw new HttpError(404, 'not_found', 'Not found');

      const given = Buffer.from(req.headers.authorization ?? '');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        throw new HttpError(401, 'unauthorized', 'Bad runner token');
      }
      const { code, tests } = (await readJson(req, MAX_BODY_BYTES)) ?? {};
      // The API cancels by closing the connection.
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) controller.abort();
      });
      sendJson(res, 200, await runner.run({ code, tests }, { signal: controller.signal }));
    } catch (err) {
      if (res.headersSent) return res.end();
      const status = err instanceof HttpError ? err.status : err instanceof RangeError ? 400 : 500;
      sendJson(res, status, { error: { code: err.code ?? 'error', message: status === 500 ? 'Runner error' : err.message } });
    }
  });
  await new Promise((resolve) => server.listen(port, host, () => resolve(undefined)));
  console.log(JSON.stringify({ level: 'info', msg: 'runner listening', port }));
  process.once('SIGTERM', () => server.close(() => process.exit(0)));
  return server;
}

/**
 * Same interface as CodeRunner, backed by the runner service.
 */
export class RemoteRunner {
  /** @param {{ url: string, token: string, timeoutMs?: number }} options */
  constructor({ url, token, timeoutMs = 30_000 }) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  /**
   * @param {{ code: string, tests: import('./runner.js').TestCase[] }} job
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<import('./runner.js').RunResult>}
   */
  async run({ code, tests }, { signal } = {}) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await fetch(`${this.url}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ code, tests }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const body = await res.json().catch(() => null);
    if (res.status === 400) throw new RangeError(body?.error?.message ?? 'Invalid run request');
    if (!res.ok) throw new Error(`Code runner failed (HTTP ${res.status})`);
    return body;
  }
}
