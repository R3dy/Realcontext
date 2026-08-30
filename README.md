# realcontext

**Complete, total visibility into everything that takes up context in an OpenCode session.**

A zero-dependency OpenCode plugin that shows you where your context window actually goes: the built-in system prompt, user-injected prompts (AGENTS.md/CLAUDE.md chains), skills (metadata vs. bodies), MCP servers, plugins, conversation, and tool schemas — in real tokens (measured where the platform allows, honestly estimated where it doesn't).

## What you get

| Surface | What it does |
|---------|-------------|
| **Terminal-title status bar** | Live one-liner after every turn: `[realcontext] ctx 15.7k/200k (8%) \| sys ~0.9k \| rules 0.7k \| skills 14.1k \| conv 0.0k` — visible in tmux status line and terminal titles. Also written to `~/.cache/realcontext/status.txt` for status scripts. |
| **`/context` command** | In the TUI: full granular breakdown — every component, every attributed file, per-skill, per-MCP, measured vs estimated flags. |
| **`context_report` tool** | Agent-callable anytime, modes: `summary` / `detailed` / `json`. |
| **`realcontext` CLI** | Headless: `realcontext report [--json]` / `realcontext status`. |

## How it measures

- **System prompt (measured):** the `experimental.chat.system.transform` hook hands realcontext the full assembled system prompt on every fire. It is persisted to `~/.cache/realcontext/capture-<session>.json`.
- **Attribution (fingerprinted):** known sources — the AGENTS.md/CLAUDE.md chain, per-skill name+description metadata — are matched into the captured prompt (normalized substring). Matched bytes are labeled `measured`; the remainder is "opencode core system prompt".
- **Session usage (measured):** the latest assistant message's token snapshot is read straight from OpenCode's SQLite store (`~/.local/share/opencode/opencode.db`): `input + cache.read + cache.write` = what the model sees. `modelID` comes with it.
- **Tool schemas (estimated):** MCP/built-in tool schemas ride the provider `tools` param, invisible to any hook — realcontext reports them as the measured residual minus attributed system-side components, clearly labeled.
- **Estimates:** chars/4 everywhere estimation is used, always labeled `estimate`.

## Install (local-path, no publish needed)

```sh
# 1. add the built plugin to your opencode config plugin array
#    in ~/.config/opencode/opencode.json:
#      "plugin": [ "/abs/path/to/realcontext/repo/dist/plugin.js" ]

# 2. add the /context command
mkdir -p ~/.config/opencode/commands
cp commands/context.md ~/.config/opencode/commands/context.md

# 3. restart opencode; after the first model turn:
/context
```

## Status file + tmux

```
# ~/.cache/realcontext/status.txt (rewritten after every turn)
# tmux: add to status-right:
#   #(cat ~/.cache/realcontext/status.txt 2>/dev/null | cut -c1-60)
```

## Configuration (optional)

`~/.config/opencode/realcontext.json`:

```json
{ "contextLimit": 200000, "title": true, "statusFile": true }
```

## Development

```sh
npm install
npm test          # vitest, 9 tests
npm run build     # tsup -> dist/
npm run typecheck # tsc --noEmit
```

## Known limits (prototype v0.1)

- Skill metadata attribution expects `name: description` lines; OpenCode's skill-block formatting may differ → skills show as estimates until tuned per version.
- Conversation/tools split is an 85/15 residual estimate; per-message conversation accounting is a planned MVP feature.
- No per-MCP live `tools/list` enumeration yet.
- Requires OpenCode ≥1.18 (SQLite session store, node ≥22 for `node:sqlite`).

## License

MIT
