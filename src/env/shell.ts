/**
 * Which shell commands run in.
 *
 * ── Why this deserves a module ──
 * It used to be one line in the bash tool: `process.env.SHELL || "/bin/bash"`. On Windows
 * that line misses on both sides: there's no $SHELL and no /bin/bash — spawn fails with
 * ENOENT, and the bash tool handles a spawn failure **as if the process had exited**
 * (the error is supposed to come out via stderr, but here the process never even started,
 * so stderr is empty). What the user saw: the model saying almost none of its commands
 * work, every one returning "(no output)". One path that can't be found shows up as the
 * whole tool being broken.
 *
 * ── On Windows, look for a real bash first rather than going straight to PowerShell ──
 * Three things in this program are built on POSIX shell syntax: statement splitting
 * (tool/bash/scan.ts), the permission rule table (permission/rules.ts), and the pipelines
 * the bash tool description teaches the model to write. Switch to PowerShell and all
 * three go wrong at once — while Git for Windows is installed on almost every Windows
 * machine people write code on, and its bundled bash keeps all three valid as they are.
 * So the order is:
 *
 *   $ALFA_SHELL → Git for Windows bash → bash on PATH → pwsh → powershell → cmd
 *
 * ★ bash on PATH must **exclude System32\bash.exe**: that's the WSL launcher, which sends
 *   the command into another filesystem namespace — `C:\repo` simply doesn't exist
 *   over there, and the error is a bare "no such file or directory" with no hint at all
 *   that "you actually went into WSL".
 *
 * ── When we fall back to PowerShell / cmd, callers need to know ──
 * Hence the posix flag, which is for outside use: statement splitting and the rule table
 * can no longer be trusted, so every command must be asked about (see tool/bash.ts), and
 * the model must be told to stop writing `| head -20` (see the tool description).
 */
import { existsSync } from "node:fs"
import { readEnv } from "./vars.ts"

export interface Shell {
  /** Private temp dir for this sandboxed command only; the host env is left untouched. */
  env?: Record<string, string>
  /** Path to the executable, handed straight to spawn */
  file: string
  /** Wrap a command into argv */
  argsFor(command: string): string[]
  /**
   * Whether it speaks POSIX syntax.
   *
   * The consequence of false isn't just "different syntax": our splitter would split a
   * PowerShell command wrongly by POSIX rules, and the approval would then be granted
   * for **a different command**. So this flag is passed all the way to the gatekeeper.
   */
  posix: boolean
  /** Name shown to humans and the model: bash / powershell / cmd */
  label: string
  /**
   * Whether it can start in its own process group.
   *
   * Must be on for POSIX (see tool/bash/kill.ts: a negative pid is the only way to kill a
   * process tree cleanly). Must be off on Windows — there, detached means "open a
   * console window of its own", a black box flashing for every command. The process tree
   * is cleaned up with taskkill /T there.
   */
  detached: boolean
}

export interface ResolveOptions {
  platform?: string
  env?: NodeJS.ProcessEnv
  /** For injection. Defaults to checking the filesystem */
  exists?: (path: string) => boolean
  /** For injection. Defaults to looking up PATH */
  which?: (name: string) => string | undefined
}

let cached: Shell | undefined

/**
 * Which shell to use on this machine. **The result is cached**: it's asked many times
 * in a session (once per command), and the answer doesn't change while the process is
 * alive, so there's no need to hit the filesystem every time.
 *
 * Passing options bypasses the cache — that's a test asking "what if this machine
 * looked like that".
 */
export function resolveShell(options: ResolveOptions = {}): Shell {
  const fresh = Object.keys(options).length > 0
  if (!fresh && cached) return cached

  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? defaultExists
  const which = options.which ?? defaultWhich

  const resolved = platform === "win32" ? windowsShell(env, exists, which) : posixShell(env["SHELL"] || "/bin/bash")
  if (!fresh) cached = resolved
  return resolved
}

/** For tests: clear the cache */
export function resetShellCache(): void {
  cached = undefined
}

function posixShell(file: string): Shell {
  return {
    file,
    argsFor: (command) => ["-c", command],
    posix: true,
    label: baseName(file),
    detached: true,
  }
}

function windowsShell(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  which: (name: string) => string | undefined,
): Shell {
  // What the user points at themselves wins. They may have installed it somewhere we
  // can't guess (scoop, a portable build, a company mirror), and "can't guess" shouldn't
  // mean "can't use"
  const explicit = readEnv("SHELL", env)
  if (explicit) return classify(explicit, false)

  // Git for Windows. Installing git brings it, at one of a few fixed paths
  const programFiles = [env["ProgramFiles"], env["ProgramW6432"], env["ProgramFiles(x86)"], "C:\\Program Files"]
  const candidates: string[] = []
  for (const root of programFiles) {
    if (root) candidates.push(winPath(root, "Git", "bin", "bash.exe"))
  }
  // Per-user install (the kind that needs no admin rights; now one of the Git
  // installer's default options)
  if (env["LOCALAPPDATA"]) candidates.push(winPath(env["LOCALAPPDATA"], "Programs", "Git", "bin", "bash.exe"))
  for (const candidate of candidates) {
    if (exists(candidate)) return classify(candidate, false)
  }

  // bash on PATH — but not the WSL one (see file header)
  const onPath = which("bash")
  if (onPath && !isWSLLauncher(onPath)) return classify(onPath, false)

  // Degraded tier. Getting here means this machine has no POSIX shell; statement
  // splitting and the rule table can no longer be trusted
  for (const name of ["pwsh", "powershell", "cmd"]) {
    const found = which(name)
    if (found) return classify(found, false)
  }
  // which can't find any of them (broken PATH?). cmd's location comes from ComSpec; it's
  // the only path on Windows that may be hard-coded
  return classify(env["ComSpec"] || "C:\\Windows\\System32\\cmd.exe", false)
}

/**
 * Build a Windows path.
 *
 * Not node:path's join: it uses the **current** platform's separator, while this code
 * always describes paths on Windows — when tests run on Linux it would produce
 * `C:\Program Files/Git/bin`, something that looks like neither Windows nor POSIX.
 */
function winPath(root: string, ...parts: string[]): string {
  return [root.replace(/[\\/]+$/, ""), ...parts].join("\\")
}

/**
 * Get the file name. **Both separators are recognized** — node:path's basename isn't
 * used because it decides by the **current** platform: when tests run on Linux,
 * `C:\...\powershell.exe` as a whole would be taken as one file name. And the whole point
 * of this module is to answer "what happens on the other platform".
 */
function baseName(file: string): string {
  const parts = file.split(/[\\/]/)
  return parts[parts.length - 1] ?? file
}

/**
 * `C:\Windows\System32\bash.exe` is the WSL launcher, not a shell that can operate on
 * local files
 */
function isWSLLauncher(path: string): boolean {
  return /[\\/]windows[\\/](system32|sysnative)[\\/]bash(\.exe)?$/i.test(path)
}

/**
 * Identify which kind of shell it is by file name.
 *
 * Anything unrecognized is treated as POSIX: the only thing that can get here is what the
 * user pointed at themselves with $ALFA_SHELL, and people who set that variable almost
 * always point at something from the sh family. A wrong guess costs something they can
 * see (the very first command fails with a syntax error), whereas guessing PowerShell
 * would needlessly ask about every single command.
 */
function classify(file: string, detached: boolean): Shell {
  const name = baseName(file).toLowerCase().replace(/\.exe$/, "")
  if (name === "powershell" || name === "pwsh") {
    return {
      file,
      // -NoProfile: the user's profile prints banners, changes encodings, sets aliases —
      // mixed into command output, what the model reads is no longer the command's own
      // output.
      // -NonInteractive: there's no TTY, so any confirmation prompt would hang until
      // timeout
      argsFor: (command) => ["-NoProfile", "-NonInteractive", "-Command", command],
      posix: false,
      label: name,
      detached,
    }
  }
  if (name === "cmd") {
    return {
      // /d skips the AutoRun registry key (same reason as -NoProfile); /s /c passes the
      // whole command through as is
      argsFor: (command) => ["/d", "/s", "/c", command],
      file,
      posix: false,
      label: "cmd",
      detached,
    }
  }
  return { file, argsFor: (command) => ["-c", command], posix: true, label: name, detached }
}

/**
 * Synchronous: asked only once per session; making it async would just add an await to
 * the bash tool's first call
 */
function defaultExists(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

function defaultWhich(name: string): string | undefined {
  return Bun.which(name) ?? undefined
}
