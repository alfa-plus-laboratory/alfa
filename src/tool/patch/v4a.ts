/**
 * Native apply_patch supplies one file's V4A body, not a shell command or a unified diff
 * with line numbers. Exact, unique context is deliberate: fuzzy matching can destroy a
 * nearby user edit while reporting success. Every hunk is prepared before the writer runs.
 * File headers/moves belong to other patch protocols and are rejected, never guessed.
 */
export function applyV4A(source: string, diff: string, creating = false): string {
  if (diff.includes("\u0000") || source.includes("\u0000")) throw new Error("apply_patch only supports text files without NUL bytes")
  const patch = diff.replaceAll("\r\n", "\n").split("\n")
  if (patch.at(-1) === "") patch.pop()
  if (creating) {
    if (patch.some(line => !line.startsWith("+"))) throw new Error("create_file diff must contain only '+' prefixed content lines")
    return patch.length ? patch.map(line => line.slice(1)).join("\n") + "\n" : ""
  }
  if (patch.length === 0) throw new Error("Empty update_file diff")
  const trailing = source.endsWith("\n")
  const lines = source === "" ? [] : source.split("\n")
  if (trailing) lines.pop()
  const result: string[] = []
  let cursor = 0, at = 0, changes = 0
  while (at < patch.length) {
    const header = patch[at]!
    if (header === "@@" || header.startsWith("@@ ")) {
      if (header !== "@@") {
        const anchor = header.slice(3)
        const index = findUnique(lines, [anchor], cursor, false)
        result.push(...lines.slice(cursor, index + 1))
        cursor = index + 1
      }
      at++
    }
    const before: string[] = [], after: string[] = []
    let eof = false, count = 0
    while (at < patch.length && patch[at] !== "@@" && !patch[at]!.startsWith("@@ ")) {
      const line = patch[at++]!
      if (line === "*** End of File") {
        eof = true
        if (at !== patch.length) throw new Error("End of File marker must terminate the diff")
        break
      }
      const prefix = line[0]
      if (prefix !== " " && prefix !== "+" && prefix !== "-") throw new Error("Invalid V4A line: use context (' '), addition ('+'), deletion ('-'), or @@")
      count++
      if (prefix !== "+") before.push(line.slice(1))
      if (prefix !== "-") after.push(line.slice(1))
      if (prefix !== " ") changes++
    }
    if (count === 0) throw new Error("Empty V4A hunk")
    const index = before.length === 0
      ? (eof || lines.length === 0 ? lines.length : -1)
      : findUnique(lines, before, cursor, eof)
    if (index < 0) throw new Error("Insertion needs exact surrounding context or an End of File marker")
    result.push(...lines.slice(cursor, index), ...after)
    cursor = index + before.length
  }
  if (changes === 0) throw new Error("No changes in update_file diff")
  result.push(...lines.slice(cursor))
  return result.join("\n") + (trailing && result.length > 0 ? "\n" : "")
}

function findUnique(lines: string[], context: string[], from: number, eof: boolean): number {
  const matches: number[] = []
  const last = lines.length - context.length
  for (let index = eof ? last : from; index <= last; index++) {
    if (index < from) continue
    if (context.every((line, offset) => lines[index + offset] === line)) matches.push(index)
  }
  if (matches.length !== 1) throw new Error(matches.length ? "Patch context has multiple matches; add more exact context" : "Patch context does not match the current file; read it again")
  return matches[0]!
}
