#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { parseArgs, styleText } from 'node:util';
import { databasePath, loadSources } from '../src/config.js';
import { KnowledgeBase } from '../src/search/knowledge-base.js';
import { defaultProvider } from '../src/llm/index.js';
import { AbortedError, InvalidKeyError, ProviderError } from '../src/llm/provider.js';
import { runAgentTurn } from '../src/agent/agent.js';
import { writeFile } from 'node:fs/promises';
import { createBuildTools, createInterviewTools, createTools } from '../src/agent/tools.js';
import { ASK_SYSTEM_PROMPT, BUILD_SYSTEM_PROMPT, INTERVIEW_SYSTEM_PROMPT } from '../src/agent/prompts.js';
import { CodeRunner } from '../src/runner/runner.js';
import { toRunnableFile } from '../web/runnable.js';
import { loadRounds, roundBriefing } from '../src/interview/rounds.js';
import { openDatabase } from '../src/db/database.js';
import { ProgressStore } from '../src/progress/progress.js';

const HELP = `preppilot — AI interview coach

Usage:
  preppilot ask "<question>"                                One question, answered from your notes
  preppilot chat                                            Multi-turn conversation (Ctrl+C stops an answer, Ctrl+D exits)
  preppilot interview [--round 4]                           Mock interview, graded 1-10 per answer (no --round: list rounds)
  preppilot progress                                        Mastery per topic and what to study next
  preppilot build "<requirement>"                           Design, code, test and explain it (saves passing code)
  preppilot code new [--topic promises] [--difficulty medium]   Generate a verified coding problem
  preppilot code list | run <id> <file> | submit <id> <file>     Practise it (submit = all tests + AI review)
  preppilot serve [--port 8080] [--host 127.0.0.1]          Start the web app
  preppilot runner [--port 9000]                            Run the code-runner service (production, needs RUNNER_TOKEN)
  preppilot init --notes <folder>[,<folder>]                Choose the note folders to learn from
  preppilot search "<query>" [--k 5] [--topic event-loop]   Search your notes (no AI)
  preppilot index                                           Show what gets indexed
  preppilot help

Options for ask / chat:
  --effort low|medium|high    How hard the model thinks (default: low)
  --model <id>                Model ID (default: claude-opus-5-5)

AI provider: Claude by default (ANTHROPIC_API_KEY). Free options:
  PREPPILOT_PROVIDER=gemini  GEMINI_API_KEY=...  GEMINI_MODEL=<a Flash model>   (Google AI Studio free tier)
  PREPPILOT_PROVIDER=openai  OPENAI_BASE_URL=http://localhost:11434/v1  OPENAI_API_KEY=ollama  OPENAI_MODEL=<model>   (Ollama, local)
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
      round: { type: 'string' },
      notes: { type: 'string' },
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
    case 'interview': {
      const { rounds } = await loadRounds(await loadSources());
      const round = rounds.find((r) => r.id === Number(values.round));
      if (!round) {
        console.log('Rounds:');
        for (const r of rounds) console.log(`  --round ${r.id}  ${r.name}${r.minutes ? ` (~${r.minutes} min)` : ''}  ${dim(r.topics.join(', '))}`);
        return;
      }
      const session = await createSession({ ...values, effort: 'medium', mode: 'interview', round });
      return chat(session, 'Start the interview.');
    }
    case 'progress':
      return printProgress();
    case 'build': {
      const requirement = rest.join(' ').trim();
      if (!requirement) return fail('build needs a requirement, e.g. preppilot build "a rate limiter, N calls per minute"');
      const session = await createSession({ ...values, effort: 'high', mode: 'build' });
      return chat(session, requirement);
    }
    case 'code': {
      const { codeCommand } = await import('../src/cli/code.js');
      return codeCommand(rest, values);
    }
    case 'runner': {
      const { startRunnerService } = await import('../src/runner/service.js');
      await startRunnerService({
        host: values.host ?? '0.0.0.0',
        port: Number(values.port ?? 9000),
        token: process.env.RUNNER_TOKEN ?? '',
        concurrency: Number(process.env.RUNNER_CONCURRENCY ?? 4),
      });
      return;
    }
    case 'init': {
      const { initConfig } = await import('../src/cli/init.js');
      return initConfig(values.notes);
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
 * @param {{ effort: string, model?: string, mode?: 'ask' | 'interview' | 'build',
 *           round?: import('../src/interview/rounds.js').Round }} options
 */
async function createSession({ effort, model, mode = 'ask', round }) {
  if (!['low', 'medium', 'high'].includes(effort)) throw new Error('--effort must be low, medium or high');
  const sources = await loadSources();
  const kb = await KnowledgeBase.build(sources);
  const provider = defaultProvider({ model });
  let tools = createTools({ kb });
  if (mode === 'interview') {
    const { rubric } = await loadRounds(sources);
    const progress = new ProgressStore(openDatabase(databasePath()));
    tools = createInterviewTools({ kb, provider, progress, rubric, userId: 'local' });
  }
  const runner = mode === 'build' ? new CodeRunner() : null;
  /** @type {import('../src/llm/provider.js').Message[]} */
  const messages = [];
  const system = { ask: ASK_SYSTEM_PROMPT, interview: INTERVIEW_SYSTEM_PROMPT, build: BUILD_SYSTEM_PROMPT }[mode];

  return {
    /** @param {string} userText @param {AbortSignal} [signal] */
    async send(userText, signal) {
      const out = new TerminalRenderer();
      /** run_code inputs by tool id; the last fully passing one is saved */
      const runs = new Map();
      let passing = null;
      try {
        const result = await runAgentTurn({
          provider,
          system,
          messages,
          userText,
          context: round && messages.length === 0 ? roundBriefing(round) : undefined,
          tools: runner ? createBuildTools({ kb, runner }) : tools,
          effort: /** @type {any} */ (effort),
          signal,
          onEvent: (event) => {
            if (event.type === 'tool_start' && event.name === 'run_code') runs.set(event.id, event.input);
            if (event.type === 'tool_end' && runs.has(event.id)) {
              const counts = /(\d+)\/(\d+)/.exec(event.summary);
              if (event.ok && counts && counts[1] === counts[2]) passing = runs.get(event.id);
            }
            out.render(event);
          },
        });
        out.finish(result);
        if (passing) {
          const file = 'preppilot-build.js';
          await writeFile(file, toRunnableFile(passing.code, passing.tests, userText.slice(0, 80)));
          console.error(styleText('green', `Saved passing code + tests to ${file}`) + dim(` (run: node ${file})`));
        }
      } catch (err) {
        out.newline();
        if (err instanceof AbortedError) return console.error(dim('(stopped)'));
        throw err;
      }
    },
  };
}

/**
 * @param {Awaited<ReturnType<typeof createSession>>} session
 * @param {string} [firstMessage] sent automatically (e.g. to start an interview)
 */
async function chat(session, firstMessage) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  /** @type {AbortController | null} */
  let current = null;
  rl.on('SIGINT', () => (current ? current.abort() : rl.close()));
  rl.on('close', () => current?.abort());

  console.log(dim('PrepPilot — Ctrl+C stops an answer, Ctrl+D exits.\n'));
  let pending = firstMessage;
  for (;;) {
    let line = pending;
    pending = undefined;
    if (line === undefined) {
      try {
        line = (await rl.question(styleText('bold', 'you › '))).trim();
      } catch {
        break; // closed (Ctrl+D)
      }
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

async function printProgress() {
  const kb = await KnowledgeBase.build(await loadSources());
  const summary = new ProgressStore(openDatabase(databasePath())).summary('local', { allTopics: kb.topics() });
  if (!summary.attempts) {
    console.log('No graded attempts yet. Try: preppilot interview --round 4');
    return;
  }
  console.log(`${summary.attempts} attempts · average ${summary.averageScore}/10\n`);
  for (const t of summary.topics) {
    const bar = '█'.repeat(Math.round(t.mastery / 10)).padEnd(10, '·');
    const review = t.due ? styleText('red', 'due now') : `review ${new Date(t.dueAt).toLocaleDateString()}`;
    console.log(`  ${t.topic.padEnd(24)} ${bar} ${String(t.mastery).padStart(3)}  last ${t.lastScore}/10  ${dim(review)}`);
  }
  if (summary.next.length) console.log(`\nStudy next: ${summary.next.join(', ')}`);
  if (summary.untried.length) console.log(dim(`Not tried yet: ${summary.untried.join(', ')}`));
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
      case 'score': {
        const color = event.score >= 7 ? 'green' : event.score >= 4 ? 'yellow' : 'red';
        const lines = [styleText(['bold', color], `Score ${event.score}/10`) + `  ${event.verdict}`];
        for (const gap of event.gaps ?? []) lines.push(dim(`  missing: ${gap}`));
        for (const wrong of event.misconceptions ?? []) lines.push(styleText('red', `  incorrect: ${wrong}`));
        process.stderr.write(`${lines.join('\n')}\n\n`);
        break;
      }
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
    const help = {
      gemini: 'Get a free key at https://aistudio.google.com and run: export GEMINI_API_KEY=...',
      openai: 'Set OPENAI_API_KEY (any value, e.g. "ollama", for a local Ollama server).',
    }[process.env.PREPPILOT_PROVIDER ?? ''];
    console.error(`${err.message}\n${help ?? 'Get a key at https://console.anthropic.com and run: export ANTHROPIC_API_KEY=sk-ant-...'}`);
  } else if (err instanceof ProviderError) {
    console.error(err.message);
  } else {
    console.error(err instanceof Error ? err.message : err);
  }
  process.exitCode = 1;
});
