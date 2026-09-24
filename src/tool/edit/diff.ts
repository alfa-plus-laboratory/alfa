/**
 * Diff generation.
 *
 * ⚠ The diff **does not enter the model's context** — the output the model sees is just
 * "Edit applied successfully." The diff travels in metadata, for terminal rendering and
 * the permission confirmation dialog. The reason: a diff tells the model nothing new (it
 * wrote the newString itself), so it would just burn tokens for nothing.
 */
import { createTwoFilesPatch, diffLines } from "diff"

export interface DiffStat {
  additions: number
  deletions: number
}

/**
 * Build a unified patch. Both sides must be normalized to LF first, or the patch is all
 * \r noise.
 */
export function createPatch(filePath: string, oldLF: string, newLF: string): string {
  return trimDiff(createTwoFilesPatch(filePath, filePath, oldLF, newLF))
}

/**
 * Uniform dedent: when the content lines share a deep common indent, they get squeezed out
 * of sight in the terminal. Only content lines (starting with + / - / space) are touched;
 * @@ / Index: / === lines are left alone.
 */
export function trimDiff(patch: string): string {
  const lines = patch.split("\n")
  const isContent = (line: string) =>
    (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
    !line.startsWith("---") &&
    !line.startsWith("+++")

  let min = Infinity
  for (const line of lines) {
    if (!isContent(line)) continue
    const body = line.slice(1)
    if (body.trim().length === 0) continue
    min = Math.min(min, body.length - body.trimStart().length)
  }
  if (min === Infinity || min === 0) return patch

  return lines.map((line) => (isContent(line) ? line[0]! + line.slice(1).slice(min) : line)).join("\n")
}

/**
 * Count added/removed lines on the **un-normalized** content (for display; plays no part
 * in matching).
 */
export function diffStat(oldContent: string, newContent: string): DiffStat {
  let additions = 0
  let deletions = 0
  for (const change of diffLines(oldContent, newContent)) {
    if (change.added) additions += change.count ?? 0
    else if (change.removed) deletions += change.count ?? 0
  }
  return { additions, deletions }
}

/** Short preview for the terminal / approval card: caps line count and per-line length. */
export function renderDiffPreview(patch: string, maxLines = 40, maxLineChars = 240): string {
  const lines = patch.split("\n").filter((l) => !l.startsWith("Index:") && !l.startsWith("==="))
  const clipped = lines.slice(0, maxLines).map((l) => (l.length > maxLineChars ? l.slice(0, maxLineChars) + "…" : l))
  if (lines.length > maxLines) clipped.push(`… ${lines.length - maxLines} more lines`)
  return clipped.join("\n")
}
