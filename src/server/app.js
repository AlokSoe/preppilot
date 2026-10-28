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
import { HttpError, compose, readJson, sendJson } from './http.js';
import { Router } from './router.js';
import { openSse } from './sse.js';
import { serveStatic } from './static.js';

/** @typedef {import('./http.js').Context} Context */

const MAX_MESSAGE_CHARS = 4000;
const CHAT_MODES = ['ask', 'interview', 'build'];
const MAX_CODE_CHARS = 50_000;
const MAX_CONCURRENT_GENERATIONS = 2;

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
 *   staticDir?: string,
 *   log?: (entry: Record<string, unknown>) => void,
 * }} deps
 */
export function createApp({ kb, provider, sessions, runner, problems, progress, interview, staticDir, log = jsonLog }) {
  // Single local user until accounts arrive (M7).
  const userId = 'local';
  const tools = createTools({ kb });
  const interviewTools = createInterviewTools({ kb, provider, progress, rubric: interview.rubric, userId });
  /** Open SSE streams, so shutdown can cancel them. @type {Set<AbortController>} */
  const activeStreams = new Set();
  let generationsInFlight = 0;

  const router = new Router()
    .get('/healthz', ({ res }) => sendJson(res, 200, { ok: true }))
    .get('/readyz', ({ res }) => sendJson(res, 200, { ok: true, ...kb.stats }))
    .get('/api/topics', ({ res }) => sendJson(res, 200, { topics: kb.topics() }))

    // ---- Ask + Interview modes (chat sessions) ----------------------------
    .get('/api/rounds', ({ res }) =>
      sendJson(res, 200, {
        rounds: interview.rounds.map(({ id, name, minutes, topics }) => ({ id, name, minutes, topics })),
      }),
    )
    .post('/api/sessions', async ({ req, res }) => {
      const body = (await readJson(req)) ?? {};
      const mode = body.mode ?? 'ask';
      if (!CHAT_MODES.includes(mode)) throw new HttpError(400, 'invalid_mode', `mode must be one of ${CHAT_MODES.join(', ')}`);
      let roundId = null;
      if (mode === 'interview') {
        roundId = Number(body.round);
        if (!interview.rounds.some((r) => r.id === roundId)) throw new HttpError(400, 'invalid_round', 'Unknown interview round');
      }
      const session = sessions.create({ mode, roundId });
      sendJson(res, 201, { id: session.id, mode: session.mode, round: session.roundId });
    })
    .get('/api/sessions/:id', ({ res, params }) => {
      const session = getSession(params.id);
      sendJson(res, 200, {
        id: session.id,
        mode: session.mode,
        round: session.roundId,
        messages: toDisplayMessages(session.messages),
      });
    })
    .post('/api/sessions/:id/messages', async (ctx) => {
      const session = getSession(ctx.params.id);
      const text = requireString(await readJson(ctx.req), 'text', MAX_MESSAGE_CHARS);
      if (session.busy) throw new HttpError(409, 'busy', 'This session is already answering a message');

      const round = session.mode === 'interview' ? interview.rounds.find((r) => r.id === session.roundId) : undefined;
      const config = {
        ask: { system: ASK_SYSTEM_PROMPT, tools, effort: 'low' },
        interview: { system: INTERVIEW_SYSTEM_PROMPT, tools: interviewTools, effort: 'medium' },
        // Fresh build tools per turn: run_code counts runs per turn.
        build: { system: BUILD_SYSTEM_PROMPT, tools: createBuildTools({ kb, runner }), effort: 'high' },
      }[session.mode];
      session.busy = true;
      sessions.touch(session);
      try {
        await streamSse(ctx, async (sse, signal) => {
          const result = await runAgentTurn({
            provider,
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
    .get('/api/progress', ({ res }) => sendJson(res, 200, progress.summary(userId, { allTopics: kb.topics() })))

    // ---- Code mode ------------------------------------------------------
    .get('/api/problems', ({ res, url }) => {
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
    .get('/api/problems/:id', ({ res, params }) => sendJson(res, 200, publicProblem(getProblem(params.id))))
    .post('/api/problems', async (ctx) => {
      const body = (await readJson(ctx.req)) ?? {};
      const topic = normalizeTopic(body.topic);
      const difficulty = body.difficulty ?? 'medium';
      if (!DIFFICULTIES.includes(difficulty)) {
        throw new HttpError(400, 'invalid_difficulty', `difficulty must be one of ${DIFFICULTIES.join(', ')}`);
      }
      if (generationsInFlight >= MAX_CONCURRENT_GENERATIONS) {
        throw new HttpError(429, 'busy', 'Other problems are being generated right now. Try again in a minute.');
      }
      generationsInFlight++;
      try {
        await streamSse(ctx, async (sse, signal) => {
          const problem = await generateProblem({
            provider,
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
    .post('/api/problems/:id/run', async ({ req, res, params }) => {
      const problem = getProblem(params.id);
      const code = requireString(await readJson(req), 'code', MAX_CODE_CHARS, { trim: false });
      const result = await runner.run({ code, tests: problem.visibleTests });
      sendJson(res, 200, publicResult(problem, result));
    })
    .post('/api/problems/:id/submit', async (ctx) => {
      const problem = getProblem(ctx.params.id);
      const code = requireString(await readJson(ctx.req), 'code', MAX_CODE_CHARS, { trim: false });
      await streamSse(ctx, async (sse, signal) => {
        const result = await runner.run({ code, tests: [...problem.visibleTests, ...problem.hiddenTests] }, { signal });
        sse.send('result', publicResult(problem, result));
        // A submission counts toward the topic's progress: share of tests passed, 1-10.
        progress.record({
          userId,
          kind: 'code',
          topic: problem.topic,
          score: Math.max(1, Math.round((10 * result.passed) / Math.max(1, result.total))),
          question: problem.title,
          feedback: `${result.passed}/${result.total} tests passed`,
        });
        const review = await reviewSubmission({
          provider,
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

  /** @param {string} id */
  function getSession(id) {
    const session = sessions.get(id);
    if (!session) throw new HttpError(404, 'session_not_found', 'Session not found or expired');
    return session;
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
    } else if (err instanceof RangeError) {
      sendJson(ctx.res, 400, { error: { code: 'bad_request', message: err.message } });
    } else {
      ctx.log({ level: 'error', msg: 'request failed', error: String(err?.stack ?? err) });
      sendJson(ctx.res, 500, { error: { code: 'internal', message: 'Internal error' } });
    }
  }
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
