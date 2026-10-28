const HEARTBEAT_MS = 15_000;

/**
 * Turn a response into a Server-Sent Events stream.
 *
 * Format per event:   event: <name>\ndata: <json>\n\n
 * A comment line (": ping") every 15 s keeps proxies and load balancers from
 * closing an idle connection while the model is thinking.
 *
 * @param {import('node:http').ServerResponse} res
 */
export function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // tell nginx-style proxies not to buffer
  });
  res.flushHeaders();

  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  heartbeat.unref();

  return {
    /** @param {string} event @param {unknown} data */
    send(event, data) {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    },
  };
}
