/**
 * Wildcard matching for permission rules.
 *
 * Ported from opencode packages/core/src/util/wildcard.ts (MIT, Copyright (c) 2025
 * opencode).
 *
 * ⚠ The semantics **differ** from glob/gitignore; don't mix the two up:
 *   - `*` is the regex `.*` and **crosses `/`**. So `src/*` matches `src/a/b/c.ts`.
 *   - `**` is exactly equivalent to `*` (not implemented separately). Writing `**` in
 *     the docs is only for human readers.
 *
 * Special case for a trailing " *": `"git status *"` should also match a bare
 * `"git status"`, or else after the user approves `git status *`, the next
 * argument-less `git status` gets asked all over again.
 */

const ESCAPE = /[.+^${}()|[\]\\]/g

export function match(pattern: string, value: string): boolean {
  // Users may write backslashes in path patterns; normalize them to forward slashes
  const normalizedPattern = pattern.replaceAll("\\", "/")
  const normalizedValue = value.replaceAll("\\", "/")

  let source = normalizedPattern.replace(ESCAPE, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")

  // "xxx .*" → "xxx( .*)?", so that both "with arguments" and "without arguments" match
  if (source.endsWith(" .*")) source = source.slice(0, -3) + "( .*)?"

  return new RegExp(`^${source}$`, "s").test(normalizedValue)
}
