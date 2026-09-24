/**
 * The line editor.
 *
 * readline can't be used here — it wants exclusive ownership of the cursor and its line,
 * while we pin a live area below it that's redrawn every frame, and the two would fight.
 * So we write our own.
 *
 * The state machine is **pure**: a key goes in, a new state and an optional action come
 * out; it touches neither the terminal, nor the clock, nor globals. So it can be fully
 * unit-tested — feed it a sequence of keys and assert what the buffer looks like. The
 * things easiest to get wrong, like cursor position and wrapping, are watched by tests,
 * not by eyeballing a real terminal.
 *
 * ── Newline or submit ──
 * Enter submits; Ctrl-J / Alt-Enter / Shift-Enter insert a newline; a backslash at the end
 * of the line also continues it (consistent with the shell). Newlines that come in via
 * paste are **always text**, never a submit — this relies on keyboard.ts's bracketed
 * paste, not on guessing.
 */
import type { Key } from "./keys.ts"
import { charWidth, displayWidth, padToWidth, truncateToWidth } from "./width.ts"

export type EditorAction =
  | { type: "submit"; text: string }
  /** Ctrl-C. Handling depends on whether the layer above is busy; the editor can't know */
  | { type: "interrupt"; hasText: boolean }
  /** Esc */
  | { type: "escape"; hasText: boolean }
  /** Ctrl-D on empty input */
  | { type: "eof" }

export class Editor {
  text = ""
  /** The insertion point, as a char index into text (not a display column) */
  cursor = 0

  private readonly history: string[]
  /** While browsing history, the index into history; -1 means not browsing */
  private historyAt = -1
  /** The half-written line from before browsing started; handed back on the way back down */
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
    // Don't record the same line twice in a row — otherwise ↑ takes ten presses to get past it
    if (this.history[this.history.length - 1] === text) return
    this.history.push(text)
  }

  /**
   * @param width The input box's inner width. Up/down must move by **screen rows**, not
   *   logical lines — a pasted block of text with no newlines wraps into several rows, and
   *   ↑ should move up through those rows rather than jump straight to history. If omitted,
   *   it degrades to moving by logical lines (easier to write tests that way).
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
        // A tab throws off width calculations and can't be aligned in the box. Expand it to
        // two spaces, WYSIWYG. If completion is ever added here, this is the entry point.
        this.insert("  ")
        return undefined
      case "pageup":
      case "pagedown":
      case "insert":
      case "clear":
      case "unknown":
        return undefined
      default:
        // A plain character (possibly a multibyte one like "中")
        if (key.name.length > 0) this.insert(key.name)
        return undefined
    }
  }

  // ───────────────────────────────────────────── key dispatch

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
        // Some terminals send Enter as Ctrl-M
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
        return undefined // clearing the screen is left to the layer above
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

  // ───────────────────────────────────────────── editing actions

  private insert(chunk: string): void {
    this.text = this.text.slice(0, this.cursor) + chunk + this.text.slice(this.cursor)
    this.cursor += chunk.length
    this.historyAt = -1
  }

  /**
   * Paste. The whole chunk is inserted as text; newlines in it don't trigger a submit.
   *
   * CRLF must be normalized — pastes from a browser or from Windows often carry \r, and
   * left in, it's a zero-width character, so the computed cursor position doesn't match
   * what the eye sees.
   */
  private paste(text: string): undefined {
    const normalized = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ")
    if (normalized.length > 0) this.insert(normalized)
    return undefined
  }

  private submit(): EditorAction | undefined {
    // Backslash at end of line = continuation, same as the shell
    if (this.text.endsWith("\\") && this.cursor === this.text.length) {
      this.text = this.text.slice(0, -1) + "\n"
      this.cursor = this.text.length
      return undefined
    }
    if (this.empty) {
      // All whitespace counts as no input, but clear it so the next line doesn't start
      // after the spaces
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

  // ───────────────────────────────────────────── up/down: box rows first, history at the edge

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
      if (direction === 1) return // already on the newest entry (i.e. the draft)
      this.draft = this.text
      this.historyAt = this.history.length - 1
    } else {
      const next = this.historyAt + direction
      if (next >= this.history.length) {
        // Back at the bottom; hand the draft back
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

// ───────────────────────────────────────────── text navigation (pure functions)

/** One code point to the left (don't split a surrogate pair in half). */
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

// ───────────────────────────────────────────── wrapping and box drawing

export interface VisualRow {
  text: string
  /** Index in the original text of this row's first character */
  start: number
}

/**
 * Wrap text containing newlines into "screen rows", remembering each row's starting index
 * in the original text — cursor coordinates are looked up in reverse through it; the
 * strings alone aren't enough.
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
    base += line.length + 1 // +1 for the newline
  }
  return rows
}

/** Original-text index at display column col of a screen row. Double-width chars aren't split. */
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

/** Which row and column the insertion point falls on. */
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
  /** Coloring functions for the border, the prompt marker and the placeholder */
  border: (text: string) => string
  marker: (text: string) => string
  placeholder: (text: string) => string
}

export interface BoxInput {
  text: string
  cursor: number
  width: number
  style: BoxStyle
  /**
   * Defaults to the regular input's ›; the risk state swaps in a wider marker, so the layout
   * can't assume it's always two columns.
   */
  marker?: string
  placeholder?: string
  /**
   * The most rows the box takes up. When 500 lines of code are pasted in, this opens a
   * window that follows the cursor.
   */
  maxRows?: number
  framed?: boolean
}

export interface Box {
  lines: string[]
  cursor: { row: number; col: number }
}

const DEFAULT_MARKER = "› "
const DEFAULT_MAX_ROWS = 10

/**
 * Draw the input box. Every returned line is guaranteed not to exceed width; the cursor
 * coordinates are relative to lines.
 *
 * As many columns are reserved as the prompt marker is wide, and continuation lines align
 * with the body. Chat and forms use thin rules above and below; the caller must count those
 * two border lines in the height.
 */
export function renderBox(input: BoxInput): Box {
  const marker = input.marker ?? DEFAULT_MARKER
  const markerWidth = displayWidth(marker)
  const inner = Math.max(1, input.width - markerWidth)
  const rows = layoutRows(input.text, inner)
  const at = cursorPosition(rows, input.cursor)
  const max = Math.max(1, input.maxRows ?? DEFAULT_MAX_ROWS)
  const from = Math.max(0, at.row - max + 1)
  const lines = rows.slice(from, from + max).map((row, i) =>
      (from + i === 0 ? input.style.marker(marker) : " ".repeat(markerWidth)) +
      (input.text ? row.text : input.style.placeholder(truncateToWidth(input.placeholder ?? "", inner))))
  const border = input.style.border("─".repeat(Math.max(1, input.width)))
  return {
    lines: input.framed ? [border, ...lines, border] : lines,
    cursor: { row: at.row - from + (input.framed ? 1 : 0), col: markerWidth + at.col },
  }
}
