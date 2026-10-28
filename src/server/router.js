import { HttpError } from './http.js';

/**
 * Tiny router: `/api/sessions/:id/messages` style patterns, method matching,
 * and correct 404 vs 405 responses.
 *
 * @typedef {import('./http.js').Context} Context
 * @typedef {(ctx: Context) => unknown} Handler
 */
export class Router {
  /** @type {{ method: string, regex: RegExp, keys: string[], handler: Handler }[]} */
  #routes = [];

  /** @param {string} pattern @param {Handler} handler */
  get(pattern, handler) {
    return this.#add('GET', pattern, handler);
  }

  /** @param {string} pattern @param {Handler} handler */
  post(pattern, handler) {
    return this.#add('POST', pattern, handler);
  }

  #add(method, pattern, handler) {
    const keys = [];
    const source = pattern.replace(/\/:([A-Za-z_]\w*)/g, (_, key) => {
      keys.push(key);
      return '/([^/]+)';
    });
    this.#routes.push({ method, regex: new RegExp(`^${source}/?$`), keys, handler });
    return this;
  }

  /**
   * @param {string} method
   * @param {string} pathname
   * @returns {{ handler: Handler, params: Record<string, string> } | { allowed: string[] } | null}
   *   a match, a 405 (path exists, method doesn't), or null (404)
   */
  match(method, pathname) {
    const allowed = [];
    for (const route of this.#routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) {
        allowed.push(route.method);
        continue;
      }
      const params = {};
      route.keys.forEach((key, i) => {
        try {
          params[key] = decodeURIComponent(m[i + 1]);
        } catch {
          throw new HttpError(400, 'bad_request', `Malformed URL parameter "${key}"`);
        }
      });
      return { handler: route.handler, params };
    }
    return allowed.length ? { allowed } : null;
  }

  /** Middleware that dispatches to the matched route. Calls next() when nothing matches. */
  middleware() {
    return async (/** @type {Context} */ ctx, /** @type {() => Promise<void>} */ next) => {
      const found = this.match(ctx.req.method ?? 'GET', ctx.url.pathname);
      if (!found) return next();
      if ('allowed' in found) {
        ctx.res.setHeader('Allow', found.allowed.join(', '));
        throw new HttpError(405, 'method_not_allowed', `Use ${found.allowed.join(' or ')}`);
      }
      ctx.params = found.params;
      await found.handler(ctx);
    };
  }
}
