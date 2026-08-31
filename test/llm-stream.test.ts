/**
 * fullStream 的归一化。
 *
 * 这里的 bug 有个共同特征:**当场什么都不会发生**。签名捡漏了、事件少发一条,
 * 这一轮照常跑完,代价要到下一轮回灌历史时才现形 —— 而那时候的现象是
 * 「屏幕上冒出几行 SDK 告警」或者「它忘了自己刚才想过什么」,离原因很远。
 */
import { describe, expect, test } from "bun:test"
import { anthropicProvider } from "../src/llm/providers/anthropic.ts"
import { openAICompatProvider } from "../src/llm/providers/openai-compat.ts"
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

describe("思考的签名", () => {
  test("★ 签名挂在正文为空的 delta 上,要一路带到 reasoning-end", async () => {
    // SDK 把 Anthropic 的 signature_delta 翻成这个形状:delta 是空串,
    // 签名在 providerMetadata 里。只在 end 事件上找的话永远拿不到 ——
    // 而没签名的思考回灌时会被整块丢掉,还每轮吐一条告警
    const events = await run([
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "先看看 paint" },
      { type: "reasoning-delta", id: "r1", text: "", providerMetadata: { anthropic: { signature: "sig-abc" } } },
      { type: "reasoning-end", id: "r1" },
    ])
    const end = events.find((event) => event.type === "reasoning-end")
    expect(end).toMatchObject({ type: "reasoning-end", id: "r1", signature: "sig-abc" })
  })

  test("带签名那条 delta 不往外发 —— 它正文是空的,发出去就是一次空重画", async () => {
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

  test("end 自己带签名时以它为准", async () => {
    const events = await run([
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "", providerMetadata: { anthropic: { signature: "old" } } },
      { type: "reasoning-end", id: "r1", providerMetadata: { anthropic: { signature: "new" } } },
    ])
    expect(events.at(-1)).toMatchObject({ signature: "new" })
  })

  test("没有签名就不编一个出来", async () => {
    const events = await run([
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "想了想" },
      { type: "reasoning-end", id: "r1" },
    ])
    expect(events.at(-1)).toEqual({ type: "reasoning-end", id: "r1" })
  })

  test("★ 新的一段思考不许继承上一段的签名 —— 签错了整段历史都会被拒", async () => {
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

describe("回灌历史", () => {
  test("★ 没签名的思考不回灌 —— SDK 收不了它,只会丢掉再吐一条告警", () => {
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
    // 正文照旧,丢的只是那段没法用的草稿
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

  test('★ "text" 档:兼容端点没有签名这一说,原样发文本', () => {
    // SDK 那边序列化成 reasoning_content。不发的话,模型在一趟工具循环里
    // 看不见自己上一步想过什么,只能从"我调了什么工具"倒推
    const json = JSON.stringify(toModelMessages(unsigned, "text"))
    expect(json).toContain("想过的")
    // 签名字段一个都不该出现 —— 这条路上压根没有
    expect(json).not.toContain("signature")
  })

  test('★ "none" 档:给那些收到 reasoning_content 直接 400 的端点', () => {
    const json = JSON.stringify(toModelMessages(unsigned, "none"))
    expect(json).not.toContain("想过的")
    expect(json).toContain("答案")
  })

  test("缺省是最保守的那一档 —— 新接的 provider 忘了填也不会炸", () => {
    expect(JSON.stringify(toModelMessages(unsigned))).toBe(JSON.stringify(toModelMessages(unsigned, "signed")))
  })
})

describe("缓存口径", () => {
  /**
   * ★ 这一栏判的是 **AI SDK 交出来的那个数**,不是 provider 原始 API 的口径。
   *
   *   照 Anthropic 文档看,input_tokens 和 cache_read_input_tokens 是分开报的,
   *   该填 false —— 曾经就是这么填的。但 @ai-sdk/anthropic 的 convertAnthropicUsage
   *   先加过一遍(total = input_tokens + cache_creation + cache_read),ai 核心
   *   取的就是 .total。填成 false 就是把缓存那部分加第二遍。
   *
   *   这个错当场不报任何异常,只是仪表盘上的数字变成两倍 —— 而它是自动压缩的
   *   触发依据,于是压缩在真实用量一半的地方就开始。
   */
  test("★ Anthropic 侧报到我们手里的 input 已经含缓存 —— 不能再加一遍", () => {
    const info = anthropicProvider({ apiKey: "test-key" }).resolve("claude-haiku-4-5", {}).info
    expect(info.cacheInInput).toBe(true)
  })

  test("OpenAI 兼容侧同理", () => {
    const info = openAICompatProvider({ apiKey: "test-key" }).resolve("whatever", {}).info
    expect(info.cacheInInput).toBe(true)
  })

  /** 真实数据:MiniMax 的 /anthropic 端点,命中率 98.4% 的那一轮 */
  test("★ 高命中率下算错口径就是接近两倍的误差", () => {
    const real = { input: 11_425, output: 91, reasoning: 0, cache: { read: 11_240, write: 0 } }
    expect(contextTokens(real, { cacheInInput: true })).toBe(11_425)
    // 填错的那个分支会得到 22_665 —— 留在这儿是为了让误差有多大一眼可见
    expect(contextTokens(real, { cacheInInput: false })).toBe(22_665)
  })
})

describe("Anthropic 的世代分档", () => {
  const resolve = (modelID: string, opts: { thinking?: boolean; baseURL?: string } = {}) =>
    anthropicProvider({ apiKey: "k", ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) }).resolve(modelID, {
      ...(opts.thinking ? { thinking: true } : {}),
    })

  /**
   * ★ 这不是调优,是能不能发出去。Anthropic 在 4.7 那一代把 temperature 和
   *   budgetTokens **删了** —— 带着它们发过去是 400,而报错不会指出是哪个字段。
   */
  test("★ 当前世代:任何时候都不带 temperature", () => {
    expect(resolve("claude-opus-5").temperature).toBeUndefined()
    expect(resolve("claude-opus-5", { thinking: true }).temperature).toBeUndefined()
    expect(resolve("claude-sonnet-5").temperature).toBeUndefined()
  })

  test("★ 当前世代:思考走 adaptive,不带 budgetTokens", () => {
    const opts = resolve("claude-opus-5", { thinking: true }).providerOptions
    expect(opts?.["anthropic"]?.["thinking"]).toEqual({ type: "adaptive" })
    expect(JSON.stringify(opts)).not.toContain("budgetTokens")
  })

  /** Opus 5 起思考是**默认开的**,省略等于开着 —— 关它必须显式说 */
  test("★ 当前世代关思考要显式发 disabled,不能靠省略", () => {
    expect(resolve("claude-opus-5").providerOptions?.["anthropic"]?.["thinking"]).toEqual({ type: "disabled" })
  })

  test("旧世代照旧:budgetTokens + temperature", () => {
    const old = resolve("claude-haiku-4-5", { thinking: true })
    expect(JSON.stringify(old.providerOptions)).toContain("budgetTokens")
    expect(resolve("claude-haiku-4-5").temperature).toBe(0)
  })

  /**
   * ★ 设了 baseURL 就是别人家的兼容端点(MiniMax 那种)。那边认哪一套参数
   *   只有它自己知道 —— 按老规矩发,因为那正是今天在跑的组合。
   */
  test("★ 第三方兼容端点不按世代裁 —— 名字撞上也不裁", () => {
    const compat = resolve("claude-opus-5", { thinking: true, baseURL: "https://api.minimaxi.com/anthropic/v1" })
    expect(JSON.stringify(compat.providerOptions)).toContain("budgetTokens")
    expect(resolve("claude-opus-5", { baseURL: "https://x/anthropic/v1" }).temperature).toBe(0)
  })
})

describe("历史上的缓存断点", () => {
  const blocks = (out: unknown) => JSON.stringify(out).split("ephemeral").length - 1

  /**
   * ★ system 上那两个断点只缓住 tools + system。断点全在那儿,后面整段对话
   *   每轮按全价重算 —— 而 agent 会话里大的正是后面那段。
   */
  test("★ 末尾要有一个断点", () => {
    const out = toModelMessages([{ role: "user", content: [{ type: "text", text: "hi" }] }])
    expect(blocks(out)).toBe(1)
  })

  test("短对话只用一个额度 —— 第二个会落在第一个上,白占", () => {
    const msgs: LLMMessage[] = Array.from({ length: 3 }, () => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: "x" }],
    }))
    expect(blocks(toModelMessages(msgs))).toBe(1)
  })

  test("★ 超过回溯窗口就补第二个 —— 一个够不着上一轮的断点等于没有", () => {
    const msgs: LLMMessage[] = Array.from({ length: 30 }, () => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: "x" }],
    }))
    expect(blocks(toModelMessages(msgs))).toBe(2)
  })

  test("空历史不炸", () => {
    expect(blocks(toModelMessages([]))).toBe(0)
  })

  /**
   * ★ 断点一度是**一句覆盖**:`block.providerOptions = CACHE_BREAKPOINT`。
   *   而思考块的 providerOptions 里装着它的**签名** —— Anthropic 收下这段思考
   *   的唯一凭据。覆盖掉之后是双输:签名没了(整段思考被丢掉 + 每轮一条
   *   "unsupported reasoning metadata" 告警),断点也没了(thinking 块本来就
   *   不可缓存,provider 收到 cache_control 只会写一句"忽略")。
   *
   *   开着扩展思考的会话里,每条 assistant 消息都以 reasoning 开头,
   *   往回数第 18 个 block 落在它上面是常事。
   */
  test("★ 断点不许把思考的签名盖掉", () => {
    const reasoning = {
      role: "assistant" as const,
      content: [{ type: "reasoning" as const, text: "想了想", signature: "sig-abc" }],
    }
    const out = toModelMessages([{ role: "user", content: [{ type: "text", text: "hi" }] }, reasoning])
    expect(JSON.stringify(out)).toContain("sig-abc")
  })

  test("★ 断点也不该落在思考块上 —— 往前挪到挂得住的那一个", () => {
    const msgs: LLMMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "想", signature: "sig" }] },
    ]
    type Block = { type?: string; providerOptions?: { anthropic?: Record<string, unknown> } }
    const out = toModelMessages(msgs)
    const parts = out.flatMap((one) => (Array.isArray(one.content) ? (one.content as Block[]) : []))
    // 签名那一块照旧带着自己的 providerOptions,但里面**没有** cacheControl
    for (const part of parts.filter((one) => one.type === "reasoning")) {
      expect(part.providerOptions?.anthropic?.["cacheControl"]).toBeUndefined()
      expect(part.providerOptions?.anthropic?.["signature"]).toBe("sig")
    }
    // 而断点确实落在了别处 —— 那条 user 文本上
    expect(blocks(out)).toBe(1)
  })
})

/**
 * 撞顶那一轮的收尾请求。
 *
 * ⚠ 上层表达「这一步一个工具都不许调」的方式是 `activeTools: []`,SDK 把它翻成
 *   `toolChoice: "none"`,而 @ai-sdk/anthropic 对 none 和空 tools 是同一个处理:
 *   **整个 tools 字段消失**。可 Anthropic 的 Messages API 有一条硬规矩 ——
 *   历史里但凡出现过 tool_use / tool_result 就必须声明 tools。两者一撞就是 400。
 *
 *   现场:一轮干满 100 步(历史里全是工具调用),最后那一轮"关掉工具、用纯文字
 *   交代进度"的请求直接被拒。而那一轮**恰恰是设计来避免半截会话的**。
 */
describe("★ 禁用工具时要不要上假工具", () => {
  test("压缩 / 摘要那种现搓的一条 user 消息:不上 —— tools 缺席完全合法", () => {
    expect(hasToolCalls(toModelMessages([{ role: "user", content: [{ type: "text", text: "材料" }] }]))).toBe(false)
  })

  test("★ 历史里有 tool-call:必须上", () => {
    const messages = toModelMessages([
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "tool-call", callID: "c1", tool: "bash", input: { command: "ls" } }] },
      { role: "tool", content: [{ callID: "c1", tool: "bash", output: "a\nb" }] },
    ])
    expect(hasToolCalls(messages)).toBe(true)
  })

  test("只有 tool 结果那一条也算", () => {
    expect(hasToolCalls([{ role: "tool", content: [] } as never])).toBe(true)
  })

  test("content 是裸字符串的形态不炸", () => {
    expect(hasToolCalls([{ role: "assistant", content: "hi" } as never])).toBe(false)
  })
})
