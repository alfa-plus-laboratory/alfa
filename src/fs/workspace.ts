/**
 * Deriving the workspace root.
 *
 * Fail closed: when no git repo is found, fall back to cwd, **never** to "/" or home.
 * This return value is directly the boundary of the out-of-bounds guard; falling back in
 * the wrong direction opens up the whole machine.
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve, sep } from "node:path"

/**
 * Walk up from start looking for .git; return that level if found, otherwise
 * resolve(start).
 */
export function findWorkspaceRoot(start: string): string {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir
    const parent = resolve(dir, "..")
    if (parent === dir) return resolve(start) // reached the filesystem root without finding it
    dir = parent
  }
}

export function isGitRepo(dir: string): boolean {
  return existsSync(join(resolve(dir), ".git"))
}

/**
 * The two ways the UI refers to the workspace.
 *
 * "Where is this" needs an **always-visible place**: the startup banner prints cwd, but
 * the conversation pushes it off screen. With three terminals open at once, "which repo
 * is this message going to land on" becomes pure guesswork, and a wrong guess means the
 * agent acting in the wrong repo. So `path` is the first footer line under the input box
 * (the Shell footer in cli/main.ts).
 */
export interface WorkspaceLabel {
  /**
   * Root directory name. Empty string when the root is "/". Nothing draws it at the
   * moment — the footer shows `path`
   */
  name: string
  /** Full path, with home folded into `~`. For the status line */
  path: string
}

/**
 * root gives the name, cwd gives the path.
 *
 * The path uses cwd rather than root: when they differ (started in a subdirectory), cwd
 * is "where I am", and root's part is a prefix of that path anyway, so nothing is lost.
 */
export function workspaceLabel(root: string, cwd: string = root): WorkspaceLabel {
  return { name: basename(root), path: homePath(cwd) }
}

/**
 * Fold paths under home into `~/…`.
 *
 * The status line is a single line, and the `/Users/someone` part is the same for every
 * path on a given machine — everything it crowds out is the part that actually tells you
 * "which project is this".
 */
export function homePath(path: string): string {
  const home = homedir()
  if (home.length === 0) return path
  if (path === home) return "~"
  return path.startsWith(home + sep) ? "~" + path.slice(home.length) : path
}
