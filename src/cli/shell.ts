/**
 * Input host for the single-column timeline. ★ Permanent answers/diffs live in
 *   LiveRegion's scrollback area; redrawing can't stand in for the record.
 *
 * ── Idle draws nothing; a running turn animates ──
 * Idle = zero refreshes: only input and state changes draw, and no timer exists. While a
 * turn runs, one timer drives the alfa mark and the clock on the running line (see
 * cli/activity.ts). This reverses the 0.10 rule of "no timed animation, not even while
 * running": a line that never moves reads the same for "thinking hard" and "hung", and
 * a turn clock that doesn't tick is worse than none. What made that rule necessary was
 * the cost of a tick — every frame erased and redrew the whole block — and LiveRegion now
 * rewrites only the changed row. ⚠ The timer must stop whenever the turn stops (and is
 * skipped while an approval card owns the frame): a still-moving mark over a question
 * nobody has answered is a lie, and a timer outliving the turn is the old idle CPU burn.
 * Settings → Animation turns it off; the line then shows a still mark and no clock.
 *
 * IME, paste, interrupt and follow-up input are all kept.
 */
import { complete, apply, type FileSource } from "./commands.ts"
import { Editor, renderBox } from "./editor.ts"
import type { Key } from "./keys.ts"
import type { Keyboard } from "./keyboard.ts"
import type { LiveRegion } from "./live.ts"
import { modeInfo, nextMode, type PermissionMode } from "../permission/mode.ts"
import { t, uiText } from "../i18n/index.ts"
import { theme } from "./theme.ts"
import { truncateToWidth, wrapWords } from "./width.ts"
import { terminalText } from "./terminal-text.ts"
import { clearInteractiveViewport } from "./brand.ts"
import { clock, FRAME_MS, mark, type Activity, type Phase } from "./activity.ts"
import { tipLabel } from "./tips.ts"

export interface ShellDeps {
  /** Up to two lines under the input box, already styled (segments carry their own colours). */
  footer?(width: number): string[]
  /** What the main agent is doing. Absent = a static `working` line, as before. */
  activity?: Activity
  /** Animate the running line. Read whenever busy changes and on refreshAnimation(). */
  animate?(): boolean
  /** Draw the tail of the model's thinking under the running line. */
  thinkingPreview?(): boolean
  /**
   * Rows pinned above the running line — plan progress, live subagents, background jobs —
   * at most `max` of them. They stay while idle: an unfinished plan or a job still running
   * is exactly what should be in view before the next message is typed.
   */
  pinned?(width: number, max: number): string[]
  /**
   * The tip for the empty input box, drawn after a coloured `tips` label; undefined = the
   * box stays empty. Absent = the catalog's plain placeholder (hosts without tips).
   */
  placeholder?(): string | undefined
  region: LiveRegion
  keyboard: Keyboard
  editor: Editor
  /** Workspace-relative candidates for `@` completion. */
  files?: FileSource
  /**
   * When the folder review found a clear risk, the input box itself must stay red too —
   * a warning that scrolls away isn't enough.
   */
  concern?(): boolean
  /** Permission mode. If not wired, nothing is shown and shift-tab does nothing */
  mode?(): PermissionMode
  setMode?(mode: PermissionMode): void | Promise<void>
  onSubmit(text: string): void
  /**
   * The line submitted while a turn is running. Three outcomes: true = the host has
   * already passed it into the running turn (see injectUser in cli/main.ts), no need to
   * queue; false = it still has to wait for this turn to finish, so it's queued;
   * "handled" = done on the spot (the settings-only commands, see isLiveCommand) — the
   * receipt is already written, nothing to echo or queue.
   */
  onSubmitBusy?(text: string): boolean | "handled"
  /** The user wants to stop the current turn */
  onCancel(): void
  onExit(): void
  /**
   * ctrl-v: save the clipboard's image and return the text to insert (an `@path`), or
   * throw with the sentence to show. Absent = ctrl-v does nothing, as before. See
   * saveClipboardImage in cli/attachments.ts for why it's a key and a file.
   */
  pasteImage?(): Promise<string>
  /**
   * Rewrite a bracketed paste before it enters the line: a pasted `data:` image URL is
   * saved and becomes its `@path` (see saveDataImages in cli/attachments.ts). Absent =
   * pastes go in as they came.
   */
  pasteText?(text: string): string
}

export class Shell {
  private readonly deps: ShellDeps
  private release: (() => void) | undefined

  private busy = false
  /**
   * Current output keeps only its last two lines, so progress is visible without
   * crowding out the input; the full output can be recovered via /detail.
   */
  private previewLabel = ""
  private previewText = ""
  /** One-off hint, gone at the next keypress */
  private note = ""
  /** Ctrl-C was pressed once while idle */
  private armed = false
  /**
   * Lines submitted while running that the host couldn't pass into the turn. Enter while
   * running never interrupts: the line goes in or waits here.
   */
  private queued: string[] = []
  private timer: ReturnType<typeof setInterval> | undefined
  private frame = 0
  private releaseActivity: (() => void) | undefined

  constructor(deps: ShellDeps) {
    this.deps = deps
  }

  start(): void {
    this.release = this.deps.keyboard.push(this.onKey)
    // With the timer running the next frame picks the change up; without it, draw now
    this.releaseActivity = this.deps.activity?.onChange(() => { if (!this.timer) this.paint() })
    this.paint()
  }

  stop(): void {
    this.release?.()
    this.release = undefined
    this.releaseActivity?.()
    this.releaseActivity = undefined
    this.stopTimer()
    this.deps.region.clear()
  }

  /** The animation setting changed; apply it to a turn already running. */
  refreshAnimation(): void {
    this.syncTimer()
    this.paint()
  }

  private syncTimer(): void {
    const want = this.busy && this.deps.activity !== undefined && (this.deps.animate?.() ?? true) && this.deps.region.active
    if (want && !this.timer) {
      this.timer = setInterval(() => {
        // An approval card owns the whole frame; nothing of ours is visible under it
        if (this.deps.region.overlaid) return
        this.frame++
        this.paint()
      }, FRAME_MS)
      this.timer.unref?.()
    } else if (!want) this.stopTimer()
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.frame = 0
  }

  // ───────────────────────────────────────────── state

  setBusy(busy: boolean): void {
    if (this.busy === busy) return
    this.busy = busy
    this.armed = false
    this.note = ""
    if (!busy) this.clearPreview()
    // A turn's host ends the activity itself to get its receipt first (pump in main.ts);
    // other busy spells (compaction) are begun and ended here
    if (busy && this.deps.activity && !this.deps.activity.running) this.deps.activity.begin()
    if (!busy) this.deps.activity?.end()
    this.syncTimer()
    this.paint()
  }

  setPreview(label: string, text: string): void {
    const tail = terminalText(text).trimEnd().split("\n").slice(-2).join("\n")
    if (this.previewLabel === label && this.previewText === tail) return
    this.previewLabel = label
    this.previewText = tail
    this.paint()
  }

  clearPreview(): void {
    if (this.previewLabel === "") return
    this.previewLabel = ""
    this.previewText = ""
    this.paint()
  }

  /**
   * Take **all** queued messages, joined into one.
   *
   * ★ Not one at a time. When a turn finishes, the few lines queued behind it are three
   *   additions to the same thing, made by the user **during the same stretch of time**
   *   ("run the tests while you're at it", "and the README") — answer them one by one
   *   as separate turns and each answer has no idea more is coming, so it first changes
   *   things per the first line, changes them again per the second, and with the third
   *   goes back and redoes the first two. What the user sees is it going in circles.
   *
   * Joined into one, it sees everything at once and decides the order itself — which is
   * a judgment call that's its to make anyway.
   */
  takeQueued(): string | undefined {
    if (this.queued.length === 0) return undefined
    const all = this.queued.splice(0)
    // The "queued" note is only valid until it actually starts running, or it would
    // hang on the status line forever
    this.note = ""
    this.paint()
    return all.join("\n")
  }

  get pending(): number {
    return this.queued.length
  }

  // ───────────────────────────────────────────── keys

  private completionIndex = 0
  private completionText = ""
  private completionHidden = false
  private readonly onKey = (key: Key): void => {
    this.note = ""
    if (key.name === "paste" && key.text && this.deps.pasteText) key = { ...key, text: this.deps.pasteText(key.text) }
    if (key.ctrl && key.name === "l") {
      clearInteractiveViewport(this.deps.region)
      this.deps.keyboard.reassert()
      this.paint()
      return
    }
    if (key.ctrl && key.name === "v" && this.deps.pasteImage) {
      this.note = t.clipboardReading
      this.paint()
      // Inserted as a paste, at wherever the cursor is when the image is ready: the same
      // path a bracketed paste takes, so newlines and width are handled the same way
      void this.deps.pasteImage().then(
        (text) => {
          if (this.note === t.clipboardReading) this.note = ""
          this.deps.editor.handle({ name: "paste", text, ctrl: false, meta: false, shift: false }, this.innerWidth)
          this.paint()
        },
        (error: unknown) => {
          this.note = error instanceof Error ? error.message : String(error)
          this.paint()
        },
      )
      return
    }
    // shift-tab switches permission mode. Checked before the completion menu below: that
    // one takes any `tab`, shifted or not, so with a menu open shift-tab would complete
    // instead of switching
    if (key.name === "tab" && key.shift && this.deps.mode && this.deps.setMode) {
      const mode = nextMode(this.deps.mode())
      void Promise.resolve(this.deps.setMode(mode)).then(() => {
        this.paint()
      }).catch(error => { this.note = String(error instanceof Error ? error.message : error); this.paint() })
      return
    }
    const editor = this.deps.editor
    const choices = this.completionHidden ? undefined : complete(editor.text, editor.cursor, this.deps.files)
    if (choices?.items.length && !key.ctrl && !key.meta) {
      if (key.name === "up" || key.name === "down") {
        this.completionIndex = Math.max(0, Math.min(choices.items.length - 1, this.completionIndex + (key.name === "up" ? -1 : 1)))
        this.paint(); return
      }
      const item = choices.items[this.completionIndex] ?? choices.items[0]!
      const exact = editor.text.slice(choices.from, choices.to) === item.value
      if (key.name === "tab" || key.name === "enter" && !exact) {
        editor.setText(apply(editor.text, choices, item)); this.completionIndex = 0
        this.paint(); return
      }
      if (key.name === "escape") { this.completionHidden = true; this.paint(); return }
    }
    const action = this.deps.editor.handle(key, this.innerWidth)

    switch (action?.type) {
      case "submit":
        if (this.busy) {
          // First try passing it straight into the running turn — queueing means waiting
          // for it to finish the whole job, and the user interjecting this line most
          // likely wants to stop exactly what it's doing now
          const outcome = this.deps.onSubmitBusy?.(action.text)
          // Handled on the spot (the settings-only commands): the receipt is already
          // written, so no echo and no queueing
          if (outcome === "handled") break
          if (outcome === true) {
            this.note = t.queuedLive
          } else {
            this.queued.push(action.text)
            this.note = uiText(
              `queued — will run after this turn (${this.queued.length})`,
              `已排队，将在本轮结束后执行（${this.queued.length}）`,
              `待機中 — このターンの後に実行（${this.queued.length}）`,
            )
          }
        } else {
          this.deps.onSubmit(action.text)
        }
        break

      case "interrupt":
        // While running, interrupting takes priority, even with half a sentence in the
        // input box — nine times out of ten, Ctrl-C means the user wants that command to
        // stop, not to clear the draft
        if (this.busy) this.deps.onCancel()
        else if (action.hasText) this.deps.editor.clear()
        else if (this.armed) return this.deps.onExit()
        else {
          this.armed = true
          this.note = t.pressCtrlCAgain
        }
        break

      case "escape":
        if (this.busy) this.deps.onCancel()
        else if (action.hasText) this.deps.editor.clear()
        break

      case "eof":
        return this.deps.onExit()
    }

    if (action?.type !== "interrupt") this.armed = false
    this.paint()
  }

  // ───────────────────────────────────────────── drawing

  private get innerWidth(): number {
    return Math.max(1, this.deps.region.width - 2)
  }

  paint(): void {
    const region = this.deps.region
    if (!region.active || !this.deps.keyboard.isCurrent(this.onKey)) return
    const width = region.width

    if (this.completionText !== this.deps.editor.text) {
      this.completionText = this.deps.editor.text; this.completionIndex = 0; this.completionHidden = false
    }
    const choices = this.completionHidden ? undefined : complete(this.deps.editor.text, this.deps.editor.cursor, this.deps.files)
    const running = this.runningLine(width)
    // Pinned rows get what a short terminal can spare after the input box's minimum
    const pinnedMax = region.rows >= 24 ? 4 : region.rows >= 18 ? 2 : region.rows >= 14 ? 1 : 0
    const above = [...(pinnedMax > 0 ? (this.deps.pinned?.(width, pinnedMax) ?? []).slice(0, pinnedMax) : []), ...running]
    if (choices?.items.length) {
      const count = Math.max(1, Math.min(6, region.rows - 6)), start = Math.max(0, this.completionIndex - count + 1)
      above.push(...choices.items.slice(start, start + count).map((item,i) => truncateToWidth((start + i === this.completionIndex ? theme.cyan("› ") : "  ") + (item.label ?? item.value) + "  " + theme.dim(item.hint), width)))
      above.push(truncateToWidth(theme.dim(uiText("  ↑↓ select · Tab complete · Enter", "  ↑↓ 选择 · Tab 补全 · Enter 确认", "  ↑↓ 選択 · Tab 補完 · Enter")), width))
    }
    const concern = this.deps.concern?.() ?? false
    const box = renderBox({
      text: this.deps.editor.text,
      cursor: this.deps.editor.cursor,
      width,
      placeholder: this.placeholderText(),
      // The input box takes at most half the screen: when a big chunk is pasted in, the
      // conversation above must not be pushed off entirely
      maxRows: Math.max(1, Math.min(12, region.rows - above.length - 8)),
      framed: region.rows >= 10,
      marker: concern ? "❕ " : undefined,
      style: {
        border: concern ? theme.red : theme.border,
        marker: concern ? theme.red : theme.accent,
        // A tip arrives already styled (label + text); the plain fallback is muted here
        placeholder: this.deps.placeholder ? (text: string) => text : theme.muted,
      },
    })
    const footer = region.rows >= 12 ? (this.deps.footer?.(width) ?? []).slice(0, 2).map(line => truncateToWidth(line, width)) : []
    const lines = [...above, ...box.lines, ...footer, this.statusLine(width)]
    region.set(lines, { row: above.length + box.cursor.row, col: box.cursor.col })
  }

  private placeholderText(): string {
    if (!this.deps.placeholder) return t.placeholder
    const tip = this.deps.placeholder()
    return tip === undefined ? "" : theme.accent(tipLabel()) + " " + theme.muted(theme.italic(tip))
  }

  private runningLine(width: number): string[] {
    if (!this.busy) return []
    const activity = this.deps.activity
    const tall = this.deps.region.rows >= 16
    if (!activity) {
      const bits = [this.previewLabel || t.working, t.interruptHint]
      const preview = tall && this.previewText ? this.previewText.split("\n").map(line => truncateToWidth("  │ " + line, width)) : []
      return [truncateToWidth(theme.accent(`  · ${bits.join(" · ")}`), width), ...preview]
    }
    const now = Date.now()
    const phase = activity.current(now)
    const ticking = this.timer !== undefined
    const tail = [ticking ? clock(activity.elapsed(now)) : "", t.interruptHint].filter(Boolean).join(" · ")
    // The mark is always three columns and coloured by mark() itself
    const head = "  " + mark(phase, ticking ? this.frame : 0) + " " +
      theme.accent(phaseLabel(phase, now, this.previewLabel)) + theme.muted(` · ${tail}`)
    const lines = [truncateToWidth(head, width)]
    if (!tall) return lines
    // A tool streaming output owns the preview; otherwise the thinking tail, if shown
    if (this.previewText && phase.kind === "tool") {
      lines.push(...this.previewText.split("\n").map(line => truncateToWidth(theme.muted("  │ ") + line, width)))
    } else if (phase.kind === "thinking" && (this.deps.thinkingPreview?.() ?? true)) {
      const thought = activity.thinking()
      if (thought) lines.push(...thoughtRows(thought, Math.max(2, width - 4), 2).map(row => truncateToWidth(theme.muted("  ┆ " + theme.italic(row)), width)))
    }
    return lines
  }

  /**
   * Permission exceptions and input hints get a line of their own, instead of competing
   * for width with the working directory / model.
   */
  private statusLine(width: number): string {
    const bits: string[] = []
    const mode = this.deps.mode?.()
    if (mode && mode !== "default") bits.push(theme.dim(modeInfo(mode).label))
    if (this.queued.length > 0) bits.push(theme.dim(t.queuedStatus(this.queued.length)))
    if (!this.busy) bits.push(theme.dim(t.plainExitHint))
    const left = "  " + bits.join(theme.dim(" · "))
    if (this.note.length === 0) return truncateToWidth(left, width)
    return truncateToWidth(left + theme.yellow(`   ${this.note}`), width)
  }
}

/**
 * The last rows of the thinking, cut at word boundaries, with `…` where the start was
 * dropped. Taking the last rows of a hard wrap began the preview mid-word (`dn't read`),
 * which reads as corrupted output rather than as a tail.
 */
function thoughtRows(text: string, width: number, rows: number): string[] {
  const all = wrapWords(text, width - 1)
  const shown = all.slice(-rows)
  if (all.length > rows && shown.length > 0) shown[0] = "…" + shown[0]
  return shown
}

function phaseLabel(phase: Phase, now: number, previewLabel: string): string {
  switch (phase.kind) {
    case "thinking": return uiText("thinking", "思考中", "思考中")
    case "writing": return uiText("writing", "输出中", "出力中")
    case "tool": return phase.name
    case "retrying": {
      const seconds = Math.max(0, Math.ceil((phase.until - now) / 1000))
      return uiText(`retrying in ${seconds}s`, `${seconds} 秒后重试`, `${seconds} 秒後に再試行`)
    }
    case "working": return previewLabel || t.working
  }
}
