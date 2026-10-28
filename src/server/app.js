import { randomUUID } from 'node:crypto';
import { runAgentTurn } from '../agent/agent.js';
import { createTools } from '../agent/tools.js';
import { ASK_SYSTEM_PROMPT } from '../agent/prompts.js';
import {
  AbortedError,
  InvalidKeyError,
  ProviderDownError,
  ProviderError,
  RateLimitedError,
} from '../llm/provider.js';
import { HttpError, compose, readJson, sendJson } from './http.js';
import { Router } from './router.js';
import { openSse } from './sse.js';
import { serveStatic } from './static.js';

/** @typedef {import('./http.js').Context} Context */

const MAX_MESSAGE_CHARS = 4000;

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
 *   staticDir?: string,
 *   log?: (entry: Record<string, unknown>) => void,
 * }} deps
 */
export function createApp({ kb, provider, sessions, staticDir, log = jsonLog }) {
  const tools = createTools({ kb });
  /** Open SSE streams, so shutdown can cancel them. @type {Set<AbortController>} */
  const activeStreams = new Set();

  const router = new Router()
    .get('/healthz', ({ res }) => sendJson(res, 200, { ok: true }))
    .get('/readyz', ({ res }) => sendJson(res, 200, { ok: true, ...kb.stats }))
    .get('/api/topics', ({ res }) => sendJson(res, 200, { topics: kb.topics() }))
    .post('/api/sessions', async ({ req, res }) => {
      const body = (await readJson(req)) ?? {};
      if (body.mode !== undefined && body.mode !== 'ask') {
        throw new HttpError(400, 'invalid_mode', 'Only "ask" mode exists so far');
      }
      const session = sessions.create({ mode: 'ask' });
      sendJson(res, 201, { id: session.id, mode: session.mode });
    })
    .get('/api/sessions/:id', ({ res, params }) => {
      const session = getSession(params.id);
      sendJson(res, 200, { id: session.id, mode: session.mode, messages: toDisplayMessages(session.messages) });
    })
    .post('/api/sessions/:id/messages', (ctx) => streamTurn(ctx));

  /**
   * POST a message → the response is an SSE stream of the agent's turn.
   * @param {Context} ctx
   */
  async function streamTurn({ req, res, params, log: logRequest }) {
    const session = getSession(params.id);
    const body = await readJson(req);
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) throw new HttpError(400, 'empty_message', 'Send { "text": "..." }');
    if (text.length > MAX_MESSAGE_CHARS) {
      throw new HttpError(400, 'message_too_long', `Messages are limited to ${MAX_MESSAGE_CHARS} characters`);
    }
    if (session.busy) throw new HttpError(409, 'busy', 'This session is already answering a message');

    session.busy = true;
    sessions.touch(session);
    const controller = new AbortController();
    activeStreams.add(controller);
    // Browser closed the tab / pressed Stop: cancel the model call so we
    // stop paying for tokens nobody will read.
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });

    const sse = openSse(res);
    try {
      const result = await runAgentTurn({
        provider,
        system: ASK_SYSTEM_PROMPT,
        messages: session.messages,
        userText: text,
        tools,
        effort: 'low',
        signal: controller.signal,
        onEvent: (event) => sse.send(event.type, event),
      });
      sse.send('done', { status: result.status, usage: result.usage });
      logRequest({ event: 'turn', status: result.status, ...result.usage });
    } catch (err) {
      if (err instanceof AbortedError) {
        logRequest({ event: 'turn', status: 'aborted' });
      } else {
        const { code, message } = describeError(err);
        if (code === 'internal') logRequest({ event: 'turn_error', error: String(err?.stack ?? err) });
        sse.send('error', { code, message });
      }
    } finally {
      session.busy = false;
      sessions.touch(session);
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

/** Request ID + one structured log line per request, written when it ends. */
function requestContext(log) {
  return async (/** @type {Context} */ ctx, next) => {
    const started = performance.now();
    ctx.requestId = (ctx.req.headers['x-request-id']?.toString().slice(0, 64)) || randomUUID();
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
    } else {
      ctx.log({ level: 'error', msg: 'request failed', error: String(err?.stack ?? err) });
      sendJson(ctx.res, 500, { error: { code: 'internal', message: 'Internal error' } });
    }
  }
}

async function notFound(/** @type {Context} */ ctx) {
  throw new HttpError(404, 'not_found', `No route for ${ctx.req.method} ${ctx.url.pathname}`);
}

/** Map provider errors to codes the UI can act on. */
export function describeError(err) {
  if (err instanceof InvalidKeyError) return { code: 'invalid_key', message: err.message };
  if (err instanceof RateLimitedError) return { code: 'rate_limited', message: err.message };
  if (err instanceof ProviderDownError) return { code: 'provider_down', message: err.message };
  if (err instanceof ProviderError) return { code: 'provider_error', message: err.message };
  return { code: 'internal', message: 'Something went wrong on our side.' };
}

/**
 * History → what the UI shows: user text, and per answer the assistant text
 * plus the tools it used. Tool results stay server-side.
 * @param {import('../llm/provider.js').Message[]} messages
 */
export function toDisplayMessages(messages) {
  /** @type {({ role: 'user', text: string } | { role: 'assistant', text: string, tools: { name: string, input: unknown }[] })[]} */
  const out = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      if (text) out.push({ role: 'user', text });
      continue;
    }
    let last = out.at(-1);
    if (last?.role !== 'assistant') {
      last = { role: 'assistant', text: '', tools: [] };
      out.push(last);
    }
    for (const block of message.content) {
      if (block.type === 'text') last.text += block.text;
      else if (block.type === 'tool_call') last.tools.push({ name: block.name, input: block.input });
    }
  }
  return out;
}

/** @param {Record<string, unknown>} entry */
function jsonLog(entry) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
}
