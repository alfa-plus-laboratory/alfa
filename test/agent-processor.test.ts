/**
 * Processor + 历史回灌。
 *
 * 这两个文件的 bug 有个共同特征:**不会当场报错**。写坏了以后,症状是下一轮
 * 请求 400,或者上下文用量算成两倍,或者会话从此再也发不出去。所以测试重点
 * 全部压在「历史回灌出来的形状合不合法」上,而不是「事件处理得对不对看着挺顺」。
 */
import { describe, expect, test } from "bun:test"
import { Processor } from "../src/agent/processor.ts"
import { Emitter, type UIEvent } from "../src/agent/events.ts"
import { findUnpairedToolCalls, toLLMMessages } from "../src/agent/to-model-messages.ts"
import { contextTokens, isOverflow, usable, usageRatio, accumulateBilled, COMPACTION_BUFFER } from "../src/agent/tokens.ts"
import { Store } from "../src/session/store.ts"
import { newMessageID, newPartID, newSessionID } from "../src/session/id.ts"
import type { AssistantMessage, MessageWithParts, Part, ToolPart } from "../src/session/schema.ts"
import type { LLMEvent, LLMMessage, ModelInfo, Tokens } from "../src/llm/types.ts"

// ─────────────────────────────────────────────── 脚手架

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
  test("文本增量累积成一个 part", async () => {
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

  test("没有 text-start 也能开块 —— 有些端点直接给 delta", async () => {
    const s = setup()
    await s.processor.run(feed({ type: "text-delta", id: "t1", text: "bare" }))
    s.processor.cleanup("done")
    const text = s.store.listParts(s.message.id).filter((p) => p.type === "text")
    expect(text).toHaveLength(1)
    expect(text[0]!.type === "text" && text[0]!.text).toBe("bare")
  })

  test("reasoning 的签名被存下来 —— 丢了下一轮 Anthropic 就 400", async () => {
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

  test("工具三段式:pending → running → completed", async () => {
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
    // input 在 running → completed 的转换里必须保留,否则回灌时 tool_use 没参数
    expect(tool.state.status === "completed" && tool.state.input).toEqual({ filePath: "/a" })
  })

  test("tool-result 先于 tool-call 到达也不崩", async () => {
    const s = setup()
    await s.processor.run(feed({ type: "tool-result", callID: "c1", tool: "read", output: "out" }))
    s.processor.cleanup("done")
    const tool = s.store.listParts(s.message.id).find((p) => p.type === "tool") as ToolPart
    expect(tool.state.status).toBe("completed")
  })

  test("tool-error 落成 error 状态", async () => {
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

  test("★ 中断时 running 的工具被改写成 error,不留孤儿", async () => {
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

  test("中断时没收尾的文本块也补上结束时间", async () => {
    const s = setup()
    await s.processor.run(feed(
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", text: "half" },
    ))
    s.processor.cleanup("interrupted")
    const text = s.store.listParts(s.message.id).find((p) => p.type === "text")
    expect(text?.type === "text" && text.time?.end).toBeGreaterThan(0)
  })

  test("cleanup 幂等 —— 调两次不会把已完成的工具改成 error", async () => {
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

  test("上下文口径取最后一个 step,计费口径累加", async () => {
    const s = setup()
    const outcome = await s.processor.run(feed(
      { type: "step-finish", finishReason: "tool-calls", tokens: tokens(1000, 50) },
      { type: "step-finish", finishReason: "stop", tokens: tokens(1500, 80) },
    ))
    expect(outcome.contextTokens.input).toBe(1500) // 不是 2500
    expect(outcome.billedTokens.input).toBe(2500)
    expect(outcome.finishReason).toBe("stop")
  })

  test("error 事件落到 message.error", async () => {
    const s = setup()
    await s.processor.run(feed({ type: "error", error: new Error("provider blew up") }))
    s.processor.cleanup("error")
    expect(s.message.finish).toBe("error")
    expect(s.message.error?.message).toBe("provider blew up")
  })

  test("发出的 UI 事件覆盖流式渲染所需", async () => {
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

  test("订阅者抛异常不影响落库", async () => {
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

// ─────────────────────────────────────────────── 历史回灌

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

  test("基本往返", () => {
    const messages = toLLMMessages([
      userMessage("u1", "hi"),
      assistantMessage("a1", [part("a1", { type: "text", text: "hello" })]),
    ])
    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ])
  })

  test("★ completed 工具产生配对的 tool 消息", () => {
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

  test("★ running(被中断)的工具也必须有结果,否则每轮都 400", () => {
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

  test("★ pending 的工具调用与结果一起丢弃,不留孤儿 result", () => {
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

  test("★ 全是 pending 工具的 assistant 消息整条跳过", () => {
    const messages = toLLMMessages([
      userMessage("u1", "x"),
      assistantMessage("a1", [
        part("a1", { type: "tool", callID: "c1", tool: "read", state: { status: "pending" } }),
      ]),
    ])
    expect(findUnpairedToolCalls(messages)).toEqual([])
    expect(messages).toHaveLength(1)
  })

  test("空 assistant 消息跳过,它的工具结果也不能漏出去", () => {
    const messages = toLLMMessages([
      userMessage("u1", "x"),
      assistantMessage("a1", []),
      userMessage("u2", "again"),
    ])
    expect(messages.map((m) => m.role)).toEqual(["user", "user"])
  })

  test("换模型时整块丢掉 reasoning —— 带着别家签名会 400,去掉签名也会", () => {
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

  describe("★ 思考只带这一趟工具循环里的", () => {
    const think = (id: string) =>
      assistantMessage(id, [
        part(id, { type: "reasoning", text: `thinking-${id}`, signature: "sig" }),
        part(id, { type: "text", text: `said-${id}` }),
      ])
    const reasoningIn = (messages: LLMMessage[], index: number): boolean => {
      const message = messages[index]
      return message?.role === "assistant" && message.content.some((c) => c.type === "reasoning")
    }

    test("同一趟里的留着 —— 每个工具决策前面那段想法,少了它下一步只能靠倒推", () => {
      // user → 想 → (工具) → 想 → …:中间没有新的用户消息,整段都是一趟
      const messages = toLLMMessages([userMessage("u1", "go"), think("a1"), think("a2")])
      expect(reasoningIn(messages, 1)).toBe(true)
      expect(reasoningIn(messages, 2)).toBe(true)
    })

    test("新的用户消息之前那些丢掉 —— Anthropic 收到也会自己剥,兼容端点根本不认", () => {
      const messages = toLLMMessages([userMessage("u1", "first"), think("a1"), userMessage("u2", "second"), think("a2")])
      expect(reasoningIn(messages, 1)).toBe(false)
      // 丢的只是思考,那一轮说过的话必须留着
      const old = messages[1]!
      expect(old.role === "assistant" && old.content.map((c) => c.type)).toEqual(["text"])
      expect(reasoningIn(messages, 3)).toBe(true)
    })

    test("合成 user 消息(收口前的检查)也算一道线", () => {
      const reminder: MessageWithParts = {
        info: { id: "u2", sessionID, role: "user", timeCreated: 1 },
        parts: [part("u2", { type: "text", text: "tsc failed", synthetic: true })],
      }
      const messages = toLLMMessages([userMessage("u1", "go"), think("a1"), reminder, think("a2")])
      expect(reasoningIn(messages, 1)).toBe(false)
      expect(reasoningIn(messages, 3)).toBe(true)
    })

    test("最后一条就是 user 时不炸(还没开口回答的那一刻)", () => {
      const messages = toLLMMessages([userMessage("u1", "go"), think("a1"), userMessage("u2", "wait")])
      expect(reasoningIn(messages, 1)).toBe(false)
      expect(messages.at(-1)!.role).toBe("user")
    })
  })

  test("step-start / step-finish 不进模型上下文", () => {
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

  test("findUnpairedToolCalls 真的会抓到问题(自检本身可信)", () => {
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

  test("多轮工具调用全部配对", () => {
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

// ─────────────────────────────────────────────── token 口径

describe("tokens", () => {
  test("Anthropic 系:input 与 cache 相加", () => {
    expect(contextTokens(tokens(1000, 50, 4000, 200), { cacheInInput: false })).toBe(5200)
  })

  test("OpenAI 系:input 已含 cache,不能再加", () => {
    // 实测 MiniMax openai-compat:in=2080 里有 2048 是缓存命中
    expect(contextTokens(tokens(2080, 57, 2048), { cacheInInput: true })).toBe(2080)
  })

  test("output 不计入上下文占用", () => {
    expect(contextTokens(tokens(100, 99_999), { cacheInInput: false })).toBe(100)
  })

  test("缺省口径偏保守(相加)", () => {
    expect(contextTokens(tokens(100, 0, 900))).toBe(1000)
  })

  test("usable 扣掉输出预算和压缩余量", () => {
    expect(usable({ context: 200_000, output: 32_000 })).toBe(200_000 - 32_000 - COMPACTION_BUFFER)
  })

  test("isOverflow 在留足余量时就为真", () => {
    const budget = usable(INFO.limit)
    expect(isOverflow(tokens(budget - 1), INFO)).toBe(false)
    expect(isOverflow(tokens(budget), INFO)).toBe(true)
  })

  test("usageRatio 封顶 1", () => {
    expect(usageRatio(tokens(usable(INFO.limit) * 2), INFO)).toBe(1)
    expect(usageRatio(undefined, INFO)).toBe(0)
  })

  test("脏数据(NaN/负数/undefined)一律当 0", () => {
    expect(contextTokens({ input: NaN, output: -5, reasoning: 0, cache: { read: -1, write: NaN } })).toBe(0)
    expect(contextTokens(undefined)).toBe(0)
  })

  test("accumulateBilled 累加各项", () => {
    const sum = accumulateBilled(tokens(10, 1, 2, 3), tokens(20, 2, 4, 6))
    expect(sum.input).toBe(30)
    expect(sum.output).toBe(3)
    expect(sum.cache).toEqual({ read: 6, write: 9 })
  })
})
