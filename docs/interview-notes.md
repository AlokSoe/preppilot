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

---

## M3 — HTTP server, SSE streaming, web chat UI

**What I built:** a server on plain `node:http` with my own router and Koa-style middleware
(request ID + JSON logs, security headers, error handler), an in-memory session store, an SSE
endpoint that streams the agent's turn, and a framework-free chat UI with an XSS-safe markdown
renderer. 85 tests, including an integration test that runs the real server on a random port with
a fake model.

### Questions you can expect

**"Why SSE and not WebSockets?"**
> The stream only flows server → browser; the browser sends each message as a normal POST. SSE is
> plain HTTP, so it works through proxies and load balancers, and needs no extra protocol. I send a
> `: ping` comment every 15 s so idle proxies don't cut the connection while the model is thinking.

**"EventSource only supports GET — how do you stream a POST?"**
> I use `fetch()` and read `response.body` as a stream, then parse SSE myself: buffer text until a
> blank line ends an event, because network chunks can split an event anywhere. I have a test that
> feeds the stream 7 bytes at a time.

**"What happens when the user closes the tab mid-answer?"**
> The server listens for the response's `close` event; if the response hadn't finished, it aborts
> an `AbortController` whose signal is passed all the way to the model API call. So we stop paying
> for tokens nobody will read, and the session is freed for the next message.

**"How do you stop two messages racing in one conversation?"**
> A `busy` flag per session: a second message while one is streaming gets `409 busy`. The flag is
> cleared in a `finally`, so errors and disconnects can't leave a session stuck — there's a test for that.

**"How do you prevent XSS from model output?"**
> The markdown renderer parses text into a plain tree, then builds DOM nodes with `createElement`
> and `textContent`. Nothing ever goes through `innerHTML`, links are only rendered for `http(s)`
> URLs, and a strict Content-Security-Policy (`script-src 'self'`) is a second layer. Tests check
> that `<img onerror=…>` and `javascript:` links stay plain text.

**"Explain your middleware design."**
> `compose()` turns a list of `(ctx, next)` functions into one, like Koa: code before `await next()`
> runs on the way in, code after runs on the way out. That's how the error handler wraps everything
> below it and the logger measures the full request time.

**"Why keep sessions in memory?"**
> It's the simplest thing for one instance, and it sits behind a small interface
> (`create / get / touch`) so the SQLite store replaces it without touching the routes. Sessions
> expire after 6 hours idle, and when the store is full the least recently used idle session is evicted —
> using a `Map`'s insertion order as the LRU list, the same trick as the LRU cache in my notes.

### Real bug I hit
> An integration test got an `error` event instead of an answer. My fake provider did
> `yield* script(args)` as a statement — but `yield*` *evaluates to* the delegate generator's return
> value, so the turn was thrown away and the agent received `undefined`. Fix: `return yield* script(args)`.
> Good generator trivia: `yield*` forwards yielded values automatically, but the return value only
> if you use it.

---

## M4 — Sandboxed code runner + Code mode

**What I built:** a code runner that executes untrusted JavaScript in a locked-down child process,
an AI problem generator that verifies every problem before saving it, SQLite storage, a submit flow
with hidden tests and a streamed AI review, plus Code mode in the web UI and CLI.

### Questions you can expect

**"How do you run untrusted code safely?"**
> Each run is a separate `node --permission` process. With no `--allow-*` flags, Node 26 blocks the
> file system, child processes, worker threads, native addons and network — I verified each one
> with a probe and have tests for them. The child gets an empty environment (no API keys), a 128 MB
> heap cap, and a wall-clock timeout that SIGKILLs it, so even `while (true) {}` stops. In
> production it also runs in its own container with no network and a memory limit, because the heap
> cap doesn't cover Buffers. Defence in depth: no single layer is trusted alone.

**"Why not `vm` or `eval` in the server process?"**
> Node's docs say `vm` is not a security mechanism, and anything in-process shares memory and the
> event loop with the server — one infinite loop would freeze every user. A separate process can be
> killed without affecting anything else.

**"How do results come back — couldn't user code just print 'passed'?"**
> Results go over a separate pipe, file descriptor 3, as NDJSON. stdout belongs to the user's code
> and is only shown as console output. I have a test where the code prints a fake "passed" line and
> still fails.

**"How do you stop heavy code from starving the server?"**
> A semaphore: at most N runs at once; the rest wait in a FIFO queue. Release hands the slot
> directly to the next waiter. There's a timing test: 4 runs of 300 ms at concurrency 2 take ≥ 600 ms.

**"How do you trust AI-generated tests?"**
> I don't — I verify them. The model returns the problem, a reference solution and the tests as
> structured JSON. Before saving, the reference solution must pass every test, and the empty starter
> code must fail at least one (otherwise the tests check nothing). If either fails, the model gets
> the exact test output and fixes its own problem, up to 3 attempts. Verified problems are cached
> in SQLite and reused, so each one costs tokens once.

**"How do hidden tests stay hidden?"**
> The public problem view never includes the reference solution or hidden test code. On submit,
> hidden tests show only their name and pass/fail — their error message could reveal the expected
> value. The AI reviewer does see everything, with instructions to give hints, not the answer.

### Real bugs I hit
> 1. **`require` was visible to user code.** Under `node -e`, Node defines `require` as a global.
>    It couldn't load anything dangerous (the permission model blocks it), but I deleted it from the
>    sandbox globals anyway — and kept the test.
> 2. **A wrong assumption in a test:** I expected `net.connect` to throw when the network is
>    blocked. It actually reports `ERR_ACCESS_DENIED` through the socket's `error` event. Lesson:
>    probe the real behaviour, don't assume it.
> 3. **Schema-stripping bug caught in review:** my first `toApiSchema` stripped unsupported keywords
>    like `minimum` everywhere — including a *property named* `minimum`. Fixed by treating keys
>    under `properties` as names, not keywords, and added a test.

---

## M5 — Interview mode, grader, progress

**What I built:** a mock-interview mode driven by the rounds and rubric in my own notes, a
separate grader that scores every answer 1–10 with structured output, SM-2 spaced repetition per
topic, and Progress pages in the web UI and CLI.

### Questions you can expect

**"Why is grading a separate model call instead of the interviewer scoring itself?"**
> Separation of concerns, like a test runner separate from the code under test. The interviewer is
> conversational and could drift toward being generous with its own questions. The grader gets only
> the question, the answer, the rubric and the reference notes, and must return JSON matching a
> schema — so scores are consistent, comparable over time, and stored as data. The interviewer
> calls it as a tool (`grade_answer`), and the tool also records progress, so the model can't
> "forget" to save a score.

**"How do you get structured data out of an LLM reliably?"**
> Structured outputs: the API constrains generation to my JSON schema. I still validate the result
> locally, because the API doesn't enforce numeric ranges like `score` 1–10 — my adapter strips those
> keywords before sending and my validator checks them after.

**"Explain your spaced repetition."**
> Simplified SM-2. A score of 7+ (the rubric's "would pass a mid-to-senior loop") grows the review
> interval: 1 day, 3 days, then interval × ease. Below 7 resets it to 1 day. Ease drifts down after
> weak answers (minimum 1.3) so hard topics come back more often. Mastery is an exponential moving
> average of scores, so one lucky answer doesn't mark a topic as mastered. "Study next" puts overdue
> topics first, then the weakest.

**"How does the interviewer know which round to run without changing the system prompt?"**
> The round briefing travels as a hidden text block in the first user message. The system prompt
> stays byte-identical across rounds, so prompt caching keeps working, and the UI hides the
> briefing because the block is marked `hidden`.

**"How do you keep progress accurate when two note collections name topics differently?"**
> A canonical topic map (`scope-and-closures` → `closures`, `this-keyword` → `this`, ...) applied on
> every write, so attempts from either source land on one topic.

### Real bug I hit
> "Study next" ranked a strong topic above a weak one when neither was due yet, because the sort
> compared exact due timestamps first — a millisecond apart. Fix: only overdue topics are ordered by
> due time; the rest are ordered by mastery. Added a test for "due beats weaker-but-not-due".
