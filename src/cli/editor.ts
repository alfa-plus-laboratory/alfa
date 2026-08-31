/**
 * 行编辑器。
 *
 * readline 在这里用不了 —— 它要独占光标和那一行,而我们要在它下面钉一个每帧
 * 重画的活动区,两边会抢。所以自己写一个。
 *
 * 状态机是**纯的**:进去一个按键,出来新状态和一个可选动作,不碰终端、不碰
 * 时间、不碰全局。所以它能被完整单测 —— 喂一串按键,断言 buffer 长什么样。
 * 光标位置和折行这类最容易错的东西,靠测试盯着,不靠在真终端上肉眼看。
 *
 * ── 换行还是提交 ──
 * Enter 提交,Ctrl-J / Alt-Enter / Shift-Enter 插入换行,行尾一个反斜杠也当
 * 续行(和 shell 一致)。粘贴进来的换行**永远是文本**,不是提交 —— 这靠
 * keyboard.ts 的括号粘贴,不靠猜。
 */
import type { Key } from "./keys.ts"
import { charWidth, displayWidth, padToWidth, truncateToWidth } from "./width.ts"

export type EditorAction =
  | { type: "submit"; text: string }
  /** Ctrl-C。怎么处理要看上层忙不忙,编辑器自己不知道 */
  | { type: "interrupt"; hasText: boolean }
  /** Esc */
  | { type: "escape"; hasText: boolean }
  /** 输入为空时的 Ctrl-D */
  | { type: "eof" }

export class Editor {
  text = ""
  /** 插入点,text 里的 char 下标(不是显示列) */
  cursor = 0

  private readonly history: string[]
  /** 正在翻历史时指向 history 的下标;-1 表示没在翻 */
  private historyAt = -1
  /** 开始翻历史之前手上那半句,翻回来要还给用户 */
  private draft = ""

  constructor(history: string[] = []) {
    this.history = [...history]
  }

  get empty(): boolean {
    return this.text.trim().length === 0
  }

  clear(): void {
    this.text = ""
    this.cursor = 0
    this.historyAt = -1
    this.draft = ""
  }

  setText(text: string): void {
    this.text = text
    this.cursor = text.length
  }

  remember(text: string): void {
    if (text.trim().length === 0) return
    // 连着敲同一句不重复记 —— 否则 ↑ 要按十下才翻过去
    if (this.history[this.history.length - 1] === text) return
    this.history.push(text)
  }

  /**
   * @param width 输入框的内宽。上下键要按**屏幕行**走而不是逻辑行 —— 粘进来
   *   一整段没有换行的文字会折成好几行,按 ↑ 应该在这几行里上移,而不是一步
   *   跳去翻历史。不传就退化成按逻辑行走(测试里这样更好写)。
   */
  handle(key: Key, width = Number.POSITIVE_INFINITY): EditorAction | undefined {
    if (key.name === "paste") return this.paste(key.text ?? "")

    if (key.ctrl) return this.control(key)
    if (key.meta) return this.alt(key)

    switch (key.name) {
      case "enter":
        return this.submit()
      case "backspace":
        this.deleteBackward()
        return undefined
      case "delete":
        this.deleteForward()
        return undefined
      case "left":
        this.cursor = prevBoundary(this.text, this.cursor)
        return undefined
      case "right":
        this.cursor = nextBoundary(this.text, this.cursor)
        return undefined
      case "home":
        this.cursor = lineStart(this.text, this.cursor)
        return undefined
      case "end":
        this.cursor = lineEnd(this.text, this.cursor)
        return undefined
      case "up":
        return this.up(width)
      case "down":
        return this.down(width)
      case "escape":
        return { type: "escape", hasText: !this.empty }
      case "tab":
        // 制表符会把宽度算乱,也没法在框里对齐。展开成两个空格,
        // 所见即所得。将来做补全的话这里就是入口。
        this.insert("  ")
        return undefined
      case "pageup":
      case "pagedown":
      case "insert":
      case "clear":
      case "unknown":
        return undefined
      default:
        // 普通字符(可能是「中」这种多字节的)
        if (key.name.length > 0) this.insert(key.name)
        return undefined
    }
  }

  // ───────────────────────────────────────────── 按键分派

  private control(key: Key): EditorAction | undefined {
    switch (key.name) {
      case "c":
        return { type: "interrupt", hasText: this.text.length > 0 }
      case "d":
        if (this.text.length === 0) return { type: "eof" }
        this.deleteForward()
        return undefined
      case "j":
        this.insert("\n")
        return undefined
      case "m":
        // 有些终端把 Enter 送成 Ctrl-M
        return this.submit()
      case "a":
        this.cursor = lineStart(this.text, this.cursor)
        return undefined
      case "e":
        this.cursor = lineEnd(this.text, this.cursor)
        return undefined
      case "b":
        this.cursor = prevBoundary(this.text, this.cursor)
        return undefined
      case "f":
        this.cursor = nextBoundary(this.text, this.cursor)
        return undefined
      case "k":
        this.text = this.text.slice(0, this.cursor) + this.text.slice(lineEnd(this.text, this.cursor))
        return undefined
      case "u": {
        const start = lineStart(this.text, this.cursor)
        this.text = this.text.slice(0, start) + this.text.slice(this.cursor)
        this.cursor = start
        return undefined
      }
      case "w":
        this.deleteWordBackward()
        return undefined
      case "l":
        return undefined // 清屏交给上层
      case "left":
        this.cursor = wordLeft(this.text, this.cursor)
        return undefined
      case "right":
        this.cursor = wordRight(this.text, this.cursor)
        return undefined
      default:
        return undefined
    }
  }

  private alt(key: Key): EditorAction | undefined {
    switch (key.name) {
      case "enter":
        this.insert("\n")
        return undefined
      case "backspace":
        this.deleteWordBackward()
        return undefined
      case "b":
      case "left":
        this.cursor = wordLeft(this.text, this.cursor)
        return undefined
      case "f":
      case "right":
        this.cursor = wordRight(this.text, this.cursor)
        return undefined
      case "d": {
        const to = wordRight(this.text, this.cursor)
        this.text = this.text.slice(0, this.cursor) + this.text.slice(to)
        return undefined
      }
      default:
        return undefined
    }
  }

  // ───────────────────────────────────────────── 编辑动作

  private insert(chunk: string): void {
    this.text = this.text.slice(0, this.cursor) + chunk + this.text.slice(this.cursor)
    this.cursor += chunk.length
    this.historyAt = -1
  }

  /**
   * 粘贴。整块当文本插进去,里面的换行不触发提交。
   *
   * CRLF 要归一 —— 从浏览器或 Windows 那边粘过来常带 \r,留着的话它是个宽度
   * 为 0 的字符,光标算出来的位置和眼睛看到的对不上。
   */
  private paste(text: string): undefined {
    const normalized = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ")
    if (normalized.length > 0) this.insert(normalized)
    return undefined
  }

  private submit(): EditorAction | undefined {
    // 行尾反斜杠 = 续行,和 shell 一样
    if (this.text.endsWith("\\") && this.cursor === this.text.length) {
      this.text = this.text.slice(0, -1) + "\n"
      this.cursor = this.text.length
      return undefined
    }
    if (this.empty) {
      // 全是空白就当没输入,但要把它清掉,免得下一句接在空格后面
      this.clear()
      return undefined
    }
    const text = this.text
    this.remember(text)
    this.clear()
    return { type: "submit", text }
  }

  private deleteBackward(): void {
    if (this.cursor === 0) return
    const start = prevBoundary(this.text, this.cursor)
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor)
    this.cursor = start
  }

  private deleteForward(): void {
    if (this.cursor >= this.text.length) return
    this.text = this.text.slice(0, this.cursor) + this.text.slice(nextBoundary(this.text, this.cursor))
  }

  private deleteWordBackward(): void {
    const start = wordLeft(this.text, this.cursor)
    if (start === this.cursor) return
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor)
    this.cursor = start
  }

  // ───────────────────────────────────────────── 上下键:先在框里移动,到头了才翻历史

  private up(width: number): undefined {
    const rows = layoutRows(this.text, width)
    const at = cursorPosition(rows, this.cursor)
    if (at.row > 0) {
      this.cursor = offsetAtColumn(rows[at.row - 1]!, at.col)
      return undefined
    }
    this.browse(-1)
    return undefined
  }

  private down(width: number): undefined {
    const rows = layoutRows(this.text, width)
    const at = cursorPosition(rows, this.cursor)
    if (at.row < rows.length - 1) {
      this.cursor = offsetAtColumn(rows[at.row + 1]!, at.col)
      return undefined
    }
    this.browse(1)
    return undefined
  }

  private browse(direction: -1 | 1): void {
    if (this.history.length === 0) return
    if (this.historyAt === -1) {
      if (direction === 1) return // 已经在最新一条(也就是草稿)上了
      this.draft = this.text
      this.historyAt = this.history.length - 1
    } else {
      const next = this.historyAt + direction
      if (next >= this.history.length) {
        // 翻回底,把草稿还回来
        this.historyAt = -1
        this.setText(this.draft)
        this.draft = ""
        return
      }
      if (next < 0) return
      this.historyAt = next
    }
    this.setText(this.history[this.historyAt] ?? "")
  }
}

// ───────────────────────────────────────────── 文本导航(纯函数)

/** 往左一个码位(别把代理对劈成两半)。 */
export function prevBoundary(text: string, index: number): number {
  if (index <= 0) return 0
  const before = text.slice(0, index)
  const chars = [...before]
  const last = chars[chars.length - 1] ?? ""
  return index - last.length
}

export function nextBoundary(text: string, index: number): number {
  if (index >= text.length) return text.length
  const point = text.codePointAt(index)
  return index + (point !== undefined && point > 0xffff ? 2 : 1)
}

export function lineStart(text: string, index: number): number {
  const at = text.lastIndexOf("\n", index - 1)
  return at === -1 ? 0 : at + 1
}

export function lineEnd(text: string, index: number): number {
  const at = text.indexOf("\n", index)
  return at === -1 ? text.length : at
}

const WORD = /[\p{L}\p{N}_]/u

export function wordLeft(text: string, index: number): number {
  let at = index
  while (at > 0 && !WORD.test(text[at - 1] ?? "")) at--
  while (at > 0 && WORD.test(text[at - 1] ?? "")) at--
  return at
}

export function wordRight(text: string, index: number): number {
  let at = index
  while (at < text.length && !WORD.test(text[at] ?? "")) at++
  while (at < text.length && WORD.test(text[at] ?? "")) at++
  return at
}

// ───────────────────────────────────────────── 折行与画框

export interface VisualRow {
  text: string
  /** 这一行第一个字符在原文里的下标 */
  start: number
}

/**
 * 把带换行的文本折成一行行「屏幕行」,并记住每行起点在原文里的下标 ——
 * 光标坐标要靠它反查,只有字符串是不够的。
 */
export function layoutRows(text: string, width: number): VisualRow[] {
  const rows: VisualRow[] = []
  const limit = Math.max(1, width)

  let base = 0
  for (const line of text.split("\n")) {
    let current = ""
    let start = base
    let used = 0
    let at = base
    for (const char of line) {
      const w = charWidth(char)
      if (used + w > limit && current.length > 0) {
        rows.push({ text: current, start })
        current = ""
        start = at
        used = 0
      }
      current += char
      used += w
      at += char.length
    }
    rows.push({ text: current, start })
    base += line.length + 1 // +1 是那个换行符
  }
  return rows
}

/** 某一屏幕行上、显示列 col 处对应原文的下标。双宽字符不劈开。 */
export function offsetAtColumn(row: VisualRow, col: number): number {
  let used = 0
  let at = row.start
  for (const char of row.text) {
    const w = charWidth(char)
    if (used + w > col) break
    used += w
    at += char.length
  }
  return at
}

/** 插入点落在哪一行的哪一列。 */
export function cursorPosition(rows: VisualRow[], cursor: number): { row: number; col: number } {
  let row = 0
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.start <= cursor) row = i
    else break
  }
  const line = rows[row]!
  return { row, col: displayWidth(line.text.slice(0, cursor - line.start)) }
}

export interface BoxStyle {
  /** 边框、提示符、占位符各自的上色函数 */
  border: (text: string) => string
  marker: (text: string) => string
  placeholder: (text: string) => string
}

export interface BoxInput {
  text: string
  cursor: number
  width: number
  style: BoxStyle
  placeholder?: string
  /** 框最多占几行。粘进来 500 行代码时靠它开一个跟着光标走的窗口。 */
  maxRows?: number
}

export interface Box {
  lines: string[]
  cursor: { row: number; col: number }
}

const MARKER = "› "
const MARKER_WIDTH = 2
/** 比这窄就不画框了 —— 框占掉 6 列,再窄下去里面剩不下几个字 */
const MIN_BOXED_WIDTH = 28
const DEFAULT_MAX_ROWS = 10

/**
 * 画输入框。返回的 lines 每行都保证不超过 width,光标坐标是相对 lines 的。
 *
 * 内宽是 width - 6:两侧边框 2 列、两侧留白 2 列、提示符 2 列。续行缩进对齐
 * 到提示符后面,这样多行输入看起来是一整块,而不是每行都顶格。
 */
export function renderBox(input: BoxInput): Box {
  const { text, cursor, width, style } = input

  if (width < MIN_BOXED_WIDTH) {
    const inner = Math.max(1, width - MARKER_WIDTH)
    const rows = layoutRows(text, inner)
    const at = cursorPosition(rows, cursor)
    return {
      lines: rows.map((row, i) => (i === 0 ? style.marker(MARKER) : "  ") + row.text),
      cursor: { row: at.row, col: MARKER_WIDTH + at.col },
    }
  }

  const inner = width - 6
  const rows = layoutRows(text, inner)
  const at = cursorPosition(rows, cursor)

  // 太长就开一个跟着光标走的窗口。整块塞进活动区会把上面的输出全顶掉,
  // 而活动区自己的截断是从顶上砍 —— 那会先砍掉上边框,看着像画烂了。
  const maxRows = Math.max(1, input.maxRows ?? DEFAULT_MAX_ROWS)
  const from = rows.length <= maxRows ? 0 : Math.min(Math.max(0, at.row - maxRows + 1), rows.length - maxRows)
  const visible = rows.slice(from, from + maxRows)

  const top = style.border("╭" + "─".repeat(width - 2) + "╮")
  const bottom = style.border(bottomBorder(width, rows.length > maxRows ? `${rows.length} lines` : undefined))
  const bar = style.border("│")

  const placeholder = text.length === 0 ? input.placeholder : undefined
  const body = visible.map((row, i) => {
    const lead = from + i === 0 ? style.marker(MARKER) : "  "
    const content = placeholder ? style.placeholder(truncateToWidth(placeholder, inner)) : row.text
    return bar + " " + lead + padToWidth(content, inner) + " " + bar
  })

  return {
    lines: [top, ...body, bottom],
    // +1 上边框,+2 「│ 」,+2 提示符
    cursor: { row: at.row - from + 1, col: 2 + MARKER_WIDTH + at.col },
  }
}

function bottomBorder(width: number, label?: string): string {
  if (!label) return "╰" + "─".repeat(width - 2) + "╯"
  const tag = ` ${label} `
  const fill = width - 2 - displayWidth(tag)
  if (fill < 2) return "╰" + "─".repeat(width - 2) + "╯"
  return "╰" + "─".repeat(fill - 1) + tag + "─" + "╯"
}
