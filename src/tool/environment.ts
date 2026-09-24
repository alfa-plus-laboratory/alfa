/**
 * When the model checks what this version can do, it reads facts from the host — it must
 * not guess config paths with ls, or pass off another agent's switches as ours.
 */
import { z } from "zod"
import type { ToolDef } from "./types.ts"
export const EnvironmentTool: ToolDef<Record<string, never>> = {
  id: "environment",
  description: "Report this run's actual sandbox backend, permission mode, authorized paths, writable temporary directory, SSH capability and supported configuration controls. Call before answering questions about current runtime permissions or diagnosing a local execution restriction; grants can change during the session. Tool approval does not grant filesystem paths or disable the OS sandbox. This does not probe network connectivity or expose credentials.",
  parameters: z.object({}),
  async execute(_args, ctx) {
    await ctx.ask({ permission: "environment", patterns: ["*"] })
    const state = ctx.runtime?.()
    return { output: state ? JSON.stringify(state, null, 2) : "Runtime reporting is unavailable in this host. Do not guess settings or sandbox controls.", metadata: { truncated: false, available: !!state } }
  },
}
