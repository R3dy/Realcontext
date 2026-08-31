# realcontext — Environment Guide

How to run, test, and produce the report states the Experience Scripts drive.
Everything here is hermetic to this repo and `~/.local/share/opencode/` (read-only).

## Prerequisites

- Node >= 22 (the report reads session usage via `node:sqlite`; `package.json` engines encodes the floor)
- No live OpenCode session required — the CLI reads OpenCode's SQLite store and the last captured prompt from disk

## Install & build

```bash
npm install
npm run build        # tsup → dist/
npm run typecheck    # tsc --noEmit
npm test             # vitest run (fully hermetic — no live MCP servers, no live DB)
```

## Run the report CLI

```bash
node dist/cli.js report              # detailed breakdown (auto-detects session from the DB)
node dist/cli.js report --json       # machine-readable
```

The CLI auto-detects: global config at `$HOME/.config/opencode/opencode.json`,
project config at `./opencode.json` / `./opencode.jsonc`, skills under
`$HOME/.config/opencode/skills`, `./.opencode/skills`, and `~/.claude/skills`.

## Producing a usage-null capture (Story 1 Experience Script, step 5)

Point `REALCONTEXT_DB` at a nonexistent path — `readUsage()` returns null when
the DB is missing (src/usage.ts), which drives the same code path as a report
run before the first assistant turn of a session:

```bash
REALCONTEXT_DB=/tmp/opencode/empty-no-such.db node dist/cli.js report
```

Expected: header shows `(estimated)`; the report still renders every component
row — conversation/tools carry explicit not-measurable markers, never silent
omission.

## Producing a no-MCP-config capture (Story 2 Experience Script, step 5)

Override `HOME` to an empty directory — `defaultPaths()` (src/scan.ts) reads
`process.env.HOME`, so the scan finds no global config, no AGENTS.md, no skills:

```bash
mkdir -p /tmp/opencode/fakehome && HOME=/tmp/opencode/fakehome node dist/cli.js report
```

Expected: report completes quickly; MCP section renders gracefully with zero
servers (INV-3: render-with-zero-capture).

## Live MCP probe ground truth (reference, not a test)

The suite never contacts live servers (INV-4). For manual ground-truth
comparison, a probe equivalent to `src/mcp-probe.ts` was measured 2026-08-30:
codebase-memory-mcp 14 tools ≈ 3,405 tok; realmemory 12 tools ≈ 2,005 tok;
gmail disabled → 0. Live values drift with server versions — treat as scale
reference only.
