/**
 * Tools the agent can call (design doc §9.3).
 *
 * @typedef {import('../llm/provider.js').ToolSpec & {
 *   run(input: any, ctx: { signal?: AbortSignal }): Promise<string> | string,
 *   summarize?(input: any, output: string): string,
 * }} Tool
 */

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
