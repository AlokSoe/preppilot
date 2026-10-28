import { validate } from '../agent/validate.js';

const SCORE = { type: 'integer', minimum: 1, maximum: 10 };
const STRINGS = { type: 'array', items: { type: 'string' } };

export const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    score: SCORE,
    criteria: {
      type: 'object',
      properties: { correctness: SCORE, depth: SCORE, clarity: SCORE, internals: SCORE, seniority: SCORE },
      required: ['correctness', 'depth', 'clarity', 'internals', 'seniority'],
      additionalProperties: false,
    },
    verdict: { type: 'string', description: 'One line, e.g. "Correct but misses why microtasks run first".' },
    strengths: STRINGS,
    gaps: STRINGS,
    misconceptions: { ...STRINGS, description: 'Incorrect claims the candidate made. Empty if none.' },
    idealAnswer: { type: 'string', description: 'Concise senior-level answer in Markdown, with a short code example if useful.' },
    followUps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
  },
  required: ['score', 'criteria', 'verdict', 'strengths', 'gaps', 'misconceptions', 'idealAnswer', 'followUps'],
  additionalProperties: false,
};

/**
 * The rubric is part of the system prompt, so it's identical for every
 * grading call in a deployment (cache-friendly).
 * @param {string} rubric
 */
export function graderPrompt(rubric) {
  return `You grade one answer from a JavaScript interview, for an engineer with about five years of experience. Be calibrated and strict: a score is evidence, not encouragement.

Rubric:
${rubric}

Rules:
- Score each criterion 1-10, then an overall score 1-10 that follows the score bands.
- Use the reference notes to check facts, but judge against how JavaScript actually behaves. If the notes are wrong, trust the language and mention it in gaps.
- "I don't know", an off-topic reply or an empty answer scores 1 on everything.
- Don't reward length. Reward correct, precise reasoning and the right mental model.
- misconceptions lists claims the candidate made that are false. Leave it empty if there are none.
- followUps are 1-3 questions a senior interviewer would ask next to probe deeper.`;
}

/**
 * Grade one interview answer with a separate, structured-output model call.
 * Kept apart from the interviewer so scoring is consistent and the
 * interviewer can't drift into grading its own questions generously.
 *
 * @param {{
 *   provider: import('../llm/provider.js').LLMProvider,
 *   rubric: string,
 *   question: string,
 *   answer: string,
 *   topic: string,
 *   notes?: { path: string, heading: string, text: string }[],
 *   signal?: AbortSignal,
 * }} args
 */
export async function gradeAnswer({ provider, rubric, question, answer, topic, notes = [], signal }) {
  const text = [
    `## Topic\n${topic}`,
    `## Question\n${question}`,
    `## Candidate's answer\n${answer.trim() || '(no answer)'}`,
    notes.length
      ? `## Reference notes\n${notes.map((n) => `### ${n.path} § ${n.heading}\n${n.text}`).join('\n\n')}`
      : '## Reference notes\n(none found)',
  ].join('\n\n');

  const { data, usage } = await provider.generateJson({
    system: graderPrompt(rubric),
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    schema: GRADE_SCHEMA,
    effort: 'medium',
    signal,
  });
  const errors = validate(GRADE_SCHEMA, data);
  if (errors.length) throw new Error(`Grader returned an invalid result: ${errors.join('; ')}`);
  return { grade: /** @type {Grade} */ (data), usage };
}

/**
 * @typedef {{
 *   score: number,
 *   criteria: { correctness: number, depth: number, clarity: number, internals: number, seniority: number },
 *   verdict: string, strengths: string[], gaps: string[], misconceptions: string[],
 *   idealAnswer: string, followUps: string[],
 * }} Grade
 */
