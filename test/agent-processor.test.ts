/**
 * Processor + replaying history.
 *
 * Bugs in these two files share one trait: **they don't fail on the spot**. Once broken,
 * the symptom is a 400 on the next turn's request, or context usage counted double, or a
 * session that can never send again. So the tests put all their weight on "is the shape
 * of the replayed history legal", not on "does the event handling look about right".
 */
import { describe, expect, test } from "bun:test"
import { Processor } from "../src/agent/processor.ts"
import { Emitter, type UIEvent } from "../src/agent/events.ts"
import { findUnpairedToolCalls, toLLMMessages } from "../src/agent/to-model-messages.ts"
import { contextTokens, usable, usageRatio, accumulateBilled, COMPACTION_BUFFER } from "../src/agent/tokens.ts"
import { Store } from "../src/session/store.ts"
import { newMessageID, newPartID, newSessionID } from "../src/session/id.ts"
import type { AssistantMessage, MessageWithParts, Part, ToolPart } from "../src/session/schema.ts"
import type { LLMEvent, LLMMessage, ModelInfo, Tokens } from "../src/llm/types.ts"

// ─────────────────────────────────────────────── Scaffolding

const INFO: ModelInfo = {
  ref: { providerID: "p", modelID: "m" },
  limit: { context: 200_000, output: 32_000 },
  supportsThinking: true,
  promptTemplate: "anthropic",
  cacheInInput: false,
}

function tokens(input: number, output = 0, read = 0, write = 0): Tokens {
  return { input, output, reasoning: 0, cache: { read, write } }
}

function setup() {
  const store = new Store(":memory:")
  const sessionID = newSessionID()
  store.createSession(sessionID, "/tmp")
  const userID = newMessageID()
  store.upsertMessage({ id: userID, sessionID, role: "user", timeCreated: Date.now() })
  const message: AssistantMessage = {
    id: newMessageID(),
    sessionID,
    role: "assistant",
    parentID: userID,
    providerID: "p",
    modelID: "m",
    cost: 0,
    timeCreated: Date.now(),
  }
  store.upsertMessage(message)
  const emitter = new Emitter<UIEvent>()
  const seen: UIEvent[] = []
  emitter.on((e) => seen.push(e))
  return { store, sessionID, userID, message, emitter, seen, processor: new Processor(store, emitter, message, INFO) }
}

async function* feed(...events: LLMEvent[]): AsyncGenerator<LLMEvent> {
  for (const event of events) yield event
}

// ─────────────────────────────────────────────── Processor

describe("Processor", () => {
  test("text deltas accumulate into one part", async () => {
    const s = setup()
    await s.processor.run(feed(
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", text: "Hel" },
      { type: "text-delta", id: "t1", text: "lo" },
      { type: "text-end", id: "t1" },
      { type: "step-finish", finishReason: "stop", tokens: tokens(10, 2) },
    ))
    s.processor.cleanup("done")

    const parts = s.store.listParts(s.message.id)
    const text = parts.filter((p) => p.type === "text")
    expect(text).toHaveLength(1)
    expect(text[0]!.type === "text" && text[0]!.text).toBe("Hello")
    expect(text[0]!.type === "text" && text[0]!.time?.end).toBeGreaterThan(0)
  })

  test("opens a block without text-start — some endpoints send bare deltas", async () => {
    const s = setup()
    await s.processor.run(feed({ type: "text-delta", id: "t1", text: "bare" }))
    s.processor.cleanup("done")
    const text = s.store.listParts(s.message.id).filter((p) => p.type === "text")
    expect(text).toHaveLength(1)
    expect(text[0]!.type === "text" && text[0]!.text).toBe("bare")
  })

  test("reasoning signature is stored — lose it and Anthropic 400s on the next turn", async () => {
    const s = setup()
    await s.processor.run(feed(
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "think" },
      { type: "reasoning-end", id: "r1", signature: "sig-abc" },
    ))
    s.processor.cleanup("done")
    const reasoning = s.store.listParts(s.message.id).find((p) => p.type === "reasoning")
    expect(reasoning?.type === "reasoning" && reasoning.signature).toBe("sig-abc")
  })

  test("tool lifecycle: pending → running → completed", async () => {
    const s = setup()
    await s.processor.run(feed(
      { type: "tool-input-start", callID: "c1", tool: "read" },
      { type: "tool-call", callID: "c1", tool: "read", input: { filePath: "/a" } },
      { type: "tool-result", callID: "c1", tool: "read", output: "file body" },
    ))
    s.processor.cleanup("done")
    const tool = s.store.listParts(s.message.id).find((p) => p.type === "tool") as ToolPart
    expect(tool.state.status).toBe("completed")
    expect(tool.state.status === "completed" && tool.state.output).toBe("file body")
    // input must survive the running → completed transition, otherwise the replayed
    // tool_use has no arguments
    expect(tool.state.status === "completed" && tool.state.input).toEqual({ filePath: "/a" })
  })

  test("tool-result arriving before tool-call doesn't crash", async () => {
    const s = setup()
    await s.processor.run(feed({ type: "tool-result", callID: "c1", tool: "read", output: "out" }))
    s.processor.cleanup("done")
    const tool = s.store.listParts(s.message.id).find((p) => p.type === "tool") as ToolPart
    expect(tool.state.status).toBe("completed")
  })

  test("tool-error lands as error status", async () => {
    const s = setup()
    await s.processor.run(feed(
      { type: "tool-call", callID: "c1", tool: "bash", input: { command: "false" } },
      { type: "tool-error", callID: "c1", tool: "bash", error: "exit 1" },
    ))
    s.processor.cleanup("done")
    const tool = s.store.listParts(s.message.id).find((p) => p.type === "tool") as ToolPart
    expect(tool.state.status).toBe("error")
    expect(tool.state.status === "error" && tool.state.error).toBe("exit 1")
  })

  test("★ on interrupt, running tools are rewritten to error, leaving no orphans", async () => {
    const s = setup()
    await s.processor.run(feed(
      { type: "tool-call", callID: "c1", tool: "bash", input: { command: "sleep 60" } },
    ))
    s.processor.cleanup("interrupted")

    const tool = s.store.listParts(s.message.id).find((p) => p.type === "tool") as ToolPart
    expect(tool.state.status).toBe("error")
    expect(tool.state.status === "error" && tool.state.metadata["interrupted"]).toBe(true)
    expect(s.message.finish).toBe("interrupted")
    expect(s.message.timeCompleted).toBeGreaterThan(0)
  })

  test("on interrupt, unfinished text blocks also get an end time", async () => {
    const s = setup()
    await s.processor.run(feed(
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", text: "half" },
    ))
    s.processor.cleanup("interrupted")
    const text = s.store.listParts(s.message.id).find((p) => p.type === "text")
    expect(text?.type === "text" && text.time?.end).toBeGreaterThan(0)
  })

  test("cleanup is idempotent — a second call doesn't turn completed tools into errors", async () => {
    const s = setup()
    await s.processor.run(feed(
      { type: "tool-call", callID: "c1", tool: "read", input: {} },
      { type: "tool-result", callID: "c1", tool: "read", output: "ok" },
      { type: "step-finish", finishReason: "stop", tokens: tokens(5) },
    ))
    s.processor.cleanup("done")
    s.processor.cleanup("interrupted")
    const tool = s.store.listParts(s.message.id).find((p) => p.type === "tool") as ToolPart
    expect(tool.state.status).toBe("completed")
    expect(s.message.finish).toBe("stop")
  })

  test("context tokens come from the last step; billed tokens accumulate", async () => {
    const s = setup()
    const outcome = await s.processor.run(feed(
      { type: "step-finish", finishReason: "tool-calls", tokens: tokens(1000, 50) },
      { type: "step-finish", finishReason: "stop", tokens: tokens(1500, 80) },
    ))
    expect(outcome.contextTokens.input).toBe(1500) // not 2500
    expect(outcome.billedTokens.input).toBe(2500)
    expect(outcome.finishReason).toBe("stop")
  })

  test("error event lands in message.error", async () => {
    const s = setup()
    await s.processor.run(feed({ type: "error", error: new Error("provider blew up") }))
    s.processor.cleanup("error")
    expect(s.message.finish).toBe("error")
    expect(s.message.error?.message).toBe("provider blew up")
  })

  test("emitted UI events cover what streaming rendering needs", async () => {
    const s = setup()
    await s.processor.run(feed(
      { type: "step-start" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", text: "x" },
      { type: "text-end", id: "t1" },
      { type: "step-finish", finishReason: "stop", tokens: tokens(1) },
    ))
    s.processor.cleanup("done")
    const types = s.seen.map((e) => e.type)
    expect(types).toContain("part.start")
    expect(types).toContain("part.delta")
    expect(types).toContain("part.end")
    expect(types).toContain("step.finish")
    expect(types).toContain("message.end")
  })

  test("a throwing subscriber doesn't stop persistence", async () => {
    const s = setup()
    s.emitter.on(() => {
      throw new Error("renderer bug")
    })
    await s.processor.run(feed({ type: "text-delta", id: "t1", text: "still saved" }))
    s.processor.cleanup("done")
    const text = s.store.listParts(s.message.id).find((p) => p.type === "text")
    expect(text?.type === "text" && text.text).toBe("still saved")
  })
})

// ─────────────────────────────────────────────── Replaying history

describe("toLLMMessages", () => {
  const sessionID = "ses_x"
  const part = (messageID: string, extra: Partial<Part> & Pick<Part, "type">): Part =>
    ({ id: newPartID(), sessionID, messageID, timeCreated: Date.now(), ...extra }) as Part

  const userMessage = (id: string, text: string): MessageWithParts => ({
    info: { id, sessionID, role: "user", timeCreated: 1 },
    parts: [part(id, { type: "text", text })],
  })

  const assistantMessage = (id: string, parts: Part[], model = { providerID: "p", modelID: "m" }): MessageWithParts => ({
    info: {
      id,
      sessionID,
      role: "assistant",
      parentID: "u1",
      providerID: model.providerID,
      modelID: model.modelID,
      cost: 0,
      timeCreated: 2,
    },
    parts,
  })

  test("basic round trip", () => {
    const messages = toLLMMessages([
      userMessage("u1", "hi"),
      assistantMessage("a1", [part("a1", { type: "text", text: "hello" })]),
    ])
    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ])
  })

  test("★ completed tools produce a paired tool message", () => {
    const messages = toLLMMessages([
      userMessage("u1", "run it"),
      assistantMessage("a1", [
        part("a1", { type: "text", text: "sure" }),
        part("a1", {
          type: "tool",
          callID: "c1",
          tool: "bash",
          state: { status: "completed", input: { command: "ls" }, output: "a\nb", metadata: {}, time: { start: 1, end: 2 } },
        }),
      ]),
    ])
    expect(findUnpairedToolCalls(messages)).toEqual([])
    expect(messages[2]).toEqual({
      role: "tool",
      content: [{ callID: "c1", tool: "bash", output: "a\nb" }],
    })
  })

  test("★ running (interrupted) tools still need a result, or every turn 400s", () => {
    const messages = toLLMMessages([
      userMessage("u1", "run it"),
      assistantMessage("a1", [
        part("a1", { type: "text", text: "sure" }),
        part("a1", {
          type: "tool",
          callID: "c1",
          tool: "bash",
          state: { status: "running", input: { command: "sleep 60" }, time: { start: 1 } },
        }),
      ]),
    ])
    expect(findUnpairedToolCalls(messages)).toEqual([])
    const toolMessage = messages.find((m) => m.role === "tool")
    expect(toolMessage?.role === "tool" && toolMessage.content[0]!.isError).toBe(true)
    expect(toolMessage?.role === "tool" && toolMessage.content[0]!.output).toContain("interrupted")
  })

  test("★ pending tool calls are dropped along with their results, leaving no orphan result", () => {
    const messages = toLLMMessages([
      userMessage("u1", "x"),
      assistantMessage("a1", [
        part("a1", { type: "text", text: "text survives" }),
        part("a1", { type: "tool", callID: "c1", tool: "read", state: { status: "pending" } }),
      ]),
    ])
    expect(findUnpairedToolCalls(messages)).toEqual([])
    expect(messages.some((m) => m.role === "tool")).toBe(false)
    expect(messages[1]!.role).toBe("assistant")
  })

  test("★ an assistant message of only pending tools is skipped entirely", () => {
    const messages = toLLMMessages([
      userMessage("u1", "x"),
      assistantMessage("a1", [
        part("a1", { type: "tool", callID: "c1", tool: "read", state: { status: "pending" } }),
      ]),
    ])
    expect(findUnpairedToolCalls(messages)).toEqual([])
    expect(messages).toHaveLength(1)
  })

  test("empty assistant messages are skipped, and none of their tool results leak out", () => {
    const messages = toLLMMessages([
      userMessage("u1", "x"),
      assistantMessage("a1", []),
      userMessage("u2", "again"),
    ])
    expect(messages.map((m) => m.role)).toEqual(["user", "user"])
  })

  test("switching models drops reasoning wholesale — a foreign signature 400s, and so does stripping it", () => {
    const history = [
      userMessage("u1", "x"),
      assistantMessage("a1", [
        part("a1", { type: "reasoning", text: "deep thought", signature: "sig" }),
        part("a1", { type: "text", text: "answer" }),
      ]),
    ]
    const kinds = (messages: LLMMessage[], index: number): string[] => {
      const message = messages[index]!
      return message.role === "assistant" ? message.content.map((c) => c.type) : []
    }

    expect(kinds(toLLMMessages(history, { model: { providerID: "p", modelID: "m" } }), 1)).toContain("reasoning")

    const different = kinds(toLLMMessages(history, { model: { providerID: "other", modelID: "z" } }), 1)
    expect(different).not.toContain("reasoning")
    expect(different).toContain("text")
  })

  describe("★ only thinking from the current tool loop is sent", () => {
    const think = (id: string) =>
      assistantMessage(id, [
        part(id, { type: "reasoning", text: `thinking-${id}`, signature: "sig" }),
        part(id, { type: "text", text: `said-${id}` }),
      ])
    const reasoningIn = (messages: LLMMessage[], index: number): boolean => {
      const message = messages[index]
      return message?.role === "assistant" && message.content.some((c) => c.type === "reasoning")
    }

    test("same-pass thinking is kept — without the thought behind each tool call, the next step must guess backwards", () => {
      // user → think → (tool) → think → …: no new user message in between, so the whole
      // stretch is one pass
      const messages = toLLMMessages([userMessage("u1", "go"), think("a1"), think("a2")])
      expect(reasoningIn(messages, 1)).toBe(true)
      expect(reasoningIn(messages, 2)).toBe(true)
    })

    test("thinking before a new user message is dropped — Anthropic strips it anyway, compatible endpoints reject it", () => {
      const messages = toLLMMessages([userMessage("u1", "first"), think("a1"), userMessage("u2", "second"), think("a2")])
      expect(reasoningIn(messages, 1)).toBe(false)
      // Only the thinking is dropped; what was said in that turn must stay
      const old = messages[1]!
      expect(old.role === "assistant" && old.content.map((c) => c.type)).toEqual(["text"])
      expect(reasoningIn(messages, 3)).toBe(true)
    })

    test("a synthetic user message (the pre-finish check) also counts as a boundary", () => {
      const reminder: MessageWithParts = {
        info: { id: "u2", sessionID, role: "user", timeCreated: 1 },
        parts: [part("u2", { type: "text", text: "tsc failed", synthetic: true })],
      }
      const messages = toLLMMessages([userMessage("u1", "go"), think("a1"), reminder, think("a2")])
      expect(reasoningIn(messages, 1)).toBe(false)
      expect(reasoningIn(messages, 3)).toBe(true)
    })

    test("doesn't break when the last message is user (the moment before replying)", () => {
      const messages = toLLMMessages([userMessage("u1", "go"), think("a1"), userMessage("u2", "wait")])
      expect(reasoningIn(messages, 1)).toBe(false)
      expect(messages.at(-1)!.role).toBe("user")
    })
  })

  test("step-start / step-finish stay out of model context", () => {
    const messages = toLLMMessages([
      userMessage("u1", "x"),
      assistantMessage("a1", [
        part("a1", { type: "step-start" }),
        part("a1", { type: "text", text: "hi" }),
        part("a1", { type: "step-finish", finishReason: "stop", tokens: tokens(1), cost: 0 }),
      ]),
    ])
    expect(messages[1]!.content).toEqual([{ type: "text", text: "hi" }])
  })

  test("findUnpairedToolCalls really catches problems (the self-check itself is trustworthy)", () => {
    const broken = [
      { role: "assistant" as const, content: [{ type: "tool-call" as const, callID: "c1", tool: "x", input: {} }] },
    ]
    expect(findUnpairedToolCalls(broken)).toEqual(["c1"])

    const orphanResult = [
      { role: "assistant" as const, content: [{ type: "tool-call" as const, callID: "c1", tool: "x", input: {} }] },
      { role: "tool" as const, content: [{ callID: "c9", tool: "x", output: "?" }] },
    ]
    expect(findUnpairedToolCalls(orphanResult)).toContain("orphan-result:c9")
  })

  test("multi-round tool calls are all paired", () => {
    const messages = toLLMMessages([
      userMessage("u1", "go"),
      assistantMessage("a1", [
        part("a1", {
          type: "tool", callID: "c1", tool: "read",
          state: { status: "completed", input: {}, output: "1", metadata: {}, time: { start: 1, end: 2 } },
        }),
        part("a1", {
          type: "tool", callID: "c2", tool: "grep",
          state: { status: "error", input: {}, error: "nope", metadata: {}, time: { start: 1, end: 2 } },
        }),
      ]),
      assistantMessage("a2", [part("a2", { type: "text", text: "done" })]),
    ])
    expect(findUnpairedToolCalls(messages)).toEqual([])
    const toolMessage = messages.find((m) => m.role === "tool")
    expect(toolMessage?.role === "tool" && toolMessage.content).toHaveLength(2)
  })
})

// ─────────────────────────────────────────────── Token accounting

describe("tokens", () => {
  test("Anthropic-style: input plus cache", () => {
    expect(contextTokens(tokens(1000, 50, 4000, 200), { cacheInInput: false })).toBe(5200)
  })

  test("OpenAI-style: input already includes cache, don't add it again", () => {
    // In real runs, MiniMax openai-chat: of in=2080, 2048 were cache hits
    expect(contextTokens(tokens(2080, 57, 2048), { cacheInInput: true })).toBe(2080)
  })

  test("output doesn't count toward context usage", () => {
    expect(contextTokens(tokens(100, 99_999), { cacheInInput: false })).toBe(100)
  })

  test("default accounting is conservative (adds them)", () => {
    expect(contextTokens(tokens(100, 0, 900))).toBe(1000)
  })

  test("usable subtracts the output budget and compaction buffer", () => {
    expect(usable({ context: 200_000, output: 32_000 })).toBe(200_000 - 32_000 - COMPACTION_BUFFER)
  })

  test("usageRatio caps at 1", () => {
    expect(usageRatio(tokens(usable(INFO.limit) * 2), INFO)).toBe(1)
    expect(usageRatio(undefined, INFO)).toBe(0)
  })

  test("garbage data (NaN/negative/undefined) counts as 0", () => {
    expect(contextTokens({ input: NaN, output: -5, reasoning: 0, cache: { read: -1, write: NaN } })).toBe(0)
    expect(contextTokens(undefined)).toBe(0)
  })

  test("accumulateBilled sums every field", () => {
    const sum = accumulateBilled(tokens(10, 1, 2, 3), tokens(20, 2, 4, 6))
    expect(sum.input).toBe(30)
    expect(sum.output).toBe(3)
    expect(sum.cache).toEqual({ read: 6, write: 9 })
  })
})
