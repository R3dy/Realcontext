# SYSTEM_MAP — realcontext

> **Last mapped:** 2026-08-30 · commit `222244d` (v0.1.0 `06a8165` + Issue #1 merge `0050190` + validator followup `222244d`, PR #2 closes #1) · project_type: `library` · Phase 4 COMPLETE
> **Dispatching context:** Cartographer refresh after the **Issue #1** merge (report accuracy defects, PR #2) via `anymake-agile`
> **Remote:** https://github.com/R3dy/Realcontext

## 1. Purpose

realcontext is a zero-runtime-dependency OpenCode plugin + CLI that gives complete visibility
into everything occupying a session's context window: the assembled system prompt, user-injected
rule files (AGENTS.md/CLAUDE.md chains), skills (metadata vs. bodies), MCP servers, plugins,
conversation, and tool schemas — in real tokens where the platform allows measurement, and
honestly-labeled chars/4 estimates where it doesn't.

Success model (library type): API quality, honest measurement semantics, and adoption
(`library` manifest governs; no monetization, no visual-quality gate).

## 2. Module Map (as-built)

| # | Module | File(s) | Responsibility | Key exports |
|---|--------|---------|----------------|-------------|
| 1 | Public API barrel | `src/index.ts` | Library surface: re-exports types, scan/capture/usage/report functions, and `RealcontextPlugin`. `main`/`exports: "."` → `dist/index.js` | `estimateTokens`, `scanAll`, `captureSystem`, `attribute`, `readUsage`, `buildBreakdown`, `render*`, `RealcontextPlugin`, all shared types |
| 2 | Plugin entry | `src/plugin.ts` → `dist/plugin.js` | OpenCode plugin `RealcontextPlugin`. Three hook surfaces (see §3-A). Every hook defensively try/catch-wrapped (INV-2) | `RealcontextPlugin` (named + default) |
| 3 | CLI | `src/cli.ts` → `dist/cli.js` (`bin: realcontext`) | Standalone headless report — no OpenCode runtime required (INV-8). Subcommands: `report` (default, detailed or `--json`), `status` (one-liner), `json` | `main(argv)`; auto-runs only when executed directly |
| 4 | Report core | `src/report.ts` | `buildBreakdown()` merges scan + capture + usage + optional `mcpMeasurements` (via `BuildInput`) into a `Breakdown`; renderers `renderStatusLine`, `renderDetailed`, `renderJson`, `contextPercent`; internal `finalize`/`bar` | See left |
| 5 | Disk scanner | `src/scan.ts` | Discovers on-disk context contributors: rules chain, skills (frontmatter split), MCP servers (`McpInfo` with `enabled` + `commandArgv`), plugins. Injectable paths for tests (INV-4, INV-9) | `scanAll`, `scanRules`, `scanSkills`, `scanMcps`, `scanPlugins`, `skillRoots`, `defaultPaths` |
| 6 | Usage reader | `src/usage.ts` | Reads the latest assistant-message token snapshot from OpenCode's SQLite store (read-only, INV-1); config loader; context limit | `readUsage(sessionID)`, `opencodeDbPath`, `loadConfig`, `contextLimit` |
| 7 | Capture + attribution | `src/capture.ts` | Persists captured system prompts (atomic write, keep-5 prune, INV-10); fingerprint-attribution of captured bytes to known sources (D-5) | `captureSystem`, `latestCapture`, `attribute`, `normalize` |
| 8 | Tokens + types | `src/tokens.ts` | Shared types (`ComponentKind`, `ItemDetail`, `Component`, `UsageInfo`, `Breakdown`), chars/4 estimator, formatters. Zero deps, pure functions (INV-6) | `estimateTokens`, `formatTokens`, `sumItems` |
| 9 | Tests | `test/realcontext.test.ts`, `test/mcp-probe.test.ts` | 21 vitest tests — scan/report suite incl. four Issue-#1 regression tests (bodies-not-in-total, not-measurable usage-null rows, measured + honest-not-measured MCP rows); probe suite (pagination, timeout, injectable spawn, never-rejects). Hermetic fixture trees in `mkdtemp` tmpdirs (INV-4) | — |
| 10 | Build config | `tsup.config.ts` | 3 ESM entries (`plugin`, `cli`, `index`), target node18, `splitting: false`, `external: ["node:sqlite"]` (D-4) | — |
| 11 | MCP probe | `src/mcp-probe.ts` | Out-of-band MCP server probe: `initialize` → `tools/list` with `nextCursor` pagination, per-server timeout, injectable spawn for tests. **Never rejects** — every per-server failure (spawn error, timeout, protocol error) becomes an `{ok: false, reason}` measurement row (D-13, INV-11) | `probeMcpServers`, `McpServerMeasurement` |

Build outputs (`dist/`): `plugin.js` (registered in OpenCode's global plugin array),
`cli.js` (bin), `index.js` (library import).

## 3. Data Flow

### A. Plugin runtime (in-session)

```
Plugin init [src/plugin.ts:28-38]
  → background fire-and-forget probeMcpServers(scanAll(paths).mcps)
  → per-server results cached in module state (mcpMeasurements); never rejects,
    with a .catch() belt-and-suspenders guard (D-13, INV-11)

experimental.chat.system.transform (pre-send, full system string[])
  → captureSystem(lastSessionID ?? "current", output.system)            [src/plugin.ts]
  → ~/.cache/realcontext/capture-<sanitized-sessionID>.json             [atomic write, prune keep=5]

OpenCode event bus [src/plugin.ts]
  session.created / message.*         → track lastSessionID
  session.idle / message.updated /
  message.part.updated                → writeStatus(lastSessionID)
       writeStatus — cache-only [D-13: no probe on the message-event hot path]:
         renders whatever cached mcpMeasurements holds —
         scanAll + latestCapture + readUsage(sessionID)
           → buildBreakdown({…, mcpMeasurements}) → renderStatusLine
         → write ~/.cache/realcontext/status.txt        (one-liner)
         → write ~/.cache/realcontext/usage.json        ({sessionID, usage, ts})
         → set terminal title via $`printf '\e]2;…\a'`  (tmux-visible)

context_report custom tool [src/plugin.ts:143]  (drives the /context command)
  → fresh probeMcpServers(scanAll(paths).mcps), falling back to cached on failure
  buildNow(sessionID) → summary | detailed | json
```

### B. CLI runtime (headless)

```
defaultPaths() → loadConfig() → scanAll() → latestCapture()
  report/json: probeMcpServers(scan.mcps) — one-shot per process, awaited
                                                      [src/cli.ts:33-37, D-13]
  report: measuredContext() = readUsage(latest capture's sessionID)
  → buildBreakdown({scan, capture, usage, config, model, mcpMeasurements})
  → renderJson | renderStatusLine | renderDetailed
  status: skips the probe entirely — cache-only, no spawn (D-13)
```

### C. Merge logic inside `buildBreakdown` (`src/report.ts`)

1. `attribute(capture, scan)` when capture exists: normalized-substring fingerprints
   (full rule-file text, skill `name: description` lines) mark bytes as **measured**;
   unmatched remainder → "opencode core system prompt" (D-5).
2. **system** component: attributed core remainder (measured) — or `tokens: 0` with
   "no capture yet" note when no capture (INV-3).
3. **rules** component: attributed items when available, else disk-scan chars/4 estimates.
4. **skills** component: resident metadata only — attributed metadata when available,
   else per-skill metadata estimates; skill bodies render as one labeled item
   "skill bodies — available on invoke (not in total)" (`src/report.ts:91`) that is
   **excluded from component and grand totals** (DRIFT-1 resolved by Issue #1).
5. **mcp** component: measured per-server from `input.mcpMeasurements`, matched to
   scanned servers by name (`src/report.ts:112`); disabled servers honestly
   `tokens: 0` (not loaded); probe failures render "not measured this run — <reason>";
   measurements absent render honest not-measured rows — never a silent zero
   (DRIFT-2 resolved by Issue #1). **plugins** component: names listed with `tokens: 0`.
6. **usage present**: `totalIn = input + cacheRead + cacheWrite`;
   residual = totalIn − (system+rules+skills), floored at 0; residual split **85/15**
   conversation/tools (D-8). `totalSource: "measured"`, `totalTokens = totalIn`.
7. **usage absent** (`src/report.ts:199-218`): `totalSource: "estimated"`,
   `totalTokens = Σ components` — with bodies excluded and conversation/tools at
   explicit `tokens: 0` not-measurable rows (stable component ids), this covers the
   attributed system side only, and the detailed renderer says so
   (`src/report.ts:283`) (DRIFT-3 resolved by Issue #1).

## 4. Data Model

In-memory (`src/tokens.ts`):

| Type | Shape |
|------|-------|
| `ComponentKind` | `"system" \| "rules" \| "skills" \| "mcp" \| "plugins" \| "conversation" \| "tools" \| "other"` |
| `ItemDetail` | `{ label, path?, tokens, measured, note? }` |
| `Component` | `{ id, label, kind, tokens, measured, items: ItemDetail[] }` |
| `UsageInfo` | `{ inputTokens, outputTokens, cacheRead, cacheWrite }` |
| `Breakdown` | `{ components, totalTokens, totalSource: "measured"\|"estimated", model, contextLimit, usage: UsageInfo\|null, capture: {ts, sessionID}\|null }` |

On-disk artifacts (all under realcontext's own namespace, INV-7):

| Artifact | Path | Producer |
|----------|------|----------|
| Capture | `~/.cache/realcontext/capture-<sanitized-sessionID>.json` — `{ts, sessionID, system: string[]}`; atomic tmp+rename; pruned to latest 5 | `src/capture.ts` |
| Status line | `~/.cache/realcontext/status.txt` | `src/plugin.ts` `writeStatus` |
| Usage cache | `~/.cache/realcontext/usage.json` — `{sessionID, usage, ts}` | `src/plugin.ts` `writeStatus` |
| Config | `~/.config/opencode/realcontext.json` — `{contextLimit?, model?, title?, statusFile?}` (read-only input) | read by `src/usage.ts` |

Environment overrides: `REALCONTEXT_DB` (db path), `REALCONTEXT_CACHE_DIR` (cache root),
`REALCONTEXT_DEBUG` (log `readUsage` failures to stderr), `HOME`.

## 5. External Integrations

| Integration | Surface | Contract / notes |
|-------------|---------|------------------|
| OpenCode plugin API (`@opencode-ai/plugin`) | `experimental.chat.system.transform` hook; `event` bus; custom `tool` registration; `$` shell runner | Dev-dependency for types only; never imported at CLI runtime. Hook signature confirmed from a live plugin on this box (`PHASE_STATE.md` "Don't redo") |
| OpenCode SQLite store | `~/.local/share/opencode/opencode.db`, `message` table — latest assistant row by `time_created`; `data` JSON: `role`, `tokens{input, output, cache{read, write}}`, `modelID`, `providerID` | Read-only (`DatabaseSync(…, { readOnly: true })`, INV-1). Ground truth verified 2026-08-30 on OpenCode 1.18.25. Context size = input + cache.read + cache.write (output excluded) |
| Filesystem (read) | `~/.config/opencode/`: `AGENTS.md`, `CLAUDE.md`, `opencode.json`, `skill/`, `skills/`; project root: `AGENTS.md`, `CLAUDE.md`, `opencode.json`, `opencode.jsonc`, `.opencode/skill|skills/`; `~/.claude/skills/` | All reads via safe readers (`readTextSafe`/`readJsonSafe`/`existsFile`); missing dirs → empty results, never throw (INV-9) |

## 6. Run / Test / Deploy

| Operation | Command | Notes |
|-----------|---------|-------|
| Install | `npm install` | devDependencies only; **zero runtime deps** (D-10) |
| Build | `npm run build` | tsup → `dist/{plugin,cli,index}.js` |
| Test | `npm test` | vitest, 21/21 green at `222244d` (incl. `test/mcp-probe.test.ts` never-rejects + Issue-#1 regressions); hermetic, no live OpenCode/DB/network (INV-4) |
| Typecheck | `npm run typecheck` | `tsc --noEmit`, clean at `222244d` |
| Run (plugin) | add `dist/plugin.js` absolute path to `plugin` array in `~/.config/opencode/opencode.json`; `/context` command via `~/.config/opencode/commands/context.md` | Absolute local paths proven live on OpenCode 1.18 |
| Run (CLI) | `node dist/cli.js report [--json]` / `node dist/cli.js status` | Works with no plugin installed (INV-8); report/json probe live MCP servers (one-shot, awaited), status skips the probe (D-13) |
| Deploy | none yet (library type) | npm publish is a next-session candidate; repo at github.com/R3dy/Realcontext |

## 7. Drift Log

*Findings quoted as mapped at `06a8165` (v0.1.0); line numbers in the Finding column refer to that revision.*

| ID | Status | Finding | Conflicts with | Notes |
|----|--------|---------|----------------|-------|
| DRIFT-1 | **resolved** | Un-invoked skill-body estimates counted into totals: the Skills component carries one aggregated "skill bodies (loaded only on invoke)" item (`src/report.ts:76-85`), and the estimated path sums every component (`src/report.ts:170`), so un-invoked skill bodies inflate `totalTokens` and the skills row | INV-5 (honest visibility: totals should reflect what is actually in context) | **Resolved by Issue #1 (PR #2, merge `0050190`)**: skills component now carries resident metadata only; the bodies item is labeled "skill bodies — available on invoke (not in total)" and excluded from component and grand totals (`src/report.ts:91`); pinned by test "estimated total excludes un-invoked skill bodies (issue #1 regression)" |
| DRIFT-2 | **resolved** | MCP component hard-codes `tokens: 0` for every scanned server (`src/report.ts:96-110`); MCP tool schemas are only implicitly inside the residual tools estimate | INV-5 (component-level honest labeling — row reads as zero-cost while schemas do occupy context) | **Resolved by Issue #1 (PR #2)**: MCP component measures per-server from injected `BuildInput.mcpMeasurements` (`src/report.ts:112`); disabled servers honestly `tokens: 0` (not loaded); probe failures render "not measured this run — <reason>"; absent measurements render honest not-measured rows — never a silent zero |
| DRIFT-3 | **resolved** | `conversation`/`tools` rows are emitted only when `usage != null` (`src/report.ts:129-168`); estimated-mode breakdowns have no conversation/tools rows at all, so estimated totals omit conversation entirely | INV-3 (render with zero usage is safe but structurally incomplete vs. the component model) | **Resolved by Issue #1 (PR #2)**: usage-null now renders explicit not-measurable conversation/tools rows with stable component ids (`src/report.ts:208-218`); estimated total noted as covering attributed system-side only (`src/report.ts:283`); test "renders explicit not-measurable conversation/tools rows when usage is null" |
| DRIFT-4 | **resolved** | `package.json` declares `"engines": { "node": ">=18" }` and tsup targets `node18`, but `node:sqlite` (required by `src/usage.ts`) exists only on Node ≥22; README documents "node ≥22" | — (no invariant; internal consistency of the shipped contract) | **Resolved by Issue #1 (PR #2)**: engines bumped to `"node": ">=22"` (verified at `222244d`), matching the `node:sqlite` floor and README; tsup `node18` target remains a syntax-transpile floor, not a runtime claim |

Documented-but-not-drift (explained limitations, recorded in decisions — unchanged by the
Issue #1 merge): skill metadata fingerprint format mismatch (D-5 known limitation, MVP
item #1); 85/15 residual split roughness (D-8, README "Known limits" — the split logic
itself is unchanged; the merge amended only the usage-null rendering, see D-8).
