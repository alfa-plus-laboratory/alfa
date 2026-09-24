/**
 * LLMMessage → AI SDK ModelMessage.
 *
 * ⚠ One hard constraint: **every tool-call must have a matching tool result**.
 * Miss one and Anthropic 400s outright, and the error message gives no clue which one it
 * was. It's easiest to trigger when an interrupt lands mid tool execution — so unfinished
 * tool calls must get a filler error result when replayed, not be dropped as-is. The agent
 * layer guarantees this; this file only converts shapes.
 */
import type { ModelMessage } from "ai"
import type { ReasoningReplay } from "./registry.ts"
import type { LLMContent, LLMMessage } from "./types.ts"

type SystemMessage = Extract<ModelMessage, { role: "system" }>

/**
 * The system section is squashed into **exactly two messages** — the first is the stable
 * template head, and the rest are merged into the second.
 *
 * This isn't fastidiousness: prompt cache hits by prefix, and if system were split into N
 * messages with N varying, the cache boundary would move with it and the hit rate would
 * drop straight to zero.
 *
 * ⚠ From AI SDK v7 on, system messages **cannot** go into messages (that throws
 *   InvalidPromptError); they must go through streamText's instructions option. v6 wasn't
 *   like this — code ported straight from v6 blows up on the first real request, and
 *   typecheck gives no hint whatsoever.
 *
 * ── Two cache breakpoints, not one ──
 * Anthropic's cache is **explicit**: without cache_control it never hits even once, and
 * every turn recomputes tools + system at full price. The prefix order in the request is
 * tools → system → messages, so a breakpoint on system caches the tool definitions along
 * with it (tool definitions are thousands of tokens, and we've already sorted them to keep
 * them stable).
 *
 * Two of them is layering:
 *   Breakpoint 1 (template)          — never changes within the process; still hits when
 *                                      the date rolls over
 *   Breakpoint 2 (env + conventions) — invalidated once a day at midnight; that one time it
 *                                      falls back to breakpoint 1 instead of losing it all
 * With a single one at the end, the first turn of each day would recompute the template
 * along with everything else.
 *
 * For providers that don't recognize this field (OpenAI-compatible endpoints) it's dead
 * data, ignored with no side effects — **but on that path the split has to go too**; for
 * why, see the single parameter below.
 */
const CACHE_BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral" } } } as const

/**
 * @param single Send only one message (merge the two parts). See
 *   ResolvedModel.singleSystem in registry.ts.
 *
 *   Splitting in two serves nothing but the two breakpoints above, and breakpoints are
 *   dead data on OpenAI-compatible endpoints — so on that path the split gains nothing,
 *   while the cost is a local inference server returning 500 outright: the vast majority
 *   of models' own Jinja chat templates allow only one system message, and the moment a
 *   second one arrives it's `raise_exception('System message must be at the beginning.')`.
 *
 * ★ The merge uses the same "\n\n" as parts.slice(1), so **the content is identical down
 *   to the character**; the only change is whether it sits in one message or two.
 */
export function toInstructions(system: string[], single = false): SystemMessage[] {
  const parts = system.filter((s) => s.trim().length > 0)
  if (parts.length === 0) return []
  const head: SystemMessage = {
    role: "system",
    content: single ? parts.join("\n\n") : parts[0]!,
    providerOptions: CACHE_BREAKPOINT,
  }
  if (single || parts.length === 1) return [head]
  return [
    head,
    { role: "system", content: parts.slice(1).join("\n\n"), providerOptions: CACHE_BREAKPOINT },
  ]
}

/**
 * A breakpoint looks back **at most 20 content blocks** for the previous cache entry. Past
 * that it can't find one and silently misses — and a single turn of the agent loop easily
 * produces a dozen-plus tool-call / tool-result pairs.
 *
 * 18 leaves a little headroom. Chained, the two breakpoints cover about 36 new blocks in a
 * single turn; any longer and the chain breaks, and that turn falls back to recomputing
 * from the system breakpoint. There's no better option — a request only gets 4
 * breakpoints in total, and system takes 2.
 */
const LOOKBACK_BLOCKS = 18

/**
 * The two breakpoints on message history: one pinned at the end, one 18 blocks back.
 *
 * ── Why the two on system aren't enough ──
 * Anthropic only caches up to a breakpoint. With every breakpoint on system, tools + system
 * are cached, but **the whole conversation after them is recomputed at full price every
 * turn** — and that is the truly big chunk of an agent session: after running a while,
 * history is well over 100k tokens, while system is only a few thousand.
 *
 * ★ For providers that don't recognize this field it's dead data (same as the two on
 *   system). Endpoints with automatic prefix caching like MiniMax don't look at it at all
 *   — over there the whole prefix is cached automatically anyway, so these breakpoints
 *   make no difference either way. This part is for **official Anthropic**.
 */
function markHistoryBreakpoints(out: ModelMessage[]): void {
  // Only array-form content can carry providerOptions; string-form content can't
  const blocks: Array<Record<string, unknown>> = []
  for (const message of out) {
    if (Array.isArray(message.content)) blocks.push(...(message.content as Array<Record<string, unknown>>))
  }
  if (blocks.length === 0) return

  /**
   * Put one on the first block at `at` or **further back** that can hold a breakpoint.
   *
   * ── ★ Why not just write blocks[at] ──
   * This used to be a single `block["providerOptions"] = CACHE_BREAKPOINT` — an
   * **overwrite**. But a thinking block's providerOptions holds its **signature** (see
   * toAssistantContent), the only credential on which Anthropic accepts that thinking.
   * Overwriting it is a double loss:
   *
   *   · The signature is gone → the provider can't recognize it as a thinking block and
   *     drops the whole thing, plus an "unsupported reasoning metadata" warning. One
   *     warning per turn for every piece of thinking in history.
   *   · The breakpoint is gone too → thinking blocks are `canCache: false` to begin with;
   *     a provider receiving cache_control just notes "ignored".
   *
   * In other words the old code both wrecked the thinking and bought no caching at all.
   * In sessions with extended thinking on, every assistant message starts with reasoning,
   * and the 18th block back landing on one is routine.
   *
   * So: skip back past the ones that can't hold it, and **merge** into the ones that can
   * rather than overwrite.
   */
  const mark = (at: number): void => {
    for (let i = at; i >= 0; i--) {
      const block = blocks[i]
      // thinking / redacted_thinking are the kind the provider explicitly marks uncacheable
      if (!block || block["type"] === "reasoning") continue
      const existing = block["providerOptions"] as Record<string, Record<string, unknown>> | undefined
      block["providerOptions"] = existing
        ? { ...existing, anthropic: { ...existing["anthropic"], ...CACHE_BREAKPOINT.anthropic } }
        : CACHE_BREAKPOINT
      return
    }
  }
  mark(blocks.length - 1)
  // Short conversations skip the second: it would land on the first and waste a slot
  if (blocks.length > LOOKBACK_BLOCKS) mark(blocks.length - 1 - LOOKBACK_BLOCKS)
}

/**
 * @param replay How thinking blocks are replayed, decided by the provider (see
 *   ReasoningReplay in registry.ts). Defaults to "signed" — the most conservative level,
 *   so a newly added provider that forgets to set it won't blow up.
 */
/**
 * @param images false = the model takes no image input (ModelInfo.images). Stored images
 *   then go out as a one-line note, not dropped silently: the model still learns the user
 *   showed it something, and can say it can't see it instead of answering as if it had.
 */
export function toModelMessages(messages: LLMMessage[], replay: ReasoningReplay = "signed", replayResponses = false, nativeApplyPatch = false, images = true): ModelMessage[] {
  const out: ModelMessage[] = []

  for (const message of messages) {
    switch (message.role) {
      case "system":
        // There shouldn't be any system left in history — if one does show up, merging it
        // into instructions would be more correct, but that means changing the caller
        // contract. Settling for second best here: turn it into user so nothing blows up.
        out.push({ role: "user", content: [{ type: "text", text: message.content }] })
        break
      case "user":
        out.push({ role: "user", content: toUserContent(message.content, images) })
        break
      case "assistant":
        out.push({ role: "assistant", content: toAssistantContent(message.content, replay, replayResponses) })
        break
      case "tool":
        out.push({
          role: "tool",
          content: message.content.map((result) => ({
            type: "tool-result" as const,
            toolCallId: result.callID,
            toolName: result.tool,
            // The native protocol requires status even for errors. SDK error-text falls
            // back to function_call_output, which cannot pair with apply_patch_call.
            output: nativeApplyPatch && result.tool === "apply_patch"
              ? ({ type: "json" as const, value: { status: result.isError ? "failed" : "completed", output: result.output } })
              : result.isError
              ? ({ type: "error-text" as const, value: result.output })
              : ({ type: "text" as const, value: result.output }),
          })),
        })
        break
    }
  }

  markHistoryBreakpoints(out)
  return out
}

type UserContent = Extract<ModelMessage, { role: "user" }>["content"]
type AssistantContent = Extract<ModelMessage, { role: "assistant" }>["content"]

function toUserContent(content: LLMContent[], images: boolean): UserContent {
  const parts: Exclude<UserContent, string> = []
  for (const item of content) {
    if (item.type === "text") parts.push({ type: "text", text: item.text })
    else if (item.type === "file") {
      parts.push(images
        ? { type: "file", mediaType: item.mediaType, data: item.data }
        : { type: "text", text: `[The user attached an image${item.filename ? ` (${item.filename})` : ""}, but this model does not accept images, so it was not sent.]` })
    }
  }
  return parts.length > 0 ? parts : [{ type: "text", text: "" }]
}

function toAssistantContent(content: LLMContent[], replay: ReasoningReplay, replayResponses: boolean): AssistantContent {
  const parts: Exclude<AssistantContent, string> = []
  for (const item of content) {
    switch (item.type) {
      case "text":
        // An empty text part makes some providers error; just drop it
        if (item.text.length > 0) parts.push({
          type: "text", text: item.text,
          ...(replayResponses && item.responses ? { providerOptions: { openai: { ...item.responses } } } : {}),
        })
        break
      case "reasoning":
        // All that reaches here is thinking from the current tool loop (anything older was
        // cut at the agent layer), and within the loop it **must** be sent back: the model
        // thinks a bit before every tool decision, and without that bit, its next step can
        // only reverse-engineer its earlier judgment from "which tools I called".
        if (replay === "none") break
        if (item.text.length === 0) break
        if (replay === "text") {
          // Compatible endpoints: send plain text back; the SDK serializes it as
          // `reasoning_content`. There's no such thing as a signature — on this path the
          // thinking was dug out of content in the first place
          parts.push({ type: "reasoning", text: item.text })
          break
        }
        // ★ "signed": thinking without a signature is **not replayed**. Anthropic can't
        //   accept an unsigned thinking block anyway: the SDK drops the whole block and
        //   emits an "unsupported reasoning metadata" warning — one per piece of thinking
        //   in history, repeated every turn (stream.ts reroutes SDK warnings to the log
        //   file, so what that costs is log noise). Dropping it here has the same result,
        //   minus the noise. For how the signature is obtained, see the pendingSignature
        //   note in stream.ts.
        if (item.signature) {
          parts.push({
            type: "reasoning",
            text: item.text,
            // The signature must be sent back verbatim, or Anthropic rejects history
            // containing thinking
            providerOptions: { anthropic: { signature: item.signature } },
          })
        }
        break
      case "tool-call":
        parts.push({
          type: "tool-call",
          toolCallId: item.callID,
          toolName: item.tool,
          input: item.input,
        })
        break
      default:
        break
    }
  }
  return parts.length > 0 ? parts : [{ type: "text", text: "" }]
}
