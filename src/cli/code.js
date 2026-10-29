import { access, readFile, writeFile } from 'node:fs/promises';
import { styleText } from 'node:util';
import { databasePath, loadSources } from '../config.js';
import { openDatabase } from '../db/database.js';
import { defaultProvider } from '../llm/index.js';
import { DIFFICULTIES, generateProblem } from '../problems/generator.js';
import { publicResult, reviewSubmission } from '../problems/review.js';
import { ProblemStore } from '../problems/store.js';
import { CodeRunner } from '../runner/runner.js';
import { KnowledgeBase } from '../search/knowledge-base.js';

const STAGES = {
  generating: 'Writing a new problem…',
  verifying: "Checking the problem's tests against a reference solution…",
  fixing: 'Fixing the first draft…',
};

/**
 * `preppilot code <new|list|run|submit>`
 * @param {string[]} args positionals after "code"
 * @param {{ topic?: string, difficulty?: string, model?: string }} options
 */
export async function codeCommand([sub, ...rest], options) {
  const store = new ProblemStore(openDatabase(databasePath()));
  const runner = new CodeRunner();

  switch (sub) {
    case 'new': {
      const topic = (options.topic ?? 'promises').toLowerCase().replace(/[\s_]+/g, '-');
      const difficulty = options.difficulty ?? 'medium';
      if (!DIFFICULTIES.includes(difficulty)) throw new Error(`--difficulty must be one of ${DIFFICULTIES.join(', ')}`);
      const kb = await KnowledgeBase.build(await loadSources());
      const problem = await generateProblem({
        provider: defaultProvider({ model: options.model }),
        runner,
        store,
        kb,
        topic,
        difficulty: /** @type {any} */ (difficulty),
        onProgress: ({ stage }) => console.error(dim(STAGES[stage])),
      });
      const file = await uniqueFileName(slug(problem.title));
      await writeFile(file, `${problem.starterCode}\n`);
      console.log(`\n${styleText('bold', problem.title)}  ${dim(`(${problem.topic}, ${problem.difficulty})`)}\n`);
      console.log(problem.statement);
      console.log(`\nStarter code written to ${styleText('bold', file)}`);
      console.log(dim(`Run:    preppilot code run ${problem.id} ${file}`));
      console.log(dim(`Submit: preppilot code submit ${problem.id} ${file}`));
      return;
    }
    case 'list': {
      const problems = store.list({ topic: options.topic });
      if (!problems.length) return console.log('No problems yet. Create one with: preppilot code new --topic promises');
      for (const p of problems) console.log(`${p.id}  ${p.title} ${dim(`(${p.topic}, ${p.difficulty})`)}`);
      return;
    }
    case 'run':
    case 'submit': {
      const [id, file] = rest;
      if (!id || !file) throw new Error(`Usage: preppilot code ${sub} <problem-id> <file.js>`);
      const problem = store.get(id);
      if (!problem) throw new Error(`No problem with id ${id}. See: preppilot code list`);
      const code = await readFile(file, 'utf8');
      const tests = sub === 'run' ? problem.visibleTests : [...problem.visibleTests, ...problem.hiddenTests];
      const result = await runner.run({ code, tests });
      printResults(publicResult(problem, result));
      if (sub === 'run') return;

      console.log(`\n${styleText('bold', 'Review')}\n`);
      const review = await reviewSubmission({
        provider: defaultProvider({ model: options.model }),
        problem,
        code,
        result,
        onEvent: (event) => {
          if (event.type === 'text') process.stdout.write(event.delta);
        },
      });
      console.log(`\n${dim(`[tokens in ${review.usage.input} · out ${review.usage.output}]`)}`);
      return;
    }
    default:
      throw new Error('Usage: preppilot code new [--topic promises] [--difficulty medium] | list | run <id> <file> | submit <id> <file>');
  }
}

/** @param {ReturnType<typeof publicResult>} result */
function printResults(result) {
  const allPassed = result.status === 'ok' && result.passed === result.total;
  console.log(styleText(allPassed ? 'green' : 'red', `${result.passed}/${result.total} tests passed`) + dim(` · ${result.durationMs} ms`));
  if (result.status !== 'ok') console.log(styleText('red', `${result.status}${result.error ? `: ${result.error}` : ''}`));
  for (const t of result.tests) {
    const mark = t.passed ? styleText('green', '✓') : styleText('red', '✗');
    console.log(`  ${mark} ${t.name}${t.hidden ? dim(' [hidden]') : ''}`);
    if ('error' in t && t.error) console.log(dim(`      ${t.error.split('\n').join('\n      ')}`));
  }
  if (result.logs) console.log(`${dim('console output:')}\n${result.logs}`);
}

function slug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'problem';
}

/** Never overwrite the user's files: lru-cache.js, lru-cache-2.js, ... */
async function uniqueFileName(base) {
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${base}.js` : `${base}-${n}.js`;
    try {
      await access(name);
    } catch {
      return name;
    }
  }
}

function dim(text) {
  return styleText('dim', text);
}
