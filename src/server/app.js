import { randomUUID } from 'node:crypto';
import { runAgentTurn } from '../agent/agent.js';
import { createBuildTools, createInterviewTools, createTools } from '../agent/tools.js';
import { ASK_SYSTEM_PROMPT, BUILD_SYSTEM_PROMPT, INTERVIEW_SYSTEM_PROMPT } from '../agent/prompts.js';
import { roundBriefing } from '../interview/rounds.js';
import {
  AbortedError,
  InvalidKeyError,
  ProviderDownError,
  ProviderError,
  RateLimitedError,
  RefusedError,
} from '../llm/provider.js';
import { DIFFICULTIES, GenerationError, generateProblem } from '../problems/generator.js';
import { publicResult, reviewSubmission } from '../problems/review.js';
import { publicProblem } from '../problems/store.js';
import { AccountError } from '../auth/accounts.js';
import { PROVIDERS } from '../llm/index.js';
import { withMetering } from '../llm/meter.js';
import { RateLimiter } from './rate-limit.js';
import { HttpError, compose, readJson, sendJson } from './http.js';
import { Router } from './router.js';
import { openSse } from './sse.js';
import { serveStatic } from './static.js';

/** @typedef {import('./http.js').Context} Context */

const MAX_MESSAGE_CHARS = 4000;
const CHAT_MODES = ['ask', 'interview', 'build'];
const MAX_CODE_CHARS = 50_000;
const MAX_CONCURRENT_GENERATIONS = 2;
const SESSION_COOKIE = 'pp_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const LOCAL_USER = { id: 'local', email: null };
/** Features that cost the most: only with the user's own key. */
const DEMO_DISABLED = new Set(['build', 'generate']);

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/**
 * Build the request handler. Everything it needs is passed in, so tests can
 * run it with a fake provider and no network.
 *
 * @param {{
 *   kb: import('../search/knowledge-base.js').KnowledgeBase,
 *   provider: import('../llm/provider.js').LLMProvider,
 *   sessions: import('./sessions.js').MemorySessionStore,
 *   runner: import('../runner/runner.js').CodeRunner,
 *   problems: import('../problems/store.js').ProblemStore,
 *   progress: import('../progress/progress.js').ProgressStore,
 *   interview: { rounds: import('../interview/rounds.js').Round[], rubric: string },
 *   accounts?: {
 *     store: import('../auth/accounts.js').AccountStore,
 *     usage: import('./usage.js').UsageStore,
 *     providerFor: (key: { provider: string, apiKey: string }) => import('../llm/provider.js').LLMProvider,
 *     demoProvider: import('../llm/provider.js').LLMProvider | null,
 *     limits?: { demoMessagesPerUser?: number, demoDailyTokens?: number },
 *     cookieSecure?: boolean,
 *   },
 *   trustProxy?: boolean,
 *   staticDir?: string,
 *   log?: (entry: Record<string, unknown>) => void,
 * }} deps
 *   Without `accounts` the server is single-user (local use): everyone is
 *   the "local" user and `provider` is used for every model call.
 */
export function createApp({
  kb,
  provider,
  sessions,
  runner,
  problems,
  progress,
  interview,
  accounts,
  trustProxy = false,
  staticDir,
  log: rawLog = jsonLog,
}) {
  /** Every log line goes through redaction: no keys, passwords or cookies in logs. */
  const log = (entry) => rawLog(redact(entry));
  const tools = createTools({ kb });
  const limiter = new RateLimiter();
  const limits = { demoMessagesPerUser: 10, demoDailyTokens: 400_000, ...accounts?.limits };
  /** Open SSE streams, so shutdown can cancel them. @type {Set<AbortController>} */
  const activeStreams = new Set();
  let generationsInFlight = 0;

  const router = new Router()
    .get('/healthz', ({ res }) => sendJson(res, 200, { ok: true }))
    .get('/readyz', ({ res }) => sendJson(res, 200, { ok: true, ...kb.stats }))
    .get('/api/topics', ({ res }) => sendJson(res, 200, { topics: kb.topics() }))

    // ---- Accounts and keys (AUTH=accounts) -------------------------------
    .get('/api/me', (ctx) => sendJson(ctx.res, 200, describeMe(ctx)))
    .post('/api/auth/signup', async (ctx) => {
      const { store } = requireAccounts();
      limit(ctx, `auth:${clientIp(ctx)}`, 10, 60_000);
      const body = (await readJson(ctx.req)) ?? {};
      const user = await store.signUp(body.email, body.password);
      setSessionCookie(ctx, store.createSession(user.id));
      ctx.log({ event: 'signup', userId: user.id });
      sendJson(ctx.res, 201, { user });
    })
    .post('/api/auth/login', async (ctx) => {
      const { store } = requireAccounts();
      limit(ctx, `auth:${clientIp(ctx)}`, 10, 60_000);
      const body = (await readJson(ctx.req)) ?? {};
      const user = await store.logIn(body.email, body.password);
      if (!user) throw new HttpError(401, 'invalid_credentials', 'Wrong email or password.');
      setSessionCookie(ctx, store.createSession(user.id));
      sendJson(ctx.res, 200, { user });
    })
    .post('/api/auth/logout', (ctx) => {
      const { store } = requireAccounts();
      const token = readCookie(ctx.req, SESSION_COOKIE);
      if (token) store.deleteSession(token);
      ctx.res.setHeader('Set-Cookie', sessionCookie('', 0));
      sendJson(ctx.res, 200, { ok: true });
    })
    .post('/api/keys', async (ctx) => {
      const { store, providerFor } = requireAccounts();
      const user = requireUser(ctx);
      limit(ctx, `keys:${user.id}`, 10, 60_000);
      const body = (await readJson(ctx.req)) ?? {};
      const providerName = body.provider ?? 'claude';
      if (!PROVIDERS.includes(providerName)) {
        throw new HttpError(400, 'invalid_provider', `provider must be one of ${PROVIDERS.join(', ')}`);
      }
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (apiKey.length < 20 || apiKey.length > 300 || /\s/.test(apiKey)) {
        throw new HttpError(400, 'invalid_key_format', 'That does not look like an API key.');
      }
      // Check the key with a call that costs no tokens before storing it.
      try {
        await providerFor({ provider: providerName, apiKey }).validateKey();
      } catch (err) {
        const { code, message } = describeError(err);
        if (code === 'invalid_key') throw new HttpError(400, 'invalid_key', 'The provider rejected that key.');
        throw new HttpError(502, 'key_check_failed', `Could not check the key right now: ${message}`);
      }
      store.setApiKey(user.id, providerName, apiKey);
      ctx.log({ event: 'key_added', userId: user.id, provider: providerName });
      sendJson(ctx.res, 200, { keys: store.listKeys(user.id) });
    })
    .delete('/api/keys/:provider', (ctx) => {
      const { store } = requireAccounts();
      const user = requireUser(ctx);
      store.deleteKey(user.id, ctx.params.provider);
      sendJson(ctx.res, 200, { keys: store.listKeys(user.id) });
    })

    // ---- Ask + Interview modes (chat sessions) ----------------------------
    .get('/api/rounds', ({ res }) =>
      sendJson(res, 200, {
        rounds: interview.rounds.map(({ id, name, minutes, topics }) => ({ id, name, minutes, topics })),
      }),
    )
    .post('/api/sessions', async (ctx) => {
      const user = requireUser(ctx);
      const body = (await readJson(ctx.req)) ?? {};
      const mode = body.mode ?? 'ask';
      if (!CHAT_MODES.includes(mode)) throw new HttpError(400, 'invalid_mode', `mode must be one of ${CHAT_MODES.join(', ')}`);
      let roundId = null;
      if (mode === 'interview') {
        roundId = Number(body.round);
        if (!interview.rounds.some((r) => r.id === roundId)) throw new HttpError(400, 'invalid_round', 'Unknown interview round');
      }
      const session = sessions.create({ mode, roundId, userId: user.id });
      sendJson(ctx.res, 201, { id: session.id, mode: session.mode, round: session.roundId });
    })
    .get('/api/sessions/:id', (ctx) => {
      const session = getSession(ctx.params.id, requireUser(ctx));
      sendJson(ctx.res, 200, {
        id: session.id,
        mode: session.mode,
        round: session.roundId,
        messages: toDisplayMessages(session.messages),
      });
    })
    .post('/api/sessions/:id/messages', async (ctx) => {
      const user = requireUser(ctx);
      const session = getSession(ctx.params.id, user);
      const text = requireString(await readJson(ctx.req), 'text', MAX_MESSAGE_CHARS);
      if (session.busy) throw new HttpError(409, 'busy', 'This session is already answering a message');
      const llm = modelFor(ctx, user, session.mode);

      const round = session.mode === 'interview' ? interview.rounds.find((r) => r.id === session.roundId) : undefined;
      const config = {
        ask: { system: ASK_SYSTEM_PROMPT, tools, effort: 'low' },
        interview: {
          system: INTERVIEW_SYSTEM_PROMPT,
          tools: createInterviewTools({ kb, provider: llm, progress, rubric: interview.rubric, userId: user.id }),
          effort: 'medium',
        },
        // Fresh build tools per turn: run_code counts runs per turn.
        build: { system: BUILD_SYSTEM_PROMPT, tools: createBuildTools({ kb, runner }), effort: 'high' },
      }[session.mode];
      session.busy = true;
      sessions.touch(session);
      try {
        await streamSse(ctx, async (sse, signal) => {
          const result = await runAgentTurn({
            provider: llm,
            system: config.system,
            messages: session.messages,
            userText: text,
            // The round briefing rides along with the first message only.
            context: round && session.messages.length === 0 ? roundBriefing(round) : undefined,
            tools: config.tools,
            effort: /** @type {import('../llm/provider.js').Effort} */ (config.effort),
            signal,
            onEvent: (event) => sse.send(event.type, event),
          });
          sse.send('done', { status: result.status, usage: result.usage });
          ctx.log({ event: 'turn', mode: session.mode, status: result.status, ...result.usage });
        });
      } finally {
        session.busy = false;
        sessions.touch(session);
      }
    })

    // ---- Progress -------------------------------------------------------
    .get('/api/progress', (ctx) =>
      sendJson(ctx.res, 200, progress.summary(requireUser(ctx).id, { allTopics: kb.topics() })),
    )

    // ---- Code mode ------------------------------------------------------
    .get('/api/problems', (ctx) => {
      requireUser(ctx);
      const { res, url } = ctx;
      const topic = url.searchParams.get('topic') || undefined;
      const list = problems.list({ topic }).map(({ id, title, topic: t, difficulty, createdAt }) => ({
        id,
        title,
        topic: t,
        difficulty,
        createdAt,
      }));
      sendJson(res, 200, { problems: list });
    })
    .get('/api/problems/:id', (ctx) => {
      requireUser(ctx);
      sendJson(ctx.res, 200, publicProblem(getProblem(ctx.params.id)));
    })
    .post('/api/problems', async (ctx) => {
      const user = requireUser(ctx);
      const body = (await readJson(ctx.req)) ?? {};
      const topic = normalizeTopic(body.topic);
      const difficulty = body.difficulty ?? 'medium';
      if (!DIFFICULTIES.includes(difficulty)) {
        throw new HttpError(400, 'invalid_difficulty', `difficulty must be one of ${DIFFICULTIES.join(', ')}`);
      }
      if (generationsInFlight >= MAX_CONCURRENT_GENERATIONS) {
        throw new HttpError(429, 'busy', 'Other problems are being generated right now. Try again in a minute.');
      }
      const llm = modelFor(ctx, user, 'generate');
      generationsInFlight++;
      try {
        await streamSse(ctx, async (sse, signal) => {
          const problem = await generateProblem({
            provider: llm,
            runner,
            store: problems,
            kb,
            topic,
            difficulty,
            signal,
            onProgress: (event) => sse.send('progress', event),
          });
          ctx.log({ event: 'problem_generated', problemId: problem.id, topic, difficulty });
          sse.send('problem', publicProblem(problem));
        });
      } finally {
        generationsInFlight--;
      }
    })
    .post('/api/problems/:id/run', async (ctx) => {
      const user = requireUser(ctx);
      limit(ctx, `run:${user.id}`, 30, 60_000);
      const problem = getProblem(ctx.params.id);
      const code = requireString(await readJson(ctx.req), 'code', MAX_CODE_CHARS, { trim: false });
      const result = await runner.run({ code, tests: problem.visibleTests });
      sendJson(ctx.res, 200, publicResult(problem, result));
    })
    .post('/api/problems/:id/submit', async (ctx) => {
      const user = requireUser(ctx);
      const problem = getProblem(ctx.params.id);
      const code = requireString(await readJson(ctx.req), 'code', MAX_CODE_CHARS, { trim: false });
      const llm = modelFor(ctx, user, 'review');
      await streamSse(ctx, async (sse, signal) => {
        const result = await runner.run({ code, tests: [...problem.visibleTests, ...problem.hiddenTests] }, { signal });
        sse.send('result', publicResult(problem, result));
        // A submission counts toward the topic's progress: share of tests passed, 1-10.
        progress.record({
          userId: user.id,
          kind: 'code',
          topic: problem.topic,
          score: Math.max(1, Math.round((10 * result.passed) / Math.max(1, result.total))),
          question: problem.title,
          feedback: `${result.passed}/${result.total} tests passed`,
        });
        const review = await reviewSubmission({
          provider: llm,
          problem,
          code,
          result,
          signal,
          onEvent: (event) => sse.send(event.type, event),
        });
        sse.send('done', { status: review.status, usage: review.usage });
        ctx.log({ event: 'submission', problemId: problem.id, passed: result.passed, total: result.total });
      });
    });

  /**
   * Run `work` with the response as an SSE stream. The browser disconnecting
   * (tab closed, Stop pressed) aborts `signal`, which cancels the model call
   * so we stop paying for tokens nobody will read. Errors become an `error`
   * event with a stable code.
   * @param {Context} ctx
   * @param {(sse: ReturnType<typeof openSse>, signal: AbortSignal) => Promise<void>} work
   */
  async function streamSse({ res, log: logRequest }, work) {
    const controller = new AbortController();
    activeStreams.add(controller);
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    const sse = openSse(res);
    try {
      await work(sse, controller.signal);
    } catch (err) {
      if (err instanceof AbortedError || controller.signal.aborted) {
        logRequest({ event: 'stream', status: 'aborted' });
      } else {
        const { code, message } = describeError(err);
        if (code === 'internal' || code === 'generation_failed') {
          logRequest({ level: 'error', event: 'stream_error', error: String(err?.stack ?? err) });
        }
        sse.send('error', { code, message });
      }
    } finally {
      activeStreams.delete(controller);
      sse.close();
    }
  }

  /** Someone else's session looks exactly like a missing one. @param {string} id @param {{ id: string }} user */
  function getSession(id, user) {
    const session = sessions.get(id);
    if (!session || session.userId !== user.id) throw new HttpError(404, 'session_not_found', 'Session not found or expired');
    return session;
  }

  /**
   * The model to use for this user's request, after rate and demo limits.
   * Single-user mode: the server's provider. With accounts: the user's own
   * key if they added one, otherwise the demo tier on the owner's key.
   * Either way it's metered, so usage is recorded for every model call.
   * @param {Context} ctx
   * @param {{ id: string }} user
   * @param {string} feature 'ask' | 'interview' | 'build' | 'generate' | 'review'
   */
  function modelFor(ctx, user, feature) {
    limit(ctx, `model:${user.id}`, 20, 60_000);
    if (!accounts) return provider;
    const { store, usage, providerFor, demoProvider } = accounts;

    const key = store.getApiKey(user.id);
    if (key) {
      usage.countRequest(user.id, 'own');
      return withMetering(providerFor(key), (u) => usage.addTokens(user.id, 'own', u));
    }
    if (!demoProvider) throw new HttpError(402, 'key_required', 'Add your API key in Settings to use the AI features.');
    if (DEMO_DISABLED.has(feature)) {
      throw new HttpError(403, 'demo_feature', 'This feature needs your own API key. Add one in Settings.');
    }
    if (usage.today(user.id).demo.requests >= limits.demoMessagesPerUser) {
      throw new HttpError(
        429,
        'demo_limit',
        `The free demo allows ${limits.demoMessagesPerUser} messages a day. Add your own API key in Settings to keep going.`,
      );
    }
    if (usage.demoTokensToday() >= limits.demoDailyTokens) {
      throw new HttpError(429, 'demo_exhausted', 'The free demo is used up for today. Add your own API key in Settings, or come back tomorrow.');
    }
    usage.countRequest(user.id, 'demo');
    return withMetering(demoProvider, (u) => usage.addTokens(user.id, 'demo', u));
  }

  function requireAccounts() {
    if (!accounts) throw new HttpError(404, 'accounts_disabled', 'Accounts are not enabled on this server.');
    return accounts;
  }

  /** @param {Context} ctx */
  function requireUser(ctx) {
    if (!ctx.user) throw new HttpError(401, 'unauthenticated', 'Log in first.');
    return ctx.user;
  }

  /** @param {Context} ctx @param {string} key @param {number} max @param {number} windowMs */
  function limit(ctx, key, max, windowMs) {
    const result = limiter.hit(key, max, windowMs);
    if (!result.ok) {
      ctx.res.setHeader('Retry-After', String(result.retryAfterSec));
      throw new HttpError(429, 'too_many_requests', `Too many requests. Try again in ${result.retryAfterSec} s.`);
    }
  }

  /** Behind a reverse proxy (Caddy) the client IP is in X-Forwarded-For. @param {Context} ctx */
  function clientIp(ctx) {
    const forwarded = ctx.req.headers['x-forwarded-for'];
    if (trustProxy && typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
    return ctx.req.socket.remoteAddress ?? 'unknown';
  }

  /** @param {string} value @param {number} maxAge seconds; 0 deletes the cookie */
  function sessionCookie(value, maxAge) {
    return [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`, ...(accounts?.cookieSecure ? ['Secure'] : [])].join(
      '; ',
    );
  }

  /** @param {Context} ctx @param {string} token */
  function setSessionCookie(ctx, token) {
    ctx.res.setHeader('Set-Cookie', sessionCookie(token, SESSION_MAX_AGE));
  }

  /** What the UI needs to know about the current user. Never includes key material. @param {Context} ctx */
  function describeMe(ctx) {
    if (!accounts) return { accounts: false, user: ctx.user, tier: 'own' };
    if (!ctx.user) return { accounts: true, user: null };
    const keys = accounts.store.listKeys(ctx.user.id);
    const usage = accounts.usage.today(ctx.user.id);
    return {
      accounts: true,
      user: ctx.user,
      keys,
      tier: keys.length ? 'own' : accounts.demoProvider ? 'demo' : 'none',
      usage,
      demo: {
        messagesPerDay: limits.demoMessagesPerUser,
        messagesLeft: Math.max(0, limits.demoMessagesPerUser - usage.demo.requests),
        disabledFeatures: [...DEMO_DISABLED],
      },
    };
  }

  /** Who is calling: from the session cookie, or the single local user. @param {Context} ctx */
  async function authenticate(ctx, next) {
    ctx.user = accounts ? accounts.store.resolveSession(readCookie(ctx.req, SESSION_COOKIE)) : LOCAL_USER;
    await next();
  }

  /** @param {string} id */
  function getProblem(id) {
    const problem = problems.get(id);
    if (!problem) throw new HttpError(404, 'problem_not_found', 'Problem not found');
    return problem;
  }

  const handle = compose([
    requestContext(log),
    securityHeaders,
    errorHandler,
    originCheck,
    authenticate,
    router.middleware(),
    ...(staticDir ? [serveStatic(staticDir)] : []),
    notFound,
  ]);

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  const handler = (req, res) => {
    /** @type {Context} */
    const ctx = {
      req,
      res,
      url: new URL(req.url ?? '/', 'http://localhost'),
      params: {},
      requestId: '',
      log: () => {},
      user: null,
    };
    handle(ctx).catch((err) => {
      // errorHandler catches everything; this is a last resort.
      log({ level: 'error', msg: 'unhandled', error: String(err?.stack ?? err) });
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'internal', message: 'Internal error' } });
      else res.end();
    });
  };

  /** Cancel every in-flight stream (graceful shutdown). */
  handler.abortAll = () => activeStreams.forEach((c) => c.abort());
  return handler;
}

/**
 * @param {any} body
 * @param {string} field
 * @param {number} maxChars
 */
function requireString(body, field, maxChars, { trim = true } = {}) {
  const raw = body?.[field];
  const value = typeof raw === 'string' ? (trim ? raw.trim() : raw) : '';
  if (!value.trim()) throw new HttpError(400, `empty_${field}`, `Send { "${field}": "..." }`);
  if (value.length > maxChars) throw new HttpError(400, `${field}_too_long`, `"${field}" is limited to ${maxChars} characters`);
  return value;
}

/** "Event Loop" → "event-loop"; rejects anything that isn't a short plain topic name. */
function normalizeTopic(topic) {
  const value = typeof topic === 'string' ? topic.trim().toLowerCase().replace(/[\s_]+/g, '-') : '';
  if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(value)) {
    throw new HttpError(400, 'invalid_topic', 'topic must be 2-60 letters, digits or dashes, e.g. "promises"');
  }
  return value;
}

/** Request ID + one structured log line per request, written when it ends. */
function requestContext(log) {
  return async (/** @type {Context} */ ctx, next) => {
    const started = performance.now();
    ctx.requestId = ctx.req.headers['x-request-id']?.toString().slice(0, 64) || randomUUID();
    ctx.res.setHeader('X-Request-Id', ctx.requestId);
    ctx.log = (fields) => log({ level: 'info', requestId: ctx.requestId, ...fields });
    ctx.res.on('close', () => {
      log({
        level: 'info',
        requestId: ctx.requestId,
        method: ctx.req.method,
        path: ctx.url.pathname,
        status: ctx.res.statusCode,
        ms: Math.round(performance.now() - started),
      });
    });
    await next();
  };
}

async function securityHeaders(/** @type {Context} */ ctx, next) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) ctx.res.setHeader(name, value);
  await next();
}

/** Turn thrown errors into JSON responses with a stable { error: { code, message } } shape. */
async function errorHandler(/** @type {Context} */ ctx, next) {
  try {
    await next();
  } catch (err) {
    if (ctx.res.headersSent) {
      ctx.res.end();
      return;
    }
    if (err instanceof HttpError) {
      sendJson(ctx.res, err.status, { error: { code: err.code, message: err.message } });
    } else if (err instanceof AccountError) {
      sendJson(ctx.res, err.code === 'email_taken' ? 409 : 400, { error: { code: err.code, message: err.message } });
    } else if (err instanceof RangeError) {
      sendJson(ctx.res, 400, { error: { code: 'bad_request', message: err.message } });
    } else {
      ctx.log({ level: 'error', msg: 'request failed', error: String(err?.stack ?? err) });
      sendJson(ctx.res, 500, { error: { code: 'internal', message: 'Internal error' } });
    }
  }
}

/**
 * CSRF defence: browsers send an Origin header on cross-site POSTs. A
 * state-changing request whose Origin isn't this host is refused. (Plus
 * SameSite=Lax cookies, and JSON-only bodies which a plain HTML form can't send.)
 */
async function originCheck(/** @type {Context} */ ctx, next) {
  const origin = ctx.req.headers.origin;
  if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(ctx.req.method ?? 'GET')) {
    let host = null;
    try {
      host = new URL(origin).host;
    } catch {
      // malformed Origin: treated as foreign
    }
    if (host !== ctx.req.headers.host) throw new HttpError(403, 'bad_origin', 'Cross-site request blocked.');
  }
  await next();
}

/** @param {import('node:http').IncomingMessage} req @param {string} name */
function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || undefined;
  }
  return undefined;
}

const SECRET_FIELDS = /^(password|apiKey|api_key|authorization|cookie|token)$/i;
const SECRET_VALUES = /\bsk-[A-Za-z0-9_-]{8,}/g;

/**
 * Remove secrets from a log entry: fields with secret names, and anything
 * that looks like an API key inside any string (e.g. an echoed error message).
 * @param {unknown} value
 * @param {string} [key]
 * @returns {any}
 */
export function redact(value, key = '') {
  if (SECRET_FIELDS.test(key)) return '[redacted]';
  if (typeof value === 'string') return value.replace(SECRET_VALUES, '[redacted]');
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

async function notFound(/** @type {Context} */ ctx) {
  throw new HttpError(404, 'not_found', `No route for ${ctx.req.method} ${ctx.url.pathname}`);
}

/** Map errors to codes the UI can act on. */
export function describeError(err) {
  if (err instanceof InvalidKeyError) return { code: 'invalid_key', message: err.message };
  if (err instanceof RateLimitedError) return { code: 'rate_limited', message: err.message };
  if (err instanceof ProviderDownError) return { code: 'provider_down', message: err.message };
  if (err instanceof RefusedError) return { code: 'refused', message: err.message };
  if (err instanceof ProviderError) return { code: 'provider_error', message: err.message };
  if (err instanceof GenerationError) {
    return { code: 'generation_failed', message: 'Could not generate a problem that passes its own tests. Please try again.' };
  }
  return { code: 'internal', message: 'Something went wrong on our side.' };
}

/**
 * History → what the UI shows: user text, and per answer the assistant text,
 * the tools it used and any score cards. Other tool results stay server-side.
 * @param {import('../llm/provider.js').Message[]} messages
 */
export function toDisplayMessages(messages) {
  /** @type {({ role: 'user', text: string } | { role: 'assistant', text: string, tools: { name: string, input: unknown }[], scores: object[] })[]} */
  const out = [];
  const gradeCalls = new Set();
  for (const message of messages) {
    if (message.role === 'user') {
      for (const block of message.content) {
        if (block.type !== 'tool_result' || block.isError || !gradeCalls.has(block.id)) continue;
        const last = out.at(-1);
        try {
          if (last?.role === 'assistant') last.scores.push(JSON.parse(block.output));
        } catch {
          // not JSON: nothing to show
        }
      }
      const text = message.content.flatMap((b) => (b.type === 'text' && !b.hidden ? [b.text] : [])).join('');
      if (text) out.push({ role: 'user', text });
      continue;
    }
    let last = out.at(-1);
    if (last?.role !== 'assistant') {
      last = { role: 'assistant', text: '', tools: [], scores: [] };
      out.push(last);
    }
    for (const block of message.content) {
      if (block.type === 'text') last.text += block.text;
      else if (block.type === 'tool_call') {
        last.tools.push({ name: block.name, input: block.input });
        if (block.name === 'grade_answer') gradeCalls.add(block.id);
      }
    }
  }
  return out;
}

/** @param {Record<string, unknown>} entry */
function jsonLog(entry) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level: 'info', ...entry })}\n`);
}
