# PrepPilot

**An AI interview coach that interviews you from your own JavaScript notes, runs your code in a
sandbox, and tracks your weak topics until they're strong.**

PrepPilot indexes your study notes and turns them into five modes:

| Mode | What it does |
|---|---|
| **Ask** | Answers JavaScript questions from your notes, citing the file and section. |
| **Interview** | Runs a mock interview round one question at a time; every answer is graded 1–10 against your rubric by a separate grader. |
| **Build** | Takes a requirement, designs it, writes code and tests, runs them in a sandbox until they pass, and explains the result. |
| **Code** | Generates machine-coding problems (verified against a reference solution before you see them), runs your solution against hidden tests, and reviews it. |
| **Progress** | Spaced repetition per topic: what's due, what's weak, what you haven't tried. |

Available as a **web app** and a **CLI** (`npx preppilot`).

## How it works

```
 Browser / CLI ──HTTPS + SSE──► API server (node:http, own router & middleware)
                                  │
            ┌─────────────────────┼──────────────────────┬────────────────────┐
            ▼                     ▼                      ▼                    ▼
   Agent loop (tool use)   BM25 search over notes   Code runner service   SQLite (node:sqlite)
   Claude via a provider-  (inverted index,         (node --permission,   problems, attempts,
   neutral interface       ~800 chunks, ~130 ms)    isolated container)   mastery, accounts
```

- **Agent loop**: written by hand. Streaming, parallel tool calls, input validation, iteration caps,
  refusal handling, prompt caching. Providers plug in behind one interface (Strategy + Adapter).
- **Retrieval**: BM25 written from scratch, over notes split by headings, with an identifier-aware tokenizer.
- **Sandbox**: each run is a separate `node --permission` process (no file system, network or child
  processes), with an empty environment, a heap cap and a SIGKILL timeout. In production it also runs
  in a separate container with no internet, a read-only file system and dropped capabilities.
- **Grading**: a separate structured-output call scores answers on five rubric criteria; scores feed
  an SM-2 review schedule.
- **Accounts** (optional): scrypt passwords, HttpOnly cookies, users' API keys encrypted with
  AES-256-GCM, a demo tier with daily caps, rate limits, CSRF Origin checks and log redaction.

One runtime dependency (`@anthropic-ai/sdk`); everything else is Node built-ins.
Full design: [docs/system-design.md](docs/system-design.md).

## Quick start (local, single user)

Requires **Node.js 26+** and an Anthropic API key.

```bash
git clone https://github.com/<your-github-user>/preppilot.git && cd preppilot
npm install
npx preppilot init --notes ~/path/to/your/notes      # one or more folders, comma-separated
export ANTHROPIC_API_KEY=sk-ant-...
npm start                                            # http://127.0.0.1:8080
```

### CLI

```bash
preppilot ask "explain microtasks vs macrotasks"
preppilot chat                                       # multi-turn
preppilot interview --round 4                        # without --round, lists the rounds
preppilot build "a rate limiter, N calls per minute" # saves passing code to preppilot-build.js
preppilot code new --topic promises --difficulty medium
preppilot code submit <problem-id> solution.js
preppilot progress
preppilot search "event delegation"                  # search only, no AI
```

Your notes can be any folders of Markdown and JavaScript files. Interview rounds and the rubric are
read from a `28-mock-interview/questions.md` file if your notes have one; otherwise built-in defaults
are used.

## Deploying

Free hosting on an Oracle Cloud Always Free VM with Docker Compose and automatic HTTPS:
see [docs/deploy.md](docs/deploy.md).

```bash
cp .env.example .env   # fill it in
docker compose up -d --build
```

## Configuration

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Server key: every request in single-user mode; the demo tier with accounts. |
| `AUTH=accounts` | Turns on sign-up/login and bring-your-own-key. |
| `KEY_ENCRYPTION_SECRET` | 32+ characters; encrypts users' keys (required with accounts). |
| `PREPPILOT_SOURCES` | Note folders, comma-separated (overrides `preppilot init`). |
| `DATABASE_PATH` | SQLite file (default `~/.preppilot/preppilot.db`). |
| `RUNNER_URL`, `RUNNER_TOKEN` | Use the separate code-runner service. |
| `DEMO_MESSAGES_PER_USER`, `DEMO_DAILY_TOKENS` | Demo tier limits. |
| `PREPPILOT_MODEL` | Model override (default `claude-opus-5-5`). |
| `TRUST_PROXY=true` | Behind Caddy or nginx: read the client IP from `X-Forwarded-For`. |

## Development

```bash
npm test     # 140+ tests, no API key needed (fake model providers, real sandbox)
```

## Docs

- [System design](docs/system-design.md): requirements, architecture, trade-offs
- [Interview notes](docs/interview-notes.md): decisions and real bugs, written as interview answers
- [Deployment](docs/deploy.md)

## License

MIT
