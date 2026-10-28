# PrepPilot — System Design

> Version 1 · 2026-10-28 · Author: Kumar Alok
> Status: **Draft for review** — we agree on this document before writing code.

---

## 1. Problem Statement

Engineers preparing for JavaScript interviews have plenty of study material but no
**interviewer**. Reading notes is passive: nobody asks follow-up questions, nobody grades
the answer, nobody runs the code you wrote under pressure, and nobody remembers which topics
you are weak at.

**PrepPilot** is an AI interview coach that turns a personal knowledge base (the
`machine-coding-js` repo and the `javascript-engineering-handbook`) into an interactive,
graded, adaptive interview — and can also take a new problem statement, design a solution,
write the JavaScript, test it, and explain it.

**One-line pitch:** *"An AI agent that interviews you from your own notes, runs and grades your
code in a sandbox, and tracks your weak spots until they're strong."*

---

## 2. Goals and Non-Goals

### Goals
1. Answer questions **grounded in the user's own notes**, with citations to the source file.
2. Run **realistic mock interviews**: question → answer → follow-up → score against a rubric.
3. **Execute user code safely** and grade it against hidden tests.
4. **Build mode:** take a requirement / problem statement and produce a design, working
   JavaScript, tests, and an explanation.
5. **Track progress** per topic and resurface weak topics (spaced repetition).
6. **Production-deployable:** Docker image, one-command deploy, health checks, logs, cost limits.

### Non-Goals (v1)
- Voice interviews, video, or proctoring.
- Languages other than JavaScript for code execution.
- Multi-tenant SaaS billing. (v1 supports multiple users with login, but no payments.)
- Fine-tuning a model. We use retrieval + prompting.

---

## 3. Users and Modes

| Mode | Who uses it | Example |
|---|---|---|
| **Ask** | Revising a topic | "Explain microtasks vs macrotasks with an example." |
| **Interview** | Practising under pressure | "Run Round 7: DOM & Networking, 30 minutes." |
| **Code** | Machine-coding practice | "Give me an LRU cache problem." → user writes code → hidden tests run → review |
| **Build** | Turning a requirement into working code | "Build a rate limiter that allows N requests per minute per user." |
| **Progress** | Planning study time | "What are my weakest 3 topics this week?" |

---

## 4. Functional Requirements

| ID | Requirement |
|---|---|
| FR-1 | Index both knowledge-base repos; re-index when files change. |
| FR-2 | Answer questions using retrieved notes; every factual answer cites `file:heading`. |
| FR-3 | Stream responses token-by-token to the browser. |
| FR-4 | Interview mode follows a round from `28-mock-interview` (question order, time box, rubric). |
| FR-5 | Grade free-text answers 1–10 against the rubric in `28-mock-interview` (correctness, depth, clarity, internal understanding, senior-level thinking), with written feedback and an ideal answer. |
| FR-6 | Run user-submitted JavaScript against hidden tests with a time and memory limit; return pass/fail per test, stdout, and errors. |
| FR-7 | Build mode: clarify requirements → propose design → write code + tests → run tests → fix (max 3 iterations) → explain. |
| FR-8 | Persist sessions, messages, attempts and per-topic mastery per user. |
| FR-9 | Recommend the next topic using spaced repetition over mastery scores. |
| FR-10 | Simple auth: email + password, session cookie. |
| FR-11 | CLI client that uses the same API (`preppilot ask "..."`, `preppilot interview --round 7`), published to npm so anyone can run `npx preppilot`. |
| FR-12 | Code mode can use problems from the repos **or** AI-generated problems; a generated problem is only shown after its hidden tests pass against a reference solution (§9.4). |

---

## 5. Non-Functional Requirements

| Concern | Target |
|---|---|
| **Latency** | First streamed token in under ~2 s for Ask mode (p95). |
| **Code run** | Hard timeout 3 s, memory cap 128 MB, no network, no filesystem writes. |
| **Availability** | Single region, 99.5% is fine for a portfolio product; graceful error messages when the model API is down. |
| **Cost** | Per-user daily token budget; prompt caching on the stable prefix. |
| **Security** | User code fully isolated from the server; API key never sent to the browser; rate limiting per user and per IP. |
| **Privacy** | Notes stay on the server; only retrieved snippets are sent to the model API. |
| **Observability** | Structured JSON logs, request IDs, token usage and latency per request. |
| **Portability** | Runs locally with `npm start`, in Docker, and on any container host (Fly.io / Render / Railway / a VM). |

---

## 6. Back-of-the-Envelope Estimates

**Knowledge base:** 140 files, ~1.1 MB of text, so roughly **300k tokens**.
Split by structure (headings / comment blocks, max ~500 tokens), that is **807 chunks**
(measured in M1). An in-memory inverted index for this is a few MB of RAM, so we don't need a
separate search service.

**Tokens per chat turn (typical):**

| Part | Tokens | Cached? |
|---|---|---|
| System prompt + tool definitions | ~3,000 | Yes, stable prefix |
| Conversation history | ~2,000–6,000 | Partly |
| Retrieved notes (5 chunks) | ~2,000 | No |
| Output (incl. thinking) | ~800–2,000 | — |

**Cost per turn** with `claude-opus-5-5` ($4 / 1M input, $20 / 1M output, cache reads $0.20 / 1M):
about **$0.03–$0.06**. A 30-turn mock interview is about **$1–$2**. A daily budget of ~200k
tokens per user caps the worst case.

**Concurrency:** a portfolio deployment sees a handful of concurrent users. Each streaming
request holds one open HTTP connection and one outbound API stream; Node's event loop handles
hundreds of these on one small instance. The **code runner** is the CPU-bound part, so it is
isolated in its own process pool (see §9.5).

---

## 7. High-Level Architecture

```
            ┌──────────────────────┐        ┌──────────────────────┐
            │  Web client          │        │  CLI client          │
            │  (vanilla JS, ESM)   │        │  (node, same API)    │
            └──────────┬───────────┘        └──────────┬───────────┘
                       │  HTTPS: REST + SSE stream      │
                       ▼                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         API Server (Node.js, node:http)                  │
│  router · auth middleware · rate limiter · request-id · error handler    │
└───────┬──────────────────────┬──────────────────────┬───────────────────┘
        │                      │                      │
        ▼                      ▼                      ▼
┌───────────────┐    ┌────────────────────┐   ┌──────────────────┐
│ Session svc   │    │  Agent Orchestrator │   │ Progress svc      │
│ (history)     │◄──►│  (tool-use loop)    │──►│ (mastery, SM-2)   │
└───────┬───────┘    └───┬──────┬──────┬──┘   └────────┬─────────┘
        │                │      │      │               │
        │      ┌─────────┘      │      └────────┐      │
        │      ▼                ▼               ▼      │
        │ ┌──────────┐   ┌────────────┐  ┌───────────┐ │
        │ │ Retriever│   │ Code Runner│  │ Grader     │ │
        │ │ (BM25)   │   │ (sandboxed │  │ (rubric,   │ │
        │ │          │   │  workers)  │  │ structured │ │
        │ └────┬─────┘   └────────────┘  │  output)   │ │
        │      │                          └───────────┘ │
        ▼      ▼                                        ▼
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│ SQLite (node:    │   │ Search index     │   │ Claude API        │
│ sqlite): users,  │   │ (built from the  │   │ (claude-opus-5-5, │
│ sessions, scores │   │  two repos)      │   │  streaming)       │
└──────────────────┘   └──────────────────┘   └──────────────────┘
```

**Request flow (Ask mode):**
1. Browser `POST /api/sessions/:id/messages` with the question; server responds with an SSE stream.
2. Orchestrator loads the session history and calls Claude with the system prompt, tools and history.
3. Claude decides to call `search_notes("event loop microtasks")`.
4. Retriever returns the top 5 chunks with file paths; the orchestrator sends them back as a tool result.
5. Claude streams the answer with citations; each text delta is forwarded to the browser as an SSE event.
6. On completion: store messages + token usage; update progress if the turn was graded.

---

## 8. Technology Choices

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 26, ES modules, plain JavaScript + JSDoc types | Shows core JS skill; JSDoc + `tsc --checkJs` gives type safety without a build step. |
| HTTP | `node:http` + our own small router/middleware | Shows we understand what Express does; ~150 lines. |
| LLM | Provider interface (§9.8); first adapter: Anthropic SDK (`@anthropic-ai/sdk`), model `claude-opus-5-5` | Agent code is provider-neutral; each provider's official SDK handles retries, streaming, types. Model IDs live in config. |
| Search | Our own BM25 inverted index | The corpus is small (~3k chunks); keyword search on technical terms (`WeakMap`, `requestIdleCallback`) is very precise. No vector DB to run. |
| Database | `node:sqlite` (built in) | Zero ops for one instance; swap to Postgres when we scale out (§12). |
| Code sandbox | `child_process` running Node with the permission model + timeouts; separate container in production | Real process isolation; `node:vm` alone is **not** a security boundary. |
| Frontend | Vanilla JS, Web Components, CSS variables | No framework needed for a chat UI; demonstrates DOM, streams, events. |
| Tests | `node:test` + `node:assert` | Built in. |
| Deploy | Dockerfile → any container host | Portable; "works in any environment". |

**Runtime dependencies:** only the official SDK of each supported AI provider (starting with
`@anthropic-ai/sdk`). Everything else is Node built-ins.

---

## 9. Component Deep Dives

### 9.1 Knowledge Indexer and Retriever

**Indexing (at startup, and on file change in dev):**
1. Walk both repos; include `*.md` and `*.js`; skip `node_modules`, `.git`.
2. **Chunk by structure, not by fixed size:**
   - Markdown: split at `##` / `###` headings; keep the heading path as metadata.
   - Handbook `.js` files: they have a fixed format (top comment block → examples → "Key
     Takeaways" Q&A), so split into those three sections.
   - Cap chunks at ~500 tokens; split long sections on blank lines with a small overlap.
3. Metadata per chunk: `{ id, repo, path, headingPath, topic, kind: "concept"|"code"|"qa" }`.
   `topic` comes from the folder name (`14-event-loop` → `event-loop`).
4. Tokenize (lower-case, split on non-word, keep identifiers like `Promise.allSettled` as both
   whole and parts), build an inverted index, compute BM25 statistics.
5. ~~Save to `data/index.json`~~ **Measured in M1:** scanning 139 files and building the index
   takes ~130 ms, so we rebuild in memory at startup instead of persisting an index file
   (one less thing to keep in sync). Revisit if the corpus grows 10×+.

**Query:** BM25 score → boost if `topic` matches the session's current topic → top-k (default 5)
→ return text + `path#heading` for citation.

**Why not embeddings / a vector DB?** Interview questions are full of exact technical terms where
keyword matching is very accurate; the corpus is tiny; and it keeps the system free of extra
services. **Upgrade path:** add an embedding provider later and combine scores (hybrid search) if
evaluation shows misses on paraphrased questions.

### 9.2 Agent Orchestrator (the tool-use loop)

We write the loop ourselves (rather than using the SDK's beta tool runner) so every step is
visible and explainable in interviews.

```
loop (max 8 iterations):
  stream = client.messages.stream({ model, system, tools, messages, output_config: { effort } })
  forward text deltas to SSE
  message = await stream.finalMessage()
  append message.content to history          // keep the full content, not just text
  switch message.stop_reason:
    "end_turn"   → done
    "tool_use"   → run every tool_use block (in parallel), append ONE user message
                   containing all tool_result blocks, continue
    "max_tokens" → tell the user the answer was cut off; offer "continue"
    "refusal"    → show a polite message; log stop_details
```

Key details:
- **Prompt caching:** `tools` and `system` never change between turns, so they form a cached
  prefix. No timestamps or user IDs inside the system prompt.
- **Effort per mode:** Ask = `low`, Interview / grading = `medium`, Build = `high`.
  This is the main cost-versus-quality setting.
- **Tool errors** are returned as `tool_result` with `is_error: true` so the model can recover;
  they never crash the loop.
- **Validation:** every tool input is validated against its JSON schema before running.
- **Iteration cap + per-user token budget** stop runaway loops.

### 9.3 Tools

| Tool | Input | Output | Notes |
|---|---|---|---|
| `search_notes` | `query`, `topic?`, `k?` | chunks with `path#heading` | Read-only. |
| `get_round` | `roundId` | questions, time box, rubric | Reads `28-mock-interview`. |
| `run_code` | `code`, `tests` | per-test pass/fail, stdout, error, duration | Sandboxed (§9.5). |
| `grade_answer` | `question`, `answer`, `topic` | `{score 1–10, criteria, verdict, strengths[], gaps[], misconceptions[], idealAnswer, followUps[]}` | Runs the separate grader (structured output), records the attempt, emits a score card. |
| `get_progress` | — | mastery per topic, due topics | Read-only. |
| `record_attempt` | `topic`, `score`, `kind` | ok | Updates mastery. Only tool that writes. |

### 9.4 Mode Flows

**Interview mode**
1. `get_round(7)` → plan: N questions, time box.
2. Ask question 1. User answers.
3. `grade_answer` → `record_attempt`.
4. Ask a **follow-up** based on the gaps found (like a real interviewer), or move on.
5. End: summary report — score per question, weakest topics, links to the notes to revise.

**Code mode**
1. Pick a problem from one of two sources:
   - **Repo problems:** `23-machine-coding` / `29-practice-problems`.
   - **AI-generated problems:** chosen by weak topic and difficulty (e.g. "medium, promises").
2. Show the statement and a function signature; **hidden tests stay on the server**.
3. User submits → `run_code` → results → AI review of correctness, complexity, edge cases, style.

**Generating a new problem safely.** A model can write a problem whose tests are wrong, which
would mark a correct user answer as failing. So every generated problem is **verified before the
user sees it**:
1. The model returns structured JSON: `{ title, statement, signature, examples, referenceSolution,
   visibleTests, hiddenTests, topic, difficulty }`.
2. The server runs **all** tests against `referenceSolution` in the sandbox.
3. All pass → save to the `problems` table and show it (without the solution or hidden tests).
   Any fail → ask the model to fix it (max 2 retries), else discard.
4. Saved problems are reused across users, so each problem costs model tokens only once.
   Duplicates are avoided by checking titles/topics already generated.

**Build mode** (requirement → working code)
1. **Clarify:** restate the requirement; list assumptions; ask at most 3 questions.
2. **Design:** API signature, data structures, complexity, edge cases.
3. **Implement:** code + tests written by the model.
4. **Verify:** `run_code`; if tests fail, read the errors and fix — **max 3 attempts**.
5. **Explain:** walkthrough, trade-offs, and "how would you extend this" follow-ups.
The user can download the final code and tests.

### 9.5 Code Runner (Sandbox)

Running untrusted code is the most security-sensitive part of the system.

**Threats:** infinite loops, memory bombs, reading server files / env vars (API key!),
network calls, spawning processes, escaping the sandbox.

**Design:**
- Each run starts a **separate Node process** with the permission model
  (`node --permission`, no `--allow-fs-*`, no `--allow-child-process`, no worker or addon permission)
  and a **clean, empty environment** (no `ANTHROPIC_API_KEY`).
- Limits: `--max-old-space-size=128`, wall-clock timeout 3 s (`SIGKILL` on timeout), output capped at 64 KB.
- Code and tests are passed over stdin as JSON; a small harness inside the child runs the tests and
  prints a JSON result.
- A **pool with a concurrency limit** (e.g. 4) and a queue, so CPU-heavy runs can't starve the API.
- **In production:** the runner is a **separate container** with no network and a read-only
  filesystem. The API talks to it over an internal HTTP port. Even if the permission model were
  bypassed, the attacker lands in an empty, isolated container.

**Why not `node:vm`?** Node's own docs say `vm` is not a security mechanism; code can escape to
the host process. It is fine for convenience, not for isolation.

### 9.6 Grader

- Input: question, user answer, rubric (parsed from `28-mock-interview` when available, else a
  built-in 1–10 rubric), and the relevant notes from `search_notes`.
- Output via **structured outputs** (`output_config.format` with a JSON schema), so the result
  is always parseable.
- **Calibration:** a small eval set (30 question/answer pairs with scores we agree on) is run
  whenever we change the grading prompt; we check the scores don't drift.

### 9.7 Progress and Spaced Repetition

Per `(user, topic)` we store `mastery` (0–100), `ease`, `intervalDays`, `dueAt` — a simplified
SM-2 algorithm:
- Score ≥ 4 → interval grows (`interval × ease`), mastery up.
- Score ≤ 2 → interval resets to 1 day, mastery down.
- "Next topic" = the most overdue topic, ties broken by lowest mastery.

### 9.8 LLM Provider Interface (multi-provider)

Users can bring a key for **any supported AI provider**. The agent loop, tools, grader and
problem generator never import a provider SDK directly; they depend on one interface
(**Strategy pattern** + **Adapter pattern**):

```
Orchestrator / Grader / ProblemGenerator
            │
            ▼
   LLMProvider (interface)
     ├── ClaudeAdapter   → @anthropic-ai/sdk     (built first, M2)
     ├── OpenAIAdapter   → official OpenAI SDK    (M9)
     └── GeminiAdapter   → official Google SDK    (M9)
```

**The interface (provider-neutral types):**
```js
/**
 * @typedef {{ role: 'user'|'assistant', content: Block[] }} Message
 * @typedef {{ type: 'text', text: string }
 *         | { type: 'tool_call', id: string, name: string, input: object }
 *         | { type: 'tool_result', id: string, output: string, isError?: boolean }} Block
 */
class LLMProvider {
  /** Stream one model turn. Yields events; returns the final turn. */
  async *streamTurn({ system, messages, tools, effort, signal }) {}
  //   yields: { type: 'text', delta }
  //   returns: { content: Block[], stopReason: 'end'|'tool_calls'|'max_tokens'|'refused',
  //              usage: { input, output, cached } }

  /** One-shot call that must return JSON matching a schema (grader, problem generator). */
  async generateJson({ system, messages, schema, effort }) {}

  /** Cheap call to check a key works (e.g. list models). */
  async validateKey() {}
}
```

**What each adapter is responsible for:**
| Concern | Differs per provider? | Adapter's job |
|---|---|---|
| Message / tool-call format | Yes | Convert to and from the neutral `Block` types. |
| Streaming events | Yes | Map native events to `{ type: 'text', delta }`. |
| Stop reasons | Yes | Map to `end` / `tool_calls` / `max_tokens` / `refused`. |
| Structured JSON output | Yes | Use the provider's native schema feature; validate with our own JSON-schema check either way. |
| Prompt caching | Yes | Use it where the provider supports it; otherwise no-op. |
| "Effort" | Yes | Map `low`/`medium`/`high` to the provider's nearest setting. |
| Errors | Yes | Map to neutral errors: `InvalidKey`, `RateLimited`, `OutOfCredit`, `ProviderDown`. |

**Contract tests:** one shared test suite that every adapter must pass (streaming text, a tool call
round-trip, structured JSON output, error mapping), run against recorded responses so CI doesn't
spend tokens, plus an opt-in live run.

**Quality note:** grading and Build mode depend heavily on model quality. Each provider gets a
**default model** in config, and the grader eval set (§9.6) is run per provider so we know
which ones grade reliably. The UI shows "best results with …" based on those scores.

---

## 10. Data Model (SQLite)

```sql
users        (id, email UNIQUE, password_hash, created_at)
sessions     (id, user_id, mode, round_id NULL, created_at, updated_at)
messages     (id, session_id, role, content_json, input_tokens, output_tokens, created_at)
attempts     (id, user_id, session_id, topic, kind, score, feedback_json, created_at)
mastery      (user_id, topic, mastery, ease, interval_days, due_at, PRIMARY KEY(user_id, topic))
usage_daily  (user_id, day, input_tokens, output_tokens, PRIMARY KEY(user_id, day))
api_keys     (user_id, provider, ciphertext, iv, auth_tag, last4, is_active, validated_at, created_at,
              PRIMARY KEY(user_id, provider))
problems     (id, source 'repo'|'generated', topic, difficulty, title, statement, signature,
              examples_json, visible_tests_json, hidden_tests_json, reference_solution,
              verified_at, created_at)
```

`content_json` stores the **full** message content array (text, tool_use, tool_result blocks), so
a session can be resumed exactly as the model saw it.

---

## 11. API Design

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/signup` · `/api/auth/login` · `/api/auth/logout` | Auth (session cookie, `HttpOnly`, `SameSite=Lax`) |
| `POST` | `/api/sessions` | Create a session `{ mode, roundId? }` |
| `GET` | `/api/sessions/:id` | History |
| `POST` | `/api/sessions/:id/messages` | Send a message; **response is an SSE stream** |
| `POST` | `/api/run` | Run code directly (Code mode "Run" button) |
| `GET` | `/api/progress` | Mastery + due topics |
| `GET` | `/api/topics` · `/api/rounds` | Catalogue |
| `GET` | `/healthz` · `/readyz` | Liveness / readiness (index loaded, DB reachable) |

**SSE event types:** `text` (delta), `tool_start` (`{name, input}`), `tool_end`
(`{name, summary}`), `score` (grade card), `done` (`{usage}`), `error` (`{code, message}`).

**Why SSE and not WebSockets?** The stream only goes server → client; the client sends each new
message as a normal POST. SSE works over plain HTTP, through proxies, and is simpler to scale.

---

## 12. Deployment and Scaling

### 12.1 Hosting on a free platform

**Requirement:** hosting should cost nothing. Our design needs **two containers** (API + runner)
and a **persistent disk** for SQLite, which rules out most free tiers:

| Option | Free? | Fits our design? |
|---|---|---|
| **Oracle Cloud "Always Free" VM** (ARM, up to 4 CPU / 24 GB RAM) | Yes, no time limit (card needed for sign-up) | **Yes** — full VM: Docker Compose, both containers, disk for SQLite. |
| Render free web service | Yes | Partly — sleeps after inactivity (slow first request), no persistent disk on free, one container. |
| Google Cloud Run free tier | Yes, within monthly limits | Partly — stateless, so SQLite data is lost; would need an external DB. |
| Fly.io / Railway | Trial credit, then paid | Yes technically, but not free long-term. |

**Decision: Oracle Cloud Always Free VM** running Docker Compose with **Caddy** in front
(automatic HTTPS with Let's Encrypt). It is also the best learning experience: you set up a real
Linux server, firewall, reverse proxy and HTTPS, which is a good interview story.
**Fallback:** Render free tier for a demo (accepting sleep and no saved data). Free-tier rules
change often, so we re-check them at milestone M8.

```
[ Oracle Always Free VM ]
  ├─ caddy             (ports 80/443, HTTPS, reverse proxy → api)
  ├─ api container     (Node, port 8080, SQLite on a mounted volume)
  └─ runner container  (no network egress, read-only FS, internal port only)
```

### 12.2 The one cost hosting can't remove: the model API — Bring Your Own Key

Hosting is free, but **every model call is paid**. So **users bring their own API key for any
supported provider** (§9.8), and the owner of the deployment pays nothing for their usage.

> **Note:** ChatGPT being free does not make the OpenAI **API** free. Some providers offer free API
> tiers with strict rate limits (and sometimes training on your data); these change often and are
> checked at implementation time. The demo tier's provider is a config setting, so it can point at
> a free tier if the owner wants zero cost.

**Two tiers:**

| Tier | Who | Limit | Key used |
|---|---|---|---|
| **Demo** | Anyone after sign-up (e.g. a recruiter opening the link) | ~10 messages per user per day, global cap ~$1/day; Build mode disabled | Owner's key (provider set in config) |
| **Full** | Users who add their own key | Only their own provider's limits | User's key, user's chosen provider |

**Key lifecycle:**
1. **Add:** the user picks a provider and pastes the key in Settings (web) or runs `preppilot key set --provider claude` (CLI). Sent once over HTTPS in the request body — never in a URL or query string. A user can store one key per provider and choose the active one.
2. **Validate:** the adapter's `validateKey()` makes a call that costs no tokens (e.g. listing models). Invalid → rejected with a clear message.
3. **Store encrypted:** AES-256-GCM using `node:crypto`, with a random IV per key and a master key from the `KEY_ENCRYPTION_SECRET` env var (never in the DB or the image). The DB holds only `{ciphertext, iv, authTag, last4}`.
4. **Use:** decrypted in memory only for the duration of a request; a per-request Anthropic client is created with it.
5. **Never returned:** the UI only ever shows `sk-ant-…abcd` (last 4 characters).
6. **Delete:** "Remove key" deletes the row immediately.

**Rules:**
- The key is **never logged**: the logger redacts any field named like `key`/`authorization` and any string starting with `sk-ant-`.
- The key **never reaches the code runner**.
- Errors from Anthropic are mapped to user-facing messages: `401` → "your key is invalid or revoked", `429` → "your key hit its rate limit", low credit → "add credit in your Anthropic console".
- Usage is still recorded per user so they can see their own token spend on a usage page.

**Why store it server-side instead of only in the browser?**
- Keeping the key in `localStorage` and sending it with each request means any XSS bug leaks it, and the CLI and web app couldn't share it.
- Server-side encrypted storage keeps one place to protect, works for both clients, and the user can revoke it anytime.
- The trade-off is that users must trust the server. We state this clearly in the UI and keep the code open source so anyone can verify.

**Other cost controls:** generated problems are cached and reused (§9.4); rate limits on sign-up.

### 12.3 Production setup
- Config via environment variables (`ANTHROPIC_API_KEY`, `SESSION_SECRET`, `DATABASE_PATH`,
  `DAILY_TOKEN_BUDGET`). Secrets in the host's secret store, never in the image.
- `Dockerfile` (multi-stage, non-root user), `docker-compose.yml` for local, GitHub Actions CI
  (lint, type-check, tests, build image).

### 12.4 CLI distribution (npm)

- Package name **`preppilot`** (available on npm as of 2026-10-28), so anyone can run `npx preppilot`.
- The CLI is a **thin client**: it talks to the hosted API, so users don't need an API key or the notes.
  - `preppilot login` → opens a device-code style login; token stored in `~/.config/preppilot/`.
  - `preppilot ask "..."`, `preppilot interview --round 7`, `preppilot code --topic promises`, `preppilot progress`.
  - `PREPPILOT_URL` env var points it at a local server during development.
- Streams answers in the terminal by reading the same SSE stream as the web UI.
- Zero runtime dependencies (uses Node's built-in `fetch`, `readline`, `util.parseArgs`).
- Published from CI on a git tag (`npm publish --provenance`), with semantic versioning.

### 12.5 Scaling out (when needed)
| Bottleneck | Change |
|---|---|
| Many API instances | SQLite → Postgres; sessions in DB (already stateless servers). |
| Code runs | Scale runner containers independently behind a queue. |
| Rate limiting across instances | Move the in-memory limiter to Redis. |
| Model API limits | Per-user budgets, queue + backoff on 429, effort lowered for Ask mode. |

---

## 13. Failure Handling

| Failure | Behaviour |
|---|---|
| Model API 429 / 5xx | SDK retries with backoff (2 retries); then SSE `error` with "try again" and nothing lost. |
| Client disconnects mid-stream | Abort the upstream API stream (`AbortController`) to stop paying for tokens. |
| Tool throws | `tool_result` with `is_error: true`; the model explains or retries. |
| Code timeout / OOM | Child killed; result `{ status: "timeout" }`; server unaffected. |
| `refusal` stop reason | Friendly message, logged with category. |
| Budget exceeded | HTTP 429 with reset time. |
| Index missing at boot | `/readyz` fails until the index is built; traffic not routed. |

---

## 14. Observability

- JSON logs with `requestId`, `userId`, `mode`, latency, `input_tokens`, `output_tokens`,
  `cache_read_input_tokens`, tool calls.
- `/api/admin/stats` (admin only): requests per day, cost per day, cache hit rate, average score.
- Cache hit rate is the first thing to check if cost rises.

---

## 15. Security Summary

- API key only on the server; runner never receives it.
- Passwords hashed with `crypto.scrypt` + per-user salt; constant-time comparison.
- Cookies `HttpOnly`, `Secure`, `SameSite=Lax`; CSRF token on state-changing requests.
- Rate limit: per IP on auth routes, per user on chat and run routes.
- Model output rendered as **text / sanitized markdown**, never raw HTML (prevents XSS via the model).
- Retrieved notes are treated as data in the prompt, not instructions.

---

## 16. Key Decisions and Trade-offs

| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Search | BM25 keyword index | Vector embeddings | Small corpus, exact technical terms, no extra service; hybrid later if evals show misses. |
| Agent loop | Hand-written | SDK tool runner | Full control and explainability; the runner is the production shortcut. |
| Streaming | SSE | WebSockets | One-way stream; simpler and proxy-friendly. |
| DB | SQLite | Postgres | Zero ops for one instance; clear migration path. |
| Sandbox | Separate process + permission model + container | `node:vm` | `vm` is not a security boundary. |
| Server | `node:http` + own router | Express | Learning + zero deps; Express in a team setting is fine. |
| Model | `claude-opus-5-5`, effort per mode | Smaller model for cheap modes | One model keeps one cache; effort controls cost first. Revisit with measured data. |

---

## 17. Milestones

| # | Milestone | Done when |
|---|---|---|
| M1 | Indexer + BM25 search + CLI `ask` | `preppilot search "closures"` returns the right files. |
| M2 | Agent loop + Ask mode via CLI | Answers with citations; tool calls visible. |
| M3 | HTTP server, SSE, web chat UI | Streaming answers in the browser. |
| M4 | Code runner + Code mode | Hidden tests run safely; timeout and memory tests pass. |
| M5 | Grader + Interview mode + progress | Full Round 7 mock with a score report. |
| M6 | Build mode | Requirement → design → code → passing tests → explanation. |
| M7 | Auth, budgets, rate limits, observability | Multi-user safe. |
| M8 | Docker, CI, deploy, README, slide deck | Public URL works; deck ready for interviews. |
| M9 | More providers (OpenAI, Gemini adapters) | Each adapter passes the shared contract tests; grader eval run per provider. |

---

## 18. Decisions Log

| Date | Question | Decision |
|---|---|---|
| 2026-10-28 | Code mode problem source | Repo problems **and** AI-generated problems, verified against a reference solution before use (§9.4). |
| 2026-10-28 | Publish the CLI? | Yes — `npx preppilot`, thin client over the hosted API (§12.4). |
| 2026-10-28 | Hosting | Free: Oracle Cloud Always Free VM + Docker Compose + Caddy; Render free as fallback (§12.1). Daily spend cap on model usage (§12.2). |
| 2026-10-28 | Who pays for model usage? | Users bring their own API key (encrypted at rest, validated, never returned or logged). Small demo tier on the owner's key so visitors can try it first (§12.2). |
| 2026-10-29 | Grading scale | 1–10 with five criteria, matching the rubric already in the notes (`28-mock-interview`), instead of the 1–5 scale first drafted. |
| 2026-10-28 | Which AI providers? | Any, via a provider interface (§9.8). Claude adapter first (M2); OpenAI and Gemini in M9 after the core works end to end. |
