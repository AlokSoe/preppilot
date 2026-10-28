import { MalformedToolInputError } from '../llm/provider.js';
import { validate } from './validate.js';

/** @typedef {import('../llm/provider.js').Message} Message */
/** @typedef {import('../llm/provider.js').Usage} Usage */
/** @typedef {import('./tools.js').Tool} Tool */

/**
 * Events emitted while a turn runs (forwarded to the CLI, later to SSE).
 * @typedef {{ type: 'text', delta: string }
 *   | { type: 'tool_start', id: string, name: string, input: unknown }
 *   | { type: 'tool_end', id: string, name: string, ok: boolean, summary: string }
 *   | { type: 'retry', reason: string }
 *   | { type: 'score', [key: string]: unknown }} AgentEvent
 *   Tools may emit their own events (e.g. the grader's score card) via ctx.onEvent.
 *
 * @typedef {'done' | 'refused' | 'truncated' | 'iteration_limit'} TurnStatus
 */

const MAX_ITERATIONS = 8;
const MAX_MALFORMED_RETRIES = 2;
const MAX_TOOL_OUTPUT_CHARS = 20_000;

/**
 * Run one user turn through the agent loop (design doc §9.2):
 *
 *   send history → stream text → model asks for tools? → run them (in
 *   parallel) → send all results back in ONE message → repeat until the
 *   model answers, refuses, or we hit the iteration cap.
 *
 * `messages` is mutated in place and only ever appended to.
 *
 * @param {{
 *   provider: import('../llm/provider.js').LLMProvider,
 *   system: string,
 *   messages: Message[],
 *   userText: string,
 *   context?: string,
 *   tools: Tool[],
 *   effort?: import('../llm/provider.js').Effort,
 *   onEvent?: (event: AgentEvent) => void,
 *   signal?: AbortSignal,
 *   maxIterations?: number,
 * }} args
 * @returns {Promise<{ status: TurnStatus, usage: Usage, text: string }>}
 */
export async function runAgentTurn({
  provider,
  system,
  messages,
  userText,
  context,
  tools,
  effort,
  onEvent = () => {},
  signal,
  maxIterations = MAX_ITERATIONS,
}) {
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const toolSpecs = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  /** @type {Usage} */
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  // `context` (e.g. an interview round's briefing) goes to the model in the
  // same message but is marked hidden, so UIs show only what the user typed.
  messages.push({
    role: 'user',
    content: [...(context ? [{ type: 'text', text: context, hidden: true }] : []), { type: 'text', text: userText }],
  });

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const turn = await streamWithRetry({ provider, system, messages, toolSpecs, effort, signal, onEvent });
    addUsage(usage, turn.usage);
    const text = turn.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');

    // A refusal may have cut the answer (or a tool call) off midway: keep
    // nothing from it and run none of its tools.
    if (turn.stopReason === 'refused') return { status: 'refused', usage, text: '' };

    const toolCalls = turn.content.filter((b) => b.type === 'tool_call');
    if (turn.stopReason === 'max_tokens' && toolCalls.length) {
      // A tool input cut off at max_tokens can still look valid. Don't run it.
      return { status: 'truncated', usage, text };
    }

    messages.push({ role: 'assistant', content: turn.content, raw: turn.raw });

    if (turn.stopReason !== 'tool_calls' || toolCalls.length === 0) {
      return { status: turn.stopReason === 'max_tokens' ? 'truncated' : 'done', usage, text };
    }

    const results = await Promise.all(
      toolCalls.map((call) => runTool(/** @type {any} */ (call), toolsByName, { signal, onEvent })),
    );
    messages.push({ role: 'user', content: results });
  }

  return { status: 'iteration_limit', usage, text: '' };
}

/**
 * Stream one model turn, forwarding text deltas. Re-issues the turn if the
 * model streamed an unparseable tool input (bounded).
 */
async function streamWithRetry({ provider, system, messages, toolSpecs, effort, signal, onEvent }) {
  for (let attempt = 0; ; attempt++) {
    try {
      const stream = provider.streamTurn({ system, messages, tools: toolSpecs, effort, signal });
      for (;;) {
        const { value, done } = await stream.next();
        if (done) return value;
        onEvent(value);
      }
    } catch (err) {
      if (!(err instanceof MalformedToolInputError) || attempt >= MAX_MALFORMED_RETRIES) throw err;
      onEvent({ type: 'retry', reason: 'malformed tool input' });
    }
  }
}

/**
 * Validate and run one tool call. Never throws: failures become
 * `isError` results so the model can see what went wrong and recover.
 * @returns {Promise<import('../llm/provider.js').ToolResultBlock>}
 */
async function runTool(call, toolsByName, { signal, onEvent }) {
  onEvent({ type: 'tool_start', id: call.id, name: call.name, input: call.input });

  const fail = (message) => {
    onEvent({ type: 'tool_end', id: call.id, name: call.name, ok: false, summary: message });
    return { type: /** @type {const} */ ('tool_result'), id: call.id, output: message, isError: true };
  };

  const tool = toolsByName.get(call.name);
  if (!tool) return fail(`Unknown tool "${call.name}".`);

  const errors = validate(tool.inputSchema, call.input);
  if (errors.length) return fail(`Invalid input: ${errors.join('; ')}. Received: ${JSON.stringify(call.input)}`);

  try {
    let output = String(await tool.run(call.input, { signal, onEvent }));
    if (output.length > MAX_TOOL_OUTPUT_CHARS) {
      output = `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[output truncated at ${MAX_TOOL_OUTPUT_CHARS} characters]`;
    }
    const summary = tool.summarize ? tool.summarize(call.input, output) : 'ok';
    onEvent({ type: 'tool_end', id: call.id, name: call.name, ok: true, summary });
    return { type: 'tool_result', id: call.id, output };
  } catch (err) {
    return fail(`Tool failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** @param {Usage} total @param {Usage} add */
function addUsage(total, add) {
  total.input += add.input;
  total.output += add.output;
  total.cacheRead += add.cacheRead;
  total.cacheWrite += add.cacheWrite;
}
