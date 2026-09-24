/**
 * The live area pinned to the bottom of the screen.
 *
 * ── It is not a full-screen TUI ──
 * There is no alternate screen. Finished output is committed into the terminal's
 * scrollback as usual (so you can still scroll up, select and copy with the mouse, and
 * tmux copy mode works as normal); only the last few lines at the bottom are "live":
 * erased and redrawn on every change. The input box, the status line and the current
 * tool name all live in those lines.
 *
 * A frame is always the same three steps: **erase the live area → write to the
 * scrollback → redraw the live area**. Any code that bypasses this order and writes
 * straight to stdout splits the screen down the middle. The one shortcut: a frame that
 * commits nothing and keeps the same height rewrites only its changed rows in place.
 * ★ The approval overlay is rendered in the same frame and doesn't change the input
 *   area's contents; background output can only go above the whole card.
 *
 * ── Why everything is wrapped at columns - 1 ──
 * Terminal auto-wrap has a "deferred wrap" state: when the last column is written, the
 * cursor stays in that column and only moves to the next line when the next character
 * comes. Most terminals do this, **but not all**. Once some terminal chooses to wrap
 * immediately, one line of content takes two rows while we count it as one — the
 * erase moves up one row too few, and from then on the live area eats upward into
 * already-printed output one frame at a time, never to recover.
 *
 * Never write to the last column and the ambiguity simply doesn't exist. The cost is
 * one empty column on the right, which nobody can tell.
 *
 * ★ Resize invalidates the row ledger before any further erase. The terminal has
 * already reflowed those rows; an old cursor-up can erase committed output or leave
 * permanent ghosts. Reset only the viewport, retaining scrollback and the pending
 * streamed tail, then ask the owner to lay out a fresh frame.
 */
import { displayWidth, truncateToWidth, wrapToWidth } from "./width.ts"

const HIDE_CURSOR = "\u001b[?25l"
const SHOW_CURSOR = "\u001b[?25h"
/**
 * Synchronized output: supporting terminals batch the writes in between into one frame;
 * the rest simply ignore it.
 */
const SYNC_BEGIN = "\u001b[?2026h"
const SYNC_END = "\u001b[?2026l"
const CLEAR_DOWN = "\u001b[0J"
const CLEAR_LINE = "\u001b[2K"

/**
 * All the capability the renderer needs. Pulled out so the Renderer doesn't have to know
 * about the live area — in tests, a fake that collects strings is enough.
 */
export interface OutputSink {
  write(text: string): void
  /** Cursor at line start? (tool cards must be drawn starting at line start) */
  readonly atLineStart: boolean
  /**
   * Commit some whole lines, and at the same time **replace** "the part not yet
   * finished" **entirely** with tail (which may contain newlines).
   *
   * markdown needs this: `**bo` isn't bold yet, `**bold**` is — how a half line looks
   * changes with the characters that come after it, so it can't be set in stone the
   * moment it's written. And this was always doable: in both sinks the half line is the
   * part that gets "redrawn every frame"; nobody had needed to change it before.
   *
   * Optional. A sink that doesn't implement it (a plain pipe) gets no markdown and just
   * outputs text as-is.
   */
  replaceTail?(committed: string[], tail: string): void
}

export interface LiveCursor {
  /** Row index within the lines array that was passed in */
  row: number
  /** Display column in that row (not a char index) */
  col: number
}

export interface LiveRegionOptions {
  output?: NodeJS.WriteStream
  /**
   * When off, degrades to "write straight to stdout" and sends not a single escape
   * sequence. Pipes, CI, and the non-TTY cases beyond --no-color all take this path —
   * sending cursor control there only pours garbage into logs.
   */
  enabled?: boolean
  /**
   * Called first when the terminal is resized.
   *
   * The live area redrawing itself isn't enough — the lines it holds were wrapped at
   * the **previous width**, and redrawing them as-is means cramming a 100-column box
   * into a 50-column terminal. What really has to happen is for the layer above to lay
   * everything out again at the new width, so this has to call back out.
   */
  onResize?(): void
}

export class LiveRegion {
  private readonly output: NodeJS.WriteStream
  private readonly enabled: boolean
  private readonly notifyResize: (() => void) | undefined

  /** Live-area content from the caller (already wrapped to width by the caller) */
  private overlayFrame?: (width: number, height: number) => { lines: string[]; cursor?: LiveCursor }
  private region: string[] = []
  private cursor: LiveCursor | undefined
  /** The half line in the scrollback area that has no newline yet */
  private pending = ""

  /** The actual rows of the frame currently on screen */
  private painted: string[] = []
  /** Row the cursor ends on after painting (erase uses it to know how far up to go) */
  private cursorRow = 0
  /** And which column. Cursor-only frames need it to compute the delta */
  private cursorCol = 0
  private suspended = false
  private closed = false
  private resizePending = false

  constructor(options: LiveRegionOptions = {}) {
    this.output = options.output ?? process.stdout
    this.enabled = options.enabled ?? (this.output.isTTY === true)
    this.notifyResize = options.onResize
    if (this.enabled) this.output.on("resize", this.onResize)
  }

  get columns(): number {
    return Math.max(20, this.output.columns ?? 80)
  }

  get rows(): number {
    return Math.max(4, this.output.rows ?? 24)
  }

  /** Usable width for live-area content. The last column stays empty, see file header. */
  get width(): number {
    return this.columns - 1
  }

  get active(): boolean {
    return this.enabled && !this.suspended && !this.closed
  }

  // ───────────────────────────────────────────── writing to the scrollback

  /**
   * Write into the scrollback area. May be half a line — streamed text arrives word by
   * word.
   *
   * Complete lines (the part ending in \n) are committed to the scrollback and **never
   * redrawn again**; the remaining half line stays in pending and is redrawn with the
   * live area every frame until its own newline arrives.
   */
  write(text: string): void {
    if (text.length === 0) return
    if (!this.active) {
      // Degraded mode: write directly. pending must still be updated — atLineStart
      // depends on it, and the "tool cards must start drawing at line start" rule has
      // to hold in piped output too.
      this.output.write(text)
      const at = text.lastIndexOf("\n")
      this.pending = at === -1 ? this.pending + text : text.slice(at + 1)
      return
    }
    this.pending += text
    const parts = this.pending.split("\n")
    this.pending = parts.pop() ?? ""
    this.paint(parts)
  }

  /** Cursor at line start? Useful when the caller needs to add a newline before this. */
  get atLineStart(): boolean {
    return this.pending.length === 0
  }

  /**
   * See OutputSink.replaceTail.
   *
   * Drawn in one go: commit + half-line swap make a single frame. Split into several
   * write() calls, streamed text would fully redraw the live area several times per
   * token — visible flicker over SSH.
   */
  replaceTail(committed: string[], tail: string): void {
    if (!this.active) {
      // In degraded mode (pipe) what's already written can't be taken back, so the half
      // line has to wait until it's final. markdown's buffering stays upstream; once a
      // line is complete it naturally arrives as committed.
      for (const line of committed) this.output.write(line + "\n")
      this.pending = ""
      return
    }
    this.pending = tail
    this.paint(committed)
  }

  // ───────────────────────────────────────────── live area

  /**
   * Set the live-area content and redraw.
   *
   * Every line in `lines` **must** already be wrapped to at most this.width — nothing
   * is wrapped here, because the cursor coordinate (row, col) was computed by the
   * caller against its own wrapped lines, and wrapping again would make them disagree.
   */
  set(lines: string[], cursor?: LiveCursor): void {
    if (!this.active) return
    this.region = lines
    this.cursor = cursor
    this.paint([])
  }

  /**
   * An approval owns an entire live frame; the input area's data underneath is left
   * alone, and background output can only scroll above the frame.
   */
  overlay(render: (width: number, height: number) => { lines: string[]; cursor?: LiveCursor }): () => void {
    if (this.overlayFrame) throw new Error("An activity overlay is already open")
    this.overlayFrame = render
    this.paint([])
    return () => {
      if (this.overlayFrame !== render) return
      this.overlayFrame = undefined
      this.paint([])
    }
  }

  /** An approval card owns the frame; the owner's own lines are not on screen. */
  get overlaid(): boolean { return this.overlayFrame !== undefined }

  refresh(): void { if (this.active) this.paint([]) }

  clear(): void {
    if (!this.active) return
    this.region = []
    this.cursor = undefined
    this.paint([])
  }

  /**
   * Send a raw control sequence directly (clear screen and the like). Erases the live
   * area first and redraws after. Once it's sent, the screen state is whatever that
   * sequence made it, so "what the previous frame painted" must be forgotten.
   */
  passthrough(sequence: string): void {
    if (!this.active) return
    this.flushResize()
    this.erase()
    this.pending = ""
    this.output.write(sequence)
    this.paint([])
  }

  /**
   * Give up the screen temporarily (for things like a permission prompt that take over
   * drawing themselves). While suspended, write() goes straight to the scrollback and
   * there is no live area.
   */
  suspend(): void {
    if (!this.enabled || this.suspended) return
    this.flushResize()
    this.erase()
    this.flushPending()
    this.suspended = true
  }

  resume(): void {
    if (!this.enabled || !this.suspended) return
    this.suspended = false
    this.paint([])
  }

  /**
   * Must be called before exiting. Erases the live area, flushes the half line, hands
   * the cursor back to the shell. Miss it, and when the user is back at the prompt a
   * half-drawn input box is still hanging above it.
   */
  close(): void {
    if (this.closed) return
    if (this.enabled) {
      this.output.off("resize", this.onResize)
      this.flushResize()
      if (!this.suspended) this.erase()
      this.flushPending()
      this.output.write(SHOW_CURSOR)
    } else if (this.pending.length > 0) {
      this.output.write("\n")
      this.pending = ""
    }
    this.closed = true
  }

  // ───────────────────────────────────────────── internals

  private flushPending(): void {
    if (this.pending.length === 0) return
    this.output.write(this.pending + "\n")
    this.pending = ""
  }

  /**
   * One frame. committed are the complete lines this frame commits to the scrollback.
   *
   * If nothing changed, send nothing — a repaint is requested far more often than the
   * frame actually changes (every key press, every chunk of a running tool's output), and
   * without this check each one is a full redraw, visible flicker on slow terminals (SSH).
   */
  private paint(committed: string[]): void {
    this.flushResize()
    const overlay = this.overlayFrame?.(this.width, this.rows - 1)
    const block = overlay ? overlay.lines.slice(0, this.rows - 1).map(line => truncateToWidth(line, this.width)) : this.buildBlock()
    const target = overlay ? { row: Math.min(Math.max(0, block.length - 1), overlay.cursor?.row ?? Math.max(0, block.length - 1)), col: Math.min(this.width, overlay.cursor?.col ?? 0) } : this.cursorTarget(block)

    if (committed.length === 0 && sameLines(block, this.painted)) {
      // ⚠ Dedup can't compare content only. ←/→ changes not a single character, it
      //   only moves the insertion point — compare content only and the whole frame is
      //   skipped, the move sequence never goes out: the logical cursor moved, the
      //   screen cursor didn't, and the next character gets inserted somewhere else
      //   "out of nowhere". Invisible normally, this bug shows the moment you use the
      //   arrow keys.
      if (target.row === this.cursorRow && target.col === this.cursorCol) return
      // Content is unchanged, so don't redraw the whole box — a small incremental move
      // is enough
      this.output.write(SYNC_BEGIN + this.moveWithin(target) + SYNC_END)
      this.cursorRow = target.row
      this.cursorCol = target.col
      return
    }

    // ★ Same height, nothing to commit: rewrite only the rows that differ. The running
    //   line's animation ticks several times a second while the input box and footer
    //   under it stay put; erasing and redrawing the whole block for each tick flickers
    //   on terminals without synchronized output and pushes a dozen lines over SSH for a
    //   one-cell change. Height changes still take the full path below — row positions
    //   would shift, and only the erase ledger knows how far up the old frame reached.
    if (committed.length === 0 && block.length === this.painted.length && block.length > 0) {
      let out = SYNC_BEGIN + HIDE_CURSOR
      for (let row = 0; row < block.length; row++) {
        if (block[row] === this.painted[row]) continue
        out += this.moveWithin({ row, col: 0 }) + CLEAR_LINE + block[row]
        this.cursorRow = row
      }
      out += this.moveWithin(target) + SHOW_CURSOR + SYNC_END
      this.painted = block
      this.cursorRow = target.row
      this.cursorCol = target.col
      this.output.write(out)
      return
    }

    let out = SYNC_BEGIN + HIDE_CURSOR + this.eraseSequence()
    for (const line of committed) out += line + "\n"

    out += block.join("\n")
    this.painted = block

    // Cursor: put it where the caller asked, if it did (the insertion point in the input
    // box); otherwise leave it at the end of the last line
    out += moveTo(block.length - 1, target)
    this.cursorRow = target.row
    this.cursorCol = target.col

    out += SHOW_CURSOR + SYNC_END
    this.output.write(out)
  }

  /**
   * All the lines shown at the bottom of the screen this frame: half line + live area.
   *
   * When they don't fit, drop from the **top**. The input box must be fully visible;
   * better to lose sight of the start of the streamed text — that part is about to be
   * committed to the scrollback, and scrolling up shows it.
   */
  private buildBlock(): string[] {
    const width = this.width
    const head = this.pending.length > 0 ? wrapToWidth(this.pending, width) : []
    // Last-line-of-defense truncation. Callers are supposed to guarantee no line is too
    // wide (see the comment on set()), but missing one spot doesn't just "look a bit
    // ugly": the overflow gets auto-wrapped by the terminal, the row count comes out
    // short, the next frame's erase goes up the wrong distance — and the UI rots from
    // there on. Truncating only looks ugly, a far cheaper way to fail.
    const block = [...head, ...this.region.map((line) => truncateToWidth(line, width))]
    const max = this.rows - 1
    return block.length > max ? block.slice(block.length - max) : block
  }

  private cursorTarget(block: string[]): LiveCursor {
    const last = Math.max(0, block.length - 1)
    if (!this.cursor) return { row: last, col: displayWidth(block[last] ?? "") }
    // Offset of the live area within block = the pending lines before it
    const offset = block.length - this.region.length
    const row = Math.min(last, Math.max(0, offset + this.cursor.row))
    return { row, col: Math.min(this.cursor.col, this.width) }
  }

  private eraseSequence(): string {
    if (this.painted.length === 0) return ""
    let out = "\r"
    if (this.cursorRow > 0) out += `\u001b[${this.cursorRow}A`
    return out + CLEAR_DOWN
  }

  private erase(): void {
    const sequence = this.eraseSequence()
    if (sequence.length > 0) this.output.write(sequence)
    this.painted = []
    this.cursorRow = 0
    this.cursorCol = 0
  }

  /** The small sequence sent when content is unchanged and only the cursor moved. */
  private moveWithin(target: LiveCursor): string {
    let out = ""
    const delta = target.row - this.cursorRow
    if (delta < 0) out += `\u001b[${-delta}A`
    else if (delta > 0) out += `\u001b[${delta}B`
    // Return to line start and count rightward; don't take a delta from the current
    // column — double-width characters make the two sides' column math disagree
    out += "\r"
    if (target.col > 0) out += `\u001b[${target.col}C`
    return out
  }

  /**
   * The terminal was resized.
   *
   * The terminal has already reflowed old content at the new width, so our recorded
   * row count is no longer trustworthy. Coalesce a burst into one microtask, but flush
   * before an intervening paint/suspend/close can use the invalid ledger. Resizes while
   * suspended are remembered until resume; the temporary owner keeps its screen.
   */
  private readonly onResize = (): void => {
    if (this.closed || this.resizePending) return
    this.resizePending = true
    queueMicrotask(() => {
      if (!this.active || !this.resizePending) return
      this.paint([])
    })
  }

  private flushResize(): void {
    if (!this.active || !this.resizePending) return
    this.resizePending = false
    this.painted = []
    this.cursorRow = 0
    this.cursorCol = 0
    // ED 2 clears the viewport; ED 3 would destroy native scrollback. passthrough()
    // cannot be used here because it erases using the old ledger and drops pending.
    this.output.write(SYNC_BEGIN + HIDE_CURSOR + "\u001b[H\u001b[2J" + SHOW_CURSOR + SYNC_END)
    this.notifyResize?.()
  }
}

function moveTo(fromRow: number, target: LiveCursor): string {
  let out = "\r"
  const up = fromRow - target.row
  if (up > 0) out += `\u001b[${up}A`
  if (target.col > 0) out += `\u001b[${target.col}C`
  return out
}

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
