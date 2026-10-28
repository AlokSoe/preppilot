import { gradeAnswer } from '../interview/grader.js';

/**
 * Tools the agent can call (design doc §9.3).
 *
 * @typedef {import('../llm/provider.js').ToolSpec & {
 *   run(input: any, ctx: { signal?: AbortSignal, onEvent?: (event: any) => void }): Promise<string> | string,
 *   summarize?(input: any, output: string): string,
 * }} Tool
 */

/**
 * Interview mode: the note tools plus grade_answer, which runs the separate
 * grader, records the attempt for spaced repetition, and emits a score card.
 * @param {{
 *   kb: import('../search/knowledge-base.js').KnowledgeBase,
 *   provider: import('../llm/provider.js').LLMProvider,
 *   progress: import('../progress/progress.js').ProgressStore,
 *   rubric: string,
 *   userId: string,
 * }} deps
 * @returns {Tool[]}
 */
export function createInterviewTools({ kb, provider, progress, rubric, userId }) {
  return [
    ...createTools({ kb }),
    {
      name: 'grade_answer',
      description:
        "Grade the candidate's answer to the question you just asked, against the interview rubric. " +
        'Call this after every answer (including "I don\'t know") before giving feedback. It records ' +
        'the score for progress tracking and returns the score, strengths, gaps, an ideal answer and follow-ups.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', minLength: 1, maxLength: 4000, description: 'The exact question you asked, including any code.' },
          answer: { type: 'string', maxLength: 8000, description: "The candidate's answer, verbatim." },
          topic: { type: 'string', minLength: 1, maxLength: 60, description: 'Topic name, e.g. "event-loop".' },
        },
        required: ['question', 'answer', 'topic'],
        additionalProperties: false,
      },
      async run({ question, answer, topic }, { signal, onEvent }) {
        const notes = kb.search(question, { k: 4, topic });
        const { grade } = await gradeAnswer({ provider, rubric, question, answer, topic, notes, signal });
        const recorded = progress.record({ userId, kind: 'interview', topic, score: grade.score, question, feedback: grade.verdict });
        onEvent?.({ type: 'score', topic: recorded.topic, mastery: recorded.mastery, ...grade });
        return JSON.stringify({ ...grade, topic: recorded.topic, topicMastery: recorded.mastery });
      },
      summarize: (input, output) => {
        const { score, verdict } = JSON.parse(output);
        return `${score}/10 · ${verdict}`;
      },
    },
  ];
}

const MAX_RUNS_PER_TURN = 6; // first run + 3 fix rounds, with some slack

/**
 * Build mode: the note tools plus run_code. Create one set per user turn:
 * the run counter caps how many times the model can execute code in a turn.
 * @param {{
 *   kb: import('../search/knowledge-base.js').KnowledgeBase,
 *   runner: import('../runner/runner.js').CodeRunner,
 * }} deps
 * @returns {Tool[]}
 */
export function createBuildTools({ kb, runner }) {
  let runs = 0;
  const testSchema = {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      code: { type: 'string', minLength: 1, maxLength: 20_000 },
    },
    required: ['name', 'code'],
    additionalProperties: false,
  };
  return [
    ...createTools({ kb }),
    {
      name: 'run_code',
      description:
        'Run JavaScript against tests in a sandbox (no network, file system or DOM; 5 s limit). ' +
        '`code` declares top-level functions/classes. Each test `code` is the body of an async function ' +
        'with `assert` (node:assert/strict) in scope; the code is re-evaluated fresh for every test. ' +
        'Returns pass/fail per test with errors, plus console output.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', minLength: 1, maxLength: 100_000 },
          tests: { type: 'array', items: testSchema, minItems: 1, maxItems: 40 },
        },
        required: ['code', 'tests'],
        additionalProperties: false,
      },
      async run({ code, tests }, { signal }) {
        if (++runs > MAX_RUNS_PER_TURN) {
          throw new Error(`Run limit reached (${MAX_RUNS_PER_TURN} per turn). Explain what is left instead of running again.`);
        }
        const result = await runner.run({ code, tests }, { signal });
        const lines = [`status: ${result.status}${result.error ? ` (${result.error})` : ''}`, `passed: ${result.passed}/${result.total}`];
        for (const t of result.tests) lines.push(`${t.passed ? 'PASS' : 'FAIL'} ${t.name}${t.error ? ` — ${t.error}` : ''}`);
        if (result.logs) lines.push('console output:', result.logs.slice(0, 4000));
        return lines.join('\n');
      },
      summarize: (input, output) => /passed: (\d+\/\d+)/.exec(output)?.[1].concat(' tests passed') ?? 'ran',
    },
  ];
}

/**
 * @param {{ kb: import('../search/knowledge-base.js').KnowledgeBase }} deps
 * @returns {Tool[]}
 */
export function createTools({ kb }) {
  return [
    {
      name: 'search_notes',
      description:
        "Search the engineer's study notes (machine-coding-js and javascript-engineering-handbook) " +
        'with keyword (BM25) search. Returns the best-matching sections with their file path and ' +
        'heading, to cite. Use specific technical terms (e.g. "microtask queue setTimeout"), ' +
        'and search again with different terms if results look off-topic.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 300, description: 'Keywords to search for.' },
          topic: {
            type: 'string',
            description: 'Optional topic to boost, e.g. "event-loop". Call list_topics for valid names.',
          },
          k: { type: 'integer', minimum: 1, maximum: 10, description: 'Number of results (default 5).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      run({ query, topic, k = 5 }) {
        const results = kb.search(query, { k, topic });
        if (!results.length) return `No notes matched "${query}".`;
        return results
          .map((r, i) => `[${i + 1}] ${r.repo}/${r.path} § ${r.heading}  (topic: ${r.topic})\n${r.text}`)
          .join('\n\n---\n\n');
      },
      summarize: (input, output) =>
        output.startsWith('No notes') ? 'no matches' : `${output.split('\n\n---\n\n').length} results`,
    },
    {
      name: 'list_topics',
      description: 'List the topic names found in the notes (useful for the `topic` option of search_notes).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => kb.topics().join(', '),
      summarize: (input, output) => `${output.split(', ').length} topics`,
    },
  ];
}
