/**
 * Read a Server-Sent Events stream from a fetch() response body.
 *
 * The browser's EventSource only supports GET, but we send each message with
 * POST, so we parse the stream ourselves. Network chunks can split an event
 * anywhere, so bytes are buffered until a blank line ends an event.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<{ event: string, data: any }>}
 */
export async function* readSse(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const event = parseEvent(raw);
        if (event) yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** @param {string} raw one event's lines @returns {{ event: string, data: any } | null} */
export function parseEvent(raw) {
  let event = 'message';
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue; // ":" lines are comments (heartbeats)
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  return { event, data: JSON.parse(data.join('\n')) };
}
