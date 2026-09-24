/**
 * SSH is a controlled host capability, not "turning off bash's sandbox". ★ argv does not
 * pass through a local shell; it can only invoke system OpenSSH, an existing alias and one
 * explicit remote command. The user can approve per host for this session; auto mode, as
 * the user chose, executes directly with no extra SSH confirmation. The config may contain
 * ProxyCommand / Match exec, and the authorization must state plainly that they will run.
 * No copying private keys, no disabling host verification, no agent forwarding;
 * credentials are for OpenSSH's use only.
 */
import type { SshHostAccess } from "./ssh-access.ts"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { buildChildEnv } from "../env/whitelist.ts"
import type { PromptFn } from "../permission/gate.ts"
import { killGroup } from "../tool/bash/kill.ts"
import { streamDecoder } from "../util/decode.ts"
import { redact } from "../util/redact.ts"

export interface SshRequest { host: string; action: "inspect" | "run"; command?: string; timeout?: number }
export interface SshResult { output: string; metadata: { truncated: boolean } & Record<string, unknown> }
const MAX_OUTPUT = 64 * 1024
export function sshArgs(input: SshRequest): string[] {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/.test(input.host)) throw new Error("Use a configured SSH alias or hostname, without options, user@ or shell syntax.")
  if (input.action !== "inspect" && input.action !== "run") throw new Error("SSH action must be inspect or run.")
  if (input.action === "run" && !input.command?.trim()) throw new Error("SSH run requires an explicit remote command; use 'true' for a connection test.")
  if (input.command?.includes("\0")) throw new Error("SSH command contains a NUL byte.")
  const options = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "PermitLocalCommand=no", "-o", "ClearAllForwardings=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2"]
  return [...options, ...(input.action === "inspect" ? ["-G"] : ["-T"]), input.host, ...(input.action === "run" ? [input.command!] : [])]
}

/**
 * Show only the parsed results needed for diagnosis; never dump ProxyCommand, the
 * environment or the full config to the model.
 */
export function inspectSshConfig(output: string, host: string): string {
  const safe = new Set(["hostname", "user", "port", "proxyjump", "identityfile", "identitiesonly", "batchmode", "stricthostkeychecking", "forwardagent", "userknownhostsfile"])
  const lines = output.split("\n").filter(line => safe.has(line.split(/\s+/)[0] ?? ""))
  const hostname = lines.find(line => line.startsWith("hostname "))?.slice(9).trim()
  lines.push("", hostname === host
    ? "Hostname is unchanged. A matching HostName override was not established; this can be valid for a DNS hostname. Do not claim an alias expanded or infer network failure."
    : "Configuration evaluated only. No SSH connection, authentication or remote command has been verified.")
  return redact(lines.join("\n"))
}

export async function runSsh(input: SshRequest, deps: {
  prompt: PromptFn
  access?: SshHostAccess
  auto?(): boolean
  signal: AbortSignal
  cwd: string
  owner?: string
  onProgress(text: string): void
  /**
   * Tests inject a real child-process fixture; production uses only the system path and
   * never takes the executable from the model or PATH.
   */
  executable?: string
}): Promise<SshResult> {
  const args = sshArgs(input)
  const executable = deps.executable ?? (process.platform === "win32" ? undefined : "/usr/bin/ssh")
  if (!executable || !existsSync(executable)) throw new Error("System OpenSSH is unavailable. This host does not provide the SSH broker.")
  if (deps.signal.aborted) throw new Error("SSH cancelled before approval.")
  const request: Parameters<PromptFn>[0] = {
    permission: "ssh.host", patterns: [input.host], alwaysPatterns: [], forbidAlways: true, allowSession: true, signal: deps.signal,
    reasons: ["Runs host OpenSSH outside the shell filesystem sandbox, using existing SSH config, keys and agent. Configured ProxyCommand / Match exec helpers may run locally. Choose once for this call, or session to allow subsequent configuration inspections and remote commands to this exact host alias, including subagents, until the conversation changes or alfa exits. Revoke with /ssh revoke HOST. Private keys are not copied into model context."],
    metadata: { command: input.action === "inspect" ? `Inspect SSH configuration for ${input.host}` : `SSH host: ${input.host}\nRemote command:\n${input.command}`, ...(deps.owner ? { job: deps.owner } : {}) },
  }
  const decision = deps.access ? await deps.access.authorize(request, deps.prompt, deps.auto) : deps.auto?.() ? "once" : await deps.prompt(request)
  if (decision === "reject" || deps.signal.aborted) throw new Error("SSH authorization rejected or cancelled. No SSH process was started.")
  const { env } = buildChildEnv(process.env, process.platform, deps.auto?.())
  if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK
  const child = spawn(executable, args, { cwd: deps.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true })
  let stdout = "", stderr = "", truncated = false
  const stdoutDecode = streamDecoder(), stderrDecode = streamDecoder()
  const append = (previous: string, text: string) => {
    const value = previous + text
    if (value.length > MAX_OUTPUT) truncated = true
    return value.slice(-MAX_OUTPUT)
  }
  child.stdout!.on("data", data => { stdout = append(stdout, stdoutDecode(data)); if (input.action === "run") deps.onProgress(redact(stdout + stderr)) })
  child.stderr!.on("data", data => { stderr = append(stderr, stderrDecode(data)); if (input.action === "run") deps.onProgress(redact(stdout + stderr)) })
  const result = await new Promise<{ exit: number | null; failure?: string }>(resolve => {
    let settled = false
    const finish = (value: { exit: number | null; failure?: string }) => {
      if (settled) return
      settled = true; clearTimeout(timer); deps.signal.removeEventListener("abort", abort); resolve(value)
    }
    const abort = () => finish({ exit: null, failure: "cancelled" })
    const timeout = Number.isFinite(input.timeout) ? Math.max(1, Math.min(input.timeout!, 120_000)) : 30_000
    const timer = setTimeout(() => finish({ exit: null, failure: "timeout" }), timeout)
    child.once("error", error => finish({ exit: null, failure: `spawn failed: ${error.message}` }))
    child.once("close", (exit, signal) => finish({ exit, ...(signal ? { failure: `signal ${signal}` } : {}) }))
    deps.signal.addEventListener("abort", abort, { once: true })
    if (deps.signal.aborted) abort()
  })
  if (result.failure) await killGroup(child)
  const body = input.action === "inspect" && result.exit === 0 ? inspectSshConfig(stdout, input.host) : redact(stdout + stderr)
  const outcome = result.failure ?? (result.exit === 0 ? input.action === "inspect" ? "configuration evaluated" : "remote command completed" : "ssh failed; use the error below, do not infer DNS/sandbox/remote-service cause without evidence")
  return {
    output: `${outcome}\n${body}${truncated ? "\nOutput truncated to the last 64 KiB per stream." : ""}`,
    metadata: { exit: result.exit, host: input.host, action: input.action, execution: "host-openssh", outcome, truncated, displayOutput: body },
  }
}
