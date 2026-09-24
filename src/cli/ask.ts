/**
 * Questions, numbered picks and free-form input share one state machine, so what the
 * keyboard confirmed and the answer the tool receives can't diverge.
 *
 * ── Two ways to ask, one answer type ──
 * The card (askCard) is the interactive path: a live frame at the bottom of the screen
 * with a cursor that ↑/↓ move, digits that pick, and a type-your-own row you can just
 * start typing into — the shape Claude Code's question card taught people. The
 * scrollback path (askInPlain) is what's left when there's no live area to draw in.
 *
 * ── What was tried first ──
 * Until 0.15 the scrollback path was the only one: the question was written into the
 * scrollback once and answered by number, because redrawing a cursor over committed lines
 * would break the terminal's own scrolling and selection. That reasoning holds for the
 * scrollback, not for the live area — the approval card had been redrawing its own frame
 * there all along (live.ts `overlay`). What it cost was real: no cursor, ⏎ could only
 * ever mean "1", typing your own answer took an `o` first, and a multiple-choice echo had
 * to spell out `-2` because nothing on screen could be un-ticked.
 *
 * ★ The card itself leaves nothing behind, so the record is the tool's own lines: the
 *   `● ask` header carries the question and `↳` the answer, and with several questions
 *   the renderer lists each one under it (see the ask rows in render.ts). That record is
 *   also what a resumed session replays; a question written straight to the scrollback
 *   never was.
 */
import type { Key } from "./keys.ts"
import type { LiveCursor } from "./live.ts"
import { theme } from "./theme.ts"
import { t } from "../i18n/index.ts"
import type { Answer, Question } from "../tool/types.ts"
import { Editor } from "./editor.ts"
import { charWidth, displayWidth, joinToWidth, stripAnsi, wrapToWidth } from "./width.ts"

/**
 * A structural type spares tests from building a real live area. suspend/resume are all
 * the scrollback path needs; overlay + refresh are what the card draws with, and without
 * them (or with the area inactive) asking falls back to the scrollback.
 */
export interface Suspendable {
  suspend(): void
  resume(): void
  active?: boolean
  overlay?(render: (width: number, height: number) => { lines: string[]; cursor?: LiveCursor }): () => void
  refresh?(): void
}

export interface AskDeps {
  /** The owner of stdin. Absent (or not a TTY) means "there's nobody here to ask" */
  keyboard?: { usable: boolean; attached: boolean; push(handler: (key: Key) => void): () => void }
  /** Defaults to process.stdout */
  output?: NodeJS.WriteStream
  /** The bottom live area: the card draws in it, the scrollback path suspends it */
  region?: Suspendable
  /** Wrap up immediately on interrupt */
  signal?: AbortSignal
}

/** Prefix the question when a tool asks several at once. */
function titleLine(question: Question): string {
  const at = question.position
  const mark = at && at.total > 1 ? theme.dim(`${at.index}/${at.total} `) : ""
  return `${mark}${theme.bold(`? ${question.question}`)}`
}

/** Ask one question the best way this host can: the card if it can draw one. */
export function ask(question: Question, deps: AskDeps = {}): Promise<Answer> {
  // Checked here as well as in each path: the card must not open (and take the keyboard)
  // on a run nobody is at
  if (!deps.keyboard?.usable || !deps.keyboard.attached) return Promise.resolve({ kind: "unavailable" })
  if (deps.region?.overlay && deps.region.refresh && deps.region.active !== false) return askCard(question, deps)
  return askInPlain(question, deps)
}

// ─────────────────────────────────────────────── the card

/**
 * The card's state: where the cursor is, what's ticked, what's typed. Pure — keys in,
 * lines out — so the tests drive it without a terminal.
 *
 * Rows the cursor can sit on, top to bottom: each option, the type-your-own row, and for
 * multiple choice a "done" row that submits the ticks.
 */
export class AskCard {
  row = 0
  readonly picked = new Set<number>()
  readonly editor = new Editor()

  constructor(readonly question: Question) {
    // Coming back to a question puts its answer back: what the user went back to look at
    // is precisely what they picked
    const previous = question.previous
    if (previous?.kind === "picked") {
      for (const [index, option] of question.options.entries()) if (previous.choices.includes(option.label)) this.picked.add(index)
      if (this.picked.size > 0) this.row = Math.min(...this.picked)
      // A single choice has no ticks to show; the cursor on it says which one it was
      if (!question.multiple) this.picked.clear()
    } else if (previous?.kind === "typed") {
      this.editor.handle({ name: "paste", text: previous.text, ctrl: false, meta: false, shift: false })
      this.row = this.other
    }
  }

  private get other(): number { return this.question.options.length }
  private get done(): number { return this.question.multiple ? this.other + 1 : -1 }
  private get last(): number { return this.question.multiple ? this.done : this.other }
  private get canBack(): boolean { return (this.question.position?.index ?? 1) > 1 }
  /** → keeps the answer this question already has; only offered when revisiting one. */
  private get kept(): Answer | undefined {
    const previous = this.question.previous
    return previous?.kind === "picked" || previous?.kind === "typed" ? previous : undefined
  }

  /** One key. Returns the answer once there is one; undefined means "redraw and wait". */
  key(key: Key): Answer | undefined {
    if (key.ctrl && (key.name === "c" || key.name === "d")) return { kind: "cancelled" }
    if (key.name === "escape") return { kind: "cancelled" }
    if (key.name === "up" || key.ctrl && key.name === "p") { this.row = this.row === 0 ? this.last : this.row - 1; return }
    if (key.name === "down" || key.ctrl && key.name === "n") { this.row = this.row === this.last ? 0 : this.row + 1; return }

    const typing = this.row === this.other
    // ← / → move between questions only where they can't mean "move inside the text"
    if (!typing || this.editor.text.length === 0) {
      if (key.name === "left" && this.canBack) return { kind: "back" }
      if (key.name === "right" && this.kept) return this.kept
    }

    if (typing) {
      if (key.name === "enter") {
        const text = this.editor.text.replaceAll(/\s+/g, " ").trim()
        return text ? { kind: "typed", text } : undefined
      }
      this.type(key)
      return
    }

    const options = this.question.options
    if (key.name === "enter" || this.question.multiple && key.name === " ") {
      if (this.row === this.done) return this.submit()
      if (!this.question.multiple) return { kind: "picked", choices: [options[this.row]!.label] }
      this.toggle(this.row)
      return
    }
    if (!key.ctrl && !key.meta && /^[1-9]$/.test(key.name)) {
      const index = Number(key.name) - 1
      if (index > this.last) return
      if (index === this.done) return this.submit()
      this.row = index
      if (index === this.other) return
      if (!this.question.multiple) return { kind: "picked", choices: [options[index]!.label] }
      this.toggle(index)
      return
    }
    // ★ Anything printable starts an answer in their own words — no key to learn first.
    //   That includes an IME commit, which arrives as a CJK character or a paste; a
    //   stray letter only fills the row, and nothing goes back until ⏎ on that row.
    //   A space is the exception on a single-choice card: an IME commits with it, and
    //   treating it as "start typing" would drop the user onto the empty row mid-thought
    if (key.ctrl || key.meta || key.name === " ") return
    if (key.name === "paste" || [...key.name].length === 1) {
      this.row = this.other
      this.type(key)
    }
  }

  private type(key: Key): void {
    // One line: an answer, not an essay. Newlines from a paste become spaces, and the
    // editor's own newline keys are swallowed
    if (key.name === "paste") { this.editor.handle({ ...key, text: (key.text ?? "").replaceAll(/\s+/g, " ") }); return }
    if (key.ctrl && key.name === "j" || key.meta && key.name === "enter" || key.name === "tab") return
    this.editor.handle(key)
  }

  private toggle(index: number): void {
    if (this.picked.has(index)) this.picked.delete(index)
    else this.picked.add(index)
  }

  /** "Done" with nothing ticked is a dismissal, the same as the scrollback path's ⏎. */
  private submit(): Answer {
    if (this.picked.size === 0) return { kind: "cancelled" }
    return { kind: "picked", choices: this.question.options.filter((_, index) => this.picked.has(index)).map(option => option.label) }
  }

  /**
   * The frame. When it's taller than the screen, the window follows the cursor and the
   * title and keys stay put — losing the keys is how a card becomes a trap.
   */
  render(width: number, height: number): { lines: string[]; cursor?: LiveCursor } {
    const question = this.question
    const head = [theme.border("─".repeat(Math.max(1, width))), ...wrapToWidth(titleLine(question), Math.max(1, width - 2)).map(line => "  " + line), ""]
    const body: string[] = []
    let focus = 0
    let cursor: LiveCursor | undefined

    const row = (index: number, content: (room: number) => string[], marks = "") => {
      const active = this.row === index
      if (active) focus = body.length
      const lead = `  ${active ? theme.accent("❯") : " "} ${marks}`
      const indent = " ".repeat(displayWidth(stripAnsi(lead)))
      const lines = content(Math.max(1, width - indent.length))
      lines.forEach((line, at) => body.push((at === 0 ? lead : indent) + line))
      return indent.length
    }

    question.options.forEach((option, index) => {
      const box = question.multiple ? (this.picked.has(index) ? theme.green("[✓] ") : theme.muted("[ ] ")) : ""
      const active = this.row === index
      row(index, room => [
        ...wrapToWidth(active ? theme.accent(option.label) : option.label, room),
        ...(option.description ? wrapToWidth(option.description, room).map(line => theme.muted(line)) : []),
      ], `${index + 1}. ${box}`)
    })

    const typing = this.row === this.other
    const at = body.length
    const indent = row(this.other, room => {
      if (this.editor.text.length === 0) return [theme.muted(t.askSomethingElse)]
      return wrapToWidth(this.editor.text, room)
    }, `${this.other + 1}. `)
    if (typing) {
      // Where the insertion point lands after the same wrap the row was drawn with
      const room = Math.max(1, width - indent)
      const before = wrapToWidth(this.editor.text.slice(0, this.editor.cursor), room)
      let line = before.length - 1, col = displayWidth(before[line] ?? "")
      if (col >= room) { line++; col = 0 }
      cursor = { row: at + line, col: indent + col }
    }
    if (question.multiple) row(this.done, () => [this.row === this.done ? theme.accent(t.askDone) : t.askDone], `${this.done + 1}. `)

    const hint = [
      ...(typing ? t.askCardHintTyping : question.multiple ? t.askCardHintMultiple : t.askCardHintSingle(this.other)).split(" · "),
      ...(this.canBack && (!typing || this.editor.text.length === 0) ? [t.askPlainHintBack] : []),
      ...(this.kept && (!typing || this.editor.text.length === 0) ? [t.askCardHintKeep] : []),
    ]
    const foot = ["", ...joinToWidth(hint, Math.max(1, width - 2)).map(line => "  " + theme.muted(line))]

    const room = height - head.length - foot.length
    if (body.length <= room || room < 1) {
      const lines = [...head, ...body, ...foot]
      if (lines.length <= height) return { lines, ...(cursor ? { cursor: { row: cursor.row + head.length, col: cursor.col } } : {}) }
      // Not even the title fits: keep the keys, drop from the top
      const cut = lines.length - height
      return { lines: lines.slice(cut), ...(cursor && cursor.row + head.length >= cut ? { cursor: { row: cursor.row + head.length - cut, col: cursor.col } } : {}) }
    }
    const start = Math.max(0, Math.min(focus - Math.floor(room / 2), body.length - room))
    const window = body.slice(start, start + room)
    return {
      lines: [...head, ...window, ...foot],
      ...(cursor && cursor.row >= start && cursor.row < start + room ? { cursor: { row: cursor.row - start + head.length, col: cursor.col } } : {}),
    }
  }
}

/**
 * The card in the live area. The keyboard is taken first and released on every exit —
 * miss one and the input box underneath never gets a key again.
 */
export async function askCard(question: Question, deps: AskDeps): Promise<Answer> {
  const region = deps.region!, keyboard = deps.keyboard!
  const card = new AskCard(question)
  let release: (() => void) | undefined, close: (() => void) | undefined
  let onAbort = () => {}
  try {
    const answer = new Promise<Answer>(resolve => {
      let settled = false
      const finish = (value: Answer) => {
        if (settled) return
        settled = true
        release?.()
        resolve(value)
      }
      onAbort = () => finish({ kind: "cancelled" })
      release = keyboard.push(key => {
        const value = card.key(key)
        if (value) finish(value)
        else region.refresh!()
      })
      if (deps.signal?.aborted) return onAbort()
      deps.signal?.addEventListener("abort", onAbort, { once: true })
    })
    close = region.overlay!((width, height) => card.render(width, height))
    return await answer
  } finally {
    deps.signal?.removeEventListener("abort", onAbort)
    release?.()
    close?.()
  }
}

// ─────────────────────────────────────────────── asking in the scrollback

/**
 * Asking in the scrollback: suspend the live area, write the question once, answer by
 * number.
 *
 * ⚠ **No redrawing** here. Text written into the scrollback is fixed and can't be erased
 *   — drawing a moving cursor would mean sending cursor-control sequences over committed
 *   lines, which the scrollback design deliberately avoids (it keeps the terminal's own
 *   scrolling, selection and tmux copy mode working as usual; see live.ts). So this side
 *   only echoes what the user pressed.
 */
export async function askInPlain(question: Question, deps: AskDeps = {}): Promise<Answer> {
  const output = deps.output ?? process.stdout

  // ★ When there's nobody to ask, **write not a single character**.
  //
  //   This path is also reached under -p and in pipes, and in both of those stdout is
  //   consumed by another program: pouring in a question nobody will answer pollutes its
  //   output. The model still receives "nobody's here" (see Answer in tool/ask.ts), and the
  //   call itself has a card on screen, so it doesn't pass silently.
  if (!deps.keyboard?.usable || !deps.keyboard.attached) return { kind: "unavailable" }

  deps.region?.suspend()
  try {
    output.write(renderQuestion(question))
    const answer = await readAnswer(question, deps, output)
    output.write("\n")
    return answer
  } finally {
    deps.region?.resume()
  }
}

/** The question itself, the copy written into the scrollback. */
export function renderQuestion(question: Question): string {
  const lines: string[] = ["", `  ${titleLine(question)}`, ""]
  question.options.forEach((option, index) => {
    lines.push(`  ${theme.cyan(`${index + 1}`)} ${option.label}`)
    if (option.description) lines.push(`    ${theme.dim(option.description)}`)
  })
  lines.push(`  ${theme.cyan("o")} ${theme.dim(t.askSomethingElse)}`)
  lines.push("")
  const hint = question.multiple ? t.askPlainHintMultiple : t.askPlainHintSingle
  // Only write ← when there are earlier questions: "previous question" on the first
  // question that does nothing when pressed is worse than not writing it
  const back = (question.position?.index ?? 1) > 1 ? ` · ${t.askPlainHintBack}` : ""
  lines.push("  " + theme.dim(hint + back))
  return lines.join("\n") + " "
}

/**
 * Read one answer.
 *
 * Single choice is done in one key press; multiple choice collects digits and enter
 * finishes. The keyboard takeover must be released on **every** exit path (including
 * throws and interrupts), or the input box underneath never gets key presses again — so
 * this uses the dispose returned by keyboard.push rather than on/off-ing stdin itself.
 */
function readAnswer(question: Question, deps: AskDeps, output: NodeJS.WriteStream): Promise<Answer> {
  const keyboard = deps.keyboard!
  return new Promise((resolve) => {
    let settled = false
    let release: (() => void) | undefined
    /** Numbers already pressed, for multiple choice */
    const picked = new Set<number>()
    /** Typing mode: not undefined means free-form input is being collected */
    let typed: string | undefined

    const finish = (answer: Answer, echo: string) => {
      if (settled) return
      settled = true
      output.write(echo)
      deps.signal?.removeEventListener("abort", onAbort)
      release?.()
      resolve(answer)
    }

    const labels = () => question.options.filter((_, index) => picked.has(index)).map((option) => option.label)

    const onKey = (key: Key) => {
      if (key.ctrl && (key.name === "c" || key.name === "d")) return finish({ kind: "cancelled" }, theme.dim("^C"))

      if (typed !== undefined) {
        if (key.name === "escape") return finish({ kind: "cancelled" }, theme.dim(` (${t.askDismissed})`))
        if (key.name === "enter") {
          const text = typed.trim()
          if (text.length === 0) return finish({ kind: "cancelled" }, theme.dim(` (${t.askDismissed})`))
          return finish({ kind: "typed", text }, "")
        }
        if (key.name === "backspace") {
          const last = [...typed].pop()
          if (!last) return
          typed = typed.slice(0, typed.length - last.length)
          // A wide character needs two backspaces, or half a glyph is left on screen
          output.write("\b \b".repeat(charWidth(last)))
          return
        }
        if (key.name === "paste") {
          const text = (key.text ?? "").replaceAll(/\s+/g, " ")
          typed += text
          output.write(text)
          return
        }
        if (key.ctrl || key.meta || [...key.name].length !== 1) return
        typed += key.name
        output.write(key.name)
        return
      }

      if (key.name === "escape") return finish({ kind: "cancelled" }, theme.dim(`(${t.askDismissed})`))
      // ← goes back a question. There's no redrawing here, so "going back" means **writing
      // the previous question out again** — the scrollback then holds two copies, which is
      // exactly the most honest representation for this kind of UI: no line on screen is
      // ever quietly changed
      if (key.name === "left" && (question.position?.index ?? 1) > 1) {
        return finish({ kind: "back" }, theme.dim("←"))
      }
      if (key.name === "enter") {
        if (!question.multiple) {
          // There's no cursor in scrollback, so Enter consistently means the first option
          // — which is why the hint line says ⏎ = 1
          const first = question.options[0]
          return first
            ? finish({ kind: "picked", choices: [first.label] }, theme.green("1"))
            : finish({ kind: "cancelled" }, "")
        }
        if (picked.size === 0) return finish({ kind: "cancelled" }, theme.dim(`(${t.askDismissed})`))
        return finish({ kind: "picked", choices: labels() }, "")
      }
      if (key.ctrl || key.meta) return
      if (key.name.toLowerCase() === "o") {
        typed = ""
        output.write(theme.cyan("o ") + theme.dim("› "))
        return
      }
      if (!/^[1-9]$/.test(key.name)) return
      const index = Number(key.name) - 1
      if (index >= question.options.length) return
      if (!question.multiple) {
        return finish({ kind: "picked", choices: [question.options[index]!.label] }, theme.green(key.name))
      }
      // Multiple choice: pressing the same digit twice un-ticks it. The screen can't be
      // erased, so the echo spells out whether it was added or removed
      if (picked.has(index)) {
        picked.delete(index)
        output.write(theme.dim(`-${key.name} `))
      } else {
        picked.add(index)
        output.write(theme.green(`${key.name} `))
      }
    }

    const onAbort = () => finish({ kind: "cancelled" }, theme.dim("^C"))

    release = keyboard.push(onKey)
    if (deps.signal?.aborted) return onAbort()
    deps.signal?.addEventListener("abort", onAbort, { once: true })
  })
}
