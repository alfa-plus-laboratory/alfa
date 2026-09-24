/**
 * What the main agent is doing right now, for the running line above the input box: the
 * phase, how long this turn has run, the tail of its thinking, and how fast it writes.
 *
 * ── Why the phase comes from the event stream and not from a flag ──
 * The line used to say `working` for everything, so a thirty-second silence read the
 * same whether the model was thinking, the provider was retrying, or `bun test` was
 * running. Each of those has a different right response (wait, wait, look at the
 * output), so the phase follows what actually streamed: reasoning → thinking, body text →
 * writing, a running tool → its name, a retry → a countdown. When nothing has streamed
 * yet it stays `working` — a provider that keeps its reasoning hidden sends no reasoning
 * events, and calling that silence "thinking" would be a guess dressed up as a fact.
 *
 * ── The mark ──
 * The running line starts with the alfa mark from the banner — the same `alfa-base` dot
 * matrix, cut down to 6×4 braille dots (three cells, `⢎⡱⣇`: the loop, then the stem with
 * its tail), in the banner's green. The motion is the state: a brightness sweep across
 * the cells while thinking, the α writing itself stroke by stroke while writing, a gap
 * running round the loop while a tool runs, a still yellow mark while a retry waits.
 * Tried first: the little robot from the retired full-screen UI. It worked as a signal
 * but was a second mascot beside the brand; the product has one face. Braille rather than
 * half blocks because a banner-shaped mark needs sub-cell resolution to fit one row, and
 * braille cells are single-width in every font (block elements are ambiguous-width).
 * Every frame is exactly three columns so the label after it never jitters.
 *
 * ── Token speed ──
 * Measured per step, from the first streamed output to the step's end: prompt processing
 * before the first token is latency, not writing speed. While a step streams, the rate
 * is estimated from the visible characters and marked `~`; at the step's end it is
 * replaced by the provider's output count. ⚠ When the provider reports reasoning tokens
 * but streamed no reasoning, that reasoning was generated before the first visible token,
 * so it is taken out of the numerator — otherwise hidden thinking inflates the rate
 * several times over.
 */
import type { UIEvent } from "../agent/events.ts"
import { estimateTokens } from "../agent/context.ts"
import { terminalText } from "./terminal-text.ts"
import { uiText } from "../i18n/index.ts"
import { duration } from "./render.ts"
import { theme } from "./theme.ts"

export type Phase =
  | { kind: "working" }
  | { kind: "thinking" }
  | { kind: "writing" }
  | { kind: "tool"; name: string }
  | { kind: "retrying"; until: number }

export interface TurnSummary { elapsedMs: number; steps: number }

/** Too short a window or too few tokens makes the rate noise (one 3-token step "at 900 tok/s"). */
const MIN_RATE_MS = 400
const MIN_RATE_TOKENS = 16
/** Only the tail of the thinking is ever drawn; keeping more is just memory. */
const THOUGHT_TAIL = 600

export class Activity {
  private started: number | undefined
  private steps = 0
  private phase: Phase = { kind: "working" }
  private tools = new Map<string, string>()
  private thought: { id: string; text: string } | undefined
  /** When this step's first output streamed; undefined until it has */
  private firstOutput: number | undefined
  private streamedChars = ""
  private sawReasoning = false
  private measured: number | undefined
  private readonly listeners = new Set<() => void>()

  /** A turn starts. The measured speed survives: it is the last thing known about the model. */
  begin(now = Date.now()): void {
    this.started = now
    this.steps = 0
    this.phase = { kind: "working" }
    this.tools.clear()
    this.thought = undefined
    this.resetStep()
    this.changed()
  }

  end(now = Date.now()): TurnSummary | undefined {
    if (this.started === undefined) return undefined
    const summary = { elapsedMs: Math.max(0, now - this.started), steps: this.steps }
    this.started = undefined
    this.tools.clear()
    this.thought = undefined
    this.phase = { kind: "working" }
    this.resetStep()
    this.changed()
    return summary
  }

  get running(): boolean { return this.started !== undefined }

  elapsed(now = Date.now()): number {
    return this.started === undefined ? 0 : Math.max(0, now - this.started)
  }

  current(now = Date.now()): Phase {
    if (this.phase.kind === "retrying" && now >= this.phase.until) return { kind: "working" }
    return this.phase
  }

  /** The thinking in progress, whitespace folded, or "" when nothing is being thought. */
  thinking(): string {
    return this.thought ? this.thought.text : ""
  }

  /**
   * Output tokens per second: the live estimate while a step streams, otherwise the last
   * measured step. `estimated` is true for the former.
   */
  speed(now = Date.now()): { rate: number; estimated: boolean } | undefined {
    if (this.firstOutput !== undefined && this.streamedChars.length > 0) {
      const ms = now - this.firstOutput
      const tokens = estimateTokens(this.streamedChars)
      if (ms >= MIN_RATE_MS * 2 && tokens >= MIN_RATE_TOKENS) return { rate: tokens / (ms / 1000), estimated: true }
    }
    return this.measured === undefined ? undefined : { rate: this.measured, estimated: false }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  handle(event: UIEvent, now = Date.now()): void {
    switch (event.type) {
      case "part.start": {
        const part = event.part
        if (part.type === "step-start") { this.resetStep(); return }
        if (part.type === "reasoning" || part.type === "text" || part.type === "tool") this.markOutput(now)
        if (part.type === "reasoning") {
          this.thought = { id: part.id, text: "" }
          this.sawReasoning = true
          this.setPhase({ kind: "thinking" })
        }
        return
      }
      case "part.delta": {
        const part = event.part
        if (part.type !== "text" && part.type !== "reasoning") return
        this.markOutput(now)
        this.streamedChars += event.delta
        if (part.type === "reasoning") {
          this.sawReasoning = true
          const text = fold((this.thought?.id === part.id ? this.thought.text : "") + event.delta)
          this.thought = { id: part.id, text: text.length > THOUGHT_TAIL ? text.slice(-THOUGHT_TAIL) : text }
          if (this.phase.kind !== "thinking") this.setPhase({ kind: "thinking" })
          else this.changed()
        } else if (this.phase.kind !== "writing") {
          this.thought = undefined
          this.setPhase({ kind: "writing" })
        }
        return
      }
      case "part.end":
        if (event.part.type === "reasoning" && this.thought?.id === event.part.id) {
          this.thought = undefined
          this.setPhase(this.toolPhase() ?? { kind: "working" })
        } else if (event.part.type === "text" && this.phase.kind === "writing") {
          this.setPhase(this.toolPhase() ?? { kind: "working" })
        }
        return
      case "tool.state": {
        const part = event.part
        if (part.state.status === "running") {
          this.tools.set(part.callID, part.tool)
          this.thought = undefined
          this.setPhase({ kind: "tool", name: part.tool })
        } else if (part.state.status !== "pending" && this.tools.delete(part.callID)) {
          this.setPhase(this.toolPhase() ?? { kind: "working" })
        }
        return
      }
      case "step.finish": {
        this.steps++
        const { output, reasoning } = event.part.tokens
        if (this.firstOutput !== undefined) {
          const visible = this.sawReasoning ? output : Math.max(0, output - (reasoning ?? 0))
          const ms = now - this.firstOutput
          if (ms >= MIN_RATE_MS && visible >= MIN_RATE_TOKENS) this.measured = visible / (ms / 1000)
        }
        this.resetStep()
        this.changed()
        return
      }
      case "retry":
        this.setPhase({ kind: "retrying", until: now + event.delayMs })
        return
      default:
        return
    }
  }

  /** With parallel calls the line names whichever tool is still running. */
  private toolPhase(): Phase | undefined {
    const names = [...this.tools.values()]
    return names.length ? { kind: "tool", name: names[names.length - 1]! } : undefined
  }

  private markOutput(now: number): void {
    this.firstOutput ??= now
  }

  private resetStep(): void {
    this.firstOutput = undefined
    this.streamedChars = ""
    this.sawReasoning = false
  }

  private setPhase(phase: Phase): void {
    this.phase = phase
    this.changed()
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }
}

function fold(text: string): string {
  return terminalText(text).replace(/\s+/g, " ").trimStart()
}

/** A ticking clock reads whole seconds; `12.3s` changing ten times a second is noise. */
export function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`
}

/**
 * The turn's permanent trace: `worked 1m23s · 7 steps`. Tool lines carry their own
 * durations; this is the one number for the whole answer — how long the user waited.
 * A turn that never reached the model (an error before the first request) shows no steps.
 */
export function turnReceipt(summary: TurnSummary): string {
  const steps = summary.steps === 0 ? ""
    : ` · ${uiText(`${summary.steps} ${summary.steps === 1 ? "step" : "steps"}`, `${summary.steps} 步`, `${summary.steps} ステップ`)}`
  return uiText(`worked ${duration(summary.elapsedMs)}`, `用时 ${duration(summary.elapsedMs)}`, `所要 ${duration(summary.elapsedMs)}`) + steps
}

/** Animation frame period. Slow enough to read as calm, fast enough that a scan reads as motion. */
export const FRAME_MS = 150

/**
 * The mark's dots, row by row (6 columns × 4 rows = three braille cells). Derived from
 * `ALFA_BASE` in cli/brand.ts: the loop's top and bottom meet the stem across a gap, its
 * right side runs into the stem, and the tail leaves the stem at the bottom right.
 */
const MARK = [
  ".##.#.",
  "#..##.",
  "#..##.",
  ".##.##",
] as const
type Dot = readonly [row: number, col: number]
const LIT: Dot[] = MARK.flatMap((line, row) => [...line].flatMap((char, col) => char === "#" ? [[row, col] as const] : []))
/** Pen order for writing the α: round the loop from its top right, then down the stem into the tail. */
const STROKE: Dot[] = [[0, 2], [0, 1], [1, 0], [2, 0], [3, 1], [3, 2], [2, 3], [1, 3], [0, 4], [1, 4], [2, 4], [3, 4], [3, 5]]
/** The loop, clockwise from its top left — the track of the gap while a tool runs. */
const LOOP: Dot[] = [[0, 1], [0, 2], [1, 3], [2, 3], [3, 2], [3, 1], [2, 0], [1, 0]]
/** Braille dot bits: left column rows 0–3, then right column rows 0–3. */
const BITS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]] as const

function braille(dots: readonly Dot[]): string[] {
  const cells = [0, 0, 0]
  for (const [row, col] of dots) cells[Math.floor(col / 2)]! |= BITS[row]![col % 2]!
  return cells.map(bits => String.fromCharCode(0x2800 + bits))
}

const FULL = braille(LIT)
/** Two dots per frame, then the finished α holds for three frames. */
const WRITING = [...Array.from({ length: Math.ceil(STROKE.length / 2) }, (_, i) => braille(STROKE.slice(0, (i + 1) * 2))), FULL, FULL, FULL]
/** A two-dot gap, one step round the loop per frame. */
const SPINNING = LOOP.map((_, i) => {
  const gap = new Set([LOOP[i]!, LOOP[(i + 1) % LOOP.length]!].map(([row, col]) => `${row},${col}`))
  return braille(LIT.filter(([row, col]) => !gap.has(`${row},${col}`)))
})
/** Which cell is lit in the brightness sweep; the rest are dimmed. Out and back, like a scan. */
const SWEEP = [0, 1, 2, 1] as const

/**
 * The mark for a phase at a frame, coloured. `frame` is a counter, not a time, so a
 * paused animation (animation off) always shows frame 0 — for every phase, the full α.
 */
export function mark(phase: Phase, frame: number): string {
  const green = (cell: string) => theme.green(cell)
  switch (phase.kind) {
    case "thinking":
    case "working": {
      if (frame === 0) return FULL.map(green).join("")
      const lit = SWEEP[frame % SWEEP.length]!
      return FULL.map((cell, i) => i === lit ? theme.bold(green(cell)) : theme.dim(green(cell))).join("")
    }
    case "writing":
      return (frame === 0 ? FULL : WRITING[frame % WRITING.length]!).map(green).join("")
    case "tool":
      return (frame === 0 ? FULL : SPINNING[frame % SPINNING.length]!).map(green).join("")
    case "retrying":
      return theme.yellow(FULL.join(""))
  }
}
