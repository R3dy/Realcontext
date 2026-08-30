/**
 * Breakdown builder + renderers. Merges the disk scan, the captured system
 * prompt (with fingerprint attribution), and measured session usage into one
 * picture of what is in the context window.
 */
import type { Breakdown, Component, ItemDetail, UsageInfo } from "./tokens.js"
import { estimateTokens, sumItems } from "./tokens.js"
import type { ScanResult } from "./scan.js"
import { attribute, type Capture } from "./capture.js"
import type { RealcontextConfig } from "./usage.js"
import { contextLimit } from "./usage.js"

export interface BuildInput {
  scan: ScanResult
  capture: Capture | null
  usage: UsageInfo | null
  config: RealcontextConfig
  model?: string
}

export function buildBreakdown(input: BuildInput): Breakdown {
  const { scan, capture, usage } = input
  const limit = contextLimit(input.config)
  const model = input.model || input.config.model || "unknown"
  const components: Component[] = []

  const attr = capture ? attribute(capture, scan) : null

  // --- system prompt (core, not attributable to any known source) ---
  const systemItems: ItemDetail[] = []
  if (attr) {
    systemItems.push({
      label: "opencode core system prompt (captured)",
      tokens: attr.coreTokens,
      measured: true,
      note: "from experimental.chat.system.transform capture; non-fingerprinted remainder",
    })
  } else {
    systemItems.push({
      label: "opencode core system prompt",
      tokens: 0,
      measured: false,
      note: "no capture yet — appears after the first model turn in a live session",
    })
  }
  components.push({
    id: "system",
    label: "System prompt (core)",
    kind: "system",
    tokens: sumItems(systemItems),
    measured: attr !== null,
    items: systemItems,
  })

  // --- rules (AGENTS.md / CLAUDE.md chain) ---
  const rulesItems: ItemDetail[] =
    attr && attr.rulesAttributed.length > 0 ? attr.rulesAttributed : scan.rules
  components.push({
    id: "rules",
    label: "User-injected prompts (AGENTS.md/CLAUDE.md)",
    kind: "rules",
    tokens: sumItems(rulesItems),
    measured: attr !== null && attr.rulesAttributed.length > 0,
    items: rulesItems,
  })

  // --- skills ---
  const skillMetaItems: ItemDetail[] =
    attr && attr.skillsAttributed.length > 0 ? attr.skillsAttributed : scan.skills.map((s) => ({
      label: `skill:${s.name}`,
      path: s.path,
      tokens: s.metaTokens,
      measured: false,
      note: s.description ? "estimate of name+description metadata" : "no frontmatter description",
    }))
  const skillBodyTokens = scan.skills.reduce((acc, s) => acc + s.bodyTokens, 0)
  const skillItems: ItemDetail[] = [...skillMetaItems]
  if (skillBodyTokens > 0) {
    skillItems.push({
      label: "skill bodies (loaded only on invoke)",
      tokens: skillBodyTokens,
      measured: false,
      note: `${scan.skills.length} skills on disk; bodies enter context when a skill is invoked`,
    })
  }
  components.push({
    id: "skills",
    label: "Skills",
    kind: "skills",
    tokens: sumItems(skillItems),
    measured: attr !== null && attr.skillsAttributed.length > 0,
    items: skillItems,
  })

  // --- MCP servers ---
  const mcpItems: ItemDetail[] = scan.mcps.map((m) => ({
    label: m.name,
    path: m.command || m.url,
    tokens: 0,
    measured: false,
    note: `${m.type} (${m.where}); tool schemas not hook-observable — counted in the tools residual`,
  }))
  components.push({
    id: "mcp",
    label: "MCP servers",
    kind: "mcp",
    tokens: 0,
    measured: false,
    items: mcpItems,
  })

  // --- plugins ---
  const pluginItems: ItemDetail[] = scan.plugins.map((p) => ({
    label: p,
    tokens: 0,
    measured: false,
    note: "contributes via system prompt and/or tool schemas; attributed parts appear under System/Rules/Skills",
  }))
  components.push({
    id: "plugins",
    label: "Plugins",
    kind: "plugins",
    tokens: 0,
    measured: false,
    items: pluginItems,
  })

  // --- conversation + tool schemas (needs measured usage) ---
  if (usage) {
    const totalIn = usage.inputTokens + usage.cacheRead + usage.cacheWrite
    const systemSide = components
      .filter((c) => ["system", "rules", "skills"].includes(c.kind))
      .reduce((acc, c) => acc + c.tokens, 0)
    const residual = Math.max(0, totalIn - systemSide)
    // split residual: assume conversation dominates; tools get a nominal floor
    // when residual is large enough to plausibly contain schemas
    const convEst = Math.round(residual * 0.85)
    const toolsEst = residual - convEst
    components.push({
      id: "conversation",
      label: "Conversation (messages + tool results)",
      kind: "conversation",
      tokens: convEst,
      measured: false,
      items: [
        {
          label: "estimated: measured input minus attributed system-side (85/15 split with tools)",
          tokens: 0,
          measured: false,
        },
      ],
    })
    components.push({
      id: "tools",
      label: "Tool schemas (built-in + MCP)",
      kind: "tools",
      tokens: toolsEst,
      measured: false,
      items: [
        {
          label: "residual estimate — schemas ride the provider tools param, invisible to hooks",
          tokens: 0,
          measured: false,
        },
      ],
    })
    return finalize(components, totalIn, "measured", model, limit, usage, capture)
  }

  const est = components.reduce((acc, c) => acc + c.tokens, 0)
  return finalize(components, est, "estimated", model, limit, null, capture)
}

function finalize(
  components: Component[],
  total: number,
  source: "measured" | "estimated",
  model: string,
  limit: number,
  usage: UsageInfo | null,
  capture: Capture | null,
): Breakdown {
  return {
    components,
    totalTokens: total,
    totalSource: source,
    model,
    contextLimit: limit,
    usage,
    capture: capture ? { ts: capture.ts, sessionID: capture.sessionID } : null,
  }
}

// ---------------- renderers ----------------

function bar(pct: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return "#".repeat(filled) + "-".repeat(width - filled)
}

export function renderStatusLine(bd: Breakdown): string {
  const pct = bd.contextLimit > 0 ? (bd.totalTokens / bd.contextLimit) * 100 : 0
  const get = (id: string) => {
    const c = bd.components.find((x) => x.id === id)
    return c ? c.tokens : 0
  }
  const parts = [
    `ctx ${(bd.totalTokens / 1000).toFixed(1)}k/${(bd.contextLimit / 1000).toFixed(0)}k (${pct.toFixed(0)}%)`,
    `sys ~${(get("system") / 1000).toFixed(1)}k`,
    `rules ${(get("rules") / 1000).toFixed(1)}k`,
    `skills ${(get("skills") / 1000).toFixed(1)}k`,
    `conv ${(get("conversation") / 1000).toFixed(1)}k`,
  ]
  return `[realcontext] ${parts.join(" | ")}`
}

export function renderDetailed(bd: Breakdown): string {
  const lines: string[] = []
  const pct = bd.contextLimit > 0 ? (bd.totalTokens / bd.contextLimit) * 100 : 0
  lines.push(`realcontext — context breakdown (${bd.totalSource})`)
  lines.push(
    `model: ${bd.model}  |  context: ${(bd.totalTokens / 1000).toFixed(1)}k / ${(bd.contextLimit / 1000).toFixed(0)}k (${pct.toFixed(1)}%) [${bar(pct)}]`,
  )
  if (bd.usage) {
    lines.push(
      `usage: input ${bd.usage.inputTokens} + cache-read ${bd.usage.cacheRead} + cache-write ${bd.usage.cacheWrite} (output ${bd.usage.outputTokens})`,
    )
  }
  if (bd.capture) lines.push(`capture: session ${bd.capture.sessionID} @ ${bd.capture.ts}`)
  lines.push("")
  lines.push("COMPONENT                          TOKENS    SRC       DETAIL")
  for (const c of bd.components) {
    const label = c.label.slice(0, 33).padEnd(33)
    const tok = c.tokens.toLocaleString("en-US").padStart(8)
    const src = c.measured ? "measured" : "estimate"
    lines.push(`${label}  ${tok}  ${src.padEnd(9)} ${c.items.length} item(s)`)
    for (const it of c.items) {
      const l = `  - ${it.label}`.slice(0, 50).padEnd(50)
      const t = it.tokens.toLocaleString("en-US").padStart(8)
      const m = it.measured ? "measured" : "estimate"
      const extra = [it.path ? `path=${it.path}` : null, it.note].filter(Boolean).join(" | ")
      lines.push(`${l}  ${t}  ${m.padEnd(8)}${extra ? " " + extra.slice(0, 120) : ""}`)
    }
  }
  lines.push("")
  lines.push("est = chars/4 estimate; measured = real bytes (captured prompt / fingerprint match / provider usage)")
  return lines.join("\n")
}

export function renderJson(bd: Breakdown): string {
  return JSON.stringify(bd, null, 2)
}

/** Small helper re-exported for the CLI one-liner. */
export function contextPercent(bd: Breakdown): number {
  return bd.contextLimit > 0 ? (bd.totalTokens / bd.contextLimit) * 100 : 0
}

export { estimateTokens }
