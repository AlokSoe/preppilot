# Interview Notes

Real decisions, measurements and bugs from building PrepPilot, written as answers you can give.
Add to this file at the end of every milestone.

---

## M1 — Indexing and search

**What I built:** a walker that scans two repos (skipping `node_modules`), a chunker that splits
files along their structure, an identifier-aware tokenizer, a BM25 ranker I wrote from scratch,
and a `preppilot search` CLI.

**Numbers:** 139 files → 807 chunks → index built in ~130 ms. 55 topics.

### Questions you can expect

**"Why BM25 and not embeddings / a vector database?"**
> The corpus is small (about 800 chunks) and full of exact technical terms like `WeakMap` or
> `Promise.allSettled`, where keyword matching is very precise. BM25 needs no extra service and
> no API calls. If evaluation showed misses on paraphrased questions, I'd add embeddings and
> combine both scores (hybrid search).

**"Why split by headings instead of fixed-size chunks?"**
> A section under one heading is about one idea, so a search hit is a complete answer and the
> heading doubles as the citation. Fixed-size windows cut explanations in half. I still cap
> sections at ~2000 characters so one chunk never floods the model's context.

**"How does your tokenizer handle code?"**
> It keeps identifiers whole and also splits them: `Promise.allSettled` produces
> `promise.allsettled`, `promise`, `allsettled`, `all`, `settled`. So a user typing
> "allSettled" or "promise all settled" still matches.

**"Why rebuild the index on every start instead of saving it?"**
> I measured it: ~130 ms for the whole corpus. Persisting it would add cache-invalidation bugs
> for no real gain. I'd revisit at 10× the size.

**"What's an inverted index?"**
> A map from each term to the documents that contain it — like the index at the back of a book.
> Mine is `Map<term, Map<docId, termFrequency>>`. To answer "closure event", I only look at the
> documents listed under those two terms instead of scanning all 807 chunks.

**"What's the time complexity of your search?"**
> Adding a document is O(L) for L terms. Search is O(sum of the postings-list sizes for the query
> terms) to score, plus O(R log R) to sort the R matching documents. It never touches documents
> that don't contain a query term. A top-k heap would make the sort O(R log k) if R got large.

**"Explain k1 and b."**
> `k1` controls how fast repeated terms stop adding score: with k1 = 0 term frequency doesn't matter
> at all; as k1 grows it approaches raw counting. `b` controls length normalisation: b = 0 ignores
> document length, b = 1 fully normalises, so a match in a short focused section beats the same
> match buried in a long one. I have tests that pin both edge cases.

### Things I noticed (talking points)
- Both repos name the same topic differently (`closures` vs `scope-and-closures`,
  `this` vs `this-keyword`). A topic alias map will fix progress tracking in M5.
- Handbook files are mostly one big comment block, so they split into "part N" chunks by size.
  Splitting on the handbook's numbered sub-headings would give better citations — a possible improvement.

---

## M2 — Agent loop + Ask mode (CLI)

**What I built:** a provider-neutral agent loop, a Claude adapter (streaming, tool use, prompt
caching, refusal fallback), two tools (`search_notes`, `list_topics`), a small JSON-schema
validator, and `preppilot ask` / `preppilot chat`. 57 tests run without any API key, using a fake
provider and a fake SDK client.

### Questions you can expect

**"Walk me through your agent loop."**
> Send the history, system prompt and tool list to the model and stream the reply. If it asks for
> tools, I validate each input against the tool's schema, run them all in parallel with
> `Promise.all`, and send every result back in **one** message. Repeat until the model answers.
> Safety rails: a cap of 8 iterations, tool errors returned as `isError` results instead of thrown,
> nothing run when a turn was refused or cut off at max tokens, and the history only ever appended to.

**"Why validate tool inputs yourself — doesn't the API do that?"**
> I stream tool inputs as they're generated (`eager_input_streaming`) so large inputs like code
> don't arrive in one late burst. The trade-off is that the API no longer validates them, so a
> malformed input could reach my tool. Every input goes through my validator first; failures go
> back to the model as an error so it can correct itself.

**"Why send all tool results in one message?"**
> The model asked for them together, so they answer one turn. Splitting them across messages
> breaks that pairing and teaches the model to stop making parallel calls.

**"How do you support several AI providers?"**
> The loop only knows neutral types (`text`, `tool_call`, `tool_result`) and an `LLMProvider`
> interface (Strategy + Adapter patterns). Each adapter converts formats, stop reasons and errors.
> Provider-specific state, like Claude's thinking blocks, travels opaquely in a `raw` field and is
> sent back unchanged by the adapter that produced it.

**"How do you keep costs down?"**
> Prompt caching: the system prompt and tool list never change, and the history is append-only, so
> each request reuses the cached prefix and pays ~10% for it. The `effort` setting is per mode:
> `low` for quick Q&A, higher for grading and Build mode.

**"How do you test code that calls an LLM?"**
> Two layers, both without network: the agent loop runs against a fake provider that replays
> scripted turns (tool calls, refusals, malformed input, iteration cap). The Claude adapter runs
> against a fake SDK client, so I assert the exact request it builds and how it maps every error type.

### Real bug I hit
> With no API key set, the CLI retried twice with "malformed tool input" before failing. The SDK
> raised the missing-credentials error as its base `AnthropicError`, and my code treated *every*
> non-API `AnthropicError` as a JSON parse failure. I narrowed the check to the SDK's specific
> parse-error message, handled missing credentials first, and added a regression test for both
> error classes. **Lesson:** classify errors as narrowly as possible, especially when the
> classification triggers a retry.
