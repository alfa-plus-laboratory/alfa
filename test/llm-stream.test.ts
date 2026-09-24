/**
 * Normalizing fullStream.
 *
 * The bugs here share one trait: **nothing happens on the spot**. A signature missed, one
 * event not emitted, and the turn still runs to completion; the cost only shows when the
 * next turn feeds the history back — and by then the symptom is "a few lines of SDK
 * warnings on screen" or "it forgot what it was just thinking", far from the cause.
 */
import { describe, expect, test } from "bun:test"
import { anthropicProvider } from "../src/llm/providers/anthropic.ts"
import { openAICompatProvider } from "../src/llm/providers/openai-compat.ts"
import { openAIProvider } from "../src/llm/providers/openai.ts"
import { normalize } from "../src/llm/stream.ts"
import { contextTokens } from "../src/agent/tokens.ts"
import { toModelMessages } from "../src/llm/to-model-messages.ts"
import { hasToolCalls } from "../src/llm/stream.ts"
import type { LLMEvent, LLMMessage } from "../src/llm/types.ts"

async function run(parts: unknown[]): Promise<LLMEvent[]> {
  const out: LLMEvent[] = []
  for await (const event of normalize(
    (async function* () {
      for (const part of parts) yield part as never
    })(),
  )) {
    out.push(event)
  }
  return out
}

describe("thinking signatures", () => {
  test("★ a signature on an empty-text delta is carried through to reasoning-end", async () => {
    // the SDK translates Anthropic's signature_delta into this shape: the delta is an
    // empty string and the signature sits in providerMetadata. Looking only on the end
    // event never finds it — and unsigned thinking is dropped wholesale when fed back,
    // with a warning spat out every turn
    const events = await run([
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "先看看 paint" },
      { type: "reasoning-delta", id: "r1", text: "", providerMetadata: { anthropic: { signature: "sig-abc" } } },
      { type: "reasoning-end", id: "r1" },
    ])
    const end = events.find((event) => event.type === "reasoning-end")
    expect(end).toMatchObject({ type: "reasoning-end", id: "r1", signature: "sig-abc" })
  })

  test("the signature-carrying delta is not emitted — its text is empty, emitting it is an empty repaint", async () => {
    const events = await run([
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "", providerMetadata: { anthropic: { signature: "sig" } } },
      { type: "reasoning-delta", id: "r1", text: "想好了" },
      { type: "reasoning-end", id: "r1" },
    ])
    const deltas = events.filter((event) => event.type === "reasoning-delta")
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toMatchObject({ text: "想好了" })
  })

  test("a signature on end itself takes precedence", async () => {
    const events = await run([
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "", providerMetadata: { anthropic: { signature: "old" } } },
      { type: "reasoning-end", id: "r1", providerMetadata: { anthropic: { signature: "new" } } },
    ])
    expect(events.at(-1)).toMatchObject({ signature: "new" })
  })

  test("no signature means none is invented", async () => {
    const events = await run([
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "想了想" },
      { type: "reasoning-end", id: "r1" },
    ])
    expect(events.at(-1)).toEqual({ type: "reasoning-end", id: "r1" })
  })

  test("★ a new thinking block never inherits the previous one's signature — a wrong signature gets the whole history rejected", async () => {
    const events = await run([
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "", providerMetadata: { anthropic: { signature: "sig-1" } } },
      { type: "reasoning-end", id: "r1" },
      { type: "reasoning-start", id: "r2" },
      { type: "reasoning-delta", id: "r2", text: "第二段" },
      { type: "reasoning-end", id: "r2" },
    ])
    expect(events.at(-1)).toEqual({ type: "reasoning-end", id: "r2" })
  })
})

describe("feeding history back", () => {
  test("★ unsigned thinking is not fed back — the SDK can't take it and would only drop it with a warning", () => {
    const withSig = toModelMessages([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "想过的", signature: "sig" },
          { type: "text", text: "答案" },
        ],
      },
    ])
    expect(JSON.stringify(withSig)).toContain("想过的")

    const without = toModelMessages([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "想过的" },
          { type: "text", text: "答案" },
        ],
      },
    ])
    expect(JSON.stringify(without)).not.toContain("想过的")
    // the text stays; all that's dropped is the unusable scratch work
    expect(JSON.stringify(without)).toContain("答案")
  })

  const unsigned: LLMMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "想过的" },
        { type: "text", text: "答案" },
      ],
    },
  ]

  test('★ "text" mode: compatible endpoints have no notion of signatures, the text is sent as is', () => {
    // the SDK serializes it as reasoning_content. Without it, within one tool loop the
    // model can't see what it thought on the previous step and can only work backward
    // from "which tools did I call"
    const json = JSON.stringify(toModelMessages(unsigned, "text"))
    expect(json).toContain("想过的")
    // not a single signature field should appear — this path has none at all
    expect(json).not.toContain("signature")
  })

  test('★ "none" mode: for endpoints that answer reasoning_content with a 400', () => {
    const json = JSON.stringify(toModelMessages(unsigned, "none"))
    expect(json).not.toContain("想过的")
    expect(json).toContain("答案")
  })

  test("the default is the most conservative mode — a new provider that forgets to set it won't break", () => {
    expect(JSON.stringify(toModelMessages(unsigned))).toBe(JSON.stringify(toModelMessages(unsigned, "signed")))
  })
})

describe("cache accounting", () => {
  /**
   * ★ This field is about **the number the AI SDK hands over**, not how the provider's
   *   raw API counts.
   *
   *   Going by Anthropic's docs, input_tokens and cache_read_input_tokens are reported
   *   separately, so it should be false — and it once was. But @ai-sdk/anthropic's
   *   convertAnthropicUsage has already added them up
   *   (total = input_tokens + cache_creation + cache_read), and the ai core takes .total.
   *   Setting false adds the cached part a second time.
   *
   *   This mistake raises nothing on the spot; the number on the gauge just doubles —
   *   and that's what triggers auto-compaction, so compaction kicks in at half the real
   *   usage.
   */
  test("★ the input Anthropic reports to us already includes cache — never add it again", () => {
    const info = anthropicProvider({ apiKey: "test-key" }).resolve("claude-haiku-4-5", {}).info
    expect(info.cacheInInput).toBe(true)
  })

  test("same for OpenAI-compatible", () => {
    const info = openAICompatProvider({ apiKey: "test-key" }).resolve("whatever", {}).info
    expect(info.cacheInInput).toBe(true)
  })

  test("same for OpenAI Responses", () => {
    const info = openAIProvider({ apiKey: "test-key" }).resolve("gpt-5", {}).info
    expect(info.cacheInInput).toBe(true)
  })

  test("OpenAI Responses requests a reasoning summary only when /think is on", () => {
    const provider = openAIProvider({ apiKey: "test-key" })
    expect(provider.resolve("gpt-5", {}).providerOptions).toEqual({ openai: { store: false } })
    expect(provider.resolve("gpt-5", { thinking: true }).providerOptions).toEqual({
      openai: { store: false, reasoningSummary: "auto" },
    })
  })

  /** Real data: MiniMax's /anthropic endpoint, a turn with a 98.4% hit rate */
  test("★ at a high hit rate, the wrong accounting is nearly a 2x error", () => {
    const real = { input: 11_425, output: 91, reasoning: 0, cache: { read: 11_240, write: 0 } }
    expect(contextTokens(real, { cacheInInput: true })).toBe(11_425)
    // the wrongly set branch gives 22_665 — kept here so the size of the error is plain
    // to see
    expect(contextTokens(real, { cacheInInput: false })).toBe(22_665)
  })
})

describe("Anthropic generation tiers", () => {
  // The id keeps the provider off process.env: without it, an ANTHROPIC_BASE_URL exported
  // by whatever shell runs the tests decides which tier these assertions see
  const resolve = (modelID: string, opts: { thinking?: boolean; baseURL?: string } = {}) =>
    anthropicProvider({ id: "anthropic", apiKey: "k", ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) }).resolve(modelID, {
      ...(opts.thinking ? { thinking: true } : {}),
    })

  /**
   * ★ This isn't tuning, it's whether the request goes through at all. Anthropic
   *   **removed** temperature and budgetTokens in the 4.7 generation — sending them gets
   *   a 400, and the error doesn't say which field.
   */
  test("★ current generation: never sends temperature", () => {
    expect(resolve("claude-opus-5").temperature).toBeUndefined()
    expect(resolve("claude-opus-5", { thinking: true }).temperature).toBeUndefined()
    expect(resolve("claude-sonnet-5").temperature).toBeUndefined()
  })

  test("★ current generation: thinking is adaptive, no budgetTokens", () => {
    const opts = resolve("claude-opus-5", { thinking: true }).providerOptions
    expect(opts?.["anthropic"]?.["thinking"]).toEqual({ type: "adaptive" })
    expect(JSON.stringify(opts)).not.toContain("budgetTokens")
  })

  /**
   * From Opus 5 on, thinking is **on by default**; omitting it means on — turning it off
   * must be explicit
   */
  test("★ current generation: thinking off is sent explicitly as disabled, never by omission", () => {
    expect(resolve("claude-opus-5").providerOptions?.["anthropic"]?.["thinking"]).toEqual({ type: "disabled" })
  })

  test("older generations unchanged: budgetTokens + temperature", () => {
    const old = resolve("claude-haiku-4-5", { thinking: true })
    expect(JSON.stringify(old.providerOptions)).toContain("budgetTokens")
    expect(resolve("claude-haiku-4-5").temperature).toBe(0)
  })

  /**
   * ★ A set baseURL means someone else's compatible endpoint (MiniMax and the like).
   *   Which set of parameters it accepts only it knows — send the old way, because that's
   *   exactly the combination running today.
   */
  test("★ third-party compatible endpoints aren't tiered by generation — not even on a name match", () => {
    const compat = resolve("claude-opus-5", { thinking: true, baseURL: "https://api.minimaxi.com/anthropic/v1" })
    expect(JSON.stringify(compat.providerOptions)).toContain("budgetTokens")
    expect(resolve("claude-opus-5", { baseURL: "https://x/anthropic/v1" }).temperature).toBe(0)
  })

  /**
   * ★ The provider template writes `https://api.anthropic.com/v1` into config, and some
   *   environments export `ANTHROPIC_BASE_URL=https://api.anthropic.com`. Both used to
   *   count as "someone else's endpoint" and got temperature sent to the current
   *   generation — a 400 on every request.
   */
  test("★ the official endpoint written out is still official, with or without /v1", () => {
    for (const baseURL of ["https://api.anthropic.com", "https://api.anthropic.com/v1", "https://api.anthropic.com/v1/"]) {
      const official = resolve("claude-opus-5", { thinking: true, baseURL })
      expect(official.temperature).toBeUndefined()
      expect(official.providerOptions?.["anthropic"]?.["thinking"]).toEqual({ type: "adaptive" })
    }
  })
})

describe("cache breakpoints in history", () => {
  const blocks = (out: unknown) => JSON.stringify(out).split("ephemeral").length - 1

  /**
   * ★ The two breakpoints on system only cache tools + system. With every breakpoint
   *   there, the whole conversation after it is recomputed at full price every turn —
   *   and in an agent session, that later part is precisely the big one.
   */
  test("★ there is a breakpoint at the end", () => {
    const out = toModelMessages([{ role: "user", content: [{ type: "text", text: "hi" }] }])
    expect(blocks(out)).toBe(1)
  })

  test("a short conversation uses only one slot — a second would land on the first and be wasted", () => {
    const msgs: LLMMessage[] = Array.from({ length: 3 }, () => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: "x" }],
    }))
    expect(blocks(toModelMessages(msgs))).toBe(1)
  })

  test("★ past the lookback window a second is added — a breakpoint that can't reach the previous turn is as good as none", () => {
    const msgs: LLMMessage[] = Array.from({ length: 30 }, () => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: "x" }],
    }))
    expect(blocks(toModelMessages(msgs))).toBe(2)
  })

  test("empty history doesn't crash", () => {
    expect(blocks(toModelMessages([]))).toBe(0)
  })

  /**
   * ★ The breakpoint was once **a single overwrite**:
   *   `block.providerOptions = CACHE_BREAKPOINT`. But a thinking block's providerOptions
   *   holds its **signature** — the only credential by which Anthropic accepts that
   *   thinking. Overwriting it loses twice: the signature is gone (the whole thinking
   *   block is dropped + an "unsupported reasoning metadata" warning every turn), and the
   *   breakpoint is gone too (thinking blocks can't be cached anyway; a provider that
   *   receives cache_control just notes "ignored").
   *
   *   In a session with extended thinking on, every assistant message starts with
   *   reasoning, so the 18th block counting back landing on one is routine.
   */
  test("★ a breakpoint never overwrites a thinking signature", () => {
    const reasoning = {
      role: "assistant" as const,
      content: [{ type: "reasoning" as const, text: "想了想", signature: "sig-abc" }],
    }
    const out = toModelMessages([{ role: "user", content: [{ type: "text", text: "hi" }] }, reasoning])
    expect(JSON.stringify(out)).toContain("sig-abc")
  })

  test("★ a breakpoint doesn't land on a thinking block either — it moves back to one that can hold it", () => {
    const msgs: LLMMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "想", signature: "sig" }] },
    ]
    type Block = { type?: string; providerOptions?: { anthropic?: Record<string, unknown> } }
    const out = toModelMessages(msgs)
    const parts = out.flatMap((one) => (Array.isArray(one.content) ? (one.content as Block[]) : []))
    // the signed block still carries its own providerOptions, but with **no** cacheControl
    // in it
    for (const part of parts.filter((one) => one.type === "reasoning")) {
      expect(part.providerOptions?.anthropic?.["cacheControl"]).toBeUndefined()
      expect(part.providerOptions?.anthropic?.["signature"]).toBe("sig")
    }
    // and the breakpoint really did land elsewhere — on that user text
    expect(blocks(out)).toBe(1)
  })
})

/**
 * The wrap-up request of a turn that hit the cap.
 *
 * ⚠ The upper layer says "no tool may be called in this step" with `activeTools: []`; the
 *   SDK translates that into `toolChoice: "none"`, and @ai-sdk/anthropic handles none
 *   and empty tools the same way: **the whole tools field disappears**. But Anthropic's
 *   Messages API has a hard rule — if tool_use / tool_result ever appeared in the
 *   history, tools must be declared. Put the two together and you get a 400.
 *
 *   What happened: a turn used all 100 steps (the history full of tool calls), and the
 *   final "tools off, report progress in plain text" request was rejected outright. And
 *   that request is **precisely what's designed to avoid a half-finished session**.
 */
describe("★ whether to add placeholder tools when tools are disabled", () => {
  test("a one-off user message like compaction / summary: no — omitting tools is perfectly legal", () => {
    expect(hasToolCalls(toModelMessages([{ role: "user", content: [{ type: "text", text: "材料" }] }]))).toBe(false)
  })

  test("★ tool-call in history: required", () => {
    const messages = toModelMessages([
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "tool-call", callID: "c1", tool: "bash", input: { command: "ls" } }] },
      { role: "tool", content: [{ callID: "c1", tool: "bash", output: "a\nb" }] },
    ])
    expect(hasToolCalls(messages)).toBe(true)
  })

  test("a lone tool-result message counts too", () => {
    expect(hasToolCalls([{ role: "tool", content: [] } as never])).toBe(true)
  })

  test("plain-string content doesn't crash", () => {
    expect(hasToolCalls([{ role: "assistant", content: "hi" } as never])).toBe(false)
  })
})
