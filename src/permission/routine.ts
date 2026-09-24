/**
 * "Running the project's own script inside the project" — a deterministic tier of
 * allow.
 *
 * ── Why this isn't left to a model ──
 * The user says "write a demo to play with", the agent writes `test/demo.py` (every
 * change printed a diff in front of them), then runs it — and the permission judge (a
 * model at the door, since retired) answered "the contents of demo.py were not provided;
 * its scope and risk cannot be assessed". That wasn't the judge being dumb; **the
 * question itself was wrong**: asking a model to read a script and predict whether it's
 * dangerous is a hard question, and hard questions are bound to get shaky answers.
 * Whereas "is the file this command runs inside the project" is a question one statSync
 * answers.
 *
 * Don't ask something that hesitates about what can be known for certain. What genuinely
 * can't be settled this way — network access, outside the project, publishing,
 * installing packages — still goes to the user. (Default mode only. Auto mode's fast path
 * used the same test until project scripts were moved to the classifier, which is now
 * shown the script text; see the header of permission/auto/fastpath.ts and
 * permission/auto/scripts.ts.)
 *
 * ── Where the line is drawn ──
 * Only "interpreter + one existing file inside the workspace" counts. Any flag is out —
 * with `python3 -c "…"` the code is on the command line, not in a file, and `-m` runs a
 * module installed on the system; neither is "the project's own script". More than one
 * argument is out too: at that point we don't know what the second one is.
 *
 * This tier **does not override** scan.ts's force: when the command has a subshell, a
 * redirect, privilege escalation or network access, the danger isn't in the command
 * name but in the structure around it, and it still gets asked.
 */
import { statSync } from "node:fs"
import { resolve, sep } from "node:path"

/**
 * Interpreters that run a script file given as an argument. System-installed modules
 * (-m) don't count; see the file header.
 */
const INTERPRETERS = new Set([
  "python",
  "python3",
  "node",
  "bun",
  "deno",
  "ruby",
  "perl",
  "php",
  "Rscript",
  "ts-node",
  "tsx",
])

export interface RoutineInput {
  /** Raw subcommand text (each segment from the bash statement splitter) */
  command: string
  /** Where this command actually runs */
  workdir: string
  /** Workspace root */
  root: string
}

/**
 * Whether this segment is "running an existing in-workspace file with an interpreter".
 *
 * When in doubt, always false — this tier is an **accelerator**, not a fallback. Missing
 * one costs one extra ask, while accepting one too many costs running something that
 * should never have run.
 */
export function runsProjectScript(input: RoutineInput): boolean {
  const tokens = input.command.trim().split(/\s+/).filter((token) => token.length > 0)
  const first = tokens[0]
  if (!first || !INTERPRETERS.has(first)) return false

  const rest = tokens.slice(1)
  // Any flag is out. With -c / -e / --eval the code isn't in a file at all,
  // and -m runs a module on the system — none of that is "the project's own script"
  if (rest.some((token) => token.startsWith("-"))) return false
  if (rest.length !== 1) return false

  const target = rest[0]!
  // If a quoted path wasn't split correctly, better to give up. The user gets asked
  // instead
  if (/["'`$]/.test(target)) return false

  const path = resolve(input.workdir, target)
  if (path !== input.root && !path.startsWith(input.root + sep)) return false

  try {
    return statSync(path).isFile()
  } catch {
    // File doesn't exist: then the command couldn't run anyway, so no need to allow it
    return false
  }
}
