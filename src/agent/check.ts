/**
 * After the edits, who tells it whether the code still compiles.
 *
 * ── Why this has to be automatic ──
 * After editing a file, the model looks back only at the diff it wrote itself. Whether the
 * diff looks right and whether it compiles are two different things: a missing import,
 * `subclipped` written as `subclip`, a changed signature with the other three call sites
 * forgotten — in a diff, all of these look perfectly reasonable. It only finds out when it
 * **remembers** to run a check, and "remembering" isn't a mechanism you can rely on: eight
 * times out of ten it remembers, and the other two you get a "done" and discover the red
 * yourself.
 *
 * So here it becomes something that needs no remembering: before a turn ends, at the moment
 * it's about to say "done", run the project's own check once, and if there are problems,
 * feed them back verbatim so it keeps fixing (see verify in agent/loop.ts).
 *
 * ── Only run the binary installed in the project ──
 * Recognized only when tsconfig.json exists **and** node_modules/.bin/tsc actually exists.
 * No `npx` fetching one off the network on the spot: that would be downloading and running
 * code without the user's say-so. If nothing is detected, act as if none of this exists —
 * the whole feature quietly isn't there. A checker that takes it upon itself to install
 * things is far more dangerous than no checker at all.
 *
 * Even so, in a freshly cloned repo `node_modules/.bin/tsc` is still something someone else
 * wrote. So it **still goes through the permission gatekeeper** (like any bash command): the
 * first time it asks, and the user can choose "don't ask again". See the verify
 * implementation in cli/main.ts.
 *
 * ── Keep the head, not the tail ──
 * The general rule for tool output is to keep the tail (the conclusion comes last);
 * compilers are **the other way around**: the first error is often the root cause, and the
 * dozens after it are its aftershocks. So here we keep the head.
 */
import type { AccessManager } from "../security/access.ts"
import { sandboxShell } from "../security/sandbox.ts"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { resolveShell } from "../env/shell.ts"
import { buildChildEnv } from "../env/whitelist.ts"
import { streamDecoder } from "../util/decode.ts"

export interface Checker {
  /** Short name for the UI: tsc / cargo / go / custom */
  id: string
  /** Full command line. Also used as the pattern when passing the gatekeeper */
  command: string
  /**
   * Only worth running if files with these extensions were touched. Empty array = run when
   * any file was touched (a command the user configured).
   *
   * Running tsc after only touching the README is pure waste — and what's wasted are the
   * seconds the user spends staring at the screen, which is what makes them switch the
   * whole feature off.
   */
  extensions: string[]
}

/**
 * Lines / bytes kept when there are problems. Any more and the model can't read it all
 * anyway; it would only blow up the window
 */
const MAX_LINES = 40
const MAX_BYTES = 6 * 1024
/**
 * How long a check may run before it counts as runaway. Same order of magnitude as the bash
 * tool's default timeout
 */
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * How to spell the local tsc.
 *
 * On Windows npm installs **three** files: `tsc` (an sh script), `tsc.cmd`, `tsc.ps1`.
 * PowerShell and cmd can't run the extensionless sh script — and the check runs every turn,
 * so a check that can't start becomes a line of red text every turn. So pick by shell:
 * POSIX (including Git bash) uses the original, non-POSIX uses .cmd. If neither exists,
 * treat the project as having no local tsc.
 */
function localTsc(has: (...parts: string[]) => boolean, posix: boolean): string | undefined {
  if (posix) return has("node_modules", ".bin", "tsc") ? "node_modules/.bin/tsc" : undefined
  if (has("node_modules", ".bin", "tsc.cmd")) return "node_modules\\.bin\\tsc.cmd"
  return undefined
}

/**
 * Which check this project should run.
 *
 * Order is priority; the first hit returns — a repo can have both tsconfig.json and go.mod
 * (a frontend + a small tool), and then running either one isn't wrong, but **running the
 * same one every time** matters more than which ranks first: nobody trusts a checker whose
 * verdict keeps changing.
 */
export function detectChecker(
  root: string,
  override?: string | false,
  /** For injection: tests ask "what if this machine runs PowerShell" */
  options: { posix?: boolean } = {},
): Checker | undefined {
  // A command the user wrote themselves beats everything, including "off"
  if (override === false) return undefined
  if (typeof override === "string" && override.trim().length > 0) {
    return { id: "check", command: override.trim(), extensions: [] }
  }

  const has = (...parts: string[]) => existsSync(join(root, ...parts))

  // TypeScript: needs both tsconfig and a local tsc; see the file header for why
  if (has("tsconfig.json")) {
    const tsc = localTsc(has, options.posix ?? resolveShell().posix)
    if (tsc) return { id: "tsc", command: `${tsc} --noEmit`, extensions: [".ts", ".tsx", ".mts", ".cts"] }
  }
  // On Windows cargo / go are just cargo.exe / go.exe, found on PATH; the command works
  // as-is
  if (has("Cargo.toml")) {
    return { id: "cargo", command: "cargo check --quiet --message-format short", extensions: [".rs"] }
  }
  if (has("go.mod")) {
    return { id: "go", command: "go build ./...", extensions: [".go"] }
  }
  return undefined
}

/** Whether this batch of changes is worth running a check for. */
export function worthChecking(checker: Checker, touched: readonly string[]): boolean {
  if (touched.length === 0) return false
  if (checker.extensions.length === 0) return true
  return touched.some((path) => checker.extensions.some((ext) => path.endsWith(ext)))
}

export interface CheckOutcome {
  /**
   * ok          — clean
   * problems    — the checker reports problems (non-zero exit code)
   * unavailable — didn't get to run: binary missing, timeout, interrupted. **Not** a
   *               problem with the code
   */
  status: "ok" | "problems" | "unavailable"
  /** The truncated output. Usually empty when ok */
  output: string
  code?: number
  /** Why it was unavailable; one line for the UI */
  reason?: string
}

export async function runCheck(
  checker: Checker,
  options: { root: string; access?: AccessManager; signal?: AbortSignal; timeoutMs?: number },
): Promise<CheckOutcome> {
  if (options.signal?.aborted) return { status: "unavailable", output: "", reason: "interrupted" }

  return new Promise<CheckOutcome>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      // Same shell as the bash tool (see env/shell.ts). This used to hard-code /bin/sh —
      // that path doesn't exist on Windows, so every end-of-turn check reported
      // "unavailable", and that reads like "this project has no usable check", not like
      // "we picked the wrong shell"
      const shell = options.access ? sandboxShell(resolveShell(), options.access) : resolveShell()
      child = spawn(shell.file, shell.argsFor(checker.command), {
        cwd: options.root,
        // Same allowlist as the bash tool: things like *_TOKEN / *_SECRET aren't passed down
        env: { ...buildChildEnv().env, ...shell.env },
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group: on timeout/interrupt the whole group is killed off, leaving no
        // orphans (same rule as the bash tool)
        detached: shell.detached,
        windowsHide: true,
      })
    } catch (error) {
      resolve({ status: "unavailable", output: "", reason: describe(error) })
      return
    }

    let raw = ""
    /**
     * Once we have enough, stop piling it into memory — a checker that floods its output
     * shouldn't blow up the process
     */
    let full = false
    // ★ `String(chunk)` decodes **in one shot**, with no cross-chunk state — a multibyte
    //   character split by the pipe gets a U+FFFD on each side, and silently. One streaming
    //   decoder per stream is the right way (see util/decode.ts); CJK text in checker
    //   output is common
    const collect = (decode: (chunk: Buffer | string) => string) => (chunk: Buffer | string) => {
      if (full) return
      raw += decode(chunk)
      if (raw.length > MAX_BYTES * 8) full = true
    }
    child.stdout?.on("data", collect(streamDecoder()))
    child.stderr?.on("data", collect(streamDecoder()))

    let settled = false
    const finish = (outcome: CheckOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      resolve(outcome)
    }

    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
      } catch {
        // already gone
      }
    }

    const timer = setTimeout(() => {
      kill()
      finish({ status: "unavailable", output: "", reason: "timeout" })
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    const onAbort = () => {
      kill()
      finish({ status: "unavailable", output: "", reason: "interrupted" })
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })

    child.on("error", (error) => finish({ status: "unavailable", output: "", reason: describe(error) }))

    child.on("close", (code) => {
      // 127 = the shell says the command wasn't found. That's not "the code has problems",
      // it's "the checker isn't installed"
      if (code === 127) {
        finish({ status: "unavailable", output: "", reason: `command not found: ${checker.command}` })
        return
      }
      finish(
        code === 0
          ? { status: "ok", output: "", code: 0 }
          : { status: "problems", output: clamp(raw), ...(code === null ? {} : { code }) },
      )
    })
  })
}

/**
 * Keep the head. See the file header: a compiler's first error is often the root cause.
 */
function clamp(raw: string): string {
  const text = raw.replace(/\r\n/g, "\n").trimEnd()
  const lines = text.split("\n")
  let kept = lines.length <= MAX_LINES ? lines : lines.slice(0, MAX_LINES)
  let out = kept.join("\n")
  if (Buffer.byteLength(out, "utf8") > MAX_BYTES) {
    while (kept.length > 1 && Buffer.byteLength(kept.join("\n"), "utf8") > MAX_BYTES) kept = kept.slice(0, -1)
    out = kept.join("\n")
  }
  const dropped = lines.length - kept.length
  return dropped > 0 ? `${out}\n... (${dropped} more lines)` : out
}

/**
 * The text fed back to the model.
 *
 * ── All three sentences are required ──
 * 1. This ran automatically; it isn't the user talking — otherwise it replies "OK, I'll
 *    change it the way you said", when the user never said a word.
 * 2. First judge whether your changes caused it — a repo that already didn't compile (which
 *    is exactly why many people open an agent) would send it diving in to fix a pile of
 *    things unrelated to this task.
 * 3. If you can't fix it, say so; don't force it — silently working around it is worse than
 *    reporting an error.
 */
export function checkReminder(checker: Checker, output: string): string {
  return [
    "<system-reminder>",
    `An automatic check ran after your edits and reported problems. This was run by the harness, not by the user —`,
    `do not thank the user for it or treat it as a new request.`,
    "",
    `$ ${checker.command}`,
    output,
    "",
    "Before you answer: decide whether these problems come from the changes you just made.",
    "- Caused by your changes: fix them, then finish the task.",
    "- Pre-existing and unrelated: leave them alone and say so in one line, so the user knows the repo was",
    "  already in that state.",
    "Never silently work around a problem you cannot fix — say what it is and where.",
    "</system-reminder>",
  ].join("\n")
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
