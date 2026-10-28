#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { parseArgs, styleText } from 'node:util';
import { loadSources } from '../src/config.js';
import { KnowledgeBase } from '../src/search/knowledge-base.js';
import { createProvider } from '../src/llm/index.js';
import { AbortedError, InvalidKeyError, ProviderError } from '../src/llm/provider.js';
import { runAgentTurn } from '../src/agent/agent.js';
import { createTools } from '../src/agent/tools.js';
import { ASK_SYSTEM_PROMPT } from '../src/agent/prompts.js';

const HELP = `preppilot — AI interview coach

Usage:
  preppilot ask "<question>"                                One question, answered from your notes
  preppilot chat                                            Multi-turn conversation (Ctrl+C stops an answer, Ctrl+D exits)
  preppilot code new [--topic promises] [--difficulty medium]   Generate a verified coding problem
  preppilot code list | run <id> <file> | submit <id> <file>     Practise it (submit = all tests + AI review)
  preppilot serve [--port 8080] [--host 127.0.0.1]          Start the web app
  preppilot search "<query>" [--k 5] [--topic event-loop]   Search your notes (no AI)
  preppilot index                                           Show what gets indexed
  preppilot help

Options for ask / chat:
  --effort low|medium|high    How hard the model thinks (default: low)
  --model <id>                Model ID (default: claude-opus-5-5)

Needs ANTHROPIC_API_KEY for ask / chat / serve.
`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      k: { type: 'string', default: '5' },
      topic: { type: 'string' },
      effort: { type: 'string', default: 'low' },
      model: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      difficulty: { type: 'string' },
    },
  });
  const [command, ...rest] = positionals;

  switch (command) {
    case 'ask': {
      const question = rest.join(' ').trim();
      if (!question) return fail('ask needs a question, e.g. preppilot ask "what is a closure?"');
      const session = await createSession(values);
      await session.send(question);
      return;
    }
    case 'chat':
      return chat(await createSession(values));
    case 'code': {
      const { codeCommand } = await import('../src/cli/code.js');
      return codeCommand(rest, values);
    }
    case 'serve': {
      const port = Number(values.port ?? process.env.PORT ?? 8080);
      if (!Number.isInteger(port) || port < 0 || port > 65535) return fail('--port must be 0-65535');
      const { startServer } = await import('../src/server/main.js');
      await startServer({ port, host: values.host ?? process.env.HOST ?? '127.0.0.1' });
      return;
    }
    case 'search': {
      const query = rest.join(' ').trim();
      if (!query) return fail('search needs a query, e.g. preppilot search "event loop"');
      const kb = await KnowledgeBase.build(await loadSources());
      const results = kb.search(query, { k: Number(values.k), topic: values.topic });
      if (!results.length) return console.log('No matches.');
      results.forEach((r, i) => {
        console.log(`${i + 1}. [${r.score.toFixed(2)}] ${r.repo}/${r.path}`);
        console.log(`   § ${r.heading}`);
        console.log(`   ${snippet(r.text)}\n`);
      });
      return;
    }
    case 'index': {
      const sources = await loadSources();
      const kb = await KnowledgeBase.build(sources);
      console.log(`Sources:\n${sources.map((s) => `  - ${s}`).join('\n')}`);
      console.log(`Files: ${kb.stats.files}  Chunks: ${kb.stats.chunks}  Built in: ${kb.stats.buildMs} ms`);
      console.log(`Topics (${kb.topics().length}): ${kb.topics().join(', ')}`);
      return;
    }
    case undefined:
    case 'help':
      return console.log(HELP);
    default:
      return fail(`Unknown command "${command}".\n\n${HELP}`);
  }
}

/**
 * A conversation: history + the agent, rendering events to the terminal.
 * @param {{ effort: string, model?: string }} options
 */
async function createSession({ effort, model }) {
  if (!['low', 'medium', 'high'].includes(effort)) throw new Error('--effort must be low, medium or high');
  const kb = await KnowledgeBase.build(await loadSources());
  const provider = createProvider({ provider: 'claude', model });
  const tools = createTools({ kb });
  /** @type {import('../src/llm/provider.js').Message[]} */
  const messages = [];

  return {
    /** @param {string} userText @param {AbortSignal} [signal] */
    async send(userText, signal) {
      const out = new TerminalRenderer();
      try {
        const result = await runAgentTurn({
          provider,
          system: ASK_SYSTEM_PROMPT,
          messages,
          userText,
          tools,
          effort: /** @type {any} */ (effort),
          signal,
          onEvent: (event) => out.render(event),
        });
        out.finish(result);
      } catch (err) {
        out.newline();
        if (err instanceof AbortedError) return console.error(dim('(stopped)'));
        throw err;
      }
    },
  };
}

/** @param {Awaited<ReturnType<typeof createSession>>} session */
async function chat(session) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  /** @type {AbortController | null} */
  let current = null;
  rl.on('SIGINT', () => (current ? current.abort() : rl.close()));
  rl.on('close', () => current?.abort());

  console.log(dim('PrepPilot chat — ask anything about JavaScript. Ctrl+C stops an answer, Ctrl+D exits.\n'));
  for (;;) {
    let line;
    try {
      line = (await rl.question(styleText('bold', 'you › '))).trim();
    } catch {
      break; // closed (Ctrl+D)
    }
    if (!line) continue;
    current = new AbortController();
    try {
      await session.send(line, current.signal);
    } finally {
      current = null;
    }
    console.log();
  }
  rl.close();
}

/** Streams agent events to the terminal: answer on stdout, tool activity dimmed. */
class TerminalRenderer {
  #atLineStart = true;

  /** @param {import('../src/agent/agent.js').AgentEvent} event */
  render(event) {
    switch (event.type) {
      case 'text':
        process.stdout.write(event.delta);
        this.#atLineStart = event.delta.endsWith('\n');
        break;
      case 'tool_start':
        this.newline();
        process.stderr.write(dim(`› ${event.name} ${JSON.stringify(event.input)}`));
        break;
      case 'tool_end':
        process.stderr.write(dim(` → ${event.summary}\n`));
        this.#atLineStart = true;
        break;
      case 'retry':
        this.newline();
        process.stderr.write(dim(`(retrying: ${event.reason})\n`));
        break;
    }
  }

  /** @param {Awaited<ReturnType<typeof runAgentTurn>>} result */
  finish({ status, usage }) {
    this.newline();
    const notes = {
      refused: 'The model declined to answer this one. Try rephrasing.',
      truncated: '(answer cut off: hit the max output length)',
      iteration_limit: '(stopped: too many tool steps in one answer)',
    };
    if (status in notes) console.error(notes[/** @type {keyof typeof notes} */ (status)]);
    console.error(
      dim(`[tokens in ${usage.input} · cached ${usage.cacheRead} · cache write ${usage.cacheWrite} · out ${usage.output}]`),
    );
  }

  newline() {
    if (!this.#atLineStart) process.stdout.write('\n');
    this.#atLineStart = true;
  }
}

function dim(text) {
  return styleText('dim', text);
}

function snippet(text, max = 160) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

main().catch((err) => {
  if (err instanceof InvalidKeyError) {
    console.error(`${err.message}\nGet a key at https://console.anthropic.com and run: export ANTHROPIC_API_KEY=sk-ant-...`);
  } else if (err instanceof ProviderError) {
    console.error(err.message);
  } else {
    console.error(err instanceof Error ? err.message : err);
  }
  process.exitCode = 1;
});
