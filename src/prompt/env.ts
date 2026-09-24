/**
 * The environment block — tells the model "where you are standing right now".
 *
 * The basics are seven things: working directory, whether it's a git repo, platform,
 * date, shell, its own version number, and which model is running. Attached is a
 * snapshot of the runtime permissions the host provides; when grants change, the dynamic
 * part is allowed to invalidate the cache — the boundary must not be hidden for the
 * sake of caching.
 * There is a reason the basics are kept restrained:
 *   - Putting things that change, like a directory tree / git status, into system means
 *     moving the prompt prefix every turn, and the cache drops straight to zero. Branch
 *     and working-tree state have a home elsewhere — a snapshot attached to the first
 *     message of a session (see prompt/git.ts); history is append-only, so the prefix
 *     is unaffected.
 *   - "What's today's date" is the one daily invalidation source the basics knowingly
 *     accept: a model that doesn't know the date will guess, and the year it guesses can
 *     lead it to write outdated API usage. The price is **the cache going stale once
 *     every midnight**; what it buys is the model not believing it's still the year of
 *     its training cutoff. A good trade, but know what you're paying for.
 *   - The model-name line is **free**: the cache is already stored per model, and the
 *     one time the model changes, it's a full miss whether this is written or not. What
 *     it saves is the model's guesses about itself — a model that thinks it's the
 *     version from two years ago will go out of its way to avoid capabilities it
 *     actually has.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { resolveShell } from "../env/shell.ts"
import { VERSION } from "../update/release.ts"

export interface EnvInput {
  runtime?: import("../security/runtime.ts").RuntimeSnapshot
  cwd: string
  /** Workspace root (usually the git root) */
  root: string
  /** For injection; pinned in tests */
  now?: Date
  platform?: string
  shell?: string
  /** `provider/model`, i.e. the `-m` string. If unavailable, this line is left out */
  model?: string
  /** For injection; pinned in tests. Defaults to this binary's own version */
  version?: string
}

export function environmentBlock(input: EnvInput): string {
  const now = input.now ?? new Date()
  const lines = [
    "Here is useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${input.cwd}`,
    `  Is directory a git repo: ${isGitRepo(input.root) ? "yes" : "no"}`,
    `  Platform: ${input.platform ?? process.platform}`,
    `  Today's date: ${formatDate(now)}`,
    `  Default shell: ${input.shell ?? defaultShell()}`,
    /**
     * ★ Its own version number.
     *
     * Without it the model can only guess which version it is — and users asking in a
     * session "does your version have XX" or "how do I upgrade" is common, and a
     * guessed answer sounds just as confident. Writing it in has a side benefit too: a
     * conversation the user pastes carries its version with it, so there's no need to
     * go back and ask.
     *
     * It changes only once per version, with almost no effect on the prompt cache
     * (swapping the binary is a full miss anyway)
     */
    `  alfa version: ${input.version ?? VERSION}`,
    "</env>",
  ]
  // The model name goes last, just before </env> — the lines above describe the
  // environment, this one describes the model itself
  if (input.model) lines.splice(lines.length - 1, 0, `  Model: ${input.model}`)
  if (input.root !== input.cwd) {
    lines.splice(3, 0, `  Workspace root: ${input.root}`)
  }
  if (input.runtime) lines.push("<runtime_state>", JSON.stringify(input.runtime, null, 2), "</runtime_state>")
  return lines.join("\n")
}

/** .git can be a directory (a regular repo) or a file (worktree / submodule); both count. */
function isGitRepo(root: string): boolean {
  return existsSync(join(root, ".git"))
}

/**
 * YYYY-MM-DD, local time zone. ISO's UTC would show users in time zones east of UTC
 * "yesterday" in the middle of the night.
 */
function formatDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * ★ What's asked for is **the shell that will actually be used to run commands** (see
 * env/shell.ts), not $SHELL.
 *
 * On Windows the two are entirely different things: there is no $SHELL there, so this
 * line used to always say "unknown", and a model that sees unknown assumes it's on
 * POSIX and goes on writing `| head -20`. Now it honestly says bash / powershell / cmd
 * — the whole point of the environment block is to keep it from guessing.
 */
function defaultShell(): string {
  return resolveShell().label
}
