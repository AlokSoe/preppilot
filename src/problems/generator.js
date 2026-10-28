import { validate } from '../agent/validate.js';

/** @typedef {import('./store.js').TestCase} TestCase */

const MAX_ATTEMPTS = 3;

/** The model couldn't produce a problem that passes its own tests. */
export class GenerationError extends Error {}
export const DIFFICULTIES = ['easy', 'medium', 'hard'];

const TEST_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    code: { type: 'string', minLength: 1 },
  },
  required: ['name', 'code'],
  additionalProperties: false,
};

export const PROBLEM_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 3, maxLength: 120 },
    statement: { type: 'string', minLength: 20, description: 'Markdown problem statement shown to the candidate.' },
    starterCode: { type: 'string', minLength: 1, description: 'Function/class signature with an empty body.' },
    referenceSolution: { type: 'string', minLength: 1 },
    visibleTests: { type: 'array', items: TEST_SCHEMA, minItems: 2 },
    hiddenTests: { type: 'array', items: TEST_SCHEMA, minItems: 3 },
  },
  required: ['title', 'statement', 'starterCode', 'referenceSolution', 'visibleTests', 'hiddenTests'],
  additionalProperties: false,
};

export const GENERATOR_PROMPT = `You write machine-coding interview problems in JavaScript for an engineer with about five years of experience, and the hidden test suites used to grade them.

Return one problem as JSON matching the schema.

Code rules (the code runs in a sandbox, so these are strict):
- Plain JavaScript. No import, export, require, module.exports, network, file system or DOM.
- starterCode declares the required function(s) or class(es) at the top level with an empty or "throw new Error('Not implemented')" body, plus a JSDoc comment describing parameters and return value.
- referenceSolution is a complete, correct implementation with the same top-level names as starterCode.
- Each test's "code" is the body of an async function. The candidate's code is pasted above it, so its declarations are in scope. A strict assert (node:assert/strict) is available as "assert"; use assert.equal, assert.deepEqual, assert.throws and assert.rejects. Tests may await.
- Every test must be deterministic and finish in well under 500 ms. Use timer delays of at most 50 ms.
- 3 or 4 visibleTests show the basic behaviour. 5 to 8 hiddenTests cover edge cases: empty input, invalid arguments, large input, ordering, async timing, and anything the statement promises.
- Test names describe the behaviour, e.g. "evicts the least recently used key".

Statement rules:
- Markdown: what to build, the exact signature, requirements as a list, one or two examples, and constraints. The statement must contain everything needed to pass the hidden tests (e.g. which error to throw and when).
- Do not include the solution or hints that give it away.`;

/**
 * Generate a problem, then VERIFY it before saving: the reference solution
 * must pass every test, and the starter code must fail at least one (or the
 * tests check nothing). On failure the model sees the results and fixes its
 * own problem, up to 3 attempts.
 *
 * @param {{
 *   provider: import('../llm/provider.js').LLMProvider,
 *   runner: import('../runner/runner.js').CodeRunner,
 *   store: import('./store.js').ProblemStore,
 *   kb?: import('../search/knowledge-base.js').KnowledgeBase,
 *   topic: string,
 *   difficulty: 'easy' | 'medium' | 'hard',
 *   onProgress?: (event: { stage: 'generating' | 'verifying' | 'fixing', attempt: number, detail?: string }) => void,
 *   signal?: AbortSignal,
 * }} args
 * @returns {Promise<import('./store.js').Problem>}
 */
export async function generateProblem({ provider, runner, store, kb, topic, difficulty, onProgress = () => {}, signal }) {
  const avoid = store.titles(topic);
  const notes = kb?.search(topic.replace(/-/g, ' '), { k: 3, topic }) ?? [];
  const request = [
    `Topic: ${topic}`,
    `Difficulty: ${difficulty}`,
    avoid.length ? `Already generated for this topic (write something different): ${avoid.join('; ')}` : '',
    notes.length
      ? `The engineer's notes on this topic, for context:\n\n${notes.map((n) => `### ${n.path} § ${n.heading}\n${n.text}`).join('\n\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  /** @type {import('../llm/provider.js').Message[]} */
  const messages = [{ role: 'user', content: [{ type: 'text', text: request }] }];
  let lastProblem = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    onProgress({ stage: attempt === 1 ? 'generating' : 'fixing', attempt });
    const { data, text, raw } = await provider.generateJson({
      system: GENERATOR_PROMPT,
      messages,
      schema: PROBLEM_SCHEMA,
      effort: 'medium',
      signal,
    });
    messages.push({ role: 'assistant', content: [{ type: 'text', text }], raw });

    const schemaErrors = validate(PROBLEM_SCHEMA, data);
    let feedback;
    if (schemaErrors.length) {
      feedback = `The JSON didn't match the requirements: ${schemaErrors.join('; ')}.`;
    } else {
      onProgress({ stage: 'verifying', attempt });
      feedback = await verify(runner, data, signal);
      if (!feedback) {
        return store.insert({
          source: 'generated',
          topic,
          difficulty,
          title: data.title,
          statement: data.statement,
          starterCode: data.starterCode,
          referenceSolution: data.referenceSolution,
          visibleTests: data.visibleTests,
          hiddenTests: data.hiddenTests,
        });
      }
    }
    lastProblem = feedback;
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: `${feedback}\n\nFix the problem and return the complete corrected JSON.` }],
    });
  }
  throw new GenerationError(`Could not generate a verified problem after ${MAX_ATTEMPTS} attempts. Last issue: ${lastProblem}`);
}

/**
 * Run the problem's own tests against its reference solution and starter code.
 * @returns {Promise<string | null>} feedback for the model, or null if the problem is valid
 */
export async function verify(runner, problem, signal) {
  const tests = [...problem.visibleTests, ...problem.hiddenTests];
  const names = tests.map((t) => t.name);
  if (new Set(names).size !== names.length) return 'Test names must be unique.';

  const reference = await runner.run({ code: problem.referenceSolution, tests }, { signal });
  if (reference.status !== 'ok' || reference.passed !== reference.total) {
    const failures = reference.tests
      .filter((t) => !t.passed)
      .map((t) => `- ${t.name}: ${t.error}`)
      .join('\n');
    return `The reference solution does not pass its own tests (status: ${reference.status}${
      reference.error ? `, ${reference.error}` : ''
    }).\n${failures}`;
  }

  const starter = await runner.run({ code: problem.starterCode, tests }, { signal });
  if (starter.status === 'compile_error') return `The starter code has a syntax error: ${starter.error}`;
  if (starter.status === 'ok' && starter.passed === starter.total) {
    return 'The empty starter code passes every test, so the tests check nothing. Make the tests assert real behaviour.';
  }
  return null;
}
