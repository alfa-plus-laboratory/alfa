/**
 * Existing SSH aliases go through the host broker; the tool reads no private keys and
 * splices no local shell command, and jump-host helpers in the local config fall within
 * the host's authorization.
 */
import { z } from "zod"
import type { ToolDef } from "./types.ts"
const Parameters = z.object({
  host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/).describe("Existing SSH alias or hostname, e.g. pc1. No user@ or options."),
  action: z.enum(["inspect", "run"]),
  command: z.string().optional().describe("Explicit remote command for run; use true for a minimal connection test."),
  timeout: z.number().int().min(1).max(120_000).optional(),
})
export const SshTool: ToolDef<z.infer<typeof Parameters>> = {
  id: "ssh", parameters: Parameters, outputSource: "command",
  description: "Use existing SSH configuration, ProxyJump and host authentication through an explicitly approved host OpenSSH invocation. Start with inspect for a user's host alias, then run with remote command 'true' to test connectivity/authentication. No local shell interpolation, arbitrary SSH flags, interactive terminal, private-key reads or agent forwarding. Auto mode uses a silent risk gate; blocked operations return a tool error, not a user approval dialog; default/confirm mode asks for first access to a host. Choose once or authorize this exact host alias for the current conversation; session grants cover subsequent commands and subagents. /ssh lists grants; /ssh revoke HOST|all revokes them. Config inspection is not a connection test. When the OS sandbox is enabled, ordinary bash cannot read ~/.ssh. Prefer this over subnet scans; do not bypass a configured jump host or invent sandbox-off flags.",
  async execute(args, ctx) {
    if (!ctx.ssh) throw new Error("SSH broker is unavailable in this host. Do not bypass the sandbox with bash or invent a disable flag.")
    return ctx.ssh(args, ctx.abortSignal, ctx.onProgress)
  },
}
