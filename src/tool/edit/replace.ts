/**
 * 模糊替换级联 —— edit 工具的心脏,纯函数零 IO。
 *
 * 移植自 opencode 的 packages/opencode/src/tool/edit.ts(MIT License,
 * Copyright (c) 2025 opencode)。改动:去掉 Effect,砍掉 9 级中的 5 级
 * (见文末说明),补上 noUncheckedIndexedAccess 需要的断言。
 *
 * ── 它在解决什么 ──
 * 模型从 read 的输出里抄一段代码回来做 search-and-replace,常见偏差:
 * 整体缩进被吃掉或多出、行内空白被规整成单空格、首尾多了一个空行、
 * 只记住了函数头尾而中间行凭印象重写。精确 indexOf 一旦 miss,就要
 * 重新 read 再试 —— 浪费一整个 LLM 往返。级联把这些偏差逐级放宽兜住。
 *
 * ── 关键语义(改动前务必读懂)──
 * 1. Replacer 产出的是「原文里的真实片段」,不是下标。外层统一用 indexOf
 *    重新定位,所以候选必须逐字出现在原文里。
 * 2. 短路规则不是「找到唯一匹配就停在该级」,而是「第一个可用候选就整体返回」。
 * 3. notFound 是**粘性**的:只要曾定位到过任何候选(哪怕都不唯一),最终报的
 *    就是 "multiple matches" 而不是 "could not find"。这两条错误文案是给模型
 *    的自纠信号(补上下文 vs 重新读文件),不能混。
 * 4. isDisproportionateMatch 命中是 **throw 中止**,不是 continue —— 宁可让
 *    模型重来,也不能静默删掉几十行。
 */

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>

const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65

export const ERR_IDENTICAL = "No changes to apply: oldString and newString are identical."
export const ERR_EMPTY_OLD =
  "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement."
export const ERR_NOT_FOUND =
  "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings."
export const ERR_MULTIPLE =
  "Found multiple matches for oldString. Provide more surrounding context to make the match unique."
export const ERR_DISPROPORTIONATE =
  "Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement."

// ─────────────────────────────────────────────────────── 工具函数

function levenshtein(a: string, b: string): number {
  if (a === "" || b === "") return Math.max(a.length, b.length)
  const matrix: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i++) {
    const rowPrev = matrix[i - 1]!
    const row = matrix[i]!
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row[j] = Math.min(rowPrev[j]! + 1, row[j - 1]! + 1, rowPrev[j - 1]! + cost)
    }
  }
  return matrix[a.length]![b.length]!
}

/**
 * 把「第 startLine..endLine 行」还原成原文里的真实 substring。
 *
 * split("\n") 再对连续区间 join("\n") 逐字等于原文,所以不需要像原实现那样
 * 手算字节偏移 —— 那套偏移累加只是为了拿下标,而我们要的就是文本本身。
 */
function sliceLines(lines: string[], startLine: number, endLine: number): string {
  return lines.slice(startLine, endLine + 1).join("\n")
}

/** 每个非空行去掉公共最小缩进。 */
function removeIndentation(text: string): string {
  const lines = text.split("\n")
  const indents = lines.filter((l) => l.trim().length > 0).map((l) => l.length - l.trimStart().length)
  const min = indents.length > 0 ? Math.min(...indents) : 0
  if (min === 0) return text
  return lines.map((l) => (l.trim().length > 0 ? l.slice(min) : l)).join("\n")
}

// ─────────────────────────────────────────────────────── 四级 Replacer

/** 1. 精确匹配。不在原文里会被外层 indexOf 过滤掉。 */
export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

/**
 * 2. 逐行 trim 后比对。解决整体缩进错、行尾多空格。
 *    可能产出多个候选(外层会用唯一性检查筛)。
 */
export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")
  if (searchLines.at(-1) === "") searchLines.pop()
  if (searchLines.length === 0) return

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j]!.trim() !== searchLines[j]!.trim()) {
        matches = false
        break
      }
    }
    if (matches) yield sliceLines(originalLines, i, i + searchLines.length - 1)
  }
}

/**
 * 3. 首尾行当锚点 + 中间行 Levenshtein 相似度。
 *    解决「模型只记得函数的头尾,中间凭印象重写」。最强也最危险的一级 ——
 *    误伤全靠 isDisproportionateMatch 兜。
 */
export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")
  // 注意:长度判断在 pop 之前,所以 "a\nb\n" 切出 3 段能过关
  if (searchLines.length < 3) return
  if (searchLines.at(-1) === "") searchLines.pop()

  const firstLineSearch = searchLines[0]!.trim()
  const lastLineSearch = searchLines.at(-1)!.trim()
  const searchBlockSize = searchLines.length
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25))

  const candidates: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i]!.trim() !== firstLineSearch) continue
    // j 从 i+2 起 —— 候选块至少 3 行
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j]!.trim() === lastLineSearch) {
        const actualBlockSize = j - i + 1
        if (Math.abs(actualBlockSize - searchBlockSize) <= maxLineDelta) {
          candidates.push({ startLine: i, endLine: j })
        }
        break // 每个起点只取最近的一个收尾锚
      }
    }
  }
  if (candidates.length === 0) return

  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]!
    const actualBlockSize = endLine - startLine + 1
    let similarity = 0
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2)
    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j]!.trim()
        const searchLine = searchLines[j]!.trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) continue // 空行不贡献分子,但仍占分母
        similarity += (1 - levenshtein(originalLine, searchLine) / maxLen) / linesToCheck
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) break // 够了就不算了
      }
    } else {
      similarity = 1.0 // 块太小没有中间行可比,直接接受
    }
    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      yield sliceLines(originalLines, startLine, endLine)
    }
    return
  }

  // 多候选:全部算完取最高分,不提前退出
  let best: { startLine: number; endLine: number } | undefined
  let bestSimilarity = 0
  for (const candidate of candidates) {
    const actualBlockSize = candidate.endLine - candidate.startLine + 1
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2)
    let similarity = 0
    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[candidate.startLine + j]!.trim()
        const searchLine = searchLines[j]!.trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) continue
        similarity += 1 - levenshtein(originalLine, searchLine) / maxLen
      }
      similarity /= linesToCheck
    } else {
      similarity = 1.0
    }
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity
      best = candidate
    }
  }
  if (best && bestSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD) {
    yield sliceLines(originalLines, best.startLine, best.endLine)
  }
}

/**
 * 4. 所有空白折叠成单空格后比对。解决「行**内**空白被规整」——
 *    `foo(  a,  b )` vs `foo( a, b )`。第 2 级只 trim 首尾,管不了行内。
 */
export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim()
  const normalizedFind = normalize(find)
  const originalLines = content.split("\n")

  // (a) 单行:整行归一后相等,或行内包含
  for (const line of originalLines) {
    if (normalize(line) === normalizedFind) {
      yield line
      continue
    }
    if (normalize(line).includes(normalizedFind)) {
      const pattern = find
        .trim()
        .split(/\s+/)
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\s+")
      const hit = line.match(new RegExp(pattern))
      if (hit) yield hit[0]
    }
  }

  // (b) 多行:等行数窗口整体归一后比对
  const searchLines = find.split("\n")
  if (searchLines.length > 1) {
    for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
      const block = originalLines.slice(i, i + searchLines.length).join("\n")
      if (normalize(block) === normalizedFind) yield block
    }
  }
}

/**
 * 5. 掐掉 oldString 首尾的空白再找。解决「模型多带了前导/尾随空行」——
 *    第 2 级只 pop 掉**一个**尾部空行,管不了前导空行。
 */
export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmed = find.trim()
  if (trimmed === find) return // 与第 1 级重复,不做无用功
  if (content.includes(trimmed)) yield trimmed

  const originalLines = content.split("\n")
  const searchLines = find.split("\n")
  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    const block = originalLines.slice(i, i + searchLines.length).join("\n")
    if (block.trim() === trimmed) yield block
  }
}

/**
 * 「去掉公共缩进后比对」这一级(opencode 的 IndentationFlexibleReplacer)**没有装**。
 *
 * 原因:它被第 2 级 LineTrimmedReplacer 完全遮蔽。LineTrimmed 逐行 trim() 后
 * 比对,对缩进的容忍严格覆盖「只去掉公共最小缩进」,而且还多容忍行尾空白。
 * 在 opencode 里这一级也排在 LineTrimmed 之后,同样不可达。
 * 保留 removeIndentation() 供将来插入 ContextAware 之类的级别时复用。
 */

/**
 * 级联顺序:严 → 松。每一级都要能覆盖前面级别的盲区,否则就是死代码。
 *
 * 未实装(需要时按此顺序插回来):
 *   EscapeNormalized —— 模型把 "\n" 写成字面反斜杠 n。真实发生率低,先不装。
 *   ContextAware     —— 行数严格相等 + 中间行精确相等率 ≥ 0.5。它比 BlockAnchor
 *                       严,但会放大误伤面,装它之前 isDisproportionateMatch
 *                       必须先有测试覆盖。
 *   IndentationFlexible / MultiOccurrence —— 均为死代码,见上文说明,不要加。
 */
const REPLACERS: Replacer[] = [
  SimpleReplacer,
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  WhitespaceNormalizedReplacer,
  TrimmedBoundaryReplacer,
]

/**
 * 防大范围误删:匹配到的片段相对 oldString 明显膨胀时,拒绝替换。
 *
 * ⚠ 在**当前**这五级级联下它其实不可达,别误以为它在保护你:
 *   - 行数分支:BlockAnchor 的 maxLineDelta(≤ 25% 行数差)已经把行数膨胀
 *     挡在候选收集阶段了,永远到不了 old+3 / old×2 的门槛。
 *   - 字符数分支:要先过 BlockAnchor 0.65 的相似度门槛,而一个字符数膨胀
 *     4 倍的块过不去。
 * 它是给 ContextAware 那种「行数相等但内容可以差很多」的松级别准备的保险。
 * 装那一级之前,这个函数必须先有覆盖 —— 所以现在保留 + 单测,而不是删掉。
 */
export function isDisproportionateMatch(search: string, oldString: string): boolean {
  const oldLines = oldString.split("\n").length
  const searchLines = search.split("\n").length
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true
  if (oldLines === 1) return false // 单行不走字符数判据,避免长行被误伤
  return search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4)
}

export interface ReplaceResult {
  content: string
  /** 命中的是第几级(0-based),用于 metadata 与调试。 */
  replacerIndex: number
  replacements: number
}

export function replace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): ReplaceResult {
  // 顺序重要:identical 检查必须在 empty 之前,
  // 否则 {oldString:"", newString:""} 会报错误的那条
  if (oldString === newString) throw new Error(ERR_IDENTICAL)
  if (oldString === "") throw new Error(ERR_EMPTY_OLD)

  let notFound = true

  for (let index = 0; index < REPLACERS.length; index++) {
    const replacer = REPLACERS[index]!
    for (const search of replacer(content, oldString)) {
      // ★ 空候选必须在这儿挡掉,而不是靠入口那句 `oldString === ""`。
      //
      //   入口挡的是**用户传空**,挡不住**级联自己产出空候选**:
      //   LineTrimmedReplacer 拿 `"\t"` 去逐行 trim 比对时,`"\t".trim()` 和
      //   空行的 `"".trim()` 相等 —— 于是每一个空行都"匹配上了",而它交出来的
      //   候选串是 `""`。接着 `"".indexOf` 恒为 0(看着像找到了),
      //   `replaceAll("", x)` 会在**每两个字符之间**插一份 x。
      //
      //   真实触发路径不需要任何恶意输入:"把 tab 换成空格" + 文件里已经没有
      //   tab 但有空行,就够了。而 edit 是默认放行的,用户看到的是
      //   "Edit applied successfully. Replacements: 18",文件已经碎了。
      if (search === "") continue
      const at = content.indexOf(search)
      if (at === -1) continue
      notFound = false

      if (isDisproportionateMatch(search, oldString)) throw new Error(ERR_DISPROPORTIONATE)

      if (replaceAll) {
        // 注意:替换的是**候选串**的所有出现,不是 oldString 的
        const count = content.split(search).length - 1
        return { content: content.replaceAll(search, newString), replacerIndex: index, replacements: count }
      }

      // 不唯一就换下一个候选/下一级,不是硬失败
      if (at !== content.lastIndexOf(search)) continue

      return {
        content: content.slice(0, at) + newString + content.slice(at + search.length),
        replacerIndex: index,
        replacements: 1,
      }
    }
  }

  throw new Error(notFound ? ERR_NOT_FOUND : ERR_MULTIPLE)
}
