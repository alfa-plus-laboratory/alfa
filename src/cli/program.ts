/**
 * The name typed on the command line.
 *
 * ── Why it isn't hardcoded ──
 * There's only one name right now (`alfa`), but help text still prints **exactly what
 * the user just typed**. The reason is that this binary gets invoked under other names:
 * symlinks people make themselves, shell aliases, and the old symlinks still left on
 * machines that installed `apcode` before the rename. Hardcode it, and those people copy
 * a command that **doesn't exist on their machine** — command not found, right after
 * they successfully ran it.
 *
 * ── Why argv0 and not argv[1] ──
 * In a single-file binary, `process.argv[1]` is the **build-time** artifact name
 * (`/$bunfs/root/xxx-bin`), the same whichever symlink you came in through — using it
 * amounts to hardcoding. `process.argv0` is the string the shell actually passed in —
 * `alfa` when invoked via the `alfa` symlink, `apcode` when via the old `apcode` one.
 *
 * When running the source directly with bun, argv0 is `bun`; then fall back to argv[1]
 * (that's the script path).
 */
import { basename } from "node:path"

/**
 * Product name. Used for the config directory and the self-reference in the system
 * prompt; doesn't vary with how the program is invoked.
 */
export const PRODUCT = "alfa"

export function programName(): string {
  const invoked = basename(process.argv0 ?? "")
  if (invoked.length > 0 && invoked !== "bun" && invoked !== "node") return invoked
  const script = basename(process.argv[1] ?? "")
  return script.length > 0 ? script : PRODUCT
}
