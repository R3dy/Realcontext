/**
 * Live MCP tool-schema enumeration (Issue #1 / roadmap "per-MCP live tools/list
 * enumeration").
 *
 * Protocol per enabled local server (JSON-RPC over stdio):
 *   initialize → notifications/initialized → tools/list (following `nextCursor`
 *   pagination — codebase-memory-mcp paginates; a naive probe sees 8/14 tools).
 *
 * Honest-labeling contract (INV-5): the returned `tokens` figure is chars/4
 * over the REAL schema bytes returned by tools/list — measured bytes, estimated
 * tokens. Never a bundled guess.
 *
 * Safety contract (INV-2): every failure mode — spawn error, hang (per-server
 * timeout), malformed response, disabled or remote server — degrades to a
 * per-server {ok:false, reason} row. `probeMcpServers` never rejects, so
 * fire-and-forget callers still get a `.catch()` belt-and-suspenders guard.
 */
import * as nodeChildProcess from "node:child_process"
import type { EventEmitter } from "node:events"
import type { McpInfo } from "./scan.js"

export interface McpServerMeasurement {
  name: string
  ok: boolean
  toolCount?: number
  /** chars/4 over the real tools/list schema bytes (INV-5: measured bytes, estimated tokens) */
  tokens?: number
  reason?: string
}

export interface MinimalProcess {
  stdin: { write(s: string): void }
  stdout: EventEmitter
  stderr: EventEmitter
  on(event: string, cb: (...args: unknown[]) => void): void
  kill(signal?: string): void
}

export interface ProbeOptions {
  /** per-server wall-clock budget; a hung server is killed and skipped */
  timeoutMs?: number
  /** injectable for tests (INV-4: no live servers in the suite) */
  spawnImpl?: (command: string, args: string[]) => MinimalProcess
}

const DEFAULT_TIMEOUT_MS = 4000

type JsonRpcMsg = {
  id?: number
  result?: { tools?: Array<Record<string, unknown>>; nextCursor?: string }
}

async function probeServer(
  info: McpInfo,
  opts: ProbeOptions,
): Promise<McpServerMeasurement> {
  const { name } = info
  if (info.enabled === false) return { name, ok: false, reason: "disabled — not probed" }
  if (info.type === "remote" || !info.commandArgv?.length) {
    return { name, ok: false, reason: info.type === "remote" ? "remote — not probed" : "no command to probe" }
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const spawnFn = opts.spawnImpl ?? ((cmd: string, args: string[]) =>
    nodeChildProcess.spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] }) as unknown as MinimalProcess)

  return new Promise<McpServerMeasurement>((resolve) => {
    let proc: MinimalProcess
    try {
      proc = spawnFn(info.commandArgv![0], info.commandArgv!.slice(1))
    } catch (err) {
      resolve({ name, ok: false, reason: `spawn failed: ${err instanceof Error ? err.message : String(err)}` })
      return
    }

    let settled = false
    const finish = (m: McpServerMeasurement) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        proc.kill("SIGKILL")
      } catch {
        /* already gone */
      }
      resolve(m)
    }

    const timer = setTimeout(
      () => finish({ name, ok: false, reason: `timeout after ${timeoutMs}ms` }),
      timeoutMs,
    )

    const tools: Array<Record<string, unknown>> = []
    let buf = ""
    const send = (o: unknown) => {
      try {
        proc.stdin.write(JSON.stringify(o) + "\n")
      } catch {
        /* stdin closed — timeout/error path will settle */
      }
    }

    proc.stdout.on("data", (d: Buffer | string) => {
      buf += String(d)
      let idx: number
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim()) continue
        let msg: JsonRpcMsg
        try {
          msg = JSON.parse(line) as JsonRpcMsg
        } catch {
          continue
        }
        if (msg?.id === 2 && msg?.result?.tools) {
          tools.push(...msg.result.tools)
          // MUST follow pagination — servers return nextCursor when the list is truncated
          if (msg.result.nextCursor) {
            send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { cursor: msg.result.nextCursor } })
            continue
          }
          finish({
            name,
            ok: true,
            toolCount: tools.length,
            tokens: Math.ceil(JSON.stringify(tools).length / 4),
          })
        }
      }
    })
    proc.on("error", (err) =>
      finish({ name, ok: false, reason: `spawn failed: ${err instanceof Error ? (err as Error).message : String(err)}` }),
    )

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "realcontext", version: "0.1.0" } } })
    send({ jsonrpc: "2.0", method: "notifications/initialized" })
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  })
}

/**
 * Probe every scanned MCP server. Never rejects; each entry degrades
 * independently. Sequential on purpose — N servers ≤ N × timeoutMs worst case,
 * and probes are user-invoked (CLI report / context_report) or background.
 */
export async function probeMcpServers(
  mcps: McpInfo[],
  opts: ProbeOptions = {},
): Promise<McpServerMeasurement[]> {
  const out: McpServerMeasurement[] = []
  for (const m of mcps) {
    try {
      out.push(await probeServer(m, opts))
    } catch (err) {
      out.push({ name: m.name, ok: false, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}
