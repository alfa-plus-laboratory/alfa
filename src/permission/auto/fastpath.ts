/**
 * What auto mode runs without asking the classifier at all.
 *
 * ── The rule: what can't run anything nobody reviewed ──
 * This tier covers
 *   · alfa's own bookkeeping tools (todo, memory, context, environment, ask, task — a
 *     subagent's own steps still come through here one by one);
 *   · searching, and reading anything that isn't a secret (the first read outside the
 *     workspace is asked about separately; see security/access.ts);
 *   · edits inside the workspace, except protected paths (protected.ts) and secrets;
 *   · shell commands made only of read-only commands, read-only git, and mkdir / touch /
 *     cd inside the workspace.
 * It matches Claude Code's auto mode: reads and working-directory edits are approved
 * outright, everything else goes to the classifier.
 *
 * ── What was taken out, and why ──
 * This list once also held the project's own build / test / lint commands, running any
 * script in the workspace, and `git add` / `commit` / `fetch`. The argument was that a
 * model round trip per test run buys nothing when the worst case is "undo it with git".
 * That argument holds for code the user wrote and fails for a repository they just
 * cloned. `npm test` runs whatever package.json says, a workspace script is whoever wrote
 * it, and `git commit` runs hooks that husky or lefthook installed from the repository.
 * None of that code had been looked at by anyone, and an unfamiliar repository is
 * exactly where auto mode gets used. They now go to the classifier, which is shown the
 * script text (scripts.ts). Putting them back reopens "clone, say 'run the tests',
 * execute anything". The cost is one classifier call per test run, the same as in
 * Claude Code.
 *
 * ── What still goes to the classifier ──
 * Secrets, anywhere and by any route (read tool, `cat`, `git show HEAD:.env`). Reading
 * one sends it to the model provider, which is fine when the task needs it and is
 * exactly what the classifier's intent score is for. Also: edits outside the workspace
 * or to protected paths, deletion, moves, history rewrites, network, installs,
 * publishing, project scripts, anything scan.ts flags (substitution, privilege
 * escalation, `| sh`, exec flags), redirects that write, and any shape this file doesn't
 * recognize. Not recognizing something is a reason to ask the classifier, never a reason
 * to block.
 *
 * ★ The shell part is a list of *names with argument checks*, not DEFAULTS' allow
 *   table: that table allows `git branch *` (which deletes branches), `date *` (which
 *   sets the clock) and `env *` (which runs programs and prints every key). A name
 *   belongs here only if, with the checks below, it cannot change anything outside the
 *   workspace or run code from it. Commands that can print the environment (env,
 *   printenv, jq's `env`, `ps e`) are left out for the same reason secret files are.
 *
 * This classifies operations; it does not isolate processes or enforce OS permissions.
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { canonicalPath, within } from "../../fs/guard.ts"
import { scan } from "../../tool/bash/scan.ts"
import type { AskInput } from "../../tool/types.ts"
import { isProtectedPath } from "./protected.ts"
import { isSecretPath } from "./secrets.ts"

/** Touch nothing on disk or the network beyond alfa's own state */
const INTERNAL = new Set(["todo", "memory", "context", "environment", "ask", "task"])

/**
 * The pattern is a regex / glob, not a path. The files grep then opens come back
 * through here one by one as `read`, and a secret among them goes to the classifier.
 */
const SEARCH = new Set(["grep", "glob"])

const READ_ONLY = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "file", "stat", "which", "type", "echo", "printf",
  "whoami", "id", "groups", "hostname", "uname", "uptime", "df", "du", "tree", "grep", "egrep",
  "fgrep", "rg", "find", "sort", "uniq", "diff", "cmp", "comm", "cut", "tr", "column", "nl",
  "rev", "basename", "dirname", "realpath", "readlink", "sw_vers", "vm_stat", "nproc", "date",
  "true", "false", "test", "sleep", "md5", "md5sum", "shasum", "sha1sum", "sha256sum",
  "strings", "od", "hexdump",
])

/**
 * Arguments that turn a read-only name into a write or an execution. scan.ts already
 * forces a review for the long forms it knows (`find -exec`, `rg --pre`, `grep -D` …);
 * these add what it doesn't: bundled short flags (`grep -rD skip`, `sort -no out`) and
 * positional forms (`hostname newname`, `date 0101…` sets the clock).
 */
const UNSAFE_ARGS: Record<string, RegExp> = {
  sort: /^(?:-[^-]*o|--output)/,
  tree: /^(?:-[^-]*o|--output)/,
  grep: /^(?:-[^-]*D|--devices)/,
  egrep: /^(?:-[^-]*D|--devices)/,
  fgrep: /^(?:-[^-]*D|--devices)/,
  rg: /^(?:-[^-]*z|--(?:pre|search-zip|hostname-bin))/,
  date: /^[^+]/,
  hostname: /^[^-]/,
  // Repeated from scan.ts on purpose: a flag missing there (-fprint0 once was) would
  // otherwise be a write that skips review
  find: /^-(?:f(?:print0?|printf|ls)|delete|exec(?:dir)?|ok(?:dir)?)$/,
  file: /^(?:-[^-]*C|--compile)/,
}

/**
 * Read-only subcommands. add / commit / fetch used to be here; commit runs hooks from the
 * repository and fetch talks to the network (see the header)
 */
const GIT_QUIET = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog"])
const GIT_DANGEROUS_ARGS = /^(?:--output|--ext-diff|--textconv|--exec-path|--config-env|--no-index|--amend)(?:=|$)/

const DISCARD = /(?:^|\s)(?:[12]?>\s*\/dev\/null|2>&1)(?=\s|$)/g
const REDIRECT_REASON = "redirects a file (< / > / >>)"

export function isFastPath(input: AskInput, root: string): boolean {
  if (INTERNAL.has(input.permission)) return true
  if (input.patterns.length === 0) return false
  if (SEARCH.has(input.permission)) return true
  if (input.permission === "read") return input.patterns.every((path) => !isSecretPath(path, root))
  if (input.permission === "edit") return input.patterns.every((path) => editInWorkspace(path, root))
  if (input.permission === "bash") return quietCommand(input, root)
  return false
}

/** Patterns are workspace-relative inside the workspace and absolute outside it (pattern.ts) */
function editInWorkspace(path: string, root: string): boolean {
  if (isAbsolute(path) || path.startsWith("..")) return false
  return !isProtectedPath(path, root) && !isSecretPath(path, root)
}

/** The pattern shape: workspace-relative inside, absolute outside */
function relativeTo(path: string, root: string): string {
  const inside = relative(root, path)
  return inside === "" ? "." : inside.startsWith("..") || isAbsolute(inside) ? path : inside
}

function quietCommand(input: AskInput, root: string): boolean {
  const metadata = input.metadata ?? {}
  if (metadata["shellPosix"] === false) return false
  // The project check passes its command as the only pattern, without metadata.command
  const command = typeof metadata["command"] === "string" ? metadata["command"] : input.patterns.length === 1 ? input.patterns[0] : undefined
  if (!command?.trim()) return false
  // No parameter expansion, substitution, line continuation or subshells: the scanner
  // strips quotes from tokens, and `cat $F` can name any file
  if (/[$`\\(){}]/.test(command)) return false
  const result = scan(command)
  if (!result.parseOk || result.segments.length === 0) return false
  if (result.reasons.some((reason) => reason !== REDIRECT_REASON)) return false
  let workdir = typeof metadata["workdir"] === "string" ? metadata["workdir"] : root
  // `~user` is expanded by the shell to another account's home, which expand() can't
  // follow; every path check below would be looking at a different place
  if (result.segments.some((segment) => segment.tokens.some((token) => /^~[^/]/.test(token.slice(token.indexOf("=") + 1))))) return false
  for (const segment of result.segments) {
    // Only discarding output and stderr→stdout are recognized. Whole boundaries first,
    // so /dev/null/xxx or 2>&10 can't slip through
    const raw = segment.raw.replace(DISCARD, " ")
    if (/[<>]/.test(raw)) return false
    const tokens = scan(raw).segments[0]?.tokens ?? []
    const [name, ...args] = tokens
    if (!name) return false
    // ★ cd is followed, so `cd ~/.config/gh && cat hosts.yml` is checked at the real path
    if (name === "cd") {
      const target = args.length === 0 ? homedir() : args.length === 1 && args[0] !== "-" ? expand(args[0]!) : undefined
      if (target === undefined) return false
      workdir = resolve(workdir, target)
      continue
    }
    if (args.some((arg) => namesSecret(arg, workdir) || globMaySecret(arg, workdir))) return false
    if (!quietSegment(name, args, workdir, root)) return false
  }
  return true
}

function quietSegment(name: string, args: string[], workdir: string, root: string): boolean {
  if (args.some((arg) => /^(?:--output|--files0-from)(?:=|$)/.test(arg))) return false
  if (READ_ONLY.has(name)) {
    const unsafe = UNSAFE_ARGS[name]
    if (unsafe && args.some((arg) => unsafe.test(arg))) return false
    // `uniq in out` writes `out`
    if (name === "uniq" && args.filter((arg) => !arg.startsWith("-")).length > 1) return false
    return true
  }
  // Creating an empty file or directory is harmless only where the edit rules would allow
  // it, judged at the real path so a symlink in the repository can't point it outside
  if (name === "mkdir" || name === "touch") {
    const targets = args.filter((arg) => !arg.startsWith("-"))
    const home = canonicalPath(root)
    return targets.length > 0 && targets.every((target) => editInWorkspace(relativeTo(canonicalPath(resolve(workdir, expand(target))), home), home))
  }
  if (name === "pmset") return args.length === 2 && args[0] === "-g" && ["batt", "therm"].includes(args[1]!)
  if (name === "git") return gitReadsOwnRepo(workdir, root) && quietGit(args)
  return false
}

/**
 * ★ Read-only git is only read-only with a config nobody planted. The workspace's own
 *   `.git/config` is written locally by clone and never comes from the remote, but a
 *   repository can commit a directory that *is* a bare repository (`vendor.git/` with
 *   HEAD, objects/, config). `cd vendor.git && git diff` then reads that config, and
 *   `diff.external` or a textconv driver runs whatever it names. So git takes the fast
 *   path only when the repository git will discover is the workspace's own: nothing
 *   between the working directory and the root looks like a git directory, and `-C`,
 *   `--git-dir` and `--work-tree` aren't used (quietGit refuses them as a subcommand).
 */
function gitReadsOwnRepo(workdir: string, root: string): boolean {
  const home = canonicalPath(root)
  let dir = canonicalPath(workdir)
  if (!within(dir, home)) return false
  while (dir !== home) {
    if (existsSync(join(dir, ".git")) || looksLikeGitDir(dir)) return false
    dir = dirname(dir)
  }
  // A workspace without its own .git leaves git to search above it, into a repository
  // that isn't this one
  return existsSync(join(home, ".git"))
}

function looksLikeGitDir(dir: string): boolean {
  return existsSync(join(dir, "HEAD")) && existsSync(join(dir, "objects")) && existsSync(join(dir, "refs"))
}

/**
 * A glob the shell will expand: `cat .en?` names a secret that the literal text doesn't.
 * A wildcard in the last component is expanded here the same way and every match is
 * checked. A wildcard in a directory component (`head ~/.ss?/id_*`) isn't expanded, it
 * just goes to review: what it reaches depends on what exists on this machine at that
 * moment, and a check whose answer changes with the disk is no check. Anything unreadable
 * or too large to expand is treated as possibly secret too.
 */
function globMaySecret(arg: string, workdir: string): boolean {
  const value = arg.startsWith("-") ? arg.slice(arg.indexOf("=") + 1 || arg.length) : arg
  if (!/[*?[]/.test(value)) return false
  if (/[*?[]/.test(dirname(value))) return true
  const pattern = expand(value)
  const absolute = isAbsolute(pattern)
  let seen = 0
  try {
    for (const hit of new Bun.Glob(absolute ? pattern.slice(1) : pattern).scanSync({ cwd: absolute ? "/" : workdir, dot: true, onlyFiles: false, absolute: true, followSymlinks: false })) {
      if (++seen > GLOB_LIMIT || isSecretPath(hit, workdir)) return true
    }
  } catch {
    return true
  }
  return false
}

const GLOB_LIMIT = 2_000

function quietGit(args: string[]): boolean {
  const rest = args[0] === "--no-pager" ? args.slice(1) : args
  const [sub, ...options] = rest
  if (!sub) return false
  if (rest.some((arg) => GIT_DANGEROUS_ARGS.test(arg))) return false
  if (GIT_QUIET.has(sub)) return true
  // Listing forms only: a positional argument creates, a flag like -D deletes
  if (sub === "branch") return options.every((arg) => /^-(?:a|r|v|vv|-all|-remotes|-list|-show-current|-verbose)$/.test(arg))
  if (sub === "remote") return options.length === 0 || (options.length === 1 && options[0] === "-v") || options[0] === "get-url"
  if (sub === "tag") return options.length === 0 || options[0] === "-l" || options[0] === "--list"
  if (sub === "stash") return options[0] === "list"
  return false
}

/** An argument that names a secret, including the value of `--flag=path` */
function namesSecret(arg: string, workdir: string): boolean {
  const value = arg.startsWith("-") ? arg.slice(arg.indexOf("=") + 1 || arg.length) : arg
  return value.length > 0 && isSecretPath(value, workdir)
}

function expand(path: string): string {
  return path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path
}
