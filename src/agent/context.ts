/**
 * Context usage: how much is loaded right now, and who is taking it.
 *
 * ── Why estimate locally instead of only reporting the provider's number ──
 * The provider gives a single total (input + cache), while what the user asks is **"who
 * filled up the window"**. Only local code can answer that: how long a tool result is, how
 * long a piece of thinking is — only the history itself knows. So this does two things:
 * slice out each part's share by local estimate, then align the total to the number the
 * provider reported (see scale). The breakdown shown always agrees with the total in the
 * title — faced with a breakdown that doesn't add up to its total, a reader trusts neither.
 *
 * ── Estimation rule: rather rough than falsely precise ──
 * No tokenizer. A real tokenizer means swapping tables per model, and the purpose here is
 * "how much room is left"; being 10% off changes no decision. There are just two rules: CJK
 * characters run about 1 token per character, everything else 3.6 characters per token.
 * Each message adds a bit of structural overhead — the message wrapper, role names and
 * tool_use ids are all real positions that cost money.
 *
 * ── What's counted is what the **next request** will send ──
 * History before the compaction point stays in the store but is never sent to the model
 * again (see to-model-messages.ts). So counting starts at the compaction point: a gauge
 * that counted already-folded history would sit dead still after compaction, which is
 * exactly the moment the user most needs it to move.
 */
import { z } from "zod"
import type { ModelInfo, Tokens } from "../llm/types.ts"
import type { MessageWithParts } from "../session/schema.ts"
import type { ToolDef } from "../tool/types.ts"
import { isMcpTool } from "../mcp/tools.ts"
import { accumulateBilled, contextTokens, emptyTokens, safe, usable } from "./tokens.ts"
import { liveHistory, loopStartIndex } from "./to-model-messages.ts"

/**
 * Structural overhead of one message.
 *
 * Role names, separators, the content-array wrapper — every message pays it, and a long
 * session has messages in the hundreds; ignore it and the whole estimate runs
 * systematically low.
 */
const PER_MESSAGE = 4
/** The extra shell of one tool call: callID, tool name, JSON brackets and quotes */
const PER_TOOL_CALL = 10
/** The shell of one tool definition: the name, the schema's outer wrapper */
const PER_TOOL_DEF = 12

/**
 * The id of the `skill` tool.
 *
 * Hard-coded as a string instead of importing the tool: this path runs every turn, and one
 * constant isn't worth dragging prompt/skills.ts and its chain (fs, config path resolution)
 * into the metering module. Tests keep it in sync (the `expect(SkillTool.id)` in
 * test/context.test.ts).
 */
const SKILL_TOOL = "skill"

/** Slices. Their order is the display order — from "always there" to "grows as you talk" */
// memory sits right after summary: both are "background loaded in", not things produced in
// this session. It was once mixed into the system slice — and the question this report
// answers is exactly "which piece to cut"; mix a piece you can't cut (system) with one
// that's gone once you delete a few files (memory), and the answer comes out wrong
// ★ env and handoff are **split out of the user slice**.
//
//   In the store these three look exactly alike: all are text parts on messages whose role
//   is user. Yet only one of them is typed by the user — of the other two, one is the repo
//   snapshot attached at the start, the other is material the program fed back (reports
//   handed back by subagents, receipts from the end-of-turn check). Lumped into one slice,
//   under agentflow this report turns straight into waste paper: a dozen-plus subagents
//   each hand in a 300-word report, the gauge reads "what you said: 120k", and the user
//   typed two sentences in total.
//
//   The criterion for the split is the same as the reason this report exists (see the
//   passage above SLICE_KEYS): mix a piece you can't cut with one that disappears once you
//   say "have them hand their reports to the next worker instead of to me", and the answer
//   comes out wrong.
export const SLICE_KEYS = [
  "system",
  "tools",
  // Other people's tools get a slice of their own: they're a fixed cost **sent every
  // turn**, and the only kind the user can switch off in one go (/mcp shows who installed
  // how many). Mixed into tools, a server that spews thirty tools would look just as
  // immovable as our own fifteen built-in tools
  "mcp",
  // skills: the catalog (sent every turn) **plus** the bodies already opened this session.
  // The two halves share a slice because the user's question is "how much did skills cost
  // me in total" — counting only the catalog would hide exactly the expensive half (one
  // body is twenty times a catalog line) inside result, and that half is the very evidence
  // of whether this design holds up
  "skills",
  "summary",
  "memory",
  "env",
  "user",
  "handoff",
  "reply",
  "thinking",
  "call",
  "result",
] as const
export type SliceKey = (typeof SLICE_KEYS)[number]

export interface ContextSlice {
  key: SliceKey
  tokens: number
}

export interface ContextReport {
  /** How much is used right now */
  used: number
  /**
   * This number is a local estimate (the provider hasn't reported yet, or what it reported
   * no longer counts)
   */
  estimated: boolean
  /** The model's context window */
  limit: number
  /**
   * The line that counts as 100%. See tokens.usable — it's below limit, leaving room for
   * compaction and output
   */
  budget: number
  /** used / budget, capped at 1 */
  ratio: number
  /** budget minus what's used; negative counts as 0 */
  free: number
  slices: ContextSlice[]
  /** Number of messages that will be sent to the model */
  messages: number
  /** Number of messages folded by compaction and no longer sent to the model */
  folded: number
  /** Where the window size came from. See ModelInfo.limitSource */
  limitSource: NonNullable<ModelInfo["limitSource"]>
  /**
   * What this run has spent in total. **Not the same thing as any number above** — those
   * describe what's in the window; this one is how much has been sent in all. It only grows,
   * and runs far larger than the window (every turn resends the whole history).
   */
  spent: { total: number; input: number; output: number; cached: number }
}

export interface ContextInput {
  history: MessageWithParts[]
  /** The system actually sent this turn. Read fresh — it's reassembled every turn */
  system: string[]
  tools: ToolDef<any>[]
  /**
   * The verbatim text of the skills **catalog** section in system (see prompt/skills.ts).
   *
   * Passed in so it can be split out of the system slice — it answers "what does one more
   * skill cost", while the system number can't be cut. Not passed means this path has no
   * skills, and everything stays as before.
   */
  skills?: string
  info: ModelInfo
  /**
   * The usage reported by the provider (already converted by contextTokens).
   *
   * When present it's authoritative, and the local estimate is used only to slice it up —
   * it's the one **real number**, and the breakdown is only a matter of proportions anyway.
   */
  reported?: number
  /** What this run has spent in total (ContextMeter.spent). Treated as zero if absent */
  spent?: Tokens
}

// ─────────────────────────────────────────────── Estimation

/**
 * What one attached image is counted as. A flat figure, not its bytes: an image costs by
 * pixels, and providers scale anything big down before counting — Claude caps the long
 * edge at 1568 px, about 1.6k tokens, which is also where cli/attachments.ts shrinks to.
 * ⚠ Estimating from the stored base64 instead would read a 3 MB screenshot as ~1M tokens
 *   and trigger compaction on the spot.
 */
export const IMAGE_TOKENS = 1_600

/**
 * Roughly how many tokens a piece of text is.
 *
 * CJK characters (Han, kana, Hangul) are about one token per character; Latin text about
 * one per 3.6 characters. These two coefficients are rules of thumb from common BPE
 * vocabularies — not exact to the unit, but good enough to answer "how much is left".
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  let wide = 0
  let rest = 0
  for (const char of text) {
    if (isIdeograph(char.codePointAt(0) ?? 0)) wide++
    else rest++
  }
  return Math.ceil(wide + rest / 3.6)
}

/**
 * CJK characters: one character is one token (sometimes more than one), so you can't divide
 * by the character count.
 */
function isIdeograph(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // Hiragana / Katakana
    (code >= 0x3400 && code <= 0x4dbf) || // Extension A
    (code >= 0x4e00 && code <= 0x9fff) || // basic block (CJK Unified Ideographs)
    (code >= 0xac00 && code <= 0xd7af) || // Hangul
    (code >= 0xf900 && code <= 0xfaff) || // Compatibility Ideographs
    (code >= 0x20000 && code <= 0x2ebef) // Extensions B–F
  )
}

/**
 * How much the tool definitions take.
 *
 * The schema follows the code, not the session, so it's cached by id — regenerating the
 * JSON Schema every time the gauge opens is wasted effort. Descriptions are **not cached**:
 * bash's description is a lazy function that changes with the shell and the cap constants.
 */
const schemaCache = new Map<string, number>()

export function toolTokens(tools: ToolDef<any>[]): number {
  let total = 0
  for (const tool of tools) {
    const description = typeof tool.description === "function" ? tool.description() : tool.description
    let schema = schemaCache.get(tool.id)
    if (schema === undefined) {
      schema = schemaTokens(tool)
      schemaCache.set(tool.id, schema)
    }
    total += estimateTokens(tool.id) + estimateTokens(description) + schema + PER_TOOL_DEF
  }
  return total
}

/**
 * Size of the parameter schema.
 *
 * Schemas that can't be converted to JSON Schema (zod with transform / refine) get a
 * conservative constant — a skewed estimate here only nudges that slice's number a little,
 * while throwing would keep the whole `/context` from opening.
 */
function schemaTokens(tool: ToolDef<any>): number {
  try {
    return estimateTokens(JSON.stringify(z.toJSONSchema(tool.parameters as never)))
  } catch {
    return 120
  }
}

// ─────────────────────────────────────────────── Slices

/**
 * Slice the history that will be sent to the model into its parts.
 *
 * ⚠ Which messages get sent is decided by liveHistory, the same function toLLMMessages uses
 * — write the check separately on each side and sooner or later you get "the gauge says
 * full, while the model actually received only half". Same for the thinking line, which
 * uses the same loopStartIndex: only thinking from the current tool loop is sent; earlier
 * thinking was dropped long ago (see to-model-messages.ts). It was once counted
 * unconditionally, so the gauge carried a big slice of thinking that was never sent.
 */
export function sliceHistory(history: MessageWithParts[]): { slices: Map<SliceKey, ContextSlice>; messages: number } {
  const slices = new Map<SliceKey, ContextSlice>()
  const add = (key: SliceKey, tokens: number) => {
    const slice = slices.get(key) ?? { key, tokens: 0 }
    slice.tokens += tokens
    slices.set(key, slice)
  }

  const live = liveHistory(history).messages
  const loopStart = loopStartIndex(live)
  let messages = 0

  for (const [index, entry] of live.entries()) {
    messages++
    // Synthetic throughout = material the program fed back, not the user's words (see the
    // passage above SLICE_KEYS). The test is "does this message contain a single line a
    // real person typed" — the repo snapshot hangs on **the user's real message**, while
    // reports and check receipts each get a message to themselves
    const injected =
      entry.info.role === "user" &&
      !entry.parts.some((part) => part.type === "text" && !part.synthetic && part.text.length > 0)
    const own: SliceKey = entry.info.role === "user" ? (injected ? "handoff" : "user") : "reply"
    // The message's own shell counts toward its own slice: the slices must add up to the
    // total, with no entry left off the books
    add(own, PER_MESSAGE)
    for (const part of entry.parts) {
      switch (part.type) {
        case "text":
          // The real person's message also carries the opening repo snapshot (see
          // attachGitContext in loop.ts)
          add(part.synthetic && !injected ? "env" : own, estimateTokens(part.text))
          break
        case "compact":
          add("summary", estimateTokens(part.text))
          break
        case "memory":
          add("memory", estimateTokens(part.text))
          break
        case "file":
          // An image the user attached counts toward what they said. See IMAGE_TOKENS
          add(own, IMAGE_TOKENS)
          break
        case "reasoning":
          // Thinking outside this loop is never sent; counting it would be overreporting
          if (index > loopStart) add("thinking", estimateTokens(part.text))
          break
        case "tool": {
          const state = part.state
          if (state.status === "pending") break // dropped whole, never reaches the model
          add("call", estimateTokens(json(state.input)) + PER_TOOL_CALL + estimateTokens(part.tool))
          const output = state.status === "completed" ? state.output : state.status === "error" ? state.error : ""
          // ★ An opened skill counts toward skills, not result.
          //
          //   It looks like tool output, but it isn't: what `read` returns is the file
          //   the user wants to see — **the work**; a skill's body is **prompt** — the
          //   model uses it to change what it does next, and it stays in the window for
          //   the rest of the turn. Classified by origin, it's closer to system than to
          //   result.
          //
          //   What matters more is the question this slice has to answer: the whole
          //   selling point of the skills design is "cheap catalog, bodies on demand",
          //   and a skills slice counting only the catalog would hide **the very number
          //   that tests that claim** inside result. Only when you can see "four catalog
          //   entries at 262 tokens, two opened for 2.4k" does the trade-off hold up.
          add(part.tool === SKILL_TOOL ? "skills" : "result", estimateTokens(output) + PER_TOOL_CALL)
          break
        }
        default:
          // step-start / step-finish don't go into the model's context
          break
      }
    }
  }

  return { slices, messages }
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}

// ─────────────────────────────────────────────── Report

export function contextReport(input: ContextInput): ContextReport {
  const { slices, messages } = sliceHistory(input.history)
  const system = input.system.reduce((sum, part) => sum + estimateTokens(part), 0)
  /**
   * ★ Whatever is split out must be **subtracted** from the slice it came from.
   *
   * This report's total is compared against the window, and the slices must sum to it —
   * counting something twice doesn't just make the numbers ugly, it makes the report lie:
   * the user cuts things based on an inflated system, and afterwards finds nothing changed.
   */
  const skills = input.skills ? estimateTokens(input.skills) : 0
  const mcpTools = input.tools.filter((one) => isMcpTool(one.id))
  slices.set("system", { key: "system", tokens: Math.max(0, system - skills) })
  slices.set("skills", { key: "skills", tokens: skills })
  slices.set("tools", { key: "tools", tokens: toolTokens(input.tools.filter((one) => !isMcpTool(one.id))) })
  slices.set("mcp", { key: "mcp", tokens: toolTokens(mcpTools) })

  const estimate = [...slices.values()].reduce((sum, slice) => sum + slice.tokens, 0)
  const used = input.reported !== undefined && input.reported > 0 ? input.reported : estimate

  /**
   * Align the slices to the total.
   *
   * The provider's number is the real one, while the slices are estimates — without
   * scaling, the title says 306k while the lines below add up to 270k, and the reader
   * starts suspecting both numbers are made up. The error is spread proportionally across
   * the slices, because the estimate's bias is global to begin with (a coefficient is off),
   * not one slice being especially skewed.
   */
  const scale = estimate > 0 ? used / estimate : 1
  const ordered = SLICE_KEYS.map((key) => ({ key, tokens: Math.round((slices.get(key)?.tokens ?? 0) * scale) }))

  const budget = usable(input.info.limit)
  return {
    used,
    estimated: input.reported === undefined || input.reported <= 0,
    limit: input.info.limit.context,
    budget,
    ratio: budget > 0 ? Math.min(1, used / budget) : 0,
    free: Math.max(0, budget - used),
    slices: ordered,
    messages,
    folded: liveHistory(input.history).folded,
    limitSource: input.info.limitSource ?? "default",
    spent: {
      total: spentTotal(input.spent, input.info),
      input: contextTokens(input.spent, input.info),
      output: safe(input.spent?.output),
      cached: safe(input.spent?.cache?.read),
    },
  }
}

// ─────────────────────────────────────────────── Meter

export interface ContextSnapshot {
  used: number
  budget: number
  limit: number
  ratio: number
  estimated: boolean
  /**
   * How many tokens this run has **burned in total** (see ContextMeter.spent).
   *
   * A completely different number from used; don't mix them up: used is "how much the
   * window holds now", and it drops with compaction; spent is "how much has been sent in
   * all", and it only grows. A session twenty turns in with 300k in the window easily has
   * spent 6M — because every turn resent the whole history.
   *
   * In and out are kept apart because **their unit prices differ by an order of
   * magnitude**: in piles up from resending history every turn (and cache hits are cheaper
   * still), out is the text the model actually wrote. Report only a total, and "4.4M" could
   * be a very cheap session or a very expensive one.
   */
  spent: { total: number; input: number; output: number }
}

/**
 * Source of the number on the status line.
 *
 * ── Why an object, rather than computing it fresh every frame ──
 * The footer is read on every frame — several a second while a turn animates — and
 * computing usage once means scanning the full history. Computed fresh, a big session
 * would scan the store that often — and this number **only changes once per turn**. So main feeds it in at turn boundaries, and
 * the UI only reads it.
 *
 * ── The two numbers, reported and estimate ──
 * The provider's is the real number, but it only exists after a request has gone out; at
 * startup, after compaction, and after switching sessions, all we have is the local
 * estimate. Both are kept, the real one takes priority, and "this is an estimate" is shown
 * — an estimate that doesn't say it's an estimate is no different from a fake number.
 */
export class ContextMeter {
  private reported: number | undefined
  private estimate = 0
  private billed: Tokens = emptyTokens()

  constructor(private info: ModelInfo) {}

  /**
   * The model changed. Window size and cache accounting (see ModelInfo.cacheInInput) all
   * change with it.
   *
   * ★ Throw away the provider-reported number while at it. It was counted by **the previous
   *   model's tokenizer**; dividing it by the new model's window measures the same text with
   *   two rulers — going from 200k to 30k, that cell would read "still plenty of room", and
   *   the next request goes straight over the limit.
   */
  retarget(info: ModelInfo): void {
    this.info = info
    this.reported = undefined
  }

  /** The provider reported (step end). Usage takes the latest report; spend accumulates. */
  observe(tokens: Tokens): void {
    const used = contextTokens(tokens, this.info)
    if (used > 0) this.reported = used
    // ⚠ Spend must **accumulate**, usage must **take the latest** — swapping the two is
    //   the easiest mistake to make in this module: accumulating usage counts a ten-step
    //   turn ten times over (compaction fires when there's no need at all), and taking only
    //   the latest spend only ever reports the last step, which is a meaningless number
    this.billed = accumulateBilled(this.billed, tokens)
  }

  /**
   * Only book the spend; don't touch usage.
   *
   * ★ Subagent accounting goes through here, and **must not go through observe()** —
   *   observe also updates `reported` to the number passed in, while a subagent's context
   *   is its own and has nothing to do with the main conversation. Getting it wrong looks
   *   like this: dispatch a subagent, and the main UI's context percentage suddenly jumps
   *   to that subagent's usage.
   */
  bill(tokens: Tokens): void {
    this.billed = accumulateBilled(this.billed, tokens)
  }

  /** Total spent this run. Kept broken down — `/context` shows in/out/cache separately */
  get spent(): Tokens {
    return this.billed
  }

  /**
   * Switched to another session; spend starts over.
   *
   * ★ **Compaction doesn't clear it** — those tokens really were spent, and compaction
   *   gives no refund. A "spent" that shrinks because of compaction is the one reading on
   *   this line that would lie.
   *
   * @param seed When picking up an old session, feed back what it has already spent (see
   *   billedFromHistory in tokens.ts). Omitted means starting from zero — which is how a
   *   new session should look. Without it, `--continue` back into a session that ran for
   *   ages would show 0 spent.
   */
  resetSpend(seed?: Tokens): void {
    this.billed = seed ?? emptyTokens()
  }

  /** A local estimate was made. */
  assume(estimate: number): void {
    this.estimate = Math.max(0, estimate)
  }

  /**
   * The reported number no longer holds — compaction, clearing, switching sessions.
   *
   * If it isn't cleared, after compaction the gauge stays where it was before, and that's
   * exactly the moment the user is watching it.
   */
  drop(): void {
    this.reported = undefined
  }

  get real(): number | undefined {
    return this.reported
  }

  get snapshot(): ContextSnapshot {
    const budget = usable(this.info.limit)
    const used = this.reported ?? this.estimate
    return {
      used,
      budget,
      limit: this.info.limit.context,
      ratio: budget > 0 ? Math.min(1, used / budget) : 0,
      estimated: this.reported === undefined,
      spent: {
        total: spentTotal(this.billed, this.info),
        input: contextTokens(this.billed, this.info),
        output: safe(this.billed.output),
      },
    }
  }
}

/**
 * Total cumulative spend.
 *
 * Cache hits are placed according to the provider's accounting (see
 * ModelInfo.cacheInInput) — they're part of input, not an extra item. **Cheap isn't
 * free**: tokens read from cache still take up the window and are still billed (just
 * cheaply); leave them out and this number comes out far below the bill.
 */
export function spentTotal(tokens: Tokens | undefined, info?: Pick<ModelInfo, "cacheInInput">): number {
  return contextTokens(tokens, info) + safe(tokens?.output)
}
