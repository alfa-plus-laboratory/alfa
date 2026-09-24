/**
 * Runtime facts are taken only from the execution layer. ★ The model's environment block
 * and the environment tool share one snapshot; neither may guess on its own whether the
 * sandbox is on. No network connectivity probing here: "policy allows" is not "target
 * reachable". Controls include executable syntax: naming only a command family leaves
 * its argument order unspecified, and live evaluations exposed invented grant arguments.
 */
import { existsSync } from "node:fs"
import type { AccessManager } from "./access.ts"
import { bwrapBlocked, sandboxStatus } from "./sandbox.ts"
import { configPath } from "../config/config.ts"
import { authPath } from "../config/auth.ts"
import type { PermissionMode } from "../permission/mode.ts"

export interface RuntimeSnapshot {
  sandbox: ReturnType<typeof sandboxStatus>
  shellExecution: "sandboxed" | "blocked" | "host"
  permissionMode: PermissionMode
  unrestricted: boolean
  sandboxPreference: boolean
  workspaceRoot: string
  grants: ReturnType<AccessManager["list"]>
  temporaryDirectory: string
  network: string
  shellCredentials: string
  /** Approved host aliases for this session, not an inventory of configured aliases. */
  sshHosts: string[]
  ssh: string
  configFile: string
  authFile: string
  controls: string[]
}
export function runtimeSnapshot(access: AccessManager, mode: PermissionMode, sshHosts: string[] = []): RuntimeSnapshot {
  const sandbox = sandboxStatus(access)
  return {
    sandbox, shellExecution: sandbox === "off" ? "host" : sandbox === "unavailable" ? "blocked" : "sandboxed", permissionMode: mode,
    unrestricted: access.unrestricted, sandboxPreference: access.sandboxEnabled,
    workspaceRoot: access.root,
    grants: access.list().sort((a, b) => a.path.localeCompare(b.path) || a.mode.localeCompare(b.mode)),
    temporaryDirectory: access.scratch(),
    network: access.unrestricted ? "Host network access; network operations still go to the auto classifier. Connectivity and DNS health still require evidence." : "OS shell policy does not isolate the network. Tool approvals still apply; connectivity and DNS health are unknown until tested.",
    shellCredentials: (access.unrestricted ? "Auto: the shell inherits the host environment; file tools can reach account-level paths, and the first file-tool read outside the workspace asks the user. OS account permissions still apply. " : "") + (sandbox === "off" ? "Shell runs with host filesystem access. Environment filtering and file-tool authorization remain separate; SSH_AUTH_SOCK is not passed by default." : sandbox === "unavailable" ? `Shell execution is blocked because ${bwrapBlocked() ? `bubblewrap is installed but cannot run here (${bwrapBlocked()}); on Ubuntu 23.10+ AppArmor restricts unprivileged user namespaces, see alfa-permissions` : "no supported OS sandbox backend is available"}. File tools have a separate path policy; their success does not establish shell access.` : "The OS sandbox applies in every permission mode: the shell reaches only the workspace, the session temp directory and /access grants, and cannot read ~/.ssh (including config and known_hosts). SSH_AUTH_SOCK is not passed by default. File tools have a separate path policy. Never infer shell visibility from a successful file-tool read."),
    sshHosts: [...sshHosts].sort(),
    ssh: process.platform === "win32" || !existsSync("/usr/bin/ssh") ? "System OpenSSH broker unavailable on this host." : "sshHosts lists hosts already authorized in this session, not all configured SSH aliases. An empty list does not mean no SSH aliases are configured. Use the ssh tool for existing aliases and authenticated remote commands. It invokes host OpenSSH with once or conversation-scoped host approval in default/confirm mode; auto mode silently gates major risks and returns blocks to the agent as tool errors; /ssh lists grants and /ssh revoke HOST|all revokes them; it does not expose private key contents. Ordinary bash follows the reported sandbox setting.",
    configFile: configPath(), authFile: authPath(),
    controls: ["/permission auto runs reads and workspace edits directly and sends everything else, including project scripts and edits to protected paths, to a silent risk classifier; deny rules, the saved sandbox setting and the first-outside-read question still apply, and after repeated blocks the user decides. default/confirm restore scoped rules", "/trust on|off|check controls project instructions, not the OS sandbox", "/access lists path grants; /access add read|write session|persistent /absolute/directory adds a recursive directory grant; /access revoke /absolute/path|all revokes grants. File-tool approvals can grant a single exact file. There is no --recursive flag.", "/settings manages configuration", "/settings → OS sandbox (experimental) controls OS shell isolation and persists across restarts; it is off by default because platform support is incomplete. It applies in every permission mode, auto included. No --no-sandbox, --sandbox=off, --dangerously-skip-permissions, ALFA_SANDBOX or sandbox.enabled setting is supported."],
  }
}
