/**
 * System-prompt capture + fingerprint attribution.
 *
 * The `experimental.chat.system.transform` hook hands us the full assembled
 * system prompt as string[]. We persist it, then attribute its bytes to known
 * sources (rules files, skill metadata) via normalized-substring matching.
 * What doesn't match a known source is "opencode core system prompt".
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { estimateTokens, type ItemDetail } from "./tokens.js"
import type { ScanResult } from "./scan.js"

export interface Capture {
  ts: string
  sessionID: string
  /** each element is one assembled chunk of the system prompt */
  system: string[]
}

function cacheDir(): string {
  const dir = process.env.REALCONTEXT_CACHE_DIR || path.join(process.env.HOME || "/", ".cache", "realcontext")
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* best effort */
  }
  return dir
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "unknown"
}

function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, file)
  } catch {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

export function captureSystem(sessionID: string, system: string[]): Capture | null {
  if (!Array.isArray(system) || system.length === 0) return null
  const cap: Capture = { ts: new Date().toISOString(), sessionID: sessionID || "unknown", system }
  const file = path.join(cacheDir(), `capture-${sanitize(cap.sessionID)}.json`)
  atomicWrite(file, JSON.stringify(cap))
  pruneCaptures()
  return cap
}

function pruneCaptures(keep = 5): void {
  try {
    const files = fs
      .readdirSync(cacheDir())
      .filter((f) => f.startsWith("capture-") && f.endsWith(".json"))
      .map((f) => ({ f, m: fs.statSync(path.join(cacheDir(), f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
    for (const old of files.slice(keep)) fs.unlinkSync(path.join(cacheDir(), old.f))
  } catch {
    /* best effort */
  }
}

export function latestCapture(): Capture | null {
  try {
    const files = fs
      .readdirSync(cacheDir())
      .filter((f) => f.startsWith("capture-") && f.endsWith(".json"))
      .map((f) => ({ f, m: fs.statSync(path.join(cacheDir(), f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
    if (files.length === 0) return null
    const raw = fs.readFileSync(path.join(cacheDir(), files[0].f), "utf8")
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed.system) || parsed.system.length === 0) return null
    return parsed as Capture
  } catch {
    return null
  }
}

export function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim()
}

export interface Attribution {
  /** rules files found verbatim inside the captured prompt */
  rulesAttributed: ItemDetail[]
  /** skill metadata lines found inside the captured prompt */
  skillsAttributed: ItemDetail[]
  /** everything else in the captured prompt, in est tokens */
  coreTokens: number
  /** total est tokens of the captured prompt (measured bytes) */
  totalTokens: number
}

/**
 * Attribute captured system-prompt bytes to known sources.
 * The prompt's own byte size is real (measured); per-source attribution is
 * fingerprinted; the remainder is the opencode core prompt.
 */
export function attribute(capture: Capture, scan: ScanResult): Attribution {
  const haystack = normalize(capture.system.join("\n"))
  const rulesAttributed: ItemDetail[] = []
  const skillsAttributed: ItemDetail[] = []
  let attributedChars = 0

  for (const rule of scan.rules) {
    if (!rule.path) continue
    let text: string | null = null
    try {
      text = fs.readFileSync(rule.path, "utf8")
    } catch {
      continue
    }
    const norm = normalize(text)
    if (norm.length > 40 && haystack.includes(norm)) {
      rulesAttributed.push({ ...rule, measured: true, note: "fingerprinted in captured system prompt" })
      attributedChars += text.length
    }
  }

  for (const skill of scan.skills) {
    const metaLine = `${skill.name}: ${skill.description}`
    const norm = normalize(metaLine)
    if (skill.description && norm.length > 20 && haystack.includes(norm)) {
      skillsAttributed.push({
        label: `skill:${skill.name}`,
        path: skill.path,
        tokens: skill.metaTokens,
        measured: true,
        note: "name+description fingerprinted in captured prompt",
      })
      attributedChars += metaLine.length
    }
  }

  const totalChars = capture.system.reduce((acc, s) => acc + (s?.length ?? 0), 0)
  const coreChars = Math.max(0, totalChars - attributedChars)
  return {
    rulesAttributed,
    skillsAttributed,
    coreTokens: estimateTokens("x".repeat(coreChars)),
    totalTokens: estimateTokens("x".repeat(totalChars)),
  }
}
