/**
 * Markdown → 终端。
 *
 * ── 为什么是「流式」而不是一个 render(text) ──
 * 模型的文本是一个 token 一个 token 来的,而 markdown 的语义要到**行**才定得下来:
 * `#` 可能是标题也可能是井号本身,` ``` ` 之后的每一行含义都变了。所以这里按行
 * 定稿:凑齐一整行就渲染、提交;没凑齐的那部分单独交出去当预览。
 *
 * ── 半行必须能重画 ──
 * `**bo` 不是粗体,`**bold**` 才是。所以未定稿的那部分不能"写下去就算了",
 * 它每帧都要按当前内容重新渲染一遍。OutputSink.replaceTail 就是为这个开的口子。
 *
 * ── 表格要攒 ──
 * 列宽必须看过所有行才知道,一行一行往外吐就永远对不齐。所以表格整块缓冲,
 * 遇到第一个非表格行(或者收尾)才排版吐出。攒着的时候按原样显示在预览里,
 * 用户看得见它在长,不会以为卡住了。
 *
 * ── 不做的事 ──
 * 不折行。折行是 sink 的事 —— 这里吐出来的是**逻辑行**,窗口一变、侧栏一收,
 * 由 sink 按新宽度重折。要是在这里就折死,历史会永远僵在旧宽度上。
 * 也因此不用知道终端多宽:表格列宽来自内容,分隔线用固定长度。
 */
import { Highlighter, languageFor } from "./highlight.ts"
import { theme } from "./theme.ts"
import { displayWidth, truncateToWidth } from "./width.ts"

/** 各层列表的项目符号。四层以上不再区分 —— 再深的嵌套本身就该重写了。 */
const BULLETS = ["•", "◦", "▪", "‣"] as const
/** 代码块的左边槽。宽度 4,续行缩进靠它对齐(见 transcript.ts 的 hanging)。 */
const CODE_GUTTER = "  │ "
/** 分隔线长度。用固定值而不是终端宽度:已经提交的行不会因为改窗口而重排。 */
const RULE = 24
/** 表格单元格的宽度上限。一个超长单元格能把整张表挤得没法看。 */
const MAX_CELL = 36

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/
const HR = /^[ \t]{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/
const LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/
const QUOTE = /^[ \t]{0,3}((?:>[ \t]?)+)(.*)$/
const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})[ \t]*([^\s`]*)/
const TASK = /^\[([ xX])\][ \t]+(.*)$/

interface Fence {
  /** ` 或 ~ */
  char: string
  /** 开启用了几个 —— 关闭必须同种且不短于它 */
  length: number
  /** 开启那行的缩进。代码行按它剥掉,列表里的代码块才不会整体右移 */
  indent: number
  /**
   * 这一段代码的高亮器。围栏没写语言、或者写了个不认识的,它就是个直通管道。
   *
   * 每个围栏一个:块注释和多行字符串的状态只在本段内接续,不能漏给下一段。
   */
  painter: Highlighter
}

/**
 * 一段 markdown 文本的流式渲染器。
 *
 * 用法:push 喂增量 → drain 取已定稿的行 → preview 取还没定稿的部分。
 * 一段结束时调 end(),它把缓冲里剩下的全部定稿并把状态复位。
 */
export class MarkdownStream {
  /** 还没等到换行的那一段 */
  private buffer = ""
  /** 已定稿、等着被 drain 取走的行 */
  private out: string[] = []
  private fence: Fence | undefined
  /** 攒着的表格行(原文) */
  private held: string[] = []
  /** 上一条定稿行是不是空行 —— 标题前要留白,但不要留两条 */
  private lastBlank = true

  /** 什么都没在手上。收尾时用它跳过无谓的写入。 */
  get idle(): boolean {
    return this.buffer.length === 0 && this.out.length === 0 && this.held.length === 0
  }

  push(delta: string): void {
    if (delta.length === 0) return
    this.buffer += delta
    let at = this.buffer.indexOf("\n")
    while (at !== -1) {
      this.feed(this.buffer.slice(0, at))
      this.buffer = this.buffer.slice(at + 1)
      at = this.buffer.indexOf("\n")
    }
  }

  /** 取走已定稿的行。 */
  drain(): string[] {
    if (this.out.length === 0) return []
    const lines = this.out
    this.out = []
    return lines
  }

  /**
   * 还没定稿的部分长什么样。**每帧都要重取** —— 它会随着后面的字符改变。
   * 可能是多行(表格攒着的时候)。
   */
  preview(): string {
    const lines: string[] = []
    for (const row of this.held) lines.push(theme.dim(row))
    if (this.buffer.length > 0) {
      // peek 而不是 line:这半行每帧都会重画一遍,推进状态的话块注释会被
      // 反复"进入",定稿时整段代码全变成注释色
      if (this.fence)
        lines.push(theme.dim(CODE_GUTTER) + this.fence.painter.peek(unindent(this.buffer, this.fence.indent)))
      // 攒表格时半行也按原样显示,和上面那些保持一致
      else if (this.held.length > 0 || FENCE_OPEN.test(this.buffer)) lines.push(theme.dim(this.buffer))
      else lines.push(renderLine(this.buffer))
    }
    return lines.join("\n")
  }

  /** 收尾:把缓冲里所有东西定稿,状态复位。返回值包含 drain 还没取走的行。 */
  end(): string[] {
    if (this.buffer.length > 0) {
      this.feed(this.buffer)
      this.buffer = ""
    }
    this.flushTable()
    const lines = this.out
    this.out = []
    this.fence = undefined
    this.lastBlank = true
    return lines
  }

  // ───────────────────────────────────────────── 内部

  private feed(raw: string): void {
    // \r\n 的 \r 留着会在行尾变成一个把光标拉回行首的控制字符
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw

    if (this.fence) {
      if (closesFence(line, this.fence)) {
        this.fence = undefined
        return
      }
      this.emit(theme.dim(CODE_GUTTER) + this.fence.painter.line(unindent(line, this.fence.indent)))
      return
    }

    const open = FENCE_OPEN.exec(line)
    if (open) {
      this.flushTable()
      const lang = open[3] ?? ""
      this.fence = {
        char: open[2]![0]!,
        length: open[2]!.length,
        indent: open[1]!.length,
        painter: new Highlighter(languageFor(lang)),
      }
      if (lang.length > 0) this.emit(theme.dim("  " + lang))
      return
    }

    if (isTableRow(line)) {
      this.held.push(line)
      return
    }
    this.flushTable()

    if (line.trim().length === 0) {
      // 连着的空行压成一条。模型很爱在段落之间放两三个换行,原样照搬会把
      // 一屏内容撑成两屏
      if (!this.lastBlank) this.emit("")
      return
    }

    const heading = HEADING.exec(line)
    if (heading) {
      if (!this.lastBlank) this.emit("")
      this.emit(renderHeading(heading[1]!.length, heading[2]!))
      return
    }

    this.emit(renderLine(line))
  }

  private emit(line: string): void {
    this.out.push(line)
    this.lastBlank = line.length === 0
  }

  private flushTable(): void {
    if (this.held.length === 0) return
    const rows = this.held
    this.held = []
    for (const line of renderTable(rows)) this.emit(line)
  }
}

// ───────────────────────────────────────────── 块

/** 一行(不含围栏切换和表格)渲染成一行。纯函数,预览也走它。 */
export function renderLine(line: string): string {
  if (line.trim().length === 0) return ""

  const heading = HEADING.exec(line)
  if (heading) return renderHeading(heading[1]!.length, heading[2]!)

  // HR 必须排在列表前面:`---` 和 `***` 都能被 LIST 的 `[-*+]` 咬到一半
  if (HR.test(line)) return theme.dim("─".repeat(RULE))

  const quote = QUOTE.exec(line)
  if (quote) {
    const depth = (quote[1]!.match(/>/g) ?? []).length
    return theme.dim("│ ".repeat(depth)) + theme.dim(renderInline(quote[2] ?? ""))
  }

  const list = LIST.exec(line)
  if (list) return renderListItem(list[1]!, list[2]!, list[3]!)

  return renderInline(line)
}

function renderHeading(level: number, text: string): string {
  const painted = renderInline(text)
  if (level === 1) return theme.bold(theme.cyan(painted))
  if (level === 2) return theme.bold(painted)
  return theme.bold(theme.dim(painted))
}

function renderListItem(indent: string, marker: string, rest: string): string {
  // tab 当两格算,不然缩进层级会算成 0
  const spaces = indent.replace(/\t/g, "  ")
  const level = Math.min(BULLETS.length - 1, Math.floor(spaces.length / 2))

  const task = TASK.exec(rest)
  if (task) {
    const done = task[1] !== " "
    const box = done ? theme.green("☑") : theme.dim("☐")
    const body = renderInline(task[2] ?? "")
    return spaces + box + " " + (done ? theme.dim(body) : body)
  }

  const ordered = /^\d/.test(marker)
  const bullet = ordered ? theme.cyan(marker) : theme.cyan(BULLETS[level]!)
  return spaces + bullet + " " + renderInline(rest)
}

function closesFence(line: string, fence: Fence): boolean {
  const trimmed = line.trim()
  if (trimmed.length < fence.length) return false
  for (const char of trimmed) if (char !== fence.char) return false
  return true
}

/** 剥掉最多 n 列缩进。代码里的相对缩进必须原样留着。 */
function unindent(line: string, n: number): string {
  let i = 0
  while (i < n && (line[i] === " " || line[i] === "\t")) i++
  return line.slice(i)
}

// ───────────────────────────────────────────── 表格

/**
 * 只认「以 | 开头」的行。
 *
 * GFM 允许省掉首尾竖线(`a | b`),但那样一句带竖线的普通话就会被当成表格 ——
 * 而表格是要攒起来的,普通句子被攒住就等于凭空卡一行不显示。宁可少认。
 */
function isTableRow(line: string): boolean {
  const t = line.trim()
  return t.startsWith("|") && t.length > 1
}

const SEP_CELL = /^:?-+:?$/
type Align = "left" | "right" | "center"

function splitRow(line: string): string[] {
  let t = line.trim()
  if (t.startsWith("|")) t = t.slice(1)
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1)
  const cells: string[] = []
  let cur = ""
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!
    if (ch === "\\" && t[i + 1] === "|") {
      cur += "|"
      i++
      continue
    }
    if (ch === "|") {
      cells.push(cur.trim())
      cur = ""
      continue
    }
    cur += ch
  }
  cells.push(cur.trim())
  return cells
}

/**
 * 排版一张表。第二行不是分隔行就说明这压根不是表格(模型有时写一半就跑了),
 * 那就退回按普通行渲染 —— 不能因为认错格式就把内容吞掉。
 */
function renderTable(rows: string[]): string[] {
  const plain = () => rows.map(renderLine)
  if (rows.length < 2) return plain()

  const sep = splitRow(rows[1]!)
  if (sep.length === 0 || !sep.every((cell) => SEP_CELL.test(cell))) return plain()

  const align: Align[] = sep.map((cell) =>
    cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left",
  )
  const raw = [splitRow(rows[0]!), ...rows.slice(2).map(splitRow)]
  const cols = raw.reduce((max, row) => Math.max(max, row.length), 1)

  const cells = raw.map((row) => {
    const out: string[] = []
    for (let c = 0; c < cols; c++) out.push(renderInline(truncateToWidth(row[c] ?? "", MAX_CELL)))
    return out
  })

  const widths: number[] = []
  for (let c = 0; c < cols; c++) {
    let width = 1
    for (const row of cells) width = Math.max(width, displayWidth(row[c]!))
    widths.push(width)
  }

  const bar = theme.dim("│")
  const row = (cell: string[], head: boolean): string =>
    "  " +
    cell
      .map((text, c) => align_(head ? theme.bold(text) : text, widths[c]!, align[c] ?? "left"))
      .join(" " + bar + " ")
      .trimEnd()
  const rule = "  " + theme.dim(widths.map((w) => "─".repeat(w)).join("─┼─"))

  return [row(cells[0]!, true), rule, ...cells.slice(1).map((cell) => row(cell, false))]
}

function align_(text: string, width: number, align: Align): string {
  const gap = width - displayWidth(text)
  if (gap <= 0) return text
  if (align === "right") return " ".repeat(gap) + text
  if (align === "center") {
    const left = gap >> 1
    return " ".repeat(left) + text + " ".repeat(gap - left)
  }
  return text + " ".repeat(gap)
}

// ───────────────────────────────────────────── 行内

/** 反斜杠能转义的标点。转义之后那个字符必须原样输出,不能再参与解析。 */
const PUNCT = /[\\`*_{}[\]()#+\-.!~|<>]/
const WORD = /[\p{L}\p{N}]/u
const LINK = /^\[([^\]]*)\]\([ \t]*<?([^)\s>]*)>?(?:[ \t]+"[^"]*")?[ \t]*\)/
const AUTOLINK = /^<((?:https?|mailto):[^>\s]+)>/
const BARE_URL = /^(?:https?:\/\/|www\.)[^\s<>()[\]"'`]+/

export function renderInline(text: string): string {
  return inline(text, 0)
}

/** depth 只用来兜底防递归爆栈,格式本身没有层数上限的概念。 */
function inline(text: string, depth: number): string {
  let out = ""
  let i = 0
  while (i < text.length) {
    const ch = text[i]!

    if (ch === "\\" && i + 1 < text.length && PUNCT.test(text[i + 1]!)) {
      out += text[i + 1]
      i += 2
      continue
    }

    // 代码跨度优先级最高:里面的 * _ 都是字面量
    if (ch === "`") {
      const code = matchCode(text, i)
      if (code) {
        out += theme.code(code.text)
        i = code.end
        continue
      }
    }

    if (ch === "!" && text[i + 1] === "[") {
      const link = LINK.exec(text.slice(i + 1))
      if (link) {
        const label = link[1] ?? ""
        out += theme.dim("[image") + (label.length > 0 ? theme.dim(" " + label) : "") + theme.dim("]")
        i += 1 + link[0].length
        continue
      }
    }

    if (ch === "[") {
      const link = LINK.exec(text.slice(i))
      if (link) {
        out += renderLink(link[1] ?? "", link[2] ?? "", depth)
        i += link[0].length
        continue
      }
    }

    if (ch === "<") {
      const auto = AUTOLINK.exec(text.slice(i))
      if (auto) {
        out += theme.cyan(theme.underline(auto[1]!))
        i += auto[0].length
        continue
      }
    }

    // 裸链接。前一个字符是词的一部分时不算 —— 那多半是 `foo.www.bar` 这种
    if ((ch === "h" || ch === "w") && (i === 0 || !/[\w/@.-]/.test(text[i - 1]!))) {
      const bare = BARE_URL.exec(text.slice(i))
      if (bare) {
        out += theme.cyan(theme.underline(bare[0]))
        i += bare[0].length
        continue
      }
    }

    if (depth < 4) {
      const em = matchEmphasis(text, i)
      if (em) {
        out += em.style(inline(em.text, depth + 1))
        i = em.end
        continue
      }
    }

    out += ch
    i++
  }
  return out
}

function renderLink(label: string, url: string, depth: number): string {
  const shown = label.length > 0 ? inline(label, depth + 1) : url
  const painted = theme.cyan(theme.underline(shown))
  // 终端里点不动链接,所以地址得看得见 —— 但和标题一样时就别说两遍
  if (label.length === 0 || label === url) return painted
  return painted + theme.dim(" (" + url + ")")
}

/** `` `code` ``:开合的反引号数量必须相等。 */
function matchCode(text: string, i: number): { text: string; end: number } | undefined {
  let n = 0
  while (text[i + n] === "`") n++
  const fence = "`".repeat(n)
  let from = i + n
  while (from < text.length) {
    const at = text.indexOf(fence, from)
    if (at === -1) return undefined
    if (text[at + n] === "`") {
      // 更长的一串,不是它的闭合
      let k = at
      while (text[k] === "`") k++
      from = k
      continue
    }
    let content = text.slice(i + n, at)
    // CommonMark:两端各有一个空格时脱掉一层,`` ` `` 才能表示一个反引号
    if (content.length > 2 && content.startsWith(" ") && content.endsWith(" ")) content = content.slice(1, -1)
    return { text: content, end: at + n }
  }
  return undefined
}

interface Emphasis {
  text: string
  end: number
  style(text: string): string
}

/**
 * `**粗**` / `*斜*` / `~~删~~`。
 *
 * 两条规矩挡住绝大多数误判:
 *   - 定界符内侧不能是空白 —— 不然 `2 * 3 * 4` 会变成斜体
 *   - `_` 不能在词内部生效 —— 不然 `snake_case_name` 会变成斜体
 */
function matchEmphasis(text: string, i: number): Emphasis | undefined {
  const ch = text[i]!
  if (ch !== "*" && ch !== "_" && ch !== "~") return undefined

  // 连着几个决定是什么。`***x***` 要整串一起吃 —— 按 `**` 开头去找闭合的话,
  // 闭合会落在那三个星号的**头两个**上,剩一个孤零零地漏在外面
  let run = 0
  while (text[i + run] === ch) run++
  if (ch === "~" && run < 2) return undefined
  const delim = ch.repeat(Math.min(run, 3))
  if (ch === "_" && i > 0 && WORD.test(text[i - 1]!)) return undefined

  const from = i + delim.length
  if (from >= text.length) return undefined
  if (/\s/.test(text[from]!)) return undefined

  const close = findClose(text, from, delim, ch)
  if (close === -1) return undefined
  const inner = text.slice(from, close)
  if (inner.length === 0) return undefined
  const end = close + delim.length
  if (ch === "_" && end < text.length && WORD.test(text[end]!)) return undefined

  const style =
    ch === "~"
      ? theme.strike
      : delim.length === 3
        ? (body: string) => theme.bold(theme.italic(body))
        : delim.length === 2
          ? theme.bold
          : theme.italic
  return { text: inner, end, style }
}

function findClose(text: string, from: number, delim: string, ch: string): number {
  for (let j = from; j + delim.length <= text.length; j++) {
    if (text[j] === "\\") {
      j++
      continue
    }
    if (text[j] === "`") {
      const code = matchCode(text, j)
      if (code) {
        j = code.end - 1
        continue
      }
    }
    if (!text.startsWith(delim, j)) continue
    // 单字符定界时撞上 `**`:那是另一码事,跳过去
    if (delim.length === 1 && text[j + 1] === ch) {
      j++
      continue
    }
    if (/\s/.test(text[j - 1] ?? " ")) continue
    return j
  }
  return -1
}
