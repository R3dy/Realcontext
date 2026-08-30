/**
 * realcontext — OpenCode plugin entry.
 *
 * Surfaces:
 *  - `experimental.chat.system.transform` → captures the full assembled system
 *    prompt (measured ground truth) and fingerprint-attributes it later.
 *  - `event` (session.idle / message.*) → refreshes the status file
 *    (~/.cache/realcontext/status.txt) + terminal title (tmux-friendly status bar).
 *  - `context_report` custom tool → interactive granular breakdown (/context).
 *
 * Every hook is defensively wrapped: this plugin must never break the host.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { scanAll, defaultPaths } from "./scan.js"
import { captureSystem, latestCapture } from "./capture.js"
import { loadConfig, readUsage } from "./usage.js"
import { buildBreakdown, renderDetailed, renderStatusLine } from "./report.js"

export const RealcontextPlugin: Plugin = async ({ $, directory }) => {
  const paths = defaultPaths(directory)
  const cfg = loadConfig(paths.globalConfigDir)
  let lastSessionID: string | null = null

  const buildNow = async (sessionID: string | null) => {
    const scan = scanAll(paths)
    const capture = latestCapture()
    const sc = sessionID ? await readUsage(sessionID) : null
    return buildBreakdown({
      scan,
      capture,
      usage: sc?.usage ?? null,
      config: cfg,
      model: sc?.model,
    })
  }

  const writeStatus = async (sessionID: string | null) => {
    try {
      const bd = await buildNow(sessionID)
      const line = renderStatusLine(bd)
      if (cfg.statusFile !== false) {
        const fs = await import("node:fs")
        const path = await import("node:path")
        const dir = process.env.REALCONTEXT_CACHE_DIR || path.join(process.env.HOME || "/", ".cache", "realcontext")
        try {
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(path.join(dir, "status.txt"), line + "\n")
          fs.writeFileSync(
            path.join(dir, "usage.json"),
            JSON.stringify({ sessionID, usage: bd.usage, ts: new Date().toISOString() }),
          )
        } catch {
          /* best effort */
        }
      }
      if (cfg.title !== false && $) {
        try {
          await $`printf '%b' ${"\u001b]2;" + line + "\u0007"}`
        } catch {
          /* best effort — no tty attached is normal */
        }
      }
    } catch {
      /* never break the host */
    }
  }

  return {
    "experimental.chat.system.transform": async (_input: unknown, output: { system?: string[] }) => {
      try {
        if (Array.isArray(output?.system) && output.system.length > 0) {
          captureSystem(lastSessionID ?? "current", output.system)
        }
      } catch {
        /* never break the host */
      }
    },

    event: async ({ event }: { event: { type?: string; properties?: Record<string, unknown> } }) => {
      try {
        const type = event?.type ?? ""
        const props = event?.properties ?? {}
        if (type === "session.created") {
          const info = (props.info ?? {}) as Record<string, unknown>
          if (typeof info.id === "string") lastSessionID = info.id
          return
        }
        const sid =
          (typeof props.sessionID === "string" && props.sessionID) ||
          ((props.info as Record<string, unknown> | undefined)?.id as string | undefined) ||
          lastSessionID
        if (typeof sid === "string" && sid) lastSessionID = sid
        if (type === "session.idle" || type === "message.updated" || type === "message.part.updated") {
          await writeStatus(lastSessionID)
        }
      } catch {
        /* never break the host */
      }
    },

    tool: {
      context_report: tool({
        description:
          "Show a complete breakdown of everything taking up context in this OpenCode session: system prompt, rules (AGENTS.md), skills, MCP servers, conversation, tool schemas. Use mode 'summary' for one line, 'detailed' (default) for the granular per-item table.",
        args: {
          mode: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const mode = (args?.mode || "detailed").toLowerCase()
          const sessionID =
            (context as { sessionID?: string } | undefined)?.sessionID ?? lastSessionID
          const bd = await buildNow(sessionID ?? null)
          if (mode === "summary") return renderStatusLine(bd)
          if (mode === "json") return JSON.stringify(bd, null, 2)
          return renderDetailed(bd)
        },
      }),
    },
  }
}

export default RealcontextPlugin
