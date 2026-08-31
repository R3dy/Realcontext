import { describe, it, expect, beforeAll, afterAll } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { scanAll, scanRules, scanSkills } from "../src/scan.js"
import { attribute } from "../src/capture.js"
import { buildBreakdown, renderDetailed, renderStatusLine } from "../src/report.js"
import { estimateTokens, formatTokens } from "../src/tokens.js"

let tmp: string
let proj: string
let gcfg: string
let claude: string

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "realcontext-test-"))
  proj = path.join(tmp, "project")
  gcfg = path.join(tmp, "gcfg")
  claude = path.join(tmp, "claude")
  for (const d of [proj, gcfg, path.join(claude, "skills"), path.join(gcfg, "skills")]) {
    fs.mkdirSync(d, { recursive: true })
  }
  // rules files
  const agentsText = "You are a test agent. " + "rule ".repeat(400) // ~2000 chars
  fs.writeFileSync(path.join(proj, "AGENTS.md"), agentsText)
  fs.writeFileSync(path.join(gcfg, "AGENTS.md"), "global rules here\n")
  // skills: one with frontmatter, one without
  fs.mkdirSync(path.join(gcfg, "skills", "alpha"), { recursive: true })
  fs.writeFileSync(
    path.join(gcfg, "skills", "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: Does alpha things very well\n---\n# Alpha\n" + "body ".repeat(200),
  )
  fs.mkdirSync(path.join(claude, "skills", "beta"), { recursive: true })
  fs.writeFileSync(path.join(claude, "skills", "beta", "SKILL.md"), "no frontmatter here\n")
  // global config with mcp + plugins
  fs.writeFileSync(
    path.join(gcfg, "opencode.json"),
    JSON.stringify({
      plugin: ["some-plugin", "/abs/path/plugin.js"],
      mcp: {
        "codebase-memory": { type: "local", command: ["node", "server.js"] },
        "web-thing": { type: "remote", url: "https://example.com/mcp" },
        "off-thing": { type: "local", command: ["node", "other.js"], enabled: false },
      },
    }),
  )
})

afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {}
})

describe("tokens", () => {
  it("estimates chars/4 and handles empties", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("abcd")).toBe(1)
    expect(estimateTokens("abcde")).toBe(2)
  })
  it("formats", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(840)).toBe("840")
    expect(formatTokens(12400)).toBe("12.4k")
    expect(formatTokens(124000)).toBe("124k")
    expect(formatTokens(1_250_000)).toBe("1.25M")
  })
})

describe("scan", () => {
  const scan = () => scanAll({ projectDir: proj, globalConfigDir: gcfg, claudeDir: claude })

  it("finds rules chain nearest-first", () => {
    const rules = scanRules(proj, gcfg)
    expect(rules.map((r) => r.label)).toEqual([
      "AGENTS.md (project)",
      "AGENTS.md (global)",
    ])
    expect(rules[0].tokens).toBeGreaterThan(400)
  })

  it("finds skills in both global-opencode and .claude roots", () => {
    const skills = scanSkills(proj, gcfg, claude)
    const names = skills.map((s) => s.name).sort()
    expect(names).toEqual(["alpha", "beta"])
    expect(skills.find((s) => s.name === "alpha")?.description).toBe("Does alpha things very well")
    expect(skills.find((s) => s.name === "alpha")!.bodyTokens).toBeGreaterThan(100)
  })

  it("finds mcps and plugins with enabled flags", () => {
    const s = scan()
    expect(s.mcps.map((m) => m.name).sort()).toEqual(["codebase-memory", "off-thing", "web-thing"])
    expect(s.mcps.find((m) => m.name === "web-thing")?.type).toBe("remote")
    // enabled flag parsing (issue #1): absent → true, explicit false → false
    expect(s.mcps.find((m) => m.name === "codebase-memory")?.enabled).toBe(true)
    expect(s.mcps.find((m) => m.name === "off-thing")?.enabled).toBe(false)
    expect(s.mcps.find((m) => m.name === "codebase-memory")?.commandArgv).toEqual(["node", "server.js"])
    expect(s.plugins).toContain("/abs/path/plugin.js")
  })

  it("survives missing dirs", () => {
    const s = scanAll({ projectDir: path.join(tmp, "nope"), globalConfigDir: path.join(tmp, "nada"), claudeDir: path.join(tmp, "nix") })
    expect(s.rules).toEqual([])
    expect(s.skills).toEqual([])
    expect(s.mcps).toEqual([])
  })
})

describe("attribution", () => {
  it("fingerprint-attributes rules + skill metadata into captured prompt", () => {
    const scan = scanAll({ projectDir: proj, globalConfigDir: gcfg, claudeDir: claude })
    const agentsText = fs.readFileSync(path.join(proj, "AGENTS.md"), "utf8")
    const system = [
      "You are OpenCode, a coding agent... (core prompt chunk)",
      agentsText,
      "Available skills:\nalpha: Does alpha things very well",
    ]
    const attr = attribute({ ts: "t", sessionID: "s", system }, scan)
    expect(attr.rulesAttributed.map((r) => r.label)).toEqual(["AGENTS.md (project)"])
    expect(attr.rulesAttributed[0].measured).toBe(true)
    expect(attr.skillsAttributed.map((s) => s.label)).toEqual(["skill:alpha"])
    expect(attr.coreTokens).toBeGreaterThan(0)
    expect(attr.totalTokens).toBeGreaterThan(attr.coreTokens)
  })
})

describe("report", () => {
  it("builds estimated-only breakdown without usage", () => {
    const scan = scanAll({ projectDir: proj, globalConfigDir: gcfg, claudeDir: claude })
    const bd = buildBreakdown({ scan, capture: null, usage: null, config: {}, model: "test-model" })
    expect(bd.totalSource).toBe("estimated")
    const ids = bd.components.map((c) => c.id)
    expect(ids).toContain("system")
    expect(ids).toContain("rules")
    expect(ids).toContain("skills")
    expect(ids).toContain("mcp")
    expect(ids).toContain("plugins")
    expect(bd.components.find((c) => c.id === "rules")!.tokens).toBeGreaterThan(0)
    const text = renderDetailed(bd)
    expect(text).toContain("realcontext — context breakdown (estimated)")
    expect(text).toContain("skill:alpha")
    expect(renderStatusLine(bd)).toMatch(/^\[realcontext\]/)
  })

  // Regression for issue #1 (the 31.6k-vs-29.6k live repro, encoded hermetically):
  // un-invoked skill bodies must be DISPLAYED but EXCLUDED from the estimated total.
  it("estimated total excludes un-invoked skill bodies (issue #1 regression)", () => {
    const scan = scanAll({ projectDir: proj, globalConfigDir: gcfg, claudeDir: claude })
    const bd = buildBreakdown({ scan, capture: null, usage: null, config: {}, model: "test-model" })
    const skills = bd.components.find((c) => c.id === "skills")!
    const bodies = skills.items.find((i) => i.label.includes("not in total"))
    expect(bodies).toBeDefined()
    expect(bodies!.tokens).toBeGreaterThan(0)
    // resident total = metadata only — strictly smaller than the displayed bodies figure
    expect(skills.tokens).toBeLessThan(bodies!.tokens)
    expect(skills.tokens).toBe(
      skills.items.filter((i) => !i.label.includes("not in total")).reduce((a, i) => a + i.tokens, 0),
    )
    // and the printed total is the sum of RESIDENT component tokens only
    const sumComponents = bd.components.reduce((a, c) => a + c.tokens, 0)
    expect(bd.totalTokens).toBe(sumComponents)
  })

  // Issue #1 (DRIFT-3 / INV-3): usage-null renders explicit not-measurable rows —
  // component ids stay present so renderStatusLine keeps resolving (AC6).
  it("renders explicit not-measurable conversation/tools rows when usage is null", () => {
    const scan = scanAll({ projectDir: proj, globalConfigDir: gcfg, claudeDir: claude })
    const bd = buildBreakdown({ scan, capture: null, usage: null, config: {}, model: "test-model" })
    const conv = bd.components.find((c) => c.id === "conversation")!
    const tools = bd.components.find((c) => c.id === "tools")!
    expect(conv.tokens).toBe(0)
    expect(tools.tokens).toBe(0)
    expect(conv.items[0].label).toContain("not measurable this capture")
    expect(tools.items[0].label).toContain("not measurable this capture")
    const text = renderDetailed(bd)
    expect(text).toContain("not measurable this capture")
    expect(text).toContain("total covers attributed system-side only")
    // AC6: statusline still resolves every id (conversation/tools render 0.0k, no crash)
    const line = renderStatusLine(bd)
    expect(line).toContain("conv 0.0k")
  })

  it("builds measured breakdown with usage (residual split, floors at 0)", () => {
    const scan = scanAll({ projectDir: proj, globalConfigDir: gcfg, claudeDir: claude })
    const usage = { inputTokens: 50_000, cacheRead: 0, cacheWrite: 0, outputTokens: 100 }
    const bd = buildBreakdown({ scan, capture: null, usage, config: { contextLimit: 200_000 } })
    expect(bd.totalSource).toBe("measured")
    expect(bd.totalTokens).toBe(50_000)
    const conv = bd.components.find((c) => c.id === "conversation")!
    const tools = bd.components.find((c) => c.id === "tools")!
    expect(conv.tokens + tools.tokens).toBeLessThanOrEqual(50_000)
    expect(conv.tokens).toBeGreaterThan(0)
    // renderers safe
    expect(renderDetailed(bd)).toContain("usage: input 50000")
  })

  // Issue #1 Story 2: measured MCP rows via injected mcpMeasurements —
  // buildBreakdown stays synchronous (these calls are unwawaited by design).
  it("renders measured MCP rows from injected mcpMeasurements", () => {
    const scan = scanAll({ projectDir: proj, globalConfigDir: gcfg, claudeDir: claude })
    const usage = { inputTokens: 50_000, cacheRead: 0, cacheWrite: 0, outputTokens: 100 }
    const bd = buildBreakdown({
      scan,
      capture: null,
      usage,
      config: {},
      mcpMeasurements: [
        { name: "codebase-memory", ok: true, toolCount: 2, tokens: 500 },
        { name: "web-thing", ok: false, reason: "remote — not probed" },
        { name: "off-thing", ok: false, reason: "disabled — not probed" },
      ],
    })
    const mcp = bd.components.find((c) => c.id === "mcp")!
    expect(mcp.tokens).toBe(500)
    expect(mcp.measured).toBe(true)
    const okRow = mcp.items.find((i) => i.label === "codebase-memory")!
    expect(okRow.measured).toBe(true)
    expect(okRow.note).toContain("2 tools")
    // honest labels for the not-measured and disabled rows
    expect(mcp.items.find((i) => i.label === "web-thing")!.note).toContain("remote — not probed")
    expect(mcp.items.find((i) => i.label === "off-thing")!.note).toContain("disabled")
    // measured MCP counts against the measured total: residual + mcp fits
    const conv = bd.components.find((c) => c.id === "conversation")!
    const tools = bd.components.find((c) => c.id === "tools")!
    expect(conv.tokens + tools.tokens + mcp.tokens).toBeLessThanOrEqual(50_000)
  })

  it("renders honest not-measured MCP rows without measurements (no silent zero)", () => {
    const scan = scanAll({ projectDir: proj, globalConfigDir: gcfg, claudeDir: claude })
    const bd = buildBreakdown({ scan, capture: null, usage: null, config: {} })
    const mcp = bd.components.find((c) => c.id === "mcp")!
    expect(mcp.tokens).toBe(0)
    expect(mcp.measured).toBe(false)
    const enabledRow = mcp.items.find((i) => i.label === "codebase-memory")!
    expect(enabledRow.note).toContain("not measured this run")
    // disabled row is a real zero, honestly labeled
    expect(mcp.items.find((i) => i.label === "off-thing")!.note).toContain("disabled — 0 in context")
  })
})
