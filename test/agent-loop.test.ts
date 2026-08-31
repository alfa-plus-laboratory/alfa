/**
 * 主循环。
 *
 * 用假的 stream 函数喂固定事件序列 —— 测的是**控制流**:什么时候再发一轮、
 * 什么时候停、撞顶怎么收场。真实 SDK 的行为已经由 retry/prompt 那两组端到端
 * 测试覆盖过了,这里再接一次只会让失败原因变模糊。
 */
import { describe, expect, test } from "bun:test"
import { Loop } from "../src/agent/loop.ts"
import { Emitter, type UIEvent } from "../src/agent/events.ts"
import { Store } from "../src/session/store.ts"
import { newMessageID, newPartID, newSessionID } from "../src/session/id.ts"
import { MAX_STEPS, MAX_STEPS_PROMPT } from "../src/prompt/max-steps.ts"
import { ContextOverflowError, type LLMEvent, type LLMRequest, type ModelInfo } from "../src/llm/types.ts"

const INFO: ModelInfo = {
  ref: { providerID: "p", modelID: "m" },
  limit: { context: 200_000, output: 32_000 },
  supportsThinking: false,
  promptTemplate: "default",
  cacheInInput: false,
}

const MODEL = { providerID: "p", modelID: "m" }

function tokens(input: number, output = 0) {
  return { input, output, reasoning: 0, cache: { read: 0, write: 0 } }
}

/**
 * 每轮返回 script[i] 的事件序列;超出就用最后一条。
 *
 * 脚本项可以是个函数,拿得到这一轮的 request —— 要模拟"工具报了 metadata"
 * (edit 的 filePath 就走这条路)时,得像真流程那样先 makeToolContext。
 */
function harness(
  script: Array<LLMEvent[] | ((request: LLMRequest) => LLMEvent[])>,
  options: {
    verify?: (input: { touched: string[]; abortSignal: AbortSignal }) => Promise<string | undefined>
    memory?: () => { text: string; notes: number } | undefined
    gitContext?: () => string | undefined
  } = {},
) {
  const store = new Store(":memory:")
  const sessionID = newSessionID()
  store.createSession(sessionID, "/tmp")
  const emitter = new Emitter<UIEvent>()
  const seen: UIEvent[] = []
  emitter.on((e) => seen.push(e))

  const requests: LLMRequest[] = []
  const loop = new Loop({
    store,
    emitter,
    tools: () => [],
    system: () => ["TEMPLATE", "ENV"],
    // 工具不在这里执行,但 ctx 本身要拿得到 —— metadata 是它上报的
    makeToolContext: () => ({
      cwd: "/tmp",
      root: "/tmp",
      sessionID,
      messageID: "m",
      callID: "c",
      abortSignal: new AbortController().signal,
      ask: async () => {},
      onProgress: () => {},
      metadata: () => {},
    }),
    ...(options.verify ? { verify: options.verify } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.gitContext ? { gitContext: options.gitContext } : {}),
    stream(request) {
      requests.push(request)
      const entry = script[Math.min(requests.length - 1, script.length - 1)]!
      return {
        info: INFO,
        // ★ 脚本项**在生成器里**才求值,不在 stream() 里。Loop 是先拿到 handle
        //   才建 Processor 的,而 ctx.metadata 要经过 Processor 才落得进 part ——
        //   在 stream() 里就调 makeToolContext 的话,metadata 会被安静地丢掉
        events: (async function* () {
          for (const event of typeof entry === "function" ? entry(request) : entry) yield event
        })(),
      }
    },
  })

  return { store, sessionID, emitter, seen, requests, loop }
}

const say = (text: string, finishReason = "stop"): LLMEvent[] => [
  { type: "step-start" },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", text },
  { type: "text-end", id: "t" },
  { type: "step-finish", finishReason, tokens: tokens(100, 10) },
]

const callTool = (callID: string, finishReason: string): LLMEvent[] => [
  { type: "step-start" },
  { type: "tool-call", callID, tool: "bash", input: { command: "ls" } },
  { type: "tool-result", callID, tool: "bash", output: "a\nb" },
  { type: "step-finish", finishReason, tokens: tokens(100, 10) },
]

// ─────────────────────────────────────────────── 基本

describe("Loop", () => {
  test("纯文本回答一轮就停", async () => {
    const h = harness([say("hello")])
    const result = await h.loop.run({
      sessionID: h.sessionID,
      model: MODEL,
      text: "hi",
      abortSignal: new AbortController().signal,
    })
    expect(result.steps).toBe(1)
    expect(h.requests).toHaveLength(1)
    expect(result.interrupted).toBe(false)
    expect(result.error).toBeUndefined()
  })

  test("用户消息先落库,并出现在第一次请求里", async () => {
    const h = harness([say("ok")])
    await h.loop.run({
      sessionID: h.sessionID,
      model: MODEL,
      text: "do the thing",
      abortSignal: new AbortController().signal,
    })
    const first = h.requests[0]!
    expect(first.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "do the thing" }] })
    expect(first.system).toEqual(["TEMPLATE", "ENV"])
  })

  test("★ finishReason 说 stop,但跑过工具 —— 仍然必须再发一轮", async () => {
    // MiniMax 一类的兼容端点真的会这样报,信 finishReason 就会"执行完一句话不说"
    const h = harness([callTool("c1", "stop"), say("here is the result")])
    const result = await h.loop.run({
      sessionID: h.sessionID,
      model: MODEL,
      text: "ls",
      abortSignal: new AbortController().signal,
    })
    expect(result.steps).toBe(2)
    // 第二轮的历史里必须带上工具结果
    const second = h.requests[1]!
    const toolMessage = second.messages.find((m) => m.role === "tool")
    expect(toolMessage?.role === "tool" && toolMessage.content[0]!.output).toBe("a\nb")
  })

  test("finishReason=tool-calls 同样再发一轮", async () => {
    const h = harness([callTool("c1", "tool-calls"), say("done")])
    const result = await h.loop.run({
      sessionID: h.sessionID,
      model: MODEL,
      text: "ls",
      abortSignal: new AbortController().signal,
    })
    expect(result.steps).toBe(2)
  })

  test("连续多轮工具调用", async () => {
    const h = harness([
      callTool("c1", "tool-calls"),
      callTool("c2", "tool-calls"),
      callTool("c3", "tool-calls"),
      say("finally"),
    ])
    const result = await h.loop.run({
      sessionID: h.sessionID,
      model: MODEL,
      text: "go",
      abortSignal: new AbortController().signal,
    })
    expect(result.steps).toBe(4)
  })

  test("计费用量跨轮累加", async () => {
    const h = harness([callTool("c1", "tool-calls"), say("done")])
    const result = await h.loop.run({
      sessionID: h.sessionID,
      model: MODEL,
      text: "go",
      abortSignal: new AbortController().signal,
    })
    expect(result.billedTokens.input).toBe(200)
    expect(result.billedTokens.output).toBe(20)
  })
})

// ─────────────────────────────────────────────── 中断

describe("中断", () => {
  test("★ 只剩被中断的工具 part 时停下,不空转", async () => {
    const h = harness([say("should never be called")])

    // 手工造一段"上次被 Ctrl-C 掐掉"的历史
    const userID = newMessageID()
    h.store.upsertMessage({ id: userID, sessionID: h.sessionID, role: "user", timeCreated: 1 })
    h.store.upsertPart({
      id: newPartID(), sessionID: h.sessionID, messageID: userID, timeCreated: 1,
      type: "text", text: "run something long",
    })
    const assistantID = newMessageID()
    h.store.upsertMessage({
      id: assistantID, sessionID: h.sessionID, role: "assistant", parentID: userID,
      providerID: "p", modelID: "m", cost: 0, timeCreated: 2, timeCompleted: 3, finish: "interrupted",
    })
    h.store.upsertPart({
      id: newPartID(), sessionID: h.sessionID, messageID: assistantID, timeCreated: 2,
      type: "tool", callID: "c1", tool: "bash",
      state: {
        status: "error", input: { command: "sleep 60" },
        error: "Tool execution was interrupted by the user before it completed.",
        metadata: { interrupted: true }, time: { start: 2, end: 3 },
      },
    })

    // 不带 text = "接着上次继续"
    const result = await h.loop.run({
      sessionID: h.sessionID,
      model: MODEL,
      abortSignal: new AbortController().signal,
    })
    expect(result.steps).toBe(0)
    expect(h.requests).toHaveLength(0)
  })

  test("对比:完成的工具 part 会触发续轮", async () => {
    const h = harness([say("continuing")])
    const userID = newMessageID()
    h.store.upsertMessage({ id: userID, sessionID: h.sessionID, role: "user", timeCreated: 1 })
    h.store.upsertPart({
      id: newPartID(), sessionID: h.sessionID, messageID: userID, timeCreated: 1, type: "text", text: "x",
    })
    const assistantID = newMessageID()
    h.store.upsertMessage({
      id: assistantID, sessionID: h.sessionID, role: "assistant", parentID: userID,
      providerID: "p", modelID: "m", cost: 0, timeCreated: 2, timeCompleted: 3, finish: "tool-calls",
    })
    h.store.upsertPart({
      id: newPartID(), sessionID: h.sessionID, messageID: assistantID, timeCreated: 2,
      type: "tool", callID: "c1", tool: "bash",
      state: { status: "completed", input: {}, output: "out", metadata: {}, time: { start: 2, end: 3 } },
    })

    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, abortSignal: new AbortController().signal,
    })
    expect(result.steps).toBe(1)
  })

  test("开跑前就 abort:一次请求都不发", async () => {
    const h = harness([say("nope")])
    const controller = new AbortController()
    controller.abort()
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: controller.signal,
    })
    expect(result.steps).toBe(0)
    expect(result.interrupted).toBe(true)
    expect(h.requests).toHaveLength(0)
  })

  test("流中途 abort:标记中断,不再发下一轮", async () => {
    const controller = new AbortController()
    const h = harness([
      () => {
        controller.abort()
        const error = new Error("aborted")
        error.name = "AbortError"
        throw error
      },
    ])
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: controller.signal,
    })
    expect(result.interrupted).toBe(true)
    expect(result.error).toBeUndefined()
    expect(h.requests).toHaveLength(1)
  })

  // ★ 这条守的是**生产环境里真正发生的那种中断**,和上面那条抛 AbortError 的不是一回事。
  //
  //   AI SDK 在 abort 时**不抛异常**:它推一个 {type:"abort"} 然后正常关流,
  //   而 llm/stream.ts 的 normalize 显式忽略 abort。于是 loop 的 catch 块
  //   (那里有一整套中断处理)在生产里根本到不了 —— 生成器正常结束,
  //   outcome.error 是 undefined,一度就按 "done" 收口了。
  //
  //   而 "done" 给没收完的工具写的是「the tool was NOT run and nothing changed.
  //   Call it again」—— 可 killGroup 是真的把命令杀掉了,它**跑过了**。
  //   模型据此重做一次已经落盘的 write/edit。
  test("★ SDK 式中断(流正常关闭、不抛):工具必须记成「被中断」,不能记成「没跑过」", async () => {
    const controller = new AbortController()
    const h = harness([
      () => {
        // 真实形状:参数收完了、工具开跑了,然后用户按下 ctrl-c。
        // 流干干净净地结束,一个异常都不抛
        controller.abort()
        return [
          { type: "step-start" },
          { type: "tool-call", callID: "c1", tool: "bash", input: { command: "npm run build" } },
        ] as LLMEvent[]
      },
    ])
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "build it", abortSignal: controller.signal,
    })

    expect(result.interrupted).toBe(true)

    const messages = h.store.listAll(h.sessionID)
    const assistant = messages.find(
      (m): m is typeof m & { info: { role: "assistant"; id: string; finish?: string } } =>
        m.info.role === "assistant",
    )!
    expect(assistant.info.finish).toBe("interrupted")

    const tool = h.store.listParts(assistant.info.id).find((part) => part.type === "tool")!
    const state = tool.state as { status: string; error?: string; metadata?: { interrupted?: boolean } }
    expect(state.metadata?.interrupted).toBe(true)
    // ⚠ 这两句断言的是**具体措辞**,守的是那条错误信息不许再变回去:
    //    「没跑过、再调一次」对一条已经跑了的命令是最坏的一句话
    expect(state.error).toContain("interrupted")
    expect(state.error).not.toContain("was NOT run")
  })

  test("工具跑到一半被中断 —— 历史里不留没有结果的 tool_use", async () => {
    const controller = new AbortController()
    const h = harness([
      () => {
        // 只有 tool-call,没有 tool-result,然后流抛中断
        return [
          { type: "step-start" },
          { type: "tool-call", callID: "c1", tool: "bash", input: { command: "sleep 60" } },
        ] as LLMEvent[]
      },
    ])
    // 流正常结束(没有 result),随后 abort
    controller.abort()
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "go", abortSignal: controller.signal })
    // 就算这轮没跑成,循环也不能靠这个 tool part 无限续下去
    expect(h.requests.length).toBeLessThanOrEqual(1)
  })
})

// ─────────────────────────────────────────────── 步数上限

describe("步数上限", () => {
  test("★ 撞顶那轮注入 MAX_STEPS_PROMPT 并禁用工具,之后不再有下一轮", async () => {
    // 永远调工具 —— 不设上限就是无限循环
    const h = harness([() => callTool(`c${Math.floor(Math.random() * 1e9)}`, "tool-calls")])
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "loop forever", abortSignal: new AbortController().signal,
    })

    expect(result.steps).toBe(MAX_STEPS)
    expect(h.requests).toHaveLength(MAX_STEPS)
    expect(result.hitStepLimit).toBe(true)

    const last = h.requests[MAX_STEPS - 1]!
    expect(last.system).toContain(MAX_STEPS_PROMPT)
    expect(last.activeTools).toEqual([])

    // 前面每一轮都不该带这段
    const earlier = h.requests[MAX_STEPS - 2]!
    expect(earlier.system).not.toContain(MAX_STEPS_PROMPT)
    expect(earlier.activeTools).toBeUndefined()
  })

  test("正常结束不算撞顶", async () => {
    const h = harness([say("done")])
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal,
    })
    expect(result.hitStepLimit).toBe(false)
  })
})

// ─────────────────────────────────────────────── 错误

describe("错误", () => {
  test("流里的 error 事件:停一轮就结束,不重试", async () => {
    const h = harness([
      [{ type: "step-start" }, { type: "error", error: new Error("provider exploded") }],
      say("never"),
    ])
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal,
    })
    expect(h.requests).toHaveLength(1)
    expect(result.error?.message).toBe("provider exploded")
  })

  test("抛出来的错误也只停一轮", async () => {
    const h = harness([
      () => {
        throw new Error("connection reset")
      },
      say("never"),
    ])
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal,
    })
    expect(h.requests).toHaveLength(1)
    expect(result.error?.message).toBe("connection reset")
    expect(h.seen.some((e) => e.type === "error")).toBe(true)
  })

  test("上下文溢出给的是能照做的话,不是原始报错", async () => {
    const h = harness([
      () => {
        throw new ContextOverflowError("prompt is too long: 250000 > 200000")
      },
    ])
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal,
    })
    expect(result.error).toBeInstanceOf(ContextOverflowError)
    // 撞顶时给的是**这一刻能按的两条路**,不是"换个模型再来" —— 压缩已经有了
    expect(result.error?.message).toContain("/compact")
  })

  test("建流就失败时,不留一条空 assistant 消息在历史里", async () => {
    const h = harness([
      () => {
        throw new Error("no credentials")
      },
    ])
    await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal,
    })
    const history = h.store.listAll(h.sessionID)
    const assistant = history.find((m) => m.info.role === "assistant")
    expect(assistant?.info.role === "assistant" && assistant.info.finish).toBe("error")
    expect(assistant?.info.role === "assistant" && assistant.info.timeCompleted).toBeGreaterThan(0)
  })

  test("空会话(没有 user 消息)直接返回", async () => {
    const h = harness([say("nope")])
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, abortSignal: new AbortController().signal,
    })
    expect(result.steps).toBe(0)
    expect(h.requests).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────── 历史重读

describe("每轮重读历史", () => {
  test("上一轮落库的 part 出现在下一轮请求里", async () => {
    const h = harness([callTool("c1", "tool-calls"), say("done")])
    await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "go", abortSignal: new AbortController().signal,
    })
    const second = h.requests[1]!
    // user → assistant(tool-call) → tool(result)
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"])
  })

  test("轮与轮之间外部改了存储,下一轮立刻生效", async () => {
    const h = harness([callTool("c1", "tool-calls"), say("done")])
    let injected = false
    h.emitter.on((event) => {
      if (event.type !== "message.end" || injected) return
      injected = true
      // 模拟压缩 / 外部注入:硬插一条 user 消息
      const id = newMessageID()
      h.store.upsertMessage({ id, sessionID: h.sessionID, role: "user", timeCreated: Date.now() })
      h.store.upsertPart({
        id: newPartID(), sessionID: h.sessionID, messageID: id, timeCreated: Date.now(),
        type: "text", text: "INJECTED MID-LOOP",
      })
    })

    await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "go", abortSignal: new AbortController().signal,
    })
    const second = h.requests[1]!
    const texts = second.messages
      .filter((m) => m.role === "user")
      .flatMap((m) => (m.role === "user" ? m.content : []))
      .map((c) => (c.type === "text" ? c.text : ""))
    expect(texts).toContain("INJECTED MID-LOOP")
  })
})

// ─────────────────────────────────────────────── 收口前的验证

/** 一次 edit:像真流程那样先由 ctx 上报 filePath,再吐 tool-result */
const editFile = (callID: string, filePath: string) => (request: LLMRequest): LLMEvent[] => {
  request.makeToolContext({ callID, abortSignal: new AbortController().signal }).metadata({ filePath })
  return [
    { type: "step-start" },
    { type: "tool-call", callID, tool: "edit", input: { filePath } },
    { type: "tool-result", callID, tool: "edit", output: "Edit applied successfully." },
    { type: "step-finish", finishReason: "tool-calls", tokens: tokens(100, 10) },
  ]
}

const userTexts = (request: LLMRequest): string[] =>
  request.messages
    .filter((m) => m.role === "user")
    .flatMap((m) => (m.role === "user" ? m.content : []))
    .map((c) => (c.type === "text" ? c.text : ""))

describe("收口前的验证", () => {
  test("★ 改过文件就在收口前验一道,验出问题的话它得接着干", async () => {
    const touchedSeen: string[][] = []
    const h = harness([editFile("c1", "/repo/src/a.ts"), say("改好了"), say("这回真好了")], {
      verify: async ({ touched }) => {
        touchedSeen.push(touched)
        return touchedSeen.length === 1 ? "CHECK FAILED: a.ts(1,1)" : undefined
      },
    })

    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "改一下", abortSignal: new AbortController().signal,
    })

    // 它说"改好了"之后没有停,而是又跑了一轮
    expect(result.steps).toBe(3)
    expect(touchedSeen[0]).toEqual(["/repo/src/a.ts"])
    // 验证的话作为 user 消息进了下一轮请求
    expect(userTexts(h.requests[2]!)).toContain("CHECK FAILED: a.ts(1,1)")
  })

  test("★ 塞回去的那条是合成的 —— 界面不能把它当成用户说的话", async () => {
    const h = harness([editFile("c1", "/repo/a.ts"), say("done"), say("done")], {
      verify: async () => (nth++ === 0 ? "PROBLEMS" : undefined),
    })
    let nth = 0
    await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "改一下", abortSignal: new AbortController().signal,
    })

    const users = h.store.listAll(h.sessionID).filter((m) => m.info.role === "user")
    expect(users.length).toBe(2)
    const injected = users[1]!.parts[0]!
    expect(injected.type === "text" && injected.synthetic).toBe(true)
    // 用户真正说的那句不带这个标记
    const original = users[0]!.parts[0]!
    expect(original.type === "text" && original.synthetic).toBeUndefined()
  })

  test("一个文件都没动就不验 —— 纯问答不该花这几秒", async () => {
    let called = 0
    const h = harness([say("是的")], {
      verify: async () => {
        called++
        return undefined
      },
    })
    await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "在吗", abortSignal: new AbortController().signal,
    })
    expect(called).toBe(0)
  })

  test("★ 一直修不好也要收场 —— 到顶就放它去回答,不能在这儿转到天亮", async () => {
    let called = 0
    const h = harness([editFile("c1", "/repo/a.ts"), say("我修好了")], {
      verify: async () => {
        called++
        return "STILL BROKEN"
      },
    })
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "改", abortSignal: new AbortController().signal,
    })
    expect(called).toBe(2)
    expect(result.steps).toBeLessThan(MAX_STEPS)
  })

  test("验证自己炸了不算这一轮失败 —— 它是加分项", async () => {
    const h = harness([editFile("c1", "/repo/a.ts"), say("好了")], {
      verify: async () => {
        throw new Error("checker exploded")
      },
    })
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "改", abortSignal: new AbortController().signal,
    })
    expect(result.error).toBeUndefined()
    expect(result.interrupted).toBe(false)
  })

  test("中断之后不验 —— 用户按 esc 是想停,不是想等一轮编译", async () => {
    const controller = new AbortController()
    let called = 0
    const h = harness([
      (request: LLMRequest) => {
        const events = editFile("c1", "/repo/a.ts")(request)
        controller.abort()
        return events
      },
      say("好了"),
    ], {
      verify: async () => {
        called++
        return "PROBLEMS"
      },
    })
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "改", abortSignal: controller.signal })
    expect(called).toBe(0)
  })
})

// ─────────────────────────────────────────────── 项目记忆

describe("★ 项目记忆挂在第一句话上", () => {
  const memory = () => ({ text: "<project-memory>MEMO-MARKER</project-memory>", notes: 1 })

  test("新会话的第一句话带上它,而且和这句话在同一条 user 消息里", async () => {
    const h = harness([say("ok")], { memory })
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal })

    const history = h.store.listAll(h.sessionID)
    const first = history[0]!
    expect(first.info.role).toBe("user")
    // 同一条消息:连着两条 user 有的 provider 会合并、有的会报错
    expect(first.parts.map((p) => p.type)).toEqual(["memory", "text"])
    expect(h.requests[0]!.messages[0]!.content).toEqual([
      { type: "text", text: "<project-memory>MEMO-MARKER</project-memory>" },
      { type: "text", text: "hi" },
    ])
  })

  test("★ 只挂一次 —— 第二句话不再挂,否则同一批便条在同一条上下文里出现两遍", async () => {
    const h = harness([say("one"), say("two")], { memory })
    const signal = new AbortController().signal
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "first", abortSignal: signal })
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "second", abortSignal: signal })

    const memoryParts = h.store
      .listAll(h.sessionID)
      .flatMap((entry) => entry.parts)
      .filter((part) => part.type === "memory")
    expect(memoryParts).toHaveLength(1)
  })

  test("收口前那条合成提醒不挂 —— 它不是一场对话的开头", async () => {
    let asked = false
    const h = harness([say("done"), say("fixed")], {
      memory,
      verify: async () => {
        if (asked) return undefined
        asked = true
        return "tsc failed"
      },
    })
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "go", abortSignal: new AbortController().signal })
    const memoryParts = h.store
      .listAll(h.sessionID)
      .flatMap((entry) => entry.parts)
      .filter((part) => part.type === "memory")
    expect(memoryParts).toHaveLength(1)
  })

  test("一条便条都没有时什么都不挂,不留一条空的 memory part", async () => {
    const h = harness([say("ok")], { memory: () => undefined })
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal })
    expect(h.store.listAll(h.sessionID)[0]!.parts.map((p) => p.type)).toEqual(["text"])
  })
})

// ─────────────────────────────────────────────── 仓库快照

describe("★ 仓库快照挂在第一句话上", () => {
  const gitContext = () => "<git-status>GIT-MARKER</git-status>"
  const memory = () => ({ text: "<project-memory>MEMO-MARKER</project-memory>", notes: 1 })

  test("次序是:仓库现状 → 项目记忆 → 用户的话。先摆事实,再摆约定,最后才是问题", async () => {
    const h = harness([say("ok")], { gitContext, memory })
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal })

    expect(h.requests[0]!.messages[0]!.content).toEqual([
      { type: "text", text: "<git-status>GIT-MARKER</git-status>" },
      { type: "text", text: "<project-memory>MEMO-MARKER</project-memory>" },
      { type: "text", text: "hi" },
    ])
  })

  test("★ 它是 synthetic 的 —— 界面不会把它当成用户说过的话", async () => {
    const h = harness([say("ok")], { gitContext })
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal })
    const [snapshot, said] = h.store.listAll(h.sessionID)[0]!.parts
    expect(snapshot!.type === "text" && snapshot!.synthetic).toBe(true)
    expect(said!.type === "text" && said!.synthetic).toBeUndefined()
  })

  test("★ 只挂一次 —— 第二句话不再挂,那份早过期了,而且它自己就是让它过期的人", async () => {
    const h = harness([say("one"), say("two")], { gitContext })
    const signal = new AbortController().signal
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "first", abortSignal: signal })
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "second", abortSignal: signal })

    const marked = h.store
      .listAll(h.sessionID)
      .flatMap((entry) => entry.parts)
      .filter((part) => part.type === "text" && part.text.includes("GIT-MARKER"))
    expect(marked).toHaveLength(1)
  })

  test("★ 挂上去之后一个字都不动 —— 历史只增不改,前缀稳定,缓存才成立", async () => {
    let branch = "main"
    const h = harness([say("one"), say("two")], { gitContext: () => `<git-status>on ${branch}</git-status>` })
    const signal = new AbortController().signal
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "first", abortSignal: signal })
    branch = "feature" // 它中途切了分支
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "second", abortSignal: signal })

    // 第二轮请求里,第一条 user 消息必须和第一轮那条逐字一致
    expect(h.requests.at(-1)!.messages[0]!.content).toEqual(h.requests[0]!.messages[0]!.content)
    expect(JSON.stringify(h.requests.at(-1)!.messages)).not.toContain("on feature")
  })

  test("不是仓库时什么都不挂,不留一条空的 part", async () => {
    const h = harness([say("ok")], { gitContext: () => undefined })
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal })
    expect(h.store.listAll(h.sessionID)[0]!.parts.map((p) => p.type)).toEqual(["text"])
  })
})
