import { readFile } from 'node:fs/promises';
import path from 'node:path';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Serve files from `root` for GET/HEAD requests that no route handled.
 * `/` maps to index.html. Paths that resolve outside `root` (../) are 404s.
 * @param {string} root absolute directory
 * @returns {import('./http.js').Middleware}
 */
export function serveStatic(root) {
  const base = path.resolve(root);
  return async (ctx, next) => {
    const method = ctx.req.method;
    if ((method !== 'GET' && method !== 'HEAD') || ctx.url.pathname.startsWith('/api/')) return next();

    let pathname;
    try {
      pathname = decodeURIComponent(ctx.url.pathname);
    } catch {
      return next();
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.resolve(base, `.${pathname}`);
    if (file !== base && !file.startsWith(base + path.sep)) return next();

    const type = CONTENT_TYPES[path.extname(file)];
    if (!type) return next();

    let body;
    try {
      body = await readFile(file);
    } catch {
      return next();
    }
    ctx.res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': 'no-cache', // always revalidate; files are small
    });
    ctx.res.end(method === 'HEAD' ? undefined : body);
  };
}
