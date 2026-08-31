/**
 * diff 生成。
 *
 * ⚠ diff **不进模型上下文** —— 模型看到的 output 只有 "Edit applied successfully."
 * diff 走 metadata,给终端渲染和权限确认弹窗用。理由是 diff 对模型没有信息增量
 * (它自己写的 newString),白白烧 token。
 */
import { createTwoFilesPatch, diffLines } from "diff"

export interface DiffStat {
  additions: number
  deletions: number
}

/** 生成 unified patch。两边内容都必须先归一成 LF,否则 patch 里全是 \r 噪音。 */
export function createPatch(filePath: string, oldLF: string, newLF: string): string {
  return trimDiff(createTwoFilesPatch(filePath, filePath, oldLF, newLF))
}

/**
 * 统一去缩进:内容行普遍有很深的公共缩进时,终端里会被挤到看不见。
 * 只动内容行(+ / - / 空格开头),@@ / Index: / === 行不碰。
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

/** 用**未归一**的内容统计增删行数(展示用,不参与匹配)。 */
export function diffStat(oldContent: string, newContent: string): DiffStat {
  let additions = 0
  let deletions = 0
  for (const change of diffLines(oldContent, newContent)) {
    if (change.added) additions += change.count ?? 0
    else if (change.removed) deletions += change.count ?? 0
  }
  return { additions, deletions }
}

/** 给终端/审批卡用的短预览:限制行数与单行长度。 */
export function renderDiffPreview(patch: string, maxLines = 40, maxLineChars = 240): string {
  const lines = patch.split("\n").filter((l) => !l.startsWith("Index:") && !l.startsWith("==="))
  const clipped = lines.slice(0, maxLines).map((l) => (l.length > maxLineChars ? l.slice(0, maxLineChars) + "…" : l))
  if (lines.length > maxLines) clipped.push(`… ${lines.length - maxLines} more lines`)
  return clipped.join("\n")
}
