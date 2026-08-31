/**
 * Hermetic tests for src/mcp-probe.ts (INV-4: no live servers — injectable
 * spawn impl fakes the whole JSON-RPC-over-stdio session).
 */
import { describe, it, expect } from "vitest"
import { EventEmitter } from "node:events"
import { probeMcpServers, type MinimalProcess, type ProbeOptions } from "../src/mcp-probe.js"
import type { McpInfo } from "../src/scan.js"

/** Scripted fake server: responds to initialize, then tools/list — optionally
 *  paginating (first response carries nextCursor) and optionally hanging. */
function fakeSpawn(script: {
  hang?: boolean
  paginate?: boolean
  toolCounts?: number[] // [first page] or [first page, second page] when paginating
  emitError?: Error
}): { impl: ProbeOptions["spawnImpl"]; requests: string[]; spawnedFor: string[] } {
  const requests: string[] = []
  const spawnedFor: string[] = []
  const impl: ProbeOptions["spawnImpl"] = (command) => {
    spawnedFor.push(command)
    const proc = new EventEmitter() as unknown as MinimalProcess
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    ;(proc as unknown as { stdout: EventEmitter; stderr: EventEmitter }).stdout = stdout
    ;(proc as unknown as { stderr: EventEmitter }).stderr = stderr
    ;(proc as unknown as { stdin: { write(s: string): void } }).stdin = {
      write: (s: string) => {
        requests.push(s)
        const msg = JSON.parse(s) as { id?: number; method?: string; params?: { cursor?: string } }
        if (script.emitError) {
          setImmediate(() => proc.emit("error", script.emitError))
          return
        }
        if (msg.method === "initialize" && msg.id === 1) {
          setImmediate(() =>
            stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "fake" } } }) + "\n"),
          )
        }
        if (msg.method === "tools/list" && msg.id === 2) {
          if (script.hang) return // never respond → timeout path
          const makeTools = (n: number, offset: number) =>
            Array.from({ length: n }, (_, i) => ({
              name: `tool_${offset + i}`,
              description: `Fake tool ${offset + i} with a description long enough to cost bytes`,
              inputSchema: { type: "object", properties: { q: { type: "string", description: "query" } } },
            }))
          if (script.paginate && !msg.params?.cursor) {
            const page1 = makeTools(script.toolCounts?.[0] ?? 8, 0)
            setImmediate(() =>
              stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: page1, nextCursor: "page-2" } }) + "\n"),
            )
          } else {
            const page2 = script.paginate ? makeTools(script.toolCounts?.[1] ?? 6, script.toolCounts?.[0] ?? 8) : makeTools(script.toolCounts?.[0] ?? 14, 0)
            setImmediate(() =>
              stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: page2 } }) + "\n"),
            )
          }
        }
      },
    }
    ;(proc as unknown as { kill(signal?: string): void }).kill = () => {
      stdout.removeAllListeners()
    }
    setImmediate(() => {}) // keep the event loop honest
    return proc
  }
  return { impl, requests, spawnedFor }
}

const localServer = (name = "fake-mcp"): McpInfo => ({
  name,
  type: "local",
  where: "global",
  command: "node fake-server.js",
  commandArgv: ["node", "fake-server.js"],
  enabled: true,
})

describe("mcp-probe", () => {
  it("measures a single-page tools/list response (chars/4 over real bytes)", async () => {
    const fake = fakeSpawn({ toolCounts: [4] })
    const out = await probeMcpServers([localServer()], { timeoutMs: 1000, spawnImpl: fake.impl })
    expect(out).toHaveLength(1)
    expect(out[0].ok).toBe(true)
    expect(out[0].toolCount).toBe(4)
    expect(out[0].tokens).toBeGreaterThan(0)
    // protocol shape: initialize → initialized → tools/list
    const methods = fake.requests.map((r) => (JSON.parse(r) as { method?: string }).method)
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"])
  })

  it("follows nextCursor pagination — 14/14 tools, guards the 8/14 failure mode", async () => {
    const fake = fakeSpawn({ paginate: true, toolCounts: [8, 6] })
    const out = await probeMcpServers([localServer()], { timeoutMs: 1000, spawnImpl: fake.impl })
    expect(out[0].ok).toBe(true)
    expect(out[0].toolCount).toBe(14)
    // the paginated follow-up request carries the cursor
    const followUp = fake.requests.map((r) => JSON.parse(r) as { params?: { cursor?: string } }).find((r) => r.params?.cursor)
    expect(followUp?.params?.cursor).toBe("page-2")
  })

  it("times out a hung server and skips gracefully (INV-2)", async () => {
    const fake = fakeSpawn({ hang: true })
    const out = await probeMcpServers([localServer()], { timeoutMs: 50, spawnImpl: fake.impl })
    expect(out[0]).toMatchObject({ ok: false })
    expect(out[0].reason).toContain("timeout after 50ms")
  }, 5000)

  it("reports spawn errors as ok:false with a reason", async () => {
    const fake = fakeSpawn({ emitError: new Error("ENOENT: no such server") })
    const out = await probeMcpServers([localServer()], { timeoutMs: 1000, spawnImpl: fake.impl })
    expect(out[0].ok).toBe(false)
    expect(out[0].reason).toContain("ENOENT")
  })

  it("skips disabled servers without spawning (INV-2/INV-4)", async () => {
    const fake = fakeSpawn({})
    const out = await probeMcpServers([{ ...localServer("off"), enabled: false }], { timeoutMs: 1000, spawnImpl: fake.impl })
    expect(out[0]).toMatchObject({ name: "off", ok: false })
    expect(out[0].reason).toContain("disabled")
    expect(fake.spawnedFor).toHaveLength(0)
  })

  it("skips remote servers without spawning", async () => {
    const fake = fakeSpawn({})
    const out = await probeMcpServers(
      [{ name: "remote-thing", type: "remote", where: "global", url: "https://example.com/mcp", enabled: true }],
      { timeoutMs: 1000, spawnImpl: fake.impl },
    )
    expect(out[0].ok).toBe(false)
    expect(out[0].reason).toContain("remote")
    expect(fake.spawnedFor).toHaveLength(0)
  })

  it("never rejects — a throwing spawn degrades to a per-server failure row", async () => {
    const impl: ProbeOptions["spawnImpl"] = () => {
      throw new Error("boom")
    }
    const out = await probeMcpServers([localServer()], { timeoutMs: 1000, spawnImpl: impl })
    expect(out[0].ok).toBe(false)
    expect(out[0].reason).toContain("boom")
  })

  it("probes multiple servers and keeps every row present", async () => {
    const fake = fakeSpawn({ toolCounts: [3] })
    const out = await probeMcpServers([localServer("a"), { ...localServer("b"), enabled: false }], {
      timeoutMs: 1000,
      spawnImpl: fake.impl,
    })
    expect(out.map((m) => m.name)).toEqual(["a", "b"])
    expect(out[0].ok).toBe(true)
    expect(out[1].ok).toBe(false)
  })
})
