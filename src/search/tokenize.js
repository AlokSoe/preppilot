/**
 * Turn text into search terms.
 *
 * Interview questions are full of identifiers (`Promise.allSettled`,
 * `addEventListener`, `WeakMap`), so we keep each identifier whole AND add
 * its parts. That way "allSettled", "promise allsettled" and
 * "Promise.allSettled" all match the same chunk.
 */

const STOP_WORDS = new Set(
  `a an and are as at be but by can do does for from has have how i if in into is it its
   of on or so than that the then there these this to too was what when where which who
   why will with you your we our they them their not no yes also just only about`.split(/\s+/),
);

/**
 * @param {string} text
 * @returns {string[]} terms, in order, duplicates kept (term frequency matters)
 */
export function tokenize(text) {
  const terms = [];
  // Identifier-ish runs, including dotted paths like Promise.allSettled.
  for (const [raw] of text.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|\d+/g)) {
    const parts = raw.split('.').flatMap(splitCamel);
    const whole = raw.toLowerCase();

    if (raw.includes('.')) push(terms, whole); // "promise.allsettled"
    for (const segment of raw.split('.')) {
      const lower = segment.toLowerCase();
      push(terms, lower); // "allsettled"
    }
    if (parts.length > raw.split('.').length) {
      for (const part of parts) push(terms, part.toLowerCase()); // "all", "settled"
    }
  }
  return terms;
}

function push(terms, term) {
  if (term.length > 1 && !STOP_WORDS.has(term)) terms.push(term);
}

/** "addEventListener" → ["add", "Event", "Listener"]; "JSONParse" → ["JSON", "Parse"] */
function splitCamel(word) {
  return word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_$]+/)
    .filter(Boolean);
}
