import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { topicFromPath } from '../indexer/chunk.js';

/**
 * @typedef {{ id: number, name: string, minutes: number | null, details: string, topics: string[] }} Round
 */

const MOCK_INTERVIEW_FILE = path.join('28-mock-interview', 'questions.md');

export const DEFAULT_RUBRIC = `For each answer, score 1-10 against:
- Correctness: is the core claim actually true?
- Depth: did the answer go beyond the surface mechanic to the underlying why?
- Clarity: could a non-expert follow the explanation?
- Internal understanding: did the answer reference the actual engine/spec mechanism (execution context, event loop, GC reachability)?
- Senior-level thinking: did the answer include trade-offs, edge cases, or "when not to do this", unprompted?

Score bands: 1-3 surface-level or incorrect. 4-6 correct but shallow, missing the internal mechanism or a key edge case. 7-8 solid, would pass a mid-to-senior interview loop. 9-10 pre-empts the interviewer's follow-up.`;

/** @type {Round[]} */
const DEFAULT_ROUNDS = [
  {
    id: 1,
    name: 'General JavaScript',
    minutes: 30,
    details: 'Format: conceptual questions with follow-ups, mixing "explain X" and "predict this output".\nTarget: 8 questions.',
    topics: ['closures', 'this', 'promises', 'event-loop', 'objects-prototypes'],
  },
];

/**
 * Read the rounds and rubric from the notes' mock-interview script
 * (`## Round N — Name (~M min)` sections and a `## Scoring Rubric` section).
 * Falls back to built-in defaults so PrepPilot works with any notes.
 * @param {string[]} sourceDirs
 * @returns {Promise<{ rounds: Round[], rubric: string }>}
 */
export async function loadRounds(sourceDirs) {
  for (const dir of sourceDirs) {
    try {
      const parsed = parseMockInterview(await readFile(path.join(dir, MOCK_INTERVIEW_FILE), 'utf8'));
      if (parsed.rounds.length) return parsed;
    } catch {
      // not in this source
    }
  }
  return { rounds: DEFAULT_ROUNDS, rubric: DEFAULT_RUBRIC };
}

/** @param {string} markdown */
export function parseMockInterview(markdown) {
  /** @type {Round[]} */
  const rounds = [];
  let rubric = '';
  const sections = markdown.split(/^## /m).slice(1);

  for (const section of sections) {
    const newline = section.indexOf('\n');
    const heading = section.slice(0, newline === -1 ? undefined : newline).trim();
    const body = (newline === -1 ? '' : section.slice(newline + 1)).replace(/\n---\s*$/, '').trim();

    const round = /^Round (\d+)\s*[—–-]\s*(.+?)(?:\s*\(~?(\d+)\s*min\))?$/.exec(heading);
    if (round) {
      // Linked folders ("[11-event-loop](../11-event-loop/questions.md)") are the round's topics.
      const topics = [...body.matchAll(/\]\(\.\.\/([^/)]+)\//g)].map((m) => topicFromPath(`${m[1]}/x`));
      rounds.push({
        id: Number(round[1]),
        name: round[2].trim(),
        minutes: round[3] ? Number(round[3]) : null,
        details: body,
        topics: [...new Set(topics)],
      });
    } else if (/^Scoring Rubric/i.test(heading)) {
      rubric = body;
    }
  }
  return { rounds, rubric: rubric || DEFAULT_RUBRIC };
}

/**
 * The first message of an interview: what this round covers. Sent as hidden
 * context with the candidate's first message, so the system prompt stays
 * identical (and cached) across rounds.
 * @param {Round} round
 */
export function roundBriefing(round) {
  return [
    `Run Round ${round.id}: ${round.name}${round.minutes ? ` (~${round.minutes} min)` : ''}.`,
    `Topics (use these names with search_notes and grade_answer): ${round.topics.join(', ')}`,
    'Round details from the notes:',
    round.details,
  ].join('\n\n');
}
