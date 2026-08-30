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

  it("finds mcps and plugins", () => {
    const s = scan()
    expect(s.mcps.map((m) => m.name).sort()).toEqual(["codebase-memory", "web-thing"])
    expect(s.mcps.find((m) => m.name === "web-thing")?.type).toBe("remote")
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
})
