/**
 * Turn code + sandbox-style tests into one file you can run with `node`:
 * the solution, then each test as a node:test case. Shared by the web UI
 * (download button) and the CLI (`preppilot build` saves it).
 *
 * Unlike the sandbox, the code is evaluated once, so tests share state.
 * That's fine for final, passing code with independent tests.
 *
 * @param {string} code
 * @param {{ name: string, code: string }[]} tests
 * @param {string} [title]
 */
export function toRunnableFile(code, tests, title = 'PrepPilot build') {
  const indent = (text) =>
    text
      .split('\n')
      .map((line) => (line ? `  ${line}` : line))
      .join('\n');
  return [
    `// ${title}`,
    '// Run the tests with: node <this file>',
    "'use strict';",
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    '',
    code.trim(),
    '',
    '// ---- Tests ----',
    ...tests.map((t) => `\ntest(${JSON.stringify(t.name)}, async () => {\n${indent(t.code.trim())}\n});`),
    '',
  ].join('\n');
}
