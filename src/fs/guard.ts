/**
 * Paths are canonicalized before authorization. The old synchronous guard is kept for
 * hosts without an authorizer; test fixtures must not turn into allow-by-default.
 */
import { realpathSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"

export class OutsideWorkspaceError extends Error {
  constructor(target: string, root: string) {
    super(
      `Refusing to access "${target}": outside the workspace root "${root}". ` +
        `Only paths inside the workspace are allowed.`,
    )
    this.name = "OutsideWorkspaceError"
  }
}

/**
 * Resolve a path to an absolute path and assert it is inside the workspace; returns the
 * resolved absolute path.
 *
 * Both checks are required:
 * 1. the literal path after resolve — blocks ../../etc/passwd
 * 2. the real path after realpath — blocks symlinks pointing outside the workspace
 *
 * When the target doesn't exist (a file about to be created), the realpath check is done
 * on the **parent directory**.
 */
export function assertInsideWorkspace(target: string, opts: { cwd: string; root: string }): string {
  const absolute = isAbsolute(target) ? resolve(target) : resolve(opts.cwd, target)
  const root = resolve(opts.root)

  if (!within(absolute, root)) throw new OutsideWorkspaceError(target, root)

  // A symlink may point the path outside the workspace
  const real = canonicalPath(absolute)
  const realRoot = realpathSafe(root)
  if (!within(real, realRoot)) throw new OutsideWorkspaceError(target, root)

  return absolute
}

export function within(path: string, root: string): boolean {
  if (path === root) return true
  const rel = relative(root, path)
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel)
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * If the target exists, realpath the target; if not, realpath its nearest existing
 * ancestor and join the remaining relative part back on.
 */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // Walk up to the first ancestor that exists
    let probe = path
    const tail: string[] = []
    for (;;) {
      const parent = resolve(probe, "..")
      if (parent === probe) return path // nothing exists all the way to the root; return as is
      tail.unshift(relative(parent, probe))
      probe = parent
      try {
        const realParent = realpathSync(probe)
        return resolve(realParent, ...tail)
      } catch {
        continue
      }
    }
  }
}

export async function authorizePath(target: string, ctx: import("../tool/types.ts").ToolContext, mode: "read" | "write"): Promise<string> {
  return ctx.access ? ctx.access.authorize(target, ctx.cwd, mode, ctx.abortSignal, ctx.owner) : assertInsideWorkspace(target, ctx)
}
