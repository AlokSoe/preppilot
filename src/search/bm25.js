/**
 * BM25 ranking
 * ============================================================
 * BM25 scores how well a document matches a query. For each query term t
 * that appears in document d:
 *
 *   score(d) += idf(t) * ( tf * (k1 + 1) ) / ( tf + k1 * (1 - b + b * len(d) / avgLen) )
 *
 *   tf      = how many times t appears in d
 *   len(d)  = number of terms in d
 *   avgLen  = average number of terms across all documents
 *   k1      = term-frequency saturation (default 1.2): the 10th "closure"
 *             in a document adds much less than the 1st
 *   b       = length normalisation (default 0.75): a match in a short
 *             document counts more than the same match in a long one
 *
 *   idf(t)  = ln( 1 + (N - n(t) + 0.5) / (n(t) + 0.5) )
 *   N       = total number of documents
 *   n(t)    = number of documents containing t
 *             (rare terms like "WeakRef" matter more than common ones
 *             like "function"; the "1 +" keeps idf positive)
 *
 * Data structure: an INVERTED INDEX — term → Map(docId → tf).
 * search() only visits the documents that contain a query term, instead of
 * scanning every document.
 *
 * Complexity:
 *   add:    O(L) for a document of L terms
 *   search: O(Σ postings(t) + R log R) — the postings lists of the query
 *           terms, then sorting the R matching documents
 */

export class BM25 {
  /** term → (docId → term frequency in that doc) */
  #postings = new Map();
  /** docId → number of terms in the doc */
  #docLengths = new Map();
  #totalLength = 0;

  /**
   * @param {{ k1?: number, b?: number }} [options]
   */
  constructor({ k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
  }

  /**
   * Add one document. Called once per document, before any search().
   * Adding the same id twice is a programmer error: throw an Error.
   * @param {string} id
   * @param {string[]} terms  already tokenized; may contain duplicates
   */
  add(id, terms) {
    if (this.#docLengths.has(id)) throw new Error(`BM25: document "${id}" was already added`);

    this.#docLengths.set(id, terms.length);
    this.#totalLength += terms.length;

    const termFrequencies = new Map();
    for (const term of terms) termFrequencies.set(term, (termFrequencies.get(term) ?? 0) + 1);

    for (const [term, tf] of termFrequencies) {
      let docs = this.#postings.get(term);
      if (!docs) this.#postings.set(term, (docs = new Map()));
      docs.set(id, tf);
    }
  }

  /** Number of documents added so far. */
  get size() {
    return this.#docLengths.size;
  }

  /**
   * Rank documents for a query.
   * - Only documents that contain at least one query term are returned.
   * - Sorted by score, highest first; ties broken by id (ascending) so results are stable.
   * - Repeated query terms count once ("closure closure" == "closure").
   * - Unknown terms are ignored; an empty query returns [].
   * @param {string[]} queryTerms  already tokenized
   * @param {{ limit?: number }} [options]  default limit 10
   * @returns {{ id: string, score: number }[]}
   */
  search(queryTerms, { limit = 10 } = {}) {
    const N = this.size;
    if (N === 0) return [];
    const avgLength = this.#totalLength / N;

    /** @type {Map<string, number>} docId → accumulated score */
    const scores = new Map();
    for (const term of new Set(queryTerms)) {
      const docs = this.#postings.get(term);
      if (!docs) continue;

      const idf = this.#idf(N, docs.size);
      for (const [id, tf] of docs) {
        const length = /** @type {number} */ (this.#docLengths.get(id));
        const norm = this.k1 * (1 - this.b + (this.b * length) / avgLength);
        const termScore = idf * ((tf * (this.k1 + 1)) / (tf + norm));
        scores.set(id, (scores.get(id) ?? 0) + termScore);
      }
    }

    return [...scores]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit);
  }

  /** Inverse document frequency: rare terms score higher. Always > 0. */
  #idf(N, docsWithTerm) {
    return Math.log(1 + (N - docsWithTerm + 0.5) / (docsWithTerm + 0.5));
  }
}
