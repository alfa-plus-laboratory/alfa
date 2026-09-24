/**
 * Stored message/part → LLMMessage[].
 *
 * Responses phase survives on verbatim assistant items, including a compacted tail. A
 * compaction summary is new user context and deliberately has no assistant item identity.
 *
 * ★ One invariant that must never be broken: **every tool-call must have a paired tool
 * result**.
 *
 * Anthropic returns a straight 400 if even one is missing, and the error doesn't tell you
 * which callID. The easiest way to hit it is an interrupt: the user hits Ctrl-C while a
 * bash is running, that tool part is left in running, and if it's simply dropped the
 * history keeps an orphan tool_use — after which **every turn's** request 400s, the
 * session is dead for good, and all the user sees is "another error".
 *
 * So pending / running / error all get turned into error results here. Better to tell the
 * model "this tool didn't run" than let it vanish.
 */
import type { LLMContent, LLMMessage, LLMToolResult, ModelRef } from "../llm/types.ts"
import type { MessageWithParts, Part, ToolPart } from "../session/schema.ts"

export interface ConvertOptions {
  /** The model for this request. Decides whether reasoning signatures and Responses item metadata can still be sent. */
  model?: ModelRef
}

const INTERRUPTED = "Tool execution was interrupted by the user before it completed."
const NEVER_RAN = "Tool call was never executed."

/**
 * The index from which messages are actually sent to the model.
 *
 * All history before the compaction point (the pin `/compact` drops) is folded into one
 * summary — it's still in the store, just no longer sent. Take the **last** compaction
 * point: in a session compacted twice, only the latest summary holds; the summary before
 * it was long since wrapped into the new one.
 *
 * Only `/compact` uses this (runCompaction in cli/main.ts: "has enough piled up since the
 * last point to be worth folding"). What the model receives, the context gauge
 * (agent/context.ts) and the next compaction all go through liveHistory below instead.
 *
 * ⚠ liveHistory finds the compaction point by the same rule — the last message with a
 *   compact part. Change one and not the other, and `/compact` counts from a different
 *   point than the one the model's history actually starts at.
 */
export function compactionIndex(history: MessageWithParts[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.parts.some((part) => part.type === "compact")) return i
  }
  return 0
}

export interface LiveHistory {
  /** The messages actually sent, in the order they are sent */
  messages: MessageWithParts[]
  /** How many are in the store but not sent this time */
  folded: number
}

/**
 * Exactly which messages get sent this time. **What goes to the model, what counts toward
 * usage, and what the next compaction reads all share this one list.**
 *
 * ── Why it isn't a simple slice ──
 * The compaction point is a message **appended at the end** (the folded ones are the ones
 * before it), and it carries a `keptFrom` pin: the most recent turns starting from that
 * message are **kept verbatim**. So the order actually sent is
 *
 *     [handoff summary] + [the kept turns, verbatim] + [what was said after compaction]
 *
 * In other words this list **is not one contiguous run**, and its order differs from the
 * store's (in the store the summary sits after the tail; when sent it has to go first —
 * it's about earlier events). That's exactly why this has to be one function and not a
 * slice written separately in three places.
 *
 * ── All three must be the same list ──
 * If the gauge and what the model sees diverge, you get "the gauge says full, but the
 * model actually only received half" — an error nobody can track down; if what compaction
 * reads and what the model sees diverge, things already folded get folded a second time.
 */
export function liveHistory(history: MessageWithParts[]): LiveHistory {
  let at = -1
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.parts.some((part) => part.type === "compact")) {
      at = i
      break
    }
  }
  if (at < 0) return { messages: history, folded: 0 }

  const mark = history[at]!.parts.find((part) => part.type === "compact")
  const keptFrom = mark?.type === "compact" ? mark.keptFrom : undefined
  // If that message can't be found, treat it as "keep nothing" (old sessions don't have
  // this column, or the message was deleted) — fall back to how compaction originally
  // behaved rather than guess a position
  const from = keptFrom === undefined ? -1 : history.findIndex((entry) => entry.info.id === keptFrom)
  /**
   * The turns kept verbatim.
   *
   * ★ **Old compaction points must be filtered out of it.** In a session compacted twice,
   *   the second keptFrom can perfectly well land **before** the first pin (compact twice
   *   in a row and it always does), so this run contains a compact message — which
   *   userContent turns into a whole block of "everything above has been replaced by the
   *   handoff summary below" and sends.
   *
   *   Result: in the middle of live history the model reads "nothing you saw before this
   *   counts any more", followed by an old summary **that has already been superseded by
   *   the current one**. Two summaries, one new and one old, both present — and the old
   *   one carries an authoritative "the original messages are gone".
   *
   *   A compaction point has a message all to itself (see applyCompaction in compact.ts),
   *   so dropping the whole message takes nothing else down with it.
   */
  const tail =
    from >= 0 && from < at
      ? history.slice(from, at).filter((entry) => !entry.parts.some((part) => part.type === "compact"))
      : []
  return {
    messages: [history[at]!, ...tail, ...history.slice(at + 1)],
    folded: at - tail.length,
  }
}

/**
 * Where the current tool loop starts — i.e. the position of the **last user message**.
 *
 * ── Why the line is drawn exactly here ──
 * Within one tool loop, thinking blocks **must be sent back verbatim**: before every
 * tool_use decision the model thinks for a bit, and without that its next step only sees
 * which tools it called and what came back, not why it decided that at the time. Anthropic
 * is stricter still — an assistant message carrying tool_use without its signed thinking
 * block is a straight 400.
 *
 * Once the loop is over and a new user message comes in, the earlier thinking can safely
 * be dropped: Anthropic strips it on its own anyway (thinking tokens are billed once, as
 * output, at generation time, not re-billed as input every turn the way conversation and
 * tool results are), and OpenAI-compatible endpoints don't accept it at all. Either way
 * "keeping it is useless", and keeping it costs us on our own context budget.
 *
 * ── A synthetic user message counts as a line too ──
 * The reminder pushed back in by the pre-finish check (see loop.ts) is sent as user. The
 * model thinks afresh after it, so cutting there is right — the thinking before it is
 * no longer needed either.
 */
export function loopStartIndex(live: MessageWithParts[]): number {
  for (let i = live.length - 1; i >= 0; i--) {
    if (live[i]!.info.role === "user") return i
  }
  return 0
}

export function toLLMMessages(history: MessageWithParts[], options: ConvertOptions = {}): LLMMessage[] {
  const out: LLMMessage[] = []

  const live = liveHistory(history).messages
  const loopStart = loopStartIndex(live)

  for (const [index, entry] of live.entries()) {
    if (entry.info.role === "user") {
      const content = userContent(entry.parts)
      if (content.length > 0) out.push({ role: "user", content })
      continue
    }

    // Pending ones are dropped entirely (call and result together); for every other status
    // the call and the result must appear as a pair. This filter must match the one in
    // assistantContent exactly — any mismatch is an orphan.
    const tools = entry.parts.filter(
      (part): part is ToolPart => part.type === "tool" && part.state.status !== "pending",
    )
    const sameModel =
      !options.model ||
      (options.model.providerID === entry.info.providerID && options.model.modelID === entry.info.modelID)

    // Only keep thinking from the current loop. See the note above loopStartIndex
    const content = assistantContent(entry.parts, sameModel && index > loopStart, !!options.model && sameModel)
    if (content.length === 0) {
      // Some providers 400 on an empty assistant message. Skip the whole thing —
      // its tool results must be skipped too, or they're orphan tool_results (also a 400).
      continue
    }

    out.push({ role: "assistant", content })

    if (tools.length > 0) {
      out.push({ role: "tool", content: tools.map(toolResult) })
    }
  }

  return out
}

function userContent(parts: Part[]): LLMContent[] {
  const content: LLMContent[] = []
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text.length > 0) content.push({ type: "text", text: part.text })
    } else if (part.type === "file") {
      content.push({ type: "file", mediaType: part.mediaType, data: part.url, ...(part.filename ? { filename: part.filename } : {}) })
    } else if (part.type === "memory") {
      // Project memory. It goes in as user because it's **background briefing**, not
      // something the model said — same reasoning as the compaction point. It sits before
      // this message's text: background first, then the question
      content.push({ type: "text", text: part.text })
    } else if (part.type === "compact") {
      // The compaction point is itself the start of this history. It appears as user
      // because the first message of the new history must be user — and this text really
      // is "background briefing", not something the model itself said
      content.push({ type: "text", text: compactionText(part.text) })
    }
  }
  return content
}

/**
 * Wrap the summary. **It must make three things clear**: the original messages before
 * this are gone, this is a summary and not the user's instructions, and if detail is
 * missing, go re-read it yourself.
 *
 * Without the last one, the model treats a coarse-grained summary as complete fact and
 * carries on — which shows up as it editing files from memory after a compaction.
 */
function compactionText(summary: string): string {
  return [
    "This session was compacted to free up context. Everything before this point has been replaced by the",
    "handoff summary below — the original messages are no longer available to you.",
    "",
    "<session-summary>",
    summary,
    "</session-summary>",
    "",
    "Continue from here. The summary is a summary: whenever you need detail it does not cover — exact file",
    "contents, command output, line numbers — read the files or run the commands again rather than recalling them.",
  ].join("\n")
}

/**
 * @param keepReasoning Whether to include this message's thinking. Covers two things at
 *   once: a model switch (feeding another provider's signature back to Anthropic is a 400,
 *   feeding it back with the signature removed is **also** a 400, so dropping it is the
 *   only safe option), and whether it's inside the current tool loop (see loopStartIndex).
 */
function assistantContent(parts: Part[], keepReasoning: boolean, keepResponses: boolean): LLMContent[] {
  const content: LLMContent[] = []
  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (part.text.length > 0) content.push({
          type: "text", text: part.text,
          // Item identity belongs to its generating model; synthetic summaries are new text.
          ...(keepResponses && !part.synthetic && part.responses ? { responses: part.responses } : {}),
        })
        break
      case "reasoning":
        if (!keepReasoning) break
        if (part.text.length === 0) break
        content.push({
          type: "reasoning",
          text: part.text,
          ...(part.signature ? { signature: part.signature } : {}),
        })
        break
      case "tool":
        // Pending means the stream broke before the model finished emitting arguments —
        // there's no input, and sending it back only gets a parameter error from the
        // provider. Call and result must be dropped **together**; the tools filter above is
        // kept in sync with this.
        if (part.state.status === "pending") break
        content.push({ type: "tool-call", callID: part.callID, tool: part.tool, input: part.state.input })
        break
      default:
        // step-start / step-finish / file don't go into the model's context
        break
    }
  }
  return content
}

function toolResult(part: ToolPart): LLMToolResult {
  const base = { callID: part.callID, tool: part.tool }
  switch (part.state.status) {
    case "completed":
      return { ...base, output: part.state.output }
    case "error":
      return { ...base, output: part.state.error, isError: true }
    case "running":
      return { ...base, output: INTERRUPTED, isError: true }
    case "pending":
      return { ...base, output: NEVER_RAN, isError: true }
  }
}

/**
 * Self-check: are tool-calls and tool results paired one-to-one?
 *
 * The conversion logic already guarantees the pairing, but that "guarantee" is a
 * conclusion reached by a human reading the code, and a one-line change can break it.
 * This function turns it into an assertable fact; tests and debug mode both use it.
 */
export function findUnpairedToolCalls(messages: LLMMessage[]): string[] {
  const problems: string[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    if (message.role !== "assistant") continue
    const calls = message.content.filter((c) => c.type === "tool-call")
    if (calls.length === 0) continue

    const next = messages[i + 1]
    const results = next?.role === "tool" ? next.content : []
    const answered = new Set(results.map((r) => r.callID))
    for (const call of calls) {
      if (call.type === "tool-call" && !answered.has(call.callID)) problems.push(call.callID)
    }
    // The reverse: a result with no matching call is also a 400
    const asked = new Set(calls.map((c) => (c.type === "tool-call" ? c.callID : "")))
    for (const result of results) {
      if (!asked.has(result.callID)) problems.push(`orphan-result:${result.callID}`)
    }
  }
  return problems
}
