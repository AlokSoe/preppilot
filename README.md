# PrepPilot

An AI interview coach that interviews you from your own JavaScript notes, runs your code in a
sandbox, and tracks your weak topics.

> Status: **Milestone 2** — agent loop and Ask mode in the CLI. See [docs/system-design.md](docs/system-design.md).

## Quick start

Requires Node.js 22.5+.

```bash
npm install
npm test                                   # run the test suite (no API key needed)
export ANTHROPIC_API_KEY=sk-ant-...         # for ask / chat
node bin/preppilot.js ask "explain microtasks vs macrotasks"
node bin/preppilot.js chat                 # multi-turn; Ctrl+C stops an answer
node bin/preppilot.js index                # what gets indexed
node bin/preppilot.js search "event loop microtasks"
node bin/preppilot.js search "closure" --topic scope-and-closures --k 3
```

Knowledge sources are listed in `preppilot.config.json`, or set `PREPPILOT_SOURCES`
(comma-separated paths).

## Docs
- [System design](docs/system-design.md)
- [Interview notes](docs/interview-notes.md)
