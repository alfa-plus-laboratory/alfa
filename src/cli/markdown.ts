/**
 * Markdown → terminal.
 *
 * ── Why "streaming" instead of a render(text) ──
 * The model's text arrives one token at a time, while markdown semantics only settle
 * per **line**: `#` might be a heading or just a hash sign, and after ` ``` ` every line
 * means something different. So lines are finalized one at a time: once a whole line is
 * in, it's rendered and committed; the incomplete part is handed out separately as a
 * preview.
 *
 * ── The half line must be redrawable ──
 * `**bo` isn't bold, `**bold**` is. So the unfinalized part can't be "written and done
 * with"; it has to be re-rendered from its current content every frame.
 * OutputSink.replaceTail is the opening made for exactly this.
 *
 * ── Tables have to be accumulated ──
 * Column widths are only known after seeing every row; emitting row by row can never
 * line up. So a table is buffered whole, and laid out and emitted only at the first
 * non-table line (or at the end). While it accumulates it's shown as-is in the preview,
 * so the user can see it growing and doesn't think things are stuck.
 *
 * ── What it doesn't do ──
 * No wrapping. What comes out of here are **logical lines**; wrapping is left to whoever
 * shows them — in the scrollback that's the terminal itself, which reflows them when the
 * window changes (the live area only wraps the unfinished half line, see live.ts). Wrap
 * them for good here and history would stay frozen at the old width forever. That's also
 * why this doesn't need to know the terminal width: table column widths come from
 * content, and the rule line has a fixed length.
 */
import { Highlighter, languageFor } from "./highlight.ts"
import { theme } from "./theme.ts"
import { displayWidth, truncateToWidth } from "./width.ts"

/**
 * Bullet for each list level. No distinction past four levels — nesting that deep
 * should be rewritten anyway.
 */
const BULLETS = ["•", "◦", "▪", "‣"] as const
/** Left gutter of a code block. Width 4. */
const CODE_GUTTER = "  │ "
/**
 * Length of a horizontal rule. A fixed value, not the terminal width: committed lines
 * aren't re-laid out when the window changes.
 */
const RULE = 24
/** Width cap for a table cell. One overlong cell can squash the whole table unreadable. */
const MAX_CELL = 36

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/
const HR = /^[ \t]{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/
const LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/
const QUOTE = /^[ \t]{0,3}((?:>[ \t]?)+)(.*)$/
const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})[ \t]*([^\s`]*)/
const TASK = /^\[([ xX])\][ \t]+(.*)$/

interface Fence {
  /** ` or ~ */
  char: string
  /** How many the opener used — the closer must be the same char and no shorter */
  length: number
  /**
   * Indentation of the opening line. Code lines get it stripped, so a code block inside
   * a list doesn't shift right as a whole
   */
  indent: number
  /**
   * The highlighter for this stretch of code. If the fence names no language, or one we
   * don't know, it's a pass-through pipe.
   *
   * One per fence: block-comment and multi-line-string state carries over only within
   * this block and must not leak into the next one.
   */
  painter: Highlighter
}

/**
 * Streaming renderer for one piece of markdown text.
 *
 * Usage: push feeds deltas → drain takes the finalized lines → preview takes the part
 * not yet finalized. Call end() when a piece is over; it finalizes everything left in
 * the buffer and resets state.
 */
export class MarkdownStream {
  /** The part still waiting for a newline */
  private buffer = ""
  /** Finalized lines waiting to be taken by drain */
  private out: string[] = []
  private fence: Fence | undefined
  /** Accumulated table rows (raw text) */
  private held: string[] = []
  /** Was the last finalized line blank? Headings want a blank line before, but not two */
  private lastBlank = true

  /** Nothing in hand. Used at the end to skip pointless writes. */
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

  /** Take the finalized lines. */
  drain(): string[] {
    if (this.out.length === 0) return []
    const lines = this.out
    this.out = []
    return lines
  }

  /**
   * What the unfinalized part looks like. **Re-fetch it every frame** — it changes with
   * the characters that come after. May be several lines (while a table accumulates).
   */
  preview(): string {
    const lines: string[] = []
    for (const row of this.held) lines.push(theme.dim(row))
    if (this.buffer.length > 0) {
      // peek, not line: this half line is redrawn every frame; advancing state would
      // "enter" a block comment over and over, and on finalizing, the whole block of
      // code would turn comment-colored
      if (this.fence)
        lines.push(theme.dim(CODE_GUTTER) + this.fence.painter.peek(unindent(this.buffer, this.fence.indent)))
      // While a table accumulates, show the half line as-is too, matching the rows above
      else if (this.held.length > 0 || FENCE_OPEN.test(this.buffer)) lines.push(theme.dim(this.buffer))
      else lines.push(renderLine(this.buffer))
    }
    return lines.join("\n")
  }

  /**
   * Finish: finalize everything in the buffer and reset state. The return value
   * includes the lines drain hasn't taken yet.
   */
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

  // ───────────────────────────────────────────── internals

  private feed(raw: string): void {
    // Left in place, the \r of \r\n becomes a control character at line end that pulls
    // the cursor back to the start of the line
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
      // Collapse consecutive blank lines into one. The model loves putting two or three
      // newlines between paragraphs; copied as-is, one screen of content stretches to two
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

// ───────────────────────────────────────────── blocks

/**
 * Render one line (fence toggles and tables excluded) into one line. Pure function;
 * the preview uses it too.
 */
export function renderLine(line: string): string {
  if (line.trim().length === 0) return ""

  const heading = HEADING.exec(line)
  if (heading) return renderHeading(heading[1]!.length, heading[2]!)

  // HR must come before lists: the spaced forms `- - -` and `* * *` also match LIST (a
  // marker, whitespace, the rest) and would render as a bullet. `---` / `***` don't —
  // LIST needs whitespace right after the marker
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
  // Count a tab as two columns, or the indent level comes out as 0
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

/** Strip at most n columns of indent. Relative indentation inside the code stays as-is. */
function unindent(line: string, n: number): string {
  let i = 0
  while (i < n && (line[i] === " " || line[i] === "\t")) i++
  return line.slice(i)
}

// ───────────────────────────────────────────── tables

/**
 * Only lines "starting with |" count.
 *
 * GFM allows leaving out the leading and trailing pipes (`a | b`), but then an ordinary
 * sentence containing a pipe gets taken for a table — and tables are accumulated, so an
 * ordinary sentence getting held means a line mysteriously stuck and not shown. Better
 * to recognize too few.
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
 * Lay out a table. If the second row isn't a separator row, this isn't a table at all
 * (the model sometimes starts one and wanders off), so fall back to rendering plain
 * lines — misreading the format must never swallow content.
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

// ───────────────────────────────────────────── inline

/**
 * Punctuation a backslash can escape. Once escaped, that character must be output as-is
 * and take no further part in parsing.
 */
const PUNCT = /[\\`*_{}[\]()#+\-.!~|<>]/
const WORD = /[\p{L}\p{N}]/u
const LINK = /^\[([^\]]*)\]\([ \t]*<?([^)\s>]*)>?(?:[ \t]+"[^"]*")?[ \t]*\)/
const AUTOLINK = /^<((?:https?|mailto):[^>\s]+)>/
const BARE_URL = /^(?:https?:\/\/|www\.)[^\s<>()[\]"'`]+/

export function renderInline(text: string): string {
  return inline(text, 0)
}

/**
 * depth is only a fallback against recursion blowing the stack; the formatting itself
 * has no notion of a nesting limit.
 */
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

    // Code spans have the highest priority: any * _ inside are literal
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

    // Bare URL. Doesn't count when the previous character is part of a word — that's
    // most likely something like `foo.www.bar`
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
  // Links can't be clicked in a terminal, so the address has to be visible — but don't
  // say it twice when it's the same as the label
  if (label.length === 0 || label === url) return painted
  return painted + theme.dim(" (" + url + ")")
}

/** `` `code` ``: the opening and closing backtick counts must be equal. */
function matchCode(text: string, i: number): { text: string; end: number } | undefined {
  let n = 0
  while (text[i + n] === "`") n++
  const fence = "`".repeat(n)
  let from = i + n
  while (from < text.length) {
    const at = text.indexOf(fence, from)
    if (at === -1) return undefined
    if (text[at + n] === "`") {
      // A longer run, not its closer
      let k = at
      while (text[k] === "`") k++
      from = k
      continue
    }
    let content = text.slice(i + n, at)
    // CommonMark: a space on both ends gets stripped once, so that `` ` `` can express a
    // single backtick
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
 * `**bold**` / `*italic*` / `~~strike~~`.
 *
 * Two rules block the vast majority of false positives:
 *   - the inside of a delimiter can't be whitespace — or `2 * 3 * 4` becomes italic
 *   - `_` doesn't take effect inside a word — or `snake_case_name` becomes italic
 */
function matchEmphasis(text: string, i: number): Emphasis | undefined {
  const ch = text[i]!
  if (ch !== "*" && ch !== "_" && ch !== "~") return undefined

  // The run length decides what it is. `***x***` has to be eaten as a whole run — look
  // for a closer starting from `**` and it lands on the **first two** of those three
  // stars, leaving one lonely star leaking out
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
    // A single-char delimiter hitting `**`: that's another matter, skip past it
    if (delim.length === 1 && text[j + 1] === ch) {
      j++
      continue
    }
    if (/\s/.test(text[j - 1] ?? " ")) continue
    return j
  }
  return -1
}
