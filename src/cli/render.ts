/**
 * Terminal rendering. It never writes to stdout itself: everything goes through the
 * OutputSink it's handed — the live area (live.ts) in interactive mode, a pass-through
 * to stdout in -p mode.
 *
 * ── Why nothing writes to stdout directly while the live area is up ──
 * Streamed text is typed out character by character; a single console.log line from
 * anywhere else splits the sentence being typed down the middle. Debug logs go to a
 * file via util/log.ts, never into stdout. There's also an input box pinned to the
 * bottom and redrawn every frame (live.ts); writing directly, bypassing it, tears it
 * apart. Direct process.stdout writes belong only where no live area exists: --help /
 * --version, the `auth` subcommand, setup hints before the session starts, and the
 * /reset receipt after region.close() (main.ts, auth.ts).
 *
 * ── Line-break state ──
 * The model's text isn't guaranteed to end with a newline, while tool cards must start
 * drawing at the start of a line. So we need to know "is the cursor at line start right
 * now" and add a \n when needed. This state looks trivial; miss it and the whole screen
 * is misaligned. The sink maintains it — the half line of text is part of the live
 * area, and only the sink knows about it.
 */
import { redact } from "../util/redact.ts"
import { theme } from "./theme.ts"
import type { OutputSink } from "./live.ts"
import { MarkdownStream } from "./markdown.ts"
import { planChanges, planRows } from "./plan.ts"
import type { UIEvent } from "../agent/events.ts"
import { t, uiText } from "../i18n/index.ts"
import { padToWidth, splitAtWidth, stripAnsi, wrapToWidth } from "./width.ts"
import { terminalText } from "./terminal-text.ts"
import type { ReasoningPart, ToolPart } from "../session/schema.ts"
import type { Tokens } from "../llm/types.ts"
import { parseTodos, type TodoItem } from "../tool/todo.ts"

export interface RenderOptions {
  width?(): number
  toolOutput?: "compact" | "expanded"
  /**
   * Where output goes. In interactive mode, the live area; in -p mode, an implementation
   * that passes straight through to stdout.
   */
  sink: OutputSink
  /** Stream the model's thinking in full (the `--reasoning` flag). Same as reasoning: "full". */
  showReasoning?: boolean
  /**
   * How thinking reaches the transcript. `full` streams it dimmed as it arrives; `preview`
   * leaves one `∴ thought 8.2s` receipt per block (the live tail is drawn by Shell and
   * never enters the scrollback); `off` prints nothing. Default off: `-p` and pipes feed
   * other programs, and a receipt is one more line they would have to filter.
   */
  reasoning?: ReasoningDisplay
  /**
   * Workspace root. Paths are shown relative to it — absolute paths stretch every card
   * until it wraps.
   */
  root?: string
  /**
   * Print a signature line before each assistant message starts speaking.
   *
   * In the scrollback transcript, the user's and the model's words were once told apart
   * only by a `›`; once it scrolled, you couldn't tell who was speaking at all —
   * especially when the model's answer had lists and code blocks too.
   */
  speakers?: boolean
  /**
   * Render the model's body text as markdown.
   *
   * Requires the sink to implement replaceTail — without the ability to "redraw the half
   * line", streaming markdown can't be done; in that case silently fall back to raw
   * output, rather than render halfway and get stuck.
   *
   * Off by default for pipes and -p: that output is for other programs to consume, and
   * bold and bullets only get in the way.
   */
  markdown?: boolean
}

export type ReasoningDisplay = "off" | "preview" | "full"

export class Renderer {
  private readonly width: () => number
  private outputMode: "compact" | "expanded"
  private readonly sink: OutputSink
  private reasoning: ReasoningDisplay
  /** The last checklist printed, so the next todo call prints only what moved (planChanges). */
  private plan: TodoItem[] = []
  private readonly root: string
  /** Tool parts whose header has already been drawn (avoids drawing twice) */
  private announced = new Set<string>()
  /**
   * The last tool that had its ● header drawn.
   *
   * With parallel calls (the model fires read + glob at once), the two ● are printed one
   * after the other, but the results come back in the order each finishes — so read's ↳
   * ends up hanging under glob's ●, which reads as flat-out wrong. So a result line omits
   * the tool name only when it directly follows its own header.
   */
  private lastAnnounced: string | undefined
  private stepStarted = 0
  /** Body renderer when markdown is on. undefined when off — body text goes out as-is. */
  private readonly md: MarkdownStream | undefined
  private readonly speakers: boolean
  /**
   * This message hasn't spoken yet. The signature is printed only once it actually
   * speaks — messages that only call tools without saying anything shouldn't get a header
   */
  private headerPending = false
  /** A thought receipt was just printed; the next tool card sits right under it */
  private glued = false

  constructor(options: RenderOptions) {
    this.width = options.width ?? (() => 80)
    this.outputMode = options.toolOutput ?? "compact"
    this.sink = options.sink
    this.reasoning = options.showReasoning ? "full" : (options.reasoning ?? "off")
    this.root = options.root ?? process.cwd()
    this.speakers = options.speakers ?? false
    this.md = options.markdown === true && typeof options.sink.replaceTail === "function" ? new MarkdownStream() : undefined
  }

  setToolOutput(value: "compact" | "expanded"): void { this.outputMode = value }
  setReasoning(value: ReasoningDisplay): void { this.reasoning = value }
  /** A different session: its first todo call must print the whole list again. */
  resetPlan(): void { this.plan = [] }

  handle(event: UIEvent): void {
    switch (event.type) {
      case "part.delta":
        if (event.part.type === "text") this.text(event.delta)
        // Thinking doesn't go through markdown: it's the model's scratch draft, not very
        // coherent to begin with, and rendering half headings and empty lists only makes
        // it harder to read. Dimming the whole stretch is enough.
        else if (event.part.type === "reasoning" && this.reasoning === "full") this.write(theme.dim(event.delta))
        break

      case "part.end":
        if (event.part.type === "text" || event.part.type === "reasoning") this.newlineIfNeeded()
        if (event.part.type === "reasoning" && this.reasoning === "preview") this.thought(event.part)
        break

      case "part.start":
        if (event.part.type === "step-start") this.stepStarted = Date.now()
        break

      case "tool.state":
        this.tool(event.part)
        break

      case "step.finish":
        this.stepLine(event.part.tokens, event.part.finishReason)
        break

      case "retry":
        this.line(
          theme.yellow(`  ↻ ${t.retrying(event.message, `${(event.delayMs / 1000).toFixed(1)}s`, event.attempt, event.maxAttempts)}`),
        )
        break

      case "error":
        this.line(theme.red(`  ✗ ${event.error.message}`))
        break

      case "message.start":
        this.headerPending = this.speakers
        break

      case "message.end":
        break
    }
  }

  // ───────────────────────────────────────────── tools

  private tool(part: ToolPart): void {
    const key = `${part.id}:${part.state.status}`
    if (this.announced.has(key)) return
    this.announced.add(key)

    switch (part.state.status) {
      case "pending":
        return // arguments not complete yet; drawing it would only flash
      case "running":
        this.newlineIfNeeded()
        if (!this.glued) this.line("")
        this.glued = false
        this.line(theme.accent(`  ● ${part.tool}`) + ` ${summarize(part, this.root)}`)
        this.lastAnnounced = part.id
        return
      case "completed": {
        const ms = part.state.time.end - part.state.time.start
        const failed = toolFailed(part)
        this.line((failed ? theme.error : theme.success)(`    ${failed ? "✗" : "↳"} ${this.owner(part)}${this.summaryOf(part)}`) + theme.muted(`  ${duration(ms)}`))
        if ((part.tool === "bash" || part.tool === "ssh") || this.outputMode === "expanded") {
          const rows = wrapToWidth(terminalText(typeof part.state.metadata.displayOutput === "string" ? part.state.metadata.displayOutput : part.state.output).trimEnd(), Math.max(1, this.width() - 6))
          const shown = this.outputMode === "expanded" ? rows : rows.slice(-6)
          if (this.outputMode === "compact" && rows.length > shown.length) this.line(theme.muted(`    … ${uiText("earlier output", "前文已省略", "前の出力を省略")} · /detail ${part.callID}`))
          for (const row of shown) if (part.state.output) this.line(theme.tool(padToWidth("    │ " + row, this.width())))
        }
        // ★ The diff is always printed. edit being allowed by default was bought on the
        //   premise that "what changed must be visible on the spot"; skip a diff even
        //   once and that default no longer holds.
        const diff = part.state.metadata["diff"]
        if (typeof diff === "string" && diff.length > 0) this.diff(diff)
        // Print the plan in full, for the same reason as the diff: what that call did
        // **is** this checklist, and printing a single `2/5` line hides everything the
        // tool did
        // Several questions: one row each, since the header and ↳ carry only the first.
        // One question is already whole in those two lines
        const asked = askedRows(part.state.metadata["asked"], this.width())
        if (asked.length > 1) for (const line of asked.flat()) this.line(line)
        const todos = parseTodos(part.state.metadata["todos"])
        // Dropped: the next plan is new, so it prints in full
        if (part.state.metadata["cleared"] === true) this.plan = []
        if (todos.length > 0) {
          for (const line of planRows(planChanges(this.plan, todos), 72)) this.line("    " + line)
          this.plan = todos
        }
        return
      }
      case "error":
        this.line(theme.error(`    ✗ ${this.owner(part)}${firstLine(part.state.error)}`))
        return
    }
  }

  /** When a result line is out of place, add "whose result this is". */
  private owner(part: ToolPart): string {
    if (this.lastAnnounced === part.id) return ""
    return `${part.tool}: `
  }

  private summaryOf(part: ToolPart): string {
    return outcomeLine(part, this.root)
  }

  /**
   * The colored unified diff. This is the user's one chance to see what the file was
   * changed into.
   *
   * The header keeps a single line with the relative path: `Index:`'s absolute path and
   * that 67-equals-sign separator are for patch(1), pure noise to a human; but the file
   * name has to stay — when several files are edited in parallel, without it you can't
   * tell whose diff this block is.
   */
  private diff(patch: string): void {
    for (const line of diffLines(patch, this.root)) this.line("    " + line)
  }

  /** The signature line, once per message, before the first thing it shows. */
  private speak(): void {
    if (!this.headerPending) return
    this.headerPending = false
    this.line("")
    this.line(theme.accent(AGENT_MARK) + theme.bold(" alfa"))
  }

  /**
   * `∴ thought 8.2s` — the thinking block's permanent trace in preview mode, indented like
   * a tool line and glued to the card that follows (the call it led to).
   *
   * Tried first: printing the `◆ alfa` signature before it. In a tool loop every step is
   * its own message, so each step grew a blank line and a signature — the signature is
   * for when the model *speaks*, and tool lines never had one. Also tried: a receipt for
   * every block. Models that think for a few hundred milliseconds before each call left a
   * `thought 98ms` above every tool line; under a second the live tail already said it all.
   */
  private thought(part: ReasoningPart): void {
    const ms = part.time?.end !== undefined ? part.time.end - part.time.start : 0
    if (ms < 1000) return
    this.line("")
    this.line(theme.dim(`  ∴ ${uiText("thought", "思考", "思考")} ${duration(ms)}`))
    this.glued = true
  }

  // ───────────────────────────────────────────── status line

  private stepLine(tokens: Tokens, finishReason: string): void {
    if (this.speakers && (finishReason === "stop" || finishReason === "tool-calls")) return
    const ms = this.stepStarted > 0 ? Date.now() - this.stepStarted : 0
    const bits = [
      `${compact(tokens.input)} in`,
      `${compact(tokens.output)} out`,
      tokens.cache.read > 0 ? `${compact(tokens.cache.read)} cached` : "",
      ms > 0 ? duration(ms) : "",
      finishReason !== "stop" && finishReason !== "tool-calls" ? finishReason : "",
    ].filter(Boolean)
    this.newlineIfNeeded()
    this.line(theme.dim(`  · ${bits.join(" · ")}`))
  }

  // ───────────────────────────────────────────── primitives

  /** Separator before a user prompt. */
  banner(text: string): void {
    this.newlineIfNeeded()
    this.line(theme.dim(text))
  }

  line(text: string): void {
    this.newlineIfNeeded()
    this.sink.write(redact(text) + "\n")
  }

  write(text: string): void {
    if (text.length === 0) return
    // Flush the markdown buffer before writing raw. Thinking and body text are two
    // separate paths; when they interleave, without this the thinking text gets tacked
    // onto the body's still-open half line
    this.flushText()
    this.sink.write(redact(text))
  }

  /**
   * Model body text.
   *
   * On every delta, commit "the finalized whole lines" and replace "the unfinished part"
   * entirely — combined into one replaceTail, drawn in one frame.
   */
  private text(delta: string): void {
    this.glued = false
    this.speak()
    if (!this.md) {
      this.write(delta)
      return
    }
    this.md.push(delta)
    this.sink.replaceTail!(this.md.drain(), this.md.preview())
  }

  /**
   * Finalize everything left in the markdown buffer.
   *
   * Must be called before any non-body output (tool cards, errors, stats lines) —
   * otherwise that content gets inserted into the middle of a code block that isn't
   * closed yet, or a half-accumulated table, and the buffered content gets emitted again
   * later, as a duplicate.
   */
  private flushText(): void {
    if (!this.md || this.md.idle) return
    this.sink.replaceTail!(this.md.end(), "")
  }

  newlineIfNeeded(): void {
    this.flushText()
    if (this.sink.atLineStart) return
    this.sink.write("\n")
  }

  /** Clear the dedup set each turn, or same-named parts across turns get swallowed. */
  reset(): void {
    this.flushText()
    this.announced.clear()
    this.stepStarted = 0
    this.headerPending = false
  }
}

/**
 * The mark on the line before the model speaks. A different shape from the user's bar —
 * you can tell at a glance who's talking.
 */
const AGENT_MARK = "◆"
/**
 * The bar to the left of the user's text. Live turns and replayed history (replay.ts)
 * both draw it through userLines — "what you said" must look the same whether it was
 * just typed or came back with a resumed session
 */
export const USER_BAR = "▌"

/**
 * What the user said, drawn as one block.
 *
 * ── Why every line carries the bar ──
 * It used to print one `›` on the first line only, with continuation lines flush left.
 * So once a three-line question scrolled up, its last two lines looked exactly like the
 * model's answer — and "who said this" is the first question to answer when reading a
 * conversation. With the bar running all the way down, the block's boundary is
 * self-evident; no counting indents.
 *
 * A bar rather than a background color: on light terminals a background color is either
 * invisible or smears into a blob, and we don't know what theme this project's users
 * run.
 */
export function userLines(text: string, width?: number): string[] {
  const bar = theme.accent(USER_BAR)
  if (width === undefined) return ["", ...text.split("\n").map((line) => `${bar} ${line}`)]
  return ["", ...wrapToWidth(text, Math.max(1, width - 2)).map(line => theme.user(padToWidth(`${USER_BAR} ${line}`, width))), ""]
}

/**
 * What a slash command prints, hung under the command's echo:
 *
 * ```
 * ▌ /think
 *
 *   ⎿ thinking on
 *     shown from the next turn
 * ```
 *
 * ── Why a block of its own ──
 * Command output used to go into the transcript as bare lines, with the command itself
 * never echoed. Nothing then separated "what /context printed" from "what the model
 * said": both were unmarked text in the same column, and a reply mid-turn landed in the
 * middle of the answer being streamed. The echo says what produced it; the elbow and the
 * indent say where it ends.
 *
 * `first` is whether this call opens the block (one command may reply several times; only
 * the first line of all of them gets the elbow). Callers indent their own replies — most
 * start every line with two spaces — so the common indent is dropped first, or the block
 * would sit two columns further right than it looks like it should.
 * ⚠ The indent is counted on the text without ANSI and cut with splitAtWidth: the spaces
 *   often sit inside a color (`theme.dim("  ")`), and a plain slice would cut the escape.
 */
export function commandLines(text: string, width: number, first: boolean): string[] {
  const rows = text.split("\n")
  const blank = (line: string) => stripAnsi(line).trim().length === 0
  while (rows.length > 0 && blank(rows[0]!)) rows.shift()
  while (rows.length > 0 && blank(rows[rows.length - 1]!)) rows.pop()
  if (rows.length === 0) return []
  const indent = Math.min(...rows.filter(line => !blank(line)).map(line => /^ */.exec(stripAnsi(line))![0].length))
  const out: string[] = []
  for (const row of rows) {
    if (blank(row)) { out.push(""); continue }
    for (const piece of wrapToWidth(indent > 0 ? splitAtWidth(row, indent)[1] : row, Math.max(1, width - 4))) {
      out.push((first ? theme.muted(`  ${COMMAND_ELBOW} `) : "    ") + piece)
      first = false
    }
  }
  return out
}

/**
 * What an ask call's questions were answered with, one group of lines per question
 * (`· question → answer`, wrapped under itself). Both texts came from outside — the
 * model wrote one, the user typed the other — so both go through terminalText.
 */
export function askedRows(value: unknown, width: number): string[][] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return []
    const { question, kind, answer } = item as Record<string, unknown>
    if (typeof question !== "string") return []
    const said = kind === "picked" || kind === "typed"
    const reply = said && typeof answer === "string" ? theme.bold(terminalText(answer)) : theme.muted(t.askDismissed)
    const text = `${theme.muted(terminalText(question))} → ${reply}`
    return [wrapToWidth(text, Math.max(1, width - 6)).map((line, at) => (at === 0 ? "    · " : "      ") + line)]
  })
}

/** Hangs a command's output under its echo. The same elbow as Claude Code's, on purpose. */
export const COMMAND_ELBOW = "⎿"

/**
 * completed only means the process returned, not that the command succeeded; exit codes
 * and HTTP errors must stand out.
 */
export function toolFailed(part: ToolPart): boolean {
  if (part.state.status === "error") return true
  if (part.state.status !== "completed") return false
  const { exit, status } = part.state.metadata
  return exit === null || typeof exit === "number" && exit !== 0 || typeof status === "number" && status >= 400
}

/**
 * Details in the order a human reads them; output must keep its real newlines, never be
 * stuffed back into a JSON string.
 */
export function toolDetails(part: ToolPart, root = ""): string {
  const state = part.state
  const lines = [theme.bold(`${part.tool} · ${state.status}`), theme.muted(`callID: ${part.callID}`), "", theme.accent(uiText("Input", "输入", "入力"))]
  if ("input" in state) {
    for (const [key, value] of Object.entries((state.input ?? {}) as Record<string, unknown>)) {
      lines.push(`${terminalText(key)}:`, terminalText(typeof value === "string" ? value : JSON.stringify(value, null, 2)))
    }
  }
  if (state.status === "completed") lines.push("", theme.accent(uiText("Result", "结果", "結果")), terminalText(outcomeLine(part, root)), "", terminalText(typeof state.metadata.displayOutput === "string" ? state.metadata.displayOutput : state.output))
  if (state.status === "completed" && typeof state.metadata.diff === "string") lines.push("", ...diffLines(state.metadata.diff, root))
  if (state.status === "error") lines.push("", theme.error(terminalText(state.error)))
  return lines.join("\n")
}

/**
 * Colors a unified diff. The tool card and /detail (toolDetails) both draw diffs through
 * this one function — with each place writing its own, some day they'd diverge in some
 * corner, and the user would think the two places were showing different things.
 */
export function diffLines(patch: string, root = ""): string[] {
  const out: string[] = []
  for (const raw of patch.split("\n")) {
    // `Index:`'s absolute path and that 67-equals-sign separator are for patch(1),
    // noise to a human; but the file name has to stay — when several files are edited
    // in parallel, without it you can't tell whose diff this block is
    if (raw.startsWith("=====")) continue
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) continue
    if (raw.startsWith("Index: ")) {
      out.push(theme.bold(shortenPaths(raw.slice("Index: ".length), root)))
      continue
    }
    if (raw.startsWith("@@")) out.push(theme.cyan(raw))
    else if (raw.startsWith("+")) out.push(theme.green(raw))
    else if (raw.startsWith("-")) out.push(theme.red(raw))
    else out.push(theme.muted(raw))
  }
  return out
}

// ───────────────────────────────────────────── pure functions (unit-testable)

export function summarize(part: ToolPart, root = ""): string {
  const input = "input" in part.state ? part.state.input : undefined
  if (!input || typeof input !== "object") return ""
  const record = input as Record<string, unknown>
  // url / query, like command, are **verbatim** things and must not be parsed as paths
  // — relativizing a URL chops it beyond recognition.
  // Same for question / description: they're prose, not paths. Without them, `● ask`
  // and `● task` would be the only two tool lines on screen that **don't say what
  // they're doing** — and those two are exactly the ones that most need to: one is
  // about to interrupt you, the other is about to spend money
  const verbatim = new Set(["command", "url", "query", "question", "description"])
  // ask takes `questions: [{ question, … }]`, not a top-level `question`; without this
  // branch its line was the blank `● ask` the paragraph above exists to prevent
  // Native patch paths are nested. A blank running card hides the target precisely
  // while a default-authorized edit is in progress; the completed diff arrives later.
  const operation = record["operation"]
  if (part.tool === "apply_patch" && operation && typeof operation === "object") {
    const { path, type } = operation as { path?: unknown; type?: unknown }
    if (typeof path === "string" && path.length > 0) {
      const action = type === "create_file" ? uiText("create", "创建", "作成") :
        type === "delete_file" ? uiText("delete", "删除", "削除") :
        type === "update_file" ? uiText("update", "修改", "更新") : ""
      return truncate([action, relativize(path, root)].filter(Boolean).join(" "), 72)
    }
  }
  // task has no `description` (the verbatim list below predates its name/prompt shape), so
  // its line went blank — on the one call that starts spending money in the background
  if (part.tool === "task") {
    const resume = typeof record["resume"] === "string" ? record["resume"] : ""
    const who = resume ? `${resume} (${uiText("resume", "唤醒", "再開")})` : typeof record["name"] === "string" ? record["name"] : ""
    const brief = typeof record["prompt"] === "string" ? record["prompt"].trim().split("\n")[0]! : ""
    return truncate([who, brief].filter(Boolean).join(" · "), 72)
  }
  const questions = record["questions"]
  if (Array.isArray(questions)) {
    const first = (questions[0] as { question?: unknown } | undefined)?.question
    if (typeof first === "string" && first.length > 0) {
      return truncate(questions.length > 1 ? `${first} (+${questions.length - 1})` : first, 72)
    }
  }
  for (const key of ["command", "filePath", "pattern", "path", "url", "query", "question", "description"]) {
    const value = record[key]
    if (typeof value !== "string" || value.length === 0) continue
    return truncate(verbatim.has(key) ? value : relativize(value, root), 72)
  }
  return ""
}

/**
 * Result summary. **Prefer metadata**, fall back to the first line of output.
 *
 * Printing the first output line is meaningless for tools like read — its first line is
 * a structural marker like `<path>…</path>` meant for the model, pure noise to the user.
 * metadata is where the things actually worth seeing are: how many lines changed, the
 * exit code, whether it was truncated.
 */
export function outcomeLine(part: ToolPart, root = ""): string {
  if (part.state.status !== "completed") return ""
  const meta = part.state.metadata
  const bits: string[] = []

  // ★ Goes first. When this slot can't fit everything it drops from the end, and
  //   "something on this page is issuing commands at the agent" is the one item in the
  //   whole line that must not be dropped — everything else is just "did it work".
  //   See tool/untrusted.ts
  const flagged = numberOf(meta["flagged"])
  if (flagged !== undefined && flagged > 0) bits.push(`⚠ ${flagged} flagged`)

  const additions = numberOf(meta["additions"])
  const deletions = numberOf(meta["deletions"])
  if (additions !== undefined || deletions !== undefined) {
    bits.push(`+${additions ?? 0} -${deletions ?? 0}`)
  }

  const exit = meta["exit"]
  if (typeof exit === "number") bits.push(exit === 0 ? "exit 0" : `exit ${exit}`)
  else if (exit === null) bits.push("killed")

  const count = numberOf(meta["matches"]) ?? numberOf(meta["count"])
  if (count !== undefined) bits.push(`${count} match${count === 1 ? "" : "es"}`)

  const lines = numberOf(meta["lines"])
  if (lines !== undefined) bits.push(`${lines} line${lines === 1 ? "" : "s"}`)

  // The two network ones. HTTP status is judged separately from exit — 200 and exit 0
  // aren't the same thing, and a 404 page was still "successfully" fetched
  const status = numberOf(meta["status"])
  if (status !== undefined) bits.push(String(status))
  const hits = numberOf(meta["hits"])
  if (hits !== undefined) bits.push(`${hits} result${hits === 1 ? "" : "s"}`)

  // What the user picked (ask), or what the dispatched thing is called (task / job).
  // This line is the only thing visible when looking back through the record — without
  // it, an answered question is reduced to "ask 0.4s"
  const answer = meta["answer"]
  if (typeof answer === "string" && answer.length > 0) bits.push(truncate(answer, 48))
  const job = meta["job"]
  if (typeof job === "string" && job.length > 0) bits.push(job)

  if (meta["truncated"] === true) bits.push("truncated")

  if (bits.length > 0) return bits.join(" · ")
  // When falling back to the first output line, shorten workspace paths — an absolute
  // path crowds out everything that's actually useful
  return shortenPaths(firstLine(part.state.output), root) || t.noOutput
}

/** Replace every in-workspace absolute path in a line of text with a relative path. */
export function shortenPaths(text: string, root: string): string {
  if (!root) return text
  const roots = [root]
  // On macOS /var and /private/var are the same directory; replace the longer prefix
  // first, so we don't leave /privatefile.ts behind.
  if (root.startsWith("/var/") || root.startsWith("/tmp/")) roots.unshift("/private" + root)
  else if (root.startsWith("/private/var/") || root.startsWith("/private/tmp/")) roots.push(root.slice(8))
  for (const path of roots) text = text.split(path + "/").join("")
  return text
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * Paths inside the workspace are shown relative, outside ones stay absolute — crossing
 * the boundary must be visible.
 */
export function relativize(path: string, root: string): string {
  if (!root || !path.startsWith(root)) return path
  const rest = path.slice(root.length).replace(/^\/+/, "")
  return rest.length > 0 ? rest : "."
}

export function firstLine(text: string, max = 100): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? ""
  return truncate(line.trim(), max)
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…"
}

export function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m${Math.round((ms % 60_000) / 1000)}s`
}
