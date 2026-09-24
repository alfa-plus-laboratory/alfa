/**
 * Allowlist of environment variables for child processes.
 *
 * ── Why it must exist ──
 * This is a **side channel the path gatekeeper can't touch at all**. You deny reading
 * `~/.aws/credentials`, but `printenv`, `echo $AWS_SECRET_ACCESS_KEY` or
 * `node -p process.env` gets the credentials out just the same. opencode passes
 * `{...process.env}` straight through, which leaves the gatekeeper wide open on this
 * route.
 *
 * ── Strategy ──
 * By default pass only the small handful "needed to run commands" and cut everything
 * else. The user can add more with ALFA_ENV_ALLOW="FOO,BAR_*".
 *
 * ── Known cost ──
 * You will run into "this command fails inside the agent but works in my own terminal".
 * So: (a) the allowlist is extensible; (b) the names of cut variables are written to the
 * debug log, to make that easy to track down.
 */
import { logger } from "../util/log.ts"
import { readEnv } from "./vars.ts"

const log = logger("env")

/** Required entries, exact match. */
const EXACT = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "TERM",
  "TZ",
  "TMPDIR",
  "LANG",
  "COLORTERM",
  "EDITOR",
  "PAGER",
])

/** Required entries, prefix match. */
const PREFIXES = [
  "LC_", // locale
  "XDG_", // directory spec
]

/**
 * The extra set required on Windows (names compared in upper case, see isAllowed).
 *
 * ── Why a separate table ──
 * The table above was written for POSIX, and on Windows the same things go by other
 * names: PATH is `Path`, the home directory is `USERPROFILE`, the temp directory is
 * `TEMP`. **And Windows environment variable names are case-insensitive**, so exact
 * matching with a `Set` was a wrong premise there to begin with — `EXACT.has("Path")` is
 * false, so the child process doesn't even get PATH, and every command is "not
 * recognized as an internal or external command". That is the other half of why "the
 * model says almost none of its commands work" (for the first half see env/shell.ts).
 *
 * ── Some are needed to run at all, not "nicer to have" ──
 * Without SystemRoot / windir, any program that uses winsock (git, npm and node
 * included) exits with a baffling initialization failure; without PATHEXT, .cmd and .exe
 * can't be found; without PSModulePath, PowerShell can't even load its own built-in
 * commands.
 */
const WINDOWS_EXACT = new Set([
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "OS",
  "PSMODULEPATH",
  "DRIVERDATA",
  // Git for Windows' bash relies on these two to know which MSYS environment it is
  "MSYSTEM",
  "MSYS",
])

/**
 * Common dev toolchain variables — cutting them causes a lot of "works on my machine"
 * confusion, and they contain no credentials themselves.
 */
const TOOLCHAIN = [
  "NODE_", // NODE_OPTIONS / NODE_ENV (note: excludes NODE_AUTH_TOKEN, see DENY)
  "npm_config_", // npm's config injection
  "PYTHON",
  "VIRTUAL_ENV",
  "CONDA_",
  "JAVA_HOME",
  "GOPATH",
  "GOROOT",
  "GOFLAGS",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "BUN_INSTALL",
  "PNPM_HOME",
  "NVM_",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
]

/**
 * The denylist beats every allowlist — even a name that matches a TOOLCHAIN prefix gets
 * cut. This is the fallback for "a sensitive entry slipped into the allowlist".
 */
const DENY_SUBSTRINGS = ["TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "PRIVATE_KEY", "APIKEY", "API_KEY", "SESSION_KEY"]

const DENY_PREFIXES = ["AWS_", "GOOGLE_", "GCP_", "AZURE_", "GITHUB_", "GH_", "GITLAB_", "NPM_", "DOCKER_", "KUBE_", "OPENAI_", "ANTHROPIC_"]

export interface BuildEnvResult {
  env: Record<string, string>
  /** Names of cut variables, for the debug log and --verbose */
  dropped: string[]
}

/**
 * auto explicitly inherits the host environment; the default path still filters, and
 * full environment values must never be written to the log.
 */
export function buildChildEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  trusted = false,
): BuildEnvResult {
  const windows = platform === "win32"
  const extra = parseExtraAllow(readEnv("ENV_ALLOW", source), windows)
  const env: Record<string, string> = {}
  const dropped: string[] = []

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (trusted || isAllowed(key, extra, windows)) env[key] = value
    else dropped.push(key)
  }

  if (dropped.length > 0) log.debug(`dropped ${dropped.length} env vars`, dropped)
  return { env, dropped }
}

/**
 * @param windows On Windows, **always compare in upper case**. Variable names are
 *   case-insensitive there, and the same PATH may be called `Path`, `PATH` or `path` in
 *   different processes — compare as is and whether it's allowed depends on who
 *   started the process, which is not how an allowlist should behave. POSIX stays
 *   case-sensitive: there `path` and `PATH` really are two different variables.
 */
function isAllowed(key: string, extra: { exact: Set<string>; prefixes: string[] }, windows: boolean): boolean {
  const upper = key.toUpperCase()
  const has = (set: Set<string>) => (windows ? set.has(upper) : set.has(key))
  const startsWithAny = (list: string[]) =>
    list.some((p) => (windows ? upper.startsWith(p.toUpperCase()) : key.startsWith(p)))

  // What the user explicitly added wins (they know what they're doing)
  if (has(extra.exact)) return true
  if (startsWithAny(extra.prefixes)) return true

  // The denylist overrides every built-in allowlist
  if (DENY_SUBSTRINGS.some((s) => upper.includes(s))) return false
  if (DENY_PREFIXES.some((p) => upper.startsWith(p))) return false

  if (has(EXACT)) return true
  if (windows && WINDOWS_EXACT.has(upper)) return true
  if (startsWithAny(PREFIXES)) return true
  if (startsWithAny(TOOLCHAIN)) return true
  return false
}

/**
 * ALFA_ENV_ALLOW="FOO,BAR_*"
 *
 * On Windows, fold what the user wrote to upper case too: names are case-insensitive
 * there, and someone who writes `ALFA_ENV_ALLOW=Path` and finds it has no effect has no
 * way to figure out why on their own.
 */
function parseExtraAllow(raw: string | undefined, windows = false): { exact: Set<string>; prefixes: string[] } {
  const exact = new Set<string>()
  const prefixes: string[] = []
  if (!raw) return { exact, prefixes }
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const name = windows ? entry.toUpperCase() : entry
    if (name.endsWith("*")) prefixes.push(name.slice(0, -1))
    else exact.add(name)
  }
  return { exact, prefixes }
}
