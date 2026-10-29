/**
 * HTTP building blocks: request context, errors, JSON helpers and
 * Koa-style middleware composition.
 *
 * @typedef {{
 *   req: import('node:http').IncomingMessage,
 *   res: import('node:http').ServerResponse,
 *   url: URL,
 *   params: Record<string, string>,
 *   requestId: string,
 *   log: (fields: Record<string, unknown>) => void,
 *   user: { id: string, email: string | null } | null,
 * }} Context
 *
 * @typedef {(ctx: Context, next: () => Promise<void>) => unknown} Middleware
 */

export class HttpError extends Error {
  /** @param {number} status @param {string} code machine-readable @param {string} message human-readable */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Read and parse a JSON request body, with a size limit.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
export async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Send Content-Type: application/json');
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > maxBytes) throw new HttpError(413, 'payload_too_large', `Body over ${maxBytes} bytes`);

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'payload_too_large', `Body over ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw new HttpError(400, 'invalid_json', 'Body is not valid JSON');
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
export function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

/**
 * Compose middleware into one function. Each gets (ctx, next); awaiting
 * next() runs the rest of the chain, so code after it runs "on the way out"
 * (the onion model, as in Koa).
 * @param {Middleware[]} middleware
 * @returns {(ctx: Context) => Promise<void>}
 */
export function compose(middleware) {
  return (ctx) => {
    let lastIndex = -1;
    const dispatch = (i) => {
      if (i <= lastIndex) return Promise.reject(new Error('next() called more than once'));
      lastIndex = i;
      const fn = middleware[i];
      if (!fn) return Promise.resolve();
      try {
        return Promise.resolve(fn(ctx, () => dispatch(i + 1)));
      } catch (err) {
        return Promise.reject(err);
      }
    };
    return dispatch(0);
  };
}
