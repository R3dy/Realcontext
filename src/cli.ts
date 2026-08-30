/**
 * realcontext CLI — standalone, no opencode runtime required.
 *
 *   realcontext report [--json]     full breakdown (capture + disk scan; usage
 *                                   if the plugin has cached it this session)
 *   realcontext status              one-line status
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { scanAll, defaultPaths } from "./scan.js"
import { latestCapture } from "./capture.js"
import { loadConfig, readUsage } from "./usage.js"
import { buildBreakdown, renderDetailed, renderStatusLine, renderJson } from "./report.js"

/** measured usage for the most recently captured session, if any */
async function measuredContext(): Promise<{ usage: ReturnType<typeof Object> | null; model?: string } | null> {
  const cap = latestCapture()
  if (!cap?.sessionID || cap.sessionID === "current" || cap.sessionID === "unknown") return null
  const sc = await readUsage(cap.sessionID)
  return sc ? { usage: sc.usage, model: sc.model } : null
}

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2)
  const cmd = args[0] || "report"
  const paths = defaultPaths()
  const cfg = loadConfig(paths.globalConfigDir)
  const scan = scanAll(paths)
  const capture = latestCapture()
  const mc = cmd === "report" ? await measuredContext() : null
  const bd = buildBreakdown({ scan, capture, usage: mc?.usage ?? null, config: cfg, model: mc?.model })

  if (args.includes("--json") || cmd === "json") {
    process.stdout.write(renderJson(bd) + "\n")
    return 0
  }
  if (cmd === "status") {
    process.stdout.write(renderStatusLine(bd) + "\n")
    return 0
  }
  process.stdout.write(renderDetailed(bd) + "\n")
  return 0
}

// only auto-run when executed directly (not when imported by tests)
import { fileURLToPath } from "node:url"
const isMain =
  typeof process !== "undefined" &&
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`realcontext: ${err?.message ?? err}\n`)
      process.exit(1)
    },
  )
}
