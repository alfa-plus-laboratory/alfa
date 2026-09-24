/**
 * ★ Analyzing the command string is not isolation. Each spawn generates an OS policy from
 * the path ledger, and the child process inherits it.
 * When enabled and no backend is available, execution is refused — no automatic
 * downgrade; only an explicit user opt-out returns to the host shell (auto keeps the
 * setting). A backend is available only if it actually runs here; see bwrapBlocked.
 * MCP and trusted extensions are host code and fall outside this promise.
 * Linux mounts the runtime libraries and authorized directories onto an empty root; macOS
 * uses Seatbelt to deny file reads and writes by default. macOS ICU timezone data is
 * a read-only runtime dependency outside /System; denying it makes Bun/JSC SIGTRAP
 * before tests can execute. Grant its version-independent container, never all of /var.
 */
import { buildChildEnv } from "../env/whitelist.ts"
import { configDir, dataDir } from "../util/xdg.ts"
import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import type { Shell } from "../env/shell.ts"
import type { AccessManager, Grant } from "./access.ts"
import { canonicalPath, within } from "../fs/guard.ts"

const runtime = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/System", "/Library/Apple", "/opt/homebrew", "/private/var/db/dyld", "/private/var/db/timezone", "/private/etc/ssl", "/etc/ssl", "/etc/ld.so.cache", "/etc/resolv.conf", "/etc/hosts"]
/** Namespace and mount flags every bubblewrap run starts with; the probe uses the same ones */
const BWRAP_BASE = ["--die-with-parent", "--new-session", "--unshare-user", "--cap-drop", "ALL", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]

export function sandboxBackend(): "seatbelt" | "bubblewrap" | "unavailable" {
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) return "seatbelt"
  if (process.platform === "linux" && Bun.which("bwrap") && bwrapBlocked() === undefined) return "bubblewrap"
  return "unavailable"
}

/**
 * Why an installed bubblewrap can't run here, or undefined when it can (or isn't installed).
 *
 * ★ Installed is not the same as usable. Ubuntu 23.10 and later let AppArmor refuse
 *   unprivileged user namespaces, and bwrap then dies with "setting up uid map:
 *   Permission denied" before running anything. Checking only for the binary reported
 *   the sandbox as on, then failed every shell command with that message. It also made
 *   the sandbox tests look like they passed: "reading outside is refused" held only
 *   because nothing could run at all. So one real run, with the same flags as every
 *   command, decides; the answer is cached for the process.
 */
export function bwrapBlocked(): string | undefined {
  if (process.platform !== "linux") return undefined
  const bwrap = Bun.which("bwrap")
  if (!bwrap) return undefined
  if (probed?.path === bwrap) return probed.blocked
  let blocked: string | undefined
  try {
    const run = Bun.spawnSync([bwrap, "--ro-bind", "/", "/", ...BWRAP_BASE, "--", "true"], { stdout: "ignore", stderr: "pipe", timeout: 5_000 })
    if (run.exitCode !== 0) blocked = run.stderr.toString().trim() || `bwrap exited with ${run.exitCode ?? "a signal"}`
  } catch (error) {
    blocked = (error as Error).message
  }
  probed = { path: bwrap, blocked }
  return blocked
}
let probed: { path: string; blocked: string | undefined } | undefined

/** What to do about a blocked bwrap, for the error the model reads (English on purpose) */
function blockedAdvice(detail: string): string {
  return /uid map|user namespace|Operation not permitted|Permission denied/i.test(detail)
    ? `bubblewrap is installed but cannot create a user namespace here (${detail}). On Ubuntu 23.10 and later, AppArmor restricts unprivileged user namespaces; bwrap needs an AppArmor profile that allows \`userns\`. The alfa-permissions skill has the steps.`
    : `bubblewrap is installed but failed to start (${detail}).`
}
export function sandboxStatus(access: AccessManager): ReturnType<typeof sandboxBackend> | "off" {
  return access.sandboxActive ? sandboxBackend() : "off"
}
export function seatbeltProfile(grants: Grant[]): string {
  const clause = (path: string, directory: boolean) => `(${directory ? "subpath" : "literal"} ${JSON.stringify(canonicalPath(path))})`
  const reads = runtime.filter(existsSync).map(p => clause(p, true))
  const writes: string[] = []
  for (const g of grants) {
    reads.push(clause(g.path, g.directory))
    if (g.mode === "write") writes.push(clause(g.path, g.directory))
  }
  const privatePaths = [".ssh", ".gnupg", ".aws", ".kube", ".docker", ".config/gcloud", ".config/alfa", ".local/share/alfa", ".netrc", ".npmrc", ".pypirc"].map(p => clause(`${homedir()}/${p}`, true)).concat([clause(configDir(), true), clause(dataDir(), true)])
  return `(version 1)
(deny default)
(allow process* signal sysctl-read mach-lookup ipc-posix* network* file-read-metadata)
(allow file-read* ${reads.join(" ")} (literal "/") (literal ${JSON.stringify(canonicalPath(process.execPath))}) (subpath "/dev"))
(allow file-write* ${writes.join(" ")} (literal "/dev/null") (literal "/dev/tty"))
(deny file-read-data file-write* ${privatePaths.join(" ")} (regex #"(^|/)([.]ssh|[.]gnupg|[.]aws|[.]kube|[.]docker)(/|$)") (regex #"(^|/)([.]env([.][^/]*)?|[.]netrc|[.]npmrc|[.]pypirc|[^/]*[.](pem|key|p12|pfx))$"))`
}
export function sandboxShell(shell: Shell, access: AccessManager, extra: Grant[] = []): Shell {
  const scratch = access.scratch()
  const env = { ...(access.unrestricted ? buildChildEnv(process.env, process.platform, true).env : {}), TMPDIR: scratch, TMP: scratch, TEMP: scratch }
  if (!access.sandboxActive) return { ...shell, env: { ...shell.env, ...env } }
  const grants = effectiveGrants([{ path: access.root, mode: "write", directory: true, persistent: false }, ...access.list(), ...extra, { path: scratch, mode: "write", directory: true, persistent: false } ])
  switch (sandboxBackend()) {
    case "seatbelt": {
      const profile = seatbeltProfile(grants)
      return { ...shell, env, file: "/usr/bin/sandbox-exec", argsFor: command => ["-p", profile, shell.file, ...shell.argsFor(command)] }
    }
    case "bubblewrap": {
      const args = [...BWRAP_BASE]
      for (const p of runtime.filter(existsSync)) args.push("--ro-bind", p, p)
      if (existsSync(process.execPath)) args.push("--ro-bind", process.execPath, process.execPath)
      for (const g of grants) {
        if (!existsSync(g.path)) throw new Error(`Sandbox cannot mount a missing path: ${g.path}. Create it with the file tool first.`)
        args.push(g.mode === "write" ? "--bind" : "--ro-bind", g.path, g.path)
      }
      for (const path of protectedMounts(grants)) {
        args.push(...(statSync(path).isDirectory() ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path]))
      }
      return { ...shell, env, file: Bun.which("bwrap")!, argsFor: command => [...args, "--", shell.file, ...shell.argsFor(command)] }
    }
    default: {
      const blocked = bwrapBlocked()
      throw new Error(blocked
        ? `OS sandbox unavailable: ${blockedAdvice(blocked)} Shell execution is blocked until that is fixed or the user turns the sandbox off in Settings. File tools remain available.`
        : "OS sandbox unavailable. Shell execution is blocked. On Linux install bubblewrap through your OS package manager; on Windows use WSL. File tools remain available.")
    }
  }
}

/**
 * Linux mounts have no path-regex deny, so secret files already present in the granted
 * trees are masked before running.
 */
export function protectedMounts(grants: Grant[]): string[] {
  const result = new Set<string>()
  const secret = /(^|\/)(\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.netrc|\.npmrc|\.pypirc|\.env(?:\.[^/]*)?|[^/]*\.(?:pem|key|p12|pfx))(\/|$)/
  for (const path of [configDir(), dataDir(), ...[".ssh", ".gnupg", ".aws", ".kube", ".docker", ".config/gcloud", ".netrc", ".npmrc", ".pypirc"].map(p => `${homedir()}/${p}`)]) {
    if (existsSync(path) && grants.some(g => within(canonicalPath(path), g.path))) result.add(canonicalPath(path))
  }
  let visited = 0
  for (const grant of grants) {
    if (!grant.directory) { if (secret.test(grant.path) && existsSync(grant.path)) result.add(grant.path); continue }
    for (const entry of new Bun.Glob("**/*").scanSync({ cwd: grant.path, dot: true, onlyFiles: false, followSymlinks: false })) {
      if (++visited > 200_000) throw new Error("Sandbox credential scan exceeded its limit. Grant narrower working directories.")
      const path = `${grant.path}/${entry}`
      if (secret.test(path) && existsSync(path)) result.add(path)
    }
  }
  return [...result].sort((a,b) => a.length-b.length).filter((path, i, all) => !all.slice(0,i).some(parent => within(path,parent)))
}

/**
 * A repeated read-only request for cwd must not remount an already write-granted root as
 * read-only; nested mounts must go parent first, child after.
 */
export function effectiveGrants(input: Grant[]): Grant[] {
  const byPath = new Map<string, Grant>()
  for (const g of input) {
    const path = canonicalPath(g.path), previous = byPath.get(path)
    byPath.set(path, { ...g, path, mode: previous?.mode === "write" ? "write" : g.mode, directory: g.directory || previous?.directory === true })
  }
  const all = [...byPath.values()]
  return all.filter(g => !all.some(parent => parent !== g && parent.directory && within(g.path,parent.path) && (parent.mode === "write" || g.mode === "read"))).sort((a,b) => a.path.length-b.path.length)
}
