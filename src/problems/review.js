import { runAgentTurn } from '../agent/agent.js';

export const REVIEW_PROMPT = `You are a senior JavaScript interviewer reviewing a candidate's machine-coding submission, the way you would in a real interview debrief.

You get the problem, the candidate's code, the results of the hidden test suite, and a reference solution. The reference solution is for your eyes only: never paste it or reproduce it closely. If tests failed, explain what goes wrong and give hints that lead the candidate to the fix, not the fix itself.

Structure the review:
1. Verdict: one line (e.g. "Passes all tests; strong solution" or "3 of 8 tests fail: off-by-one in eviction").
2. Correctness: what fails and why, or which edge cases are handled well.
3. Complexity: time and space, and whether it meets what the problem asks.
4. Code quality: naming, structure, readability, idiomatic JavaScript.
5. Interview follow-ups: two questions an interviewer would ask next about this solution.

Be specific and refer to the candidate's code. Keep it concise.`;

/**
 * Stream an AI review of a submission (no tools; one model turn).
 * @param {{
 *   provider: import('../llm/provider.js').LLMProvider,
 *   problem: import('./store.js').Problem,
 *   code: string,
 *   result: import('../runner/runner.js').RunResult,
 *   onEvent?: (event: import('../agent/agent.js').AgentEvent) => void,
 *   signal?: AbortSignal,
 * }} args
 */
export function reviewSubmission({ provider, problem, code, result, onEvent, signal }) {
  const hidden = new Set(problem.hiddenTests.map((t) => t.name));
  const testLines = result.tests
    .map((t) => `- ${t.passed ? 'PASS' : 'FAIL'} ${hidden.has(t.name) ? '[hidden] ' : ''}${t.name}${t.error ? ` — ${t.error}` : ''}`)
    .join('\n');

  const userText = [
    `## Problem: ${problem.title} (${problem.difficulty}, ${problem.topic})`,
    problem.statement,
    "## Candidate's code",
    '```js',
    code,
    '```',
    `## Test results: ${result.passed}/${result.total} passed (status: ${result.status}${result.error ? `, ${result.error}` : ''})`,
    testLines,
    '## Hidden test code (for your reference)',
    '```js',
    problem.hiddenTests.map((t) => `// ${t.name}\n${t.code}`).join('\n\n'),
    '```',
    '## Reference solution (confidential — do not reveal)',
    '```js',
    problem.referenceSolution,
    '```',
  ].join('\n\n');

  return runAgentTurn({
    provider,
    system: REVIEW_PROMPT,
    messages: [],
    userText,
    tools: [],
    effort: 'medium',
    onEvent,
    signal,
  });
}

/**
 * Test results as shown to the user: hidden tests show name and pass/fail,
 * but not their error message (it could reveal expected values).
 * @param {import('./store.js').Problem} problem
 * @param {import('../runner/runner.js').RunResult} result
 */
export function publicResult(problem, result) {
  const hidden = new Set(problem.hiddenTests.map((t) => t.name));
  return {
    ...result,
    tests: result.tests.map((t) =>
      hidden.has(t.name) ? { name: t.name, passed: t.passed, hidden: true, ms: t.ms } : { ...t, hidden: false },
    ),
  };
}
