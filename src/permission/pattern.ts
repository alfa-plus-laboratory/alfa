/**
 * The canonical form of permission patterns.
 *
 * ⚠ This is an easy place to get wrong, and getting it wrong makes rules **fail
 * silently** (no error, they just never match).
 *
 * Rule: for file-type permissions, patterns always use **workspace-relative paths**,
 * never absolute ones. Two reasons:
 *   1. Wildcard matching compares against the whole pattern. With absolute paths, a
 *      rule like `*.env` would have to be written `*​/*.env` to match, and rules with
 *      no leading `*`, like `.envrc` or `id_rsa*`, would **never match** — a silent
 *      failure, the most dangerous class of bug.
 *   2. When the user writes config, `src/*` is what feels natural; they shouldn't have
 *      to care where the repo lives on disk.
 *
 * Absolute paths still get passed to the UI for display — put them in metadata, not in
 * patterns.
 */
import { isAbsolute, relative } from "node:path"

/**
 * Absolute path → workspace-relative path. Anything out of bounds (in theory already
 * blocked by the guard) falls back to the absolute path.
 */
export function workspacePattern(absolute: string, root: string): string {
  const rel = relative(root, absolute)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return absolute
  return rel
}
