/**
 * Session-usage reader — reads OpenCode's SQLite store directly
 * (~/.local/share/opencode/opencode.db, `message` table).
 *
 * Ground truth (verified 2026-08-30 on opencode 1.18.25): each assistant
 * message row's `data` JSON carries the request-level token snapshot:
 *   tokens: { total, input, output, reasoning, cache: { read, write } }
 *   modelID / providerID identify the model.
 * Context size = input + cache.read + cache.write (output is NOT in context).
 */
import * as fs from "node:fs"
import * as path from "node:path"
import type { UsageInfo } from "./tokens.js"
export type { UsageInfo } from "./tokens.js"

export interface RealcontextConfig {
  contextLimit?: number
  model?: string
  title?: boolean
  statusFile?: boolean
}

const DEFAULT_CONTEXT_LIMIT = 200_000

export function loadConfig(globalConfigDir?: string): RealcontextConfig {
  const home = process.env.HOME || "/"
  const cfgDir = globalConfigDir || path.join(home, ".config", "opencode")
  try {
    const raw = fs.readFileSync(path.join(cfgDir, "realcontext.json"), "utf8")
    const parsed = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null ? (parsed as RealcontextConfig) : {}
  } catch {
    return {}
  }
}

export interface SessionContext {
  usage: UsageInfo
  model: string
  provider: string
}

export function opencodeDbPath(): string {
  if (process.env.REALCONTEXT_DB) return process.env.REALCONTEXT_DB
  return path.join(process.env.HOME || "/", ".local", "share", "opencode", "opencode.db")
}

/**
 * Latest assistant-message token snapshot for a session, straight from the
 * SQLite store. Returns null when the session/db is unavailable (estimates
 * mode). Uses node:sqlite — zero external deps.
 */
export async function readUsage(sessionID: string): Promise<SessionContext | null> {
  if (!sessionID) return null
  const dbFile = opencodeDbPath()
  try {
    fs.accessSync(dbFile)
  } catch {
    return null
  }
  try {
    // constructed specifier survives bundler rewriting (tsup strips "node:"
    // from dynamic imports, which breaks resolution)
    const spec = "node:" + "sqlite"
    const { DatabaseSync } = (await import(/* @vite-ignore */ spec)) as {
      DatabaseSync: new (p: string, opts?: { readOnly?: boolean }) => {
        prepare: (sql: string) => { get: (...a: unknown[]) => unknown }
        close: () => void
      }
    }
    const db = new DatabaseSync(dbFile, { readOnly: true })
    try {
      const row = db
        .prepare(
          `SELECT data FROM message
           WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'
           ORDER BY time_created DESC LIMIT 1`,
        )
        .get(sessionID) as { data: string } | undefined
      if (!row?.data) return null
      const parsed = JSON.parse(row.data) as Record<string, unknown>
      const t = parsed.tokens as Record<string, unknown> | undefined
      if (!t || typeof t !== "object") return null
      const cache = (t.cache ?? {}) as Record<string, unknown>
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0)
      return {
        usage: {
          inputTokens: num(t.input),
          outputTokens: num(t.output),
          cacheRead: num(cache.read),
          cacheWrite: num(cache.write),
        },
        model: typeof parsed.modelID === "string" ? parsed.modelID : "unknown",
        provider: typeof parsed.providerID === "string" ? parsed.providerID : "unknown",
      }
    } finally {
      db.close()
    }
  } catch (err) {
    if (process.env.REALCONTEXT_DEBUG) {
      console.error(`[realcontext] readUsage failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return null
  }
}

export function contextLimit(cfg: RealcontextConfig): number {
  return cfg.contextLimit && cfg.contextLimit > 0 ? cfg.contextLimit : DEFAULT_CONTEXT_LIMIT
}
