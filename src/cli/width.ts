/**
 * Display width.
 *
 * This is where hand-written TUIs usually die. The bottom live area decides how many
 * lines to move back up on redraw from "how many lines does this content occupy"; get
 * the line count wrong by one and the UI starts eating output that was already printed,
 * and never recovers.
 *
 * Lines = ceil(display width / terminal columns), so the display width must be exact.
 * Three things throw it off:
 *   1. ANSI escape sequences take no columns (`\u001b[31m` is 5 chars, 0 columns)
 *   2. **CJK characters take 2 columns** — for this project that is the norm, not an
 *      edge case
 *   3. Combining marks (tone marks, variation selectors, ZWJ) take 0 columns
 *
 * ── Which way to err when we get it wrong ──
 * An emoji ZWJ sequence (👨‍👩‍👧) is one 2-column glyph in a terminal that does
 * ligatures, and three glyphs in one that doesn't. There is no portable way to tell. We
 * always **assume no ligature**, i.e. we overestimate the width: overestimating only
 * wraps early and leaves a bit of blank space on the right; underestimating overflows,
 * undercounts lines, and the UI falls apart. Better ugly than misaligned.
 */

/**
 * Every ANSI escape sequence: CSI (`\u001b[…`), OSC (`\u001b]…BEL/ST`), and the
 * two-character kind. Not just SGR — cursor movement and the like take no width either.
 *
 * ESC is always written as `\u001b`, never as a raw control character: a raw one is
 * invisible in diffs, grep and editors, so when it gets mangled nobody can tell (this
 * repo has been bitten by that once).
 */
const ANSI = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g

/** SGR (color) only; wrapping relies on it to carry the color over to the next line. */
const SGR = /^\u001b\[[0-9;]*m$/

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "")
}

/**
 * East Asian Wide / Fullwidth ranges, sorted, binary-searched.
 *
 * The table covers CJK, kana, Hangul, fullwidth symbols and the common emoji blocks. It
 * is not all of Unicode — the full table is hundreds of lines and changes every version;
 * the obscure ranges we miss count as 1 column, which errs in the "too small" direction,
 * but the odds of those characters showing up in a terminal are far lower than the cost
 * of maintaining a full table.
 *
 * The ranges were not counted by hand: the BMP half comes from Markus Kuhn's wcwidth.c
 * (public domain), the emoji half is copied from the EAW=W ranges in Unicode's
 * EastAsianWidth.txt. See NOTICE.
 */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x231a, 0x231b], // ⌚⌛
  [0x2329, 0x232a], // 〈〉
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653], // zodiac signs
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e], // CJK Radicals / Kangxi Radicals / CJK Symbols and Punctuation
  [0x3041, 0x33ff], // Hiragana → Katakana → Bopomofo → Hangul Compat. Jamo → Enclosed CJK
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs (base block)
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // vertical punctuation (Vertical Forms)
  [0xfe30, 0xfe6f], // CJK Compatibility Forms / Small Form Variants
  [0xff00, 0xff60], // fullwidth ASCII
  [0xffe0, 0xffe6], // fullwidth symbols
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18aff], // Tangut / Khitan Small Script
  [0x1b000, 0x1b16f], // Kana Supplement
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1fa7c],
  [0x1fa80, 0x1fa88],
  [0x1fa90, 0x1fabd],
  [0x1fac0, 0x1fac5],
  [0x1fad0, 0x1fadb],
  [0x1fae0, 0x1fae8],
  [0x1faf0, 0x1faf8],
  [0x20000, 0x2fffd], // CJK Extensions B–F
  [0x30000, 0x3fffd], // CJK Extensions G–
]

/**
 * Zero width: combining marks (Mn/Me), format characters (Cf, including ZWJ and the
 * zero-width space), variation selectors.
 */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u

function isWide(code: number): boolean {
  let low = 0
  let high = WIDE.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const range = WIDE[mid]!
    if (code < range[0]) high = mid - 1
    else if (code > range[1]) low = mid + 1
    else return true
  }
  return false
}

/** How many columns a single code point takes. */
export function charWidth(char: string): number {
  const code = char.codePointAt(0)
  if (code === undefined) return 0
  if (code === 0x00) return 0
  // Control characters: shouldn't get here; if they do, count 0 — they don't advance the
  // cursor (\n\t aside, which callers handle at a higher level)
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0
  if (ZERO_WIDTH.test(char)) return 0
  return isWide(code) ? 2 : 1
}

/** Display width of a piece of text (ANSI stripped first). */
export function displayWidth(text: string): number {
  let total = 0
  for (const char of stripAnsi(text)) total += charWidth(char)
  return total
}

/**
 * Lay out short segments (`⏎ select`, `esc dismiss`) as `a · b · c`, breaking only
 * between segments. A key hint hard-wrapped by wrapToWidth split `← previous` from
 * `question` across two rows; a segment is only cut when it alone is wider than a row.
 */
export function joinToWidth(parts: string[], width: number, separator = " · "): string[] {
  const rows: string[] = []
  let row = ""
  for (const part of parts) {
    const next = row ? row + separator + part : part
    if (!row || displayWidth(next) <= width) { row = next; continue }
    rows.push(row)
    row = part
  }
  if (row) rows.push(row)
  return rows.flatMap(line => wrapToWidth(line, width))
}

/**
 * Hard-wrap by display width, **preserving colors**.
 *
 * Hard wrapping (by character, not by word) is deliberate: the terminal's own auto-wrap
 * is a hard wrap, and we match it, so the same text looks the same whether it is
 * previewed in the live area or committed to the scrollback and reflowed by the
 * terminal.
 *
 * Two things that must be right:
 *   - **Never split a double-width character.** If it doesn't fit, push the whole thing
 *     to the next line and leave one blank column at the end of the current line — the
 *     terminal does the same in that situation.
 *   - **Colors must carry over.** Append a reset at the end of the line and re-emit the
 *     accumulated SGR at the start of the next, otherwise the color stops halfway after
 *     the first wrap.
 */
export function wrapToWidth(text: string, width: number): string[] {
  if (width < 1) return [text]

  const lines: string[] = []
  let current = ""
  let used = 0
  /** SGR sequences currently in effect; replayed at the start of each new line on wrap */
  let active: string[] = []

  const flush = () => {
    lines.push(active.length > 0 ? current + RESET : current)
    current = active.join("")
    used = 0
  }

  ANSI.lastIndex = 0
  let index = 0
  while (index < text.length) {
    ANSI.lastIndex = index
    const match = ANSI.exec(text)
    if (match && match.index === index) {
      const sequence = match[0]
      current += sequence
      if (SGR.test(sequence)) {
        if (sequence === RESET || sequence === "\u001b[m") active = []
        else active.push(sequence)
      }
      index += sequence.length
      continue
    }

    const char = String.fromCodePoint(text.codePointAt(index)!)
    index += char.length

    if (char === "\n") {
      flush()
      continue
    }
    const w = charWidth(char)
    if (used + w > width && used > 0) flush()
    current += char
    used += w
  }
  lines.push(active.length > 0 ? current + RESET : current)
  return lines
}

const RESET = "\u001b[0m"

/**
 * Empty SGR, equivalent to reset. Derived from RESET so we don't have to write out a raw
 * escape sequence again.
 */
const RESET_SHORT = RESET.slice(0, 2) + "m"

/**
 * Split into two at the given display column, **without breaking colors**.
 *
 * Needed for hanging indents: the first line keeps its original "indent + bullet", every
 * following line gets the same width of spaces instead. A plain slice would cut an ANSI
 * sequence in half (the head keeps half an escape, the tail loses its color), so the
 * head gets a trailing reset and the tail re-emits the still-active SGR up front — the
 * same approach as wrapping.
 *
 * If the cut lands in the middle of a double-width character, the whole character goes
 * to the tail; better the head is one column short.
 */
export function splitAtWidth(text: string, columns: number): [string, string] {
  if (columns <= 0) return ["", text]

  let head = ""
  let used = 0
  let active: string[] = []

  ANSI.lastIndex = 0
  let index = 0
  while (index < text.length) {
    ANSI.lastIndex = index
    const match = ANSI.exec(text)
    if (match && match.index === index) {
      const sequence = match[0]
      head += sequence
      if (SGR.test(sequence)) {
        if (sequence === RESET || sequence === RESET_SHORT) active = []
        else active.push(sequence)
      }
      index += sequence.length
      continue
    }

    const char = String.fromCodePoint(text.codePointAt(index)!)
    const w = charWidth(char)
    if (used + w > columns) break
    head += char
    used += w
    index += char.length
  }

  const rest = text.slice(index)
  if (active.length === 0 || rest.length === 0) return [head, rest]
  return [head + RESET, active.join("") + rest]
}

/**
 * Right-pad with spaces to the given display width. Too wide is not truncated —
 * truncation is for the caller to decide explicitly.
 */
export function padToWidth(text: string, width: number): string {
  const pad = width - displayWidth(text)
  return pad > 0 ? text + " ".repeat(pad) : text
}

/**
 * Truncate to the given display width, with an ellipsis if it overflows.
 *
 * The ellipsis itself takes 1 column and must be counted in the budget, otherwise
 * "truncated to fit exactly" plus the ellipsis overflows again.
 */
export function truncateToWidth(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return ""
  if (displayWidth(text) <= width) return text
  // ⚠ Colors must survive. This used to "strip ANSI, then cut char by char", so a line
  //   of highlighted code turned entirely white whenever it didn't fit — and in the
  //   right-hand column not fitting is the norm.
  const [head] = splitAtWidth(text, width - displayWidth(ellipsis))
  return head + ellipsis
}

/**
 * Truncate the other way: drop from the **left**, keep the end. Used for paths.
 *
 * Everything that tells paths apart is in the tail — cutting
 * `~/code/alfa-labs/subtools/alfa-workspace` on the right gives `~/code/alfa-…`, which
 * throws away exactly the one part that tells you "which project is this".
 *
 * The cut prefers to land on a `/`: `…/subtools/alfa-workspace` reads as a path at a
 * glance, while `…tools/alfa-workspace` is half a word. Only when even the whole last
 * segment doesn't fit do we hard-cut character by character.
 *
 * Accepts only plain text without ANSI (which paths are), so none of the
 * color-carrying business.
 */
export function elideLeft(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return ""
  if (displayWidth(text) <= width) return text
  const room = width - displayWidth(ellipsis)
  if (room <= 0) return ellipsis

  const parts = text.split("/")
  // Longest tail first, then shorter: the first one that fits is the most we can keep
  for (let at = 1; at < parts.length; at++) {
    const tail = "/" + parts.slice(at).join("/")
    if (displayWidth(tail) <= room) return ellipsis + tail
  }
  return ellipsis + takeRight(text, room)
}

/**
 * Collect from the end until `columns` columns are filled. Double-width characters are
 * never split; better one column short.
 */
function takeRight(text: string, columns: number): string {
  const chars = [...text]
  let used = 0
  let at = chars.length
  while (at > 0) {
    const w = charWidth(chars[at - 1]!)
    if (used + w > columns) break
    used += w
    at -= 1
  }
  return chars.slice(at).join("")
}

/**
 * Wrap at spaces, falling back to wrapToWidth for a run too long for one row (a URL, or
 * CJK text, which has no spaces and may break between any two characters). For plain
 * prose only — no SGR handling. Used where a line cut mid-word reads as garbage and the
 * text is prose, e.g. the thinking tail under the running line.
 */
export function wrapWords(text: string, width: number): string[] {
  const out: string[] = []
  let line = ""
  for (const token of text.split(/(\s+)/)) {
    if (token.length === 0) continue
    if (/^\s+$/.test(token)) { if (line.length > 0) line += " "; continue }
    if (displayWidth(line + token) <= width) { line += token; continue }
    if (line.trim().length > 0) out.push(line.trimEnd())
    if (displayWidth(token) <= width) { line = token; continue }
    const pieces = wrapToWidth(token, width)
    line = pieces.pop() ?? ""
    out.push(...pieces)
  }
  if (line.trim().length > 0) out.push(line.trimEnd())
  return out
}
