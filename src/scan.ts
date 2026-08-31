/**
 * Disk scanner — discovers everything on disk that contributes to an OpenCode
 * session's context: rules files (AGENTS.md/CLAUDE.md chain), skills, MCP
 * servers, plugins. Injectable paths so tests can use fixture trees.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { estimateTokens, type ItemDetail } from "./tokens.js"

export interface SkillInfo {
  name: string
  path: string
  description: string
  /** est tokens of the name+description metadata line that sits in the prompt */
  metaTokens: number
  /** est tokens of the SKILL.md body, loaded only on invoke */
  bodyTokens: number
}

export interface McpInfo {
  name: string
  type: "local" | "remote"
  where: "global" | "project"
  command?: string
  /** raw argv for spawning (probe) — kept separate from the display string */
  commandArgv?: string[]
  url?: string
  /** config `enabled` flag — absent means enabled */
  enabled: boolean
}

export interface ScanResult {
  projectDir: string
  globalConfigDir: string
  rules: ItemDetail[]
  skills: SkillInfo[]
  mcps: McpInfo[]
  plugins: string[]
}

function readTextSafe(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8")
  } catch {
    return null
  }
}

function readJsonSafe(p: string): Record<string, unknown> | null {
  const raw = readTextSafe(p)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function existsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** Global + project + ancestor AGENTS.md/CLAUDE.md, nearest-to-project first. */
export function scanRules(projectDir: string, globalConfigDir: string): ItemDetail[] {
  const out: ItemDetail[] = []
  const seen = new Set<string>()
  const consider = (p: string, label: string) => {
    const real = p
    if (seen.has(real) || !existsFile(real)) return
    seen.add(real)
    const text = readTextSafe(real) ?? ""
    if (!text.trim()) return
    out.push({
      label,
      path: real,
      tokens: estimateTokens(text),
      measured: false,
      note: "estimate from disk bytes (chars/4)",
    })
  }
  // nearest-first: walk up from projectDir (max 6 levels, stop at home)
  const home = globalConfigDir.replace(/\/\.config\/opencode$/, "") || "/"
  let dir = path.resolve(projectDir)
  const chain: string[] = []
  for (let i = 0; i < 6 && dir && dir !== home && dir !== "/"; i++) {
    chain.unshift(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const d of chain) {
    consider(path.join(d, "AGENTS.md"), `AGENTS.md (${d === path.resolve(projectDir) ? "project" : "parent"})`)
    consider(path.join(d, "CLAUDE.md"), `CLAUDE.md (${d === path.resolve(projectDir) ? "project" : "parent"})`)
  }
  consider(path.join(globalConfigDir, "AGENTS.md"), "AGENTS.md (global)")
  consider(path.join(globalConfigDir, "CLAUDE.md"), "CLAUDE.md (global)")
  return out
}

function parseFrontmatter(text: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { body: text }
  const fm = m[1]
  const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim()
  const description = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim()
  return { name, description, body: text.slice(m[0].length) }
}

/** All candidate skill roots: singular + plural, global + project, plus ~/.claude/skills. */
export function skillRoots(projectDir: string, globalConfigDir: string, claudeDir: string): string[] {
  return [
    path.join(globalConfigDir, "skill"),
    path.join(globalConfigDir, "skills"),
    path.join(projectDir, ".opencode", "skill"),
    path.join(projectDir, ".opencode", "skills"),
    path.join(claudeDir, "skills"),
  ]
}

export function scanSkills(projectDir: string, globalConfigDir: string, claudeDir: string): SkillInfo[] {
  const out: SkillInfo[] = []
  const seen = new Set<string>()
  for (const root of skillRoots(projectDir, globalConfigDir, claudeDir)) {
    let entries: string[] = []
    try {
      entries = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      const skillMd = path.join(root, entry, "SKILL.md")
      if (seen.has(skillMd) || !existsFile(skillMd)) continue
      seen.add(skillMd)
      const text = readTextSafe(skillMd) ?? ""
      const { name, description, body } = parseFrontmatter(text)
      const displayName = name || entry
      const desc = description || ""
      out.push({
        name: displayName,
        path: skillMd,
        description: desc,
        metaTokens: estimateTokens(`${displayName}: ${desc}`),
        bodyTokens: estimateTokens(text),
      })
    }
  }
  return out.sort((a, b) => b.metaTokens - a.metaTokens)
}

export function scanMcps(projectDir: string, globalConfigDir: string): McpInfo[] {
  const out: McpInfo[] = []
  for (const [where, file] of [
    ["global", path.join(globalConfigDir, "opencode.json")] as const,
    ["project", path.join(projectDir, "opencode.json")] as const,
    ["project", path.join(projectDir, "opencode.jsonc")] as const,
  ]) {
    const cfg = readJsonSafe(file)
    if (!cfg) continue
    const mcps = cfg.mcp
    if (typeof mcps !== "object" || mcps === null) continue
    for (const [name, raw] of Object.entries(mcps as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null) continue
      const m = raw as Record<string, unknown>
      const type = m.type === "remote" ? "remote" : "local"
      out.push({
        name,
        type,
        where,
        command: typeof m.command === "string" ? m.command : Array.isArray(m.command) ? m.command.join(" ") : undefined,
        commandArgv: Array.isArray(m.command) ? m.command.map(String) : typeof m.command === "string" ? m.command.split(/\s+/).filter(Boolean) : undefined,
        url: typeof m.url === "string" ? m.url : undefined,
        enabled: m.enabled !== false,
      })
    }
  }
  return out
}

export function scanPlugins(projectDir: string, globalConfigDir: string): string[] {
  const out: string[] = []
  for (const file of [path.join(globalConfigDir, "opencode.json"), path.join(projectDir, "opencode.json")]) {
    const cfg = readJsonSafe(file)
    if (!cfg) continue
    if (Array.isArray(cfg.plugin)) for (const p of cfg.plugin) if (typeof p === "string") out.push(p)
  }
  return out
}

export function scanAll(opts: {
  projectDir: string
  globalConfigDir: string
  claudeDir: string
}): ScanResult {
  return {
    projectDir: opts.projectDir,
    globalConfigDir: opts.globalConfigDir,
    rules: scanRules(opts.projectDir, opts.globalConfigDir),
    skills: scanSkills(opts.projectDir, opts.globalConfigDir, opts.claudeDir),
    mcps: scanMcps(opts.projectDir, opts.globalConfigDir),
    plugins: scanPlugins(opts.projectDir, opts.globalConfigDir),
  }
}

/** Default paths for the real box. */
export function defaultPaths(projectDir?: string) {
  const home = process.env.HOME || "/"
  return {
    projectDir: projectDir || process.cwd(),
    globalConfigDir: path.join(home, ".config", "opencode"),
    claudeDir: path.join(home, ".claude"),
  }
}
