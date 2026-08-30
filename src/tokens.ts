/** Shared types + token estimation + formatting. Zero runtime deps. */

export type ComponentKind =
  | "system"
  | "rules"
  | "skills"
  | "mcp"
  | "plugins"
  | "conversation"
  | "tools"
  | "other"

export interface ItemDetail {
  label: string
  path?: string
  tokens: number
  /** true = derived from real bytes (captured prompt or usage); false = chars/4 estimate of a guess */
  measured: boolean
  note?: string
}

export interface Component {
  id: string
  label: string
  kind: ComponentKind
  tokens: number
  measured: boolean
  items: ItemDetail[]
}

export interface UsageInfo {
  inputTokens: number
  cacheRead: number
  cacheWrite: number
  outputTokens: number
}

export interface Breakdown {
  components: Component[]
  /** what the model actually sees (input + cache) when usage is present */
  totalTokens: number
  totalSource: "measured" | "estimated"
  model: string
  contextLimit: number
  usage: UsageInfo | null
  capture: { ts: string; sessionID: string } | null
}

const CHARS_PER_TOKEN = 4

/** chars/4 estimator — deliberately simple, always labeled as an estimate. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** "840", "12.4k", "1.25M" */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`
  }
  return `${Math.round((n / 1_000_000) * 100) / 100}M`
}

export function sumItems(items: ItemDetail[]): number {
  return items.reduce((acc, it) => acc + (Number.isFinite(it.tokens) ? it.tokens : 0), 0)
}
