/**
 * 上下文占用与压缩。
 *
 * 这里盯的是几类**不报错的错** —— 它们全都表现为「数字看着挺像那么回事」:
 *   - 分项加起来对不上标题上的总数 → 两个数用户都会不信
 *   - 折叠掉的历史还算在占用里 → 压缩完仪表盘纹丝不动
 *   - 折叠点没生效 → 模型照旧收到全量历史,压缩等于白按(而且没有任何报错)
 *   - 100% 那条线两处各算一套 → 状态行写着 87%,provider 那边已经在报超限
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import {
  contextReport,
  ContextMeter,
  estimateTokens,
  sliceHistory,
  SLICE_KEYS,
  toolTokens,
} from "../src/agent/context.ts"
import { applyCompaction, chooseTail, createCompactor, describeSession, withFileLedger } from "../src/agent/compact.ts"
import { compactionIndex, toLLMMessages } from "../src/agent/to-model-messages.ts"
import { isSettled } from "../src/agent/loop.ts"
import { billedFromHistory, usable } from "../src/agent/tokens.ts"
import {
  contextChip,
  contextRule,
  gauge,
  gradientGauge,
  rampPaint,
  renderContextReport,
  sliceLabel,
  spentChip,
} from "../src/cli/context.ts"
import { setColorEnabled } from "../src/cli/theme.ts"
import { displayWidth } from "../src/cli/width.ts"
import { inputDivider } from "../src/tui/chrome.ts"
import { setInterfaceLanguage } from "../src/i18n/index.ts"
import { ContextTool } from "../src/tool/context-window.ts"
import { SkillTool } from "../src/tool/skill.ts"
import { createToolContext } from "../src/tool/context.ts"
import type { ContextView } from "../src/tool/types.ts"
import type { LLMEvent, LLMRequest, ModelInfo } from "../src/llm/types.ts"
import type { MessageWithParts, Part } from "../src/session/schema.ts"
import { Store } from "../src/session/store.ts"
import { registerBuiltins } from "../src/tool/builtin.ts"
import { ToolRegistry } from "../src/tool/registry.ts"

setColorEnabled(false)
setInterfaceLanguage("en")

/** 花费的空快照。测显示的那几条不关心它 */
const ZERO_SPENT = { total: 0, input: 0, output: 0 }

const INFO: ModelInfo = {
  ref: { providerID: "anthropic", modelID: "test" },
  limit: { context: 1_000_000, output: 32_000 },
  limitSource: "default",
  supportsThinking: true,
  promptTemplate: "anthropic",
  cacheInInput: false,
}

// ─────────────────────────────────────────────── 造历史

let seq = 0
function base(role: "user" | "assistant"): MessageWithParts["info"] {
  const id = `m${++seq}`
  return role === "user"
    ? { id, sessionID: "s", role, timeCreated: seq }
    : { id, sessionID: "s", role, parentID: "u", providerID: "anthropic", modelID: "test", cost: 0, timeCreated: seq }
}

function message(role: "user" | "assistant", ...parts: Array<Partial<Part> & { type: Part["type"] }>): MessageWithParts {
  const info = base(role)
  return {
    info,
    parts: parts.map(
      (part, index) =>
        ({
          id: `${info.id}-p${index}`,
          sessionID: "s",
          messageID: info.id,
          timeCreated: seq,
          ...part,
        }) as Part,
    ),
  }
}

const said = (text: string) => message("user", { type: "text", text })
const replied = (text: string) => message("assistant", { type: "text", text })
const ran = (tool: string, input: unknown, output: string) =>
  message("assistant", {
    type: "tool",
    callID: `c${++seq}`,
    tool,
    state: { status: "completed", input, output, metadata: {}, time: { start: 1, end: 2 } },
  })

// ─────────────────────────────────────────────── 估算

/**
 * ★ 分出来的两栏都必须是从原来那栏里**减掉**的,不是加上去的。
 *
 * 这份报告的总数是拿来和窗口比的,分项的和必须等于它 —— 一栏算两遍的后果不是
 * 数字难看,是它开始骗人:用户照着一个虚高的 system 去砍东西,砍完发现没变。
 */
describe("skills 目录和 MCP 工具各自单列", () => {
  const info = {
    limit: { context: 200_000, output: 8_000 },
  } as unknown as Parameters<typeof contextReport>[0]["info"]

  const fakeTool = (id: string) => ({
    id,
    description: "x".repeat(400),
    parameters: z.object({}),
    async execute() {
      return { output: "", metadata: { truncated: false } }
    },
  })

  test("目录从 system 里分出来,总数不变", () => {
    const catalogue = "# Skills\n\n- `one` — does a thing"
    const system = ["prefix", `tail with the catalogue inside\n\n${catalogue}`]
    const withSkills = contextReport({ history: [], system, tools: [], skills: catalogue, info })
    const without = contextReport({ history: [], system, tools: [], info })

    const sum = (r: typeof withSkills) => r.slices.reduce((n, one) => n + one.tokens, 0)
    expect(sum(withSkills)).toBe(sum(without))
    const skills = withSkills.slices.find((one) => one.key === "skills")!.tokens
    expect(skills).toBeGreaterThan(0)
    expect(withSkills.slices.find((one) => one.key === "system")!.tokens).toBe(
      without.slices.find((one) => one.key === "system")!.tokens - skills,
    )
  })

  test("MCP 的工具不算在我们自己的 tools 里", () => {
    const tools = [fakeTool("read"), fakeTool("mcp__github__create_issue"), fakeTool("mcp__db__query")]
    const report = contextReport({ history: [], system: [], tools, info })
    const mcp = report.slices.find((one) => one.key === "mcp")!.tokens
    const own = report.slices.find((one) => one.key === "tools")!.tokens
    expect(mcp).toBeGreaterThan(0)
    expect(own).toBeGreaterThan(0)
    // 两个 MCP 工具对一个内建工具,别人家那栏该更大
    expect(mcp).toBeGreaterThan(own)

    const onlyOwn = contextReport({ history: [], system: [], tools: [fakeTool("read")], info })
    expect(onlyOwn.slices.find((one) => one.key === "mcp")!.tokens).toBe(0)
    expect(onlyOwn.slices.find((one) => one.key === "tools")!.tokens).toBe(own)
  })
})

describe("token 估算", () => {
  test("空串是 0,别的都大于 0", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("hello")).toBeGreaterThan(0)
  })

  test("★ 方块字按字算,不按字符数除 —— 除下去会把中文会话的占用低估三倍", () => {
    const chinese = "上下文窗口还剩多少"
    const latin = "how much context is left"
    expect(estimateTokens(chinese)).toBeGreaterThanOrEqual(chinese.length)
    // 同样九个「字」,英文那串字符多得多,但 token 数应该是同一个量级
    expect(estimateTokens(latin)).toBeLessThan(latin.length)
  })

  test("长度是单调的:更长的文本不可能估得更少", () => {
    expect(estimateTokens("abc".repeat(100))).toBeGreaterThan(estimateTokens("abc".repeat(10)))
  })

  test("工具定义算得出来,而且不是 0 —— 它是 system 之后最大的一块固定开销", () => {
    const tools = registerBuiltins(new ToolRegistry()).list()
    expect(toolTokens(tools)).toBeGreaterThan(200)
  })
})

// ─────────────────────────────────────────────── 分项

describe("分项", () => {
  test("各归各类", () => {
    const history = [said("改一下 live.ts"), ran("read", { filePath: "live.ts" }, "x".repeat(4_000)), replied("好了")]
    const { slices, messages } = sliceHistory(history)
    expect(messages).toBe(3)
    expect(slices.get("user")!.tokens).toBeGreaterThan(0)
    expect(slices.get("reply")!.tokens).toBeGreaterThan(0)
    expect(slices.get("call")!.tokens).toBeGreaterThan(0)
    // 工具输出是长会话里最大的一块,这条断言就是它
    expect(slices.get("result")!.tokens).toBeGreaterThan(slices.get("user")!.tokens)
  })

  /**
   * ★ 打开的那份 skill 记在 skills 头上,不记 result。
   *
   * 界面上有一栏就叫 skills,读的人自然当它是"skills 一共花了我多少"。而 skills
   * 这套设计的全部卖点是"目录便宜、正文按需" —— 一栏只数目录的话,恰好把验证
   * 这句话的那个数(正文,一份是一行目录的二十倍)藏进了 result 里。
   */
  test("★ 打开的 skill 记在 skills 那一栏,不记 result", () => {
    const body = "这份 skill 的正文,写着这个项目怎么发版。".repeat(60)
    const { slices } = sliceHistory([
      said("发个版"),
      ran("skill", { name: "cut-a-release" }, body),
      ran("read", { filePath: "package.json" }, "x".repeat(400)),
    ])
    expect(slices.get("skills")!.tokens).toBeGreaterThan(estimateTokens(body) * 0.9)
    // read 的输出照旧留在 result —— 那是活儿,不是提示词
    expect(slices.get("result")!.tokens).toBeGreaterThan(0)
    expect(slices.get("result")!.tokens).toBeLessThan(slices.get("skills")!.tokens / 5)
    // 调用本身照旧在 call:搬的是输出,分项加起来还得等于总数
    expect(slices.get("call")!.tokens).toBeGreaterThan(0)
  })

  test("★ 写死的那个工具 id 要和真的对得上 —— context.ts 不 import 它", () => {
    expect(SkillTool.id).toBe("skill")
  })

  test("★ 子 agent 交回来的报告不算「你说的话」—— agentflow 下它会是最大的一块", () => {
    // 库里它和用户敲的那句长得一模一样:role 都是 user,都是 text part。
    // 差别只有一个 synthetic 标志(见 cli/main.ts 的 injectSynthetic)
    const report = (text: string) => message("user", { type: "text", text, synthetic: true })
    const long = "调查agent 交回来的一大段结论。".repeat(80)

    const { slices } = sliceHistory([said("升级一下这个子系统"), report(long), report(long)])
    expect(slices.get("handoff")!.tokens).toBeGreaterThan(0)
    // ★ 这条就是那个 bug:两份报告曾经全记在用户头上,于是仪表盘写着
    //   「你说的话 120k」,而用户一共敲了八个字
    expect(slices.get("user")!.tokens).toBeLessThan(slices.get("handoff")!.tokens / 10)
  })

  test("开场那条上挂的仓库快照也不算 —— 它和用户的原话挤在同一条消息里", () => {
    const withSnapshot = message(
      "user",
      { type: "text", text: "现在是什么状态".repeat(1), synthetic: true },
      { type: "text", text: "看一下" },
    )
    const { slices } = sliceHistory([withSnapshot])
    expect(slices.get("env")!.tokens).toBeGreaterThan(0)
    expect(slices.get("user")!.tokens).toBeGreaterThan(0)
    // 一条真人说过话的消息**不是**注入 —— 整条都算成 handoff 就把用户的原话也吞了
    expect(slices.get("handoff")).toBeUndefined()
  })

  test("★ thinking 那一栏只算真会发出去的 —— 一度是无条件全算,于是仪表盘挂着一大栏虚的", () => {
    const thought = (text: string) => message("assistant", { type: "reasoning", text, signature: "sig" })
    const long = "想了很久很久的一段".repeat(50)

    // 这一趟循环里的:算
    const current = sliceHistory([said("go"), thought(long)])
    expect(current.slices.get("thinking")!.tokens).toBeGreaterThan(0)

    // 上一趟的:模型收不到(见 to-model-messages.ts 的 loopStartIndex),就不该算
    const past = sliceHistory([said("first"), thought(long), said("second")])
    expect(past.slices.get("thinking")).toBeUndefined()
  })

  test("★ 分项加起来必须等于标题上那个总数 —— 对不上的话两个数都没人信", () => {
    const report = contextReport({
      history: [said("hi"), ran("bash", { command: "ls" }, "a\nb\nc"), replied("done")],
      system: ["you are an agent"],
      tools: [],
      info: INFO,
    })
    const sum = report.slices.reduce((total, slice) => total + slice.tokens, 0)
    // 缩放之后各项是四舍五入过的,允许每项差一个
    expect(Math.abs(sum - report.used)).toBeLessThanOrEqual(report.slices.length)
  })

  test("★ provider 报了数就以它为准,分项按比例对齐过去", () => {
    const history = [said("hi"), replied("hello")]
    const bare = contextReport({ history, system: ["sys"], tools: [], info: INFO })
    const scaled = contextReport({ history, system: ["sys"], tools: [], info: INFO, reported: bare.used * 4 })
    expect(scaled.used).toBe(bare.used * 4)
    expect(scaled.estimated).toBe(false)
    expect(bare.estimated).toBe(true)
    const sum = scaled.slices.reduce((total, slice) => total + slice.tokens, 0)
    expect(Math.abs(sum - scaled.used)).toBeLessThanOrEqual(scaled.slices.length)
  })

  test("空会话也画得出来:只有 system 和工具定义", () => {
    const report = contextReport({ history: [], system: ["sys"], tools: [], info: INFO })
    expect(report.messages).toBe(0)
    expect(report.slices.find((slice) => slice.key === "system")!.tokens).toBeGreaterThan(0)
    expect(report.free).toBe(report.budget - report.used)
  })
})

// ─────────────────────────────────────────────── 100% 那条线

describe("窗口预算", () => {
  test("★ 100 万的窗口以 90 万为满 —— 大窗口按比例留余量", () => {
    expect(usable({ context: 1_000_000, output: 32_000 })).toBe(900_000)
  })

  test("小窗口按绝对值留:一成不够压缩自己用", () => {
    // 20 万留一成只有 2 万,装不下一次压缩请求,所以还是走 output + 压缩余量
    expect(usable({ context: 200_000, output: 32_000 })).toBe(148_000)
  })

  test("ratio 是相对 budget 的,不是相对 limit —— 两处口径必须是同一个", () => {
    const meter = new ContextMeter(INFO)
    meter.assume(450_000)
    expect(meter.snapshot.budget).toBe(900_000)
    expect(meter.snapshot.ratio).toBeCloseTo(0.5, 5)
  })
})

describe("花费", () => {
  test("★ 花费是**累加**的,占用是**取最新**的 —— 这两个口径反过来用就全错了", () => {
    const meter = new ContextMeter(INFO)
    // 一个 turn 里的三步:每一步的 input 都含整段历史
    meter.observe({ input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } })
    meter.observe({ input: 2_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } })
    meter.observe({ input: 3_000, output: 300, reasoning: 0, cache: { read: 0, write: 0 } })
    // 占用 = 最后一步的 input(不是 6_000)
    expect(meter.snapshot.used).toBe(3_000)
    // 花费 = 三步相加,含 output
    expect(meter.snapshot.spent.total).toBe(1_000 + 2_000 + 3_000 + 100 + 200 + 300)
    expect(meter.snapshot.spent.input).toBe(6_000)
    expect(meter.snapshot.spent.output).toBe(600)
  })

  test("缓存命中也算花掉了 —— 便宜不等于没花", () => {
    const meter = new ContextMeter(INFO)
    meter.observe({ input: 500, output: 100, reasoning: 0, cache: { read: 9_000, write: 0 } })
    // cacheInInput=false 的 provider:input 和 cache 分开报,要相加
    expect(meter.snapshot.spent.total).toBe(500 + 9_000 + 100)
  })

  test("★ 压缩不退款 —— 一个会因为压缩而变小的「已花费」是在骗人", () => {
    const meter = new ContextMeter(INFO)
    meter.observe({ input: 400_000, output: 1_000, reasoning: 0, cache: { read: 0, write: 0 } })
    const before = meter.snapshot.spent.total
    meter.drop() // 压缩之后:占用作废
    meter.assume(9_000)
    expect(meter.snapshot.used).toBe(9_000)
    expect(meter.snapshot.spent.total).toBe(before)
    // 换会话才归零
    meter.resetSpend()
    expect(meter.snapshot.spent.total).toBe(0)
  })

  test("报告里把 in / out / 缓存拆开,并解释它为什么比窗口大", () => {
    const report = contextReport({
      history: [said("hi")],
      system: ["sys"],
      tools: [],
      info: INFO,
      spent: { input: 1_200_000, output: 40_000, reasoning: 0, cache: { read: 900_000, write: 0 } },
    })
    expect(report.spent.total).toBe(1_200_000 + 900_000 + 40_000)
    expect(report.spent.cached).toBe(900_000)
    const text = renderContextReport(report, "anthropic/test")
    expect(text).toContain("2.1M")
    expect(text).toContain("from cache")
    expect(text).toContain("re-sends the whole history")
  })

  test("★ 状态行上进出分开写 —— 单价差一个数量级,合成一个数就分不出贵贱", () => {
    const chip = (spent: { total: number; input: number; output: number }) =>
      spentChip({ used: 0, budget: 900_000, limit: 1_000_000, ratio: 0, estimated: true, spent })
    // 一个 token 都没花的时候不画:`0 in · 0 out` 只是噪音
    expect(chip(ZERO_SPENT)).toBe("")
    expect(chip({ total: 4_386_000, input: 4_300_000, output: 86_000 })).toBe("4.3M in · 86k out")
  })
})

describe("仪表", () => {
  test("provider 报过就用真数,没报过是估的", () => {
    const meter = new ContextMeter(INFO)
    meter.assume(1_000)
    expect(meter.snapshot.estimated).toBe(true)
    expect(meter.snapshot.used).toBe(1_000)

    meter.observe({ input: 5_000, output: 100, reasoning: 0, cache: { read: 2_000, write: 0 } })
    expect(meter.snapshot.estimated).toBe(false)
    // cacheInInput=false 的 provider:input 和 cache 要相加
    expect(meter.snapshot.used).toBe(7_000)
  })

  test("★ 压缩之后那个真数不再成立,drop 之后必须掉回估值", () => {
    const meter = new ContextMeter(INFO)
    meter.observe({ input: 800_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
    meter.assume(12_000)
    expect(meter.snapshot.used).toBe(800_000)
    meter.drop()
    expect(meter.snapshot.used).toBe(12_000)
    expect(meter.snapshot.estimated).toBe(true)
  })

  test("output 不算进占用 —— 它下一轮会以 input 的身份再算一遍", () => {
    const meter = new ContextMeter(INFO)
    meter.observe({ input: 1_000, output: 90_000, reasoning: 0, cache: { read: 0, write: 0 } })
    expect(meter.snapshot.used).toBe(1_000)
  })

  test("★ 换模型:窗口跟着换,而且 provider 报的那个数必须作废", () => {
    const meter = new ContextMeter(INFO)
    meter.observe({ input: 500_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
    meter.assume(9_000)
    expect(meter.snapshot.used).toBe(500_000)

    // 100 万的窗口换成 3 万的
    meter.retarget({ ...INFO, limit: { context: 32_000, output: 8_000 } })
    expect(meter.snapshot.limit).toBe(32_000)
    // 那 50 万是上一个模型的分词器数出来的,拿去除新窗口是两把尺子量同一段话
    expect(meter.snapshot.used).toBe(9_000)
    expect(meter.snapshot.estimated).toBe(true)
  })

  test("换模型不退款 —— 花掉的还是花掉了", () => {
    const meter = new ContextMeter(INFO)
    meter.observe({ input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } })
    meter.retarget({ ...INFO, limit: { context: 32_000, output: 8_000 } })
    expect(meter.snapshot.spent.total).toBe(1_100)
  })
})

// ─────────────────────────────────────────────── 压缩点

describe("压缩点", () => {
  const compacted = (text: string) => message("user", { type: "compact", text, folded: 3, tokensBefore: 100 })

  test("没压过就是从头开始", () => {
    expect(compactionIndex([said("a"), replied("b")])).toBe(0)
  })

  test("★ 压缩点之前的历史不再发给模型", () => {
    const history = [said("很久以前"), replied("嗯"), compacted("到这里为止的交接"), said("接着干")]
    const messages = toLLMMessages(history)
    const flat = JSON.stringify(messages)
    expect(flat).not.toContain("很久以前")
    expect(flat).toContain("到这里为止的交接")
    expect(flat).toContain("接着干")
  })

  test("摘要以 user 的身份进去,而且说清了原文已经没了", () => {
    const messages = toLLMMessages([compacted("摘要正文"), said("继续")])
    expect(messages[0]!.role).toBe("user")
    const text = JSON.stringify(messages[0])
    expect(text).toContain("<session-summary>")
    expect(text).toContain("no longer available")
  })

  test("压过两次只认最后那次 —— 早先那段摘要已经被包进新的里了", () => {
    const history = [compacted("第一次"), said("中间"), compacted("第二次"), said("现在")]
    expect(compactionIndex(history)).toBe(2)
    const flat = JSON.stringify(toLLMMessages(history))
    expect(flat).not.toContain("第一次")
    expect(flat).toContain("第二次")
  })

  test("★ 仪表盘和模型看到的是同一段历史 —— 折叠掉的不许再算进占用", () => {
    const heavy = "x".repeat(40_000)
    const history = [said(heavy), replied(heavy), compacted("短摘要"), said("hi")]
    const report = contextReport({ history, system: [], tools: [], info: INFO })
    expect(report.folded).toBe(2)
    expect(report.messages).toBe(2)
    expect(report.used).toBeLessThan(estimateTokens(heavy))
  })
})

// ─────────────────────────────────────────────── 留一条尾巴

describe("最近几轮原样留着", () => {
  /** 造一段:一条压缩点,keptFrom 指向 history 里那条消息 */
  const withTail = (text: string, keptFrom: string) =>
    message("user", { type: "compact", text, folded: 3, tokensBefore: 100, keptFrom })

  test("★ 摘要在前,留下来的原文跟在后面 —— 它讲的是更早的事", () => {
    const older = said("很久以前")
    const keep = said("最近这句")
    const answer = replied("最近那个回答")
    const mark = withTail("到这里为止的交接", keep.info.id)
    const history = [older, keep, answer, mark]
    const messages = toLLMMessages(history)
    const flat = JSON.stringify(messages)
    expect(flat).not.toContain("很久以前")
    expect(flat).toContain("到这里为止的交接")
    expect(flat).toContain("最近这句")
    // 顺序:摘要第一,原文跟上
    expect(JSON.stringify(messages[0])).toContain("到这里为止的交接")
    expect(JSON.stringify(messages[1])).toContain("最近这句")
  })

  // ★ 连着压两次的时候,第二次的 keptFrom 一定落在第一颗钉子**之前**。
  //   夹在中间的那条 compact 消息会被 userContent 翻成一整段
  //   「以上内容已被下面这份交接摘要取代」发出去 —— 于是模型在一段活生生的
  //   历史中间读到一句"你前面看到的都不作数了",底下跟着一份**已经被现在
  //   这份取代**的旧摘要,而旧的那份还带着一句权威的"原文已经没有了"
  test("★ 留下来那一段里夹着的旧压缩点要剔掉,不能再发一遍", () => {
    const older = said("很久以前")
    const first = message("user", { type: "compact", text: "第一版交接", folded: 2, tokensBefore: 100 })
    const between = said("两次压缩之间说的")
    const second = withTail("第二版交接", first.info.id)
    const flat = JSON.stringify(toLLMMessages([older, first, between, second]))

    expect(flat).toContain("第二版交接")
    expect(flat).toContain("两次压缩之间说的")
    // 旧的那份**一个字都不该出现**
    expect(flat).not.toContain("第一版交接")
    // 那句"以上内容已被取代"也只该出现一次 —— 就是最新那份带的那句
    const notices = flat.split("This session was compacted").length - 1
    expect(notices).toBe(1)
  })

  test("压缩之后新说的话排在最后", () => {
    const keep = said("留住的")
    const mark = withTail("交接", keep.info.id)
    const messages = toLLMMessages([said("老的"), keep, mark, said("压完之后说的")])
    expect(JSON.stringify(messages.at(-1))).toContain("压完之后说的")
  })

  test("老会话没有 keptFrom —— 退回「一条都不留」,而不是猜一个位置", () => {
    const history = [said("老的"), said("也老"), message("user", { type: "compact", text: "交接", folded: 2, tokensBefore: 1 })]
    const flat = JSON.stringify(toLLMMessages(history))
    expect(flat).not.toContain("老的")
    expect(flat).not.toContain("也老")
    expect(flat).toContain("交接")
  })

  test("keptFrom 指着一条已经不在的消息,当作什么都没留 —— 不猜位置", () => {
    const history = [said("老的"), withTail("交接", "不存在的-id")]
    expect(JSON.stringify(toLLMMessages(history))).not.toContain("老的")
  })

  test("★ 仪表盘只把真正折掉的算成折掉 —— 留下来的那几条照旧占着窗口", () => {
    const heavy = "x".repeat(40_000)
    const keep = said(heavy)
    const history = [said(heavy), keep, withTail("短摘要", keep.info.id)]
    const report = contextReport({ history, system: [], tools: [], info: INFO })
    expect(report.folded).toBe(1)
    expect(report.used).toBeGreaterThan(estimateTokens(heavy))
  })
})

describe("尾巴留多长", () => {
  test("历史太短就一条都不留 —— 这次压缩本来也不该发生", () => {
    const live = [said("a"), replied("b")]
    expect(chooseTail(live, 100_000)).toBe(live.length)
  })

  test("★ 刀落在 user 消息上 —— 切在 assistant 和它的工具结果之间就是孤儿结果", () => {
    const live = [
      said("最初"),
      replied("好"),
      ran("bash", { command: "x" }, "out"),
      replied("嗯"),
      said("接着说"),
      ran("read", { filePath: "a.ts" }, "内容"),
      replied("看完了"),
    ]
    const cut = chooseTail(live, 100_000)
    expect(cut).toBeLessThan(live.length)
    expect(live[cut]!.info.role).toBe("user")
  })

  test("★ 尾巴太重就往回收 —— 压缩是在窗口快满时跑的,留着它等于白压", () => {
    const heavy = "y".repeat(200_000)
    const live = [said("最初"), replied("好"), replied("嗯"), replied("哦"), said("接着说"), ran("bash", {}, heavy)]
    expect(chooseTail(live, 20_000)).toBe(live.length)
  })
})

describe("改过的文件由程序钉住", () => {
  const edited = (path: string) =>
    message("assistant", {
      type: "tool",
      callID: `c${path}`,
      tool: "edit",
      state: { status: "completed", input: { filePath: path }, output: "ok", metadata: {}, time: { start: 1, end: 2 } },
    })

  test("★ 模型漏写一个路径不报错,所以这一行不交给它写", () => {
    const out = withFileLedger("GOAL: …", [edited("src/a.ts"), edited("src/b.ts"), edited("src/a.ts")])
    expect(out).toContain("GOAL: …")
    expect(out).toContain("src/a.ts")
    expect(out).toContain("src/b.ts")
    // 去重:同一个文件改三次还是一个文件
    expect(out.split("src/a.ts").length - 1).toBe(1)
  })

  test("一个文件都没动过就不加这一段", () => {
    expect(withFileLedger("GOAL: …", [said("聊聊"), replied("好")])).toBe("GOAL: …")
  })

  test("失败的那次不算 —— 那是「试过」,不是「改过」", () => {
    const failed = message("assistant", {
      type: "tool",
      callID: "cf",
      tool: "write",
      state: { status: "error", input: { filePath: "src/nope.ts" }, error: "EACCES", metadata: {}, time: { start: 1, end: 2 } },
    })
    expect(withFileLedger("GOAL: …", [failed])).toBe("GOAL: …")
  })
})

describe("压缩点不是一句待答的话", () => {
  /** 一问一答,而且答的正是这一问 */
  function answered(text: string): MessageWithParts[] {
    const user = said(text)
    const reply = replied("好")
    if (reply.info.role === "assistant") {
      reply.info.parentID = user.info.id
      reply.info.timeCompleted = 2
    }
    return [user, reply]
  }

  test("★ 压完不该再自己转一轮 —— 那一轮的输入是「一份摘要,外加没有问题」", () => {
    const history = answered("改一下 live.ts")
    expect(isSettled(history)).toBe(true)
    history.push(message("user", { type: "compact", text: "交接", folded: 2, tokensBefore: 1 }))
    expect(isSettled(history)).toBe(true)
  })

  test("压缩点后面用户真说了话,那当然要答", () => {
    const history = [
      ...answered("改一下"),
      message("user", { type: "compact", text: "交接", folded: 2, tokensBefore: 1 }),
      said("接着弄"),
    ]
    expect(isSettled(history)).toBe(false)
  })
})

describe("压缩落库", () => {
  test("★ 原文一个字都不删 —— 模型看不见,不等于用户看不见", () => {
    const store = new Store(":memory:")
    store.createSession("s1", "/repo")
    store.upsertMessage({ id: "u1", sessionID: "s1", role: "user", timeCreated: 1 })
    store.upsertPart({
      id: "p1",
      sessionID: "s1",
      messageID: "u1",
      timeCreated: 1,
      type: "text",
      text: "原来那句话",
    })

    applyCompaction(store, "s1", "交接说明", { folded: 1, tokensBefore: 999 })
    const history = store.listAll("s1")
    // 库里两条都在:老的那条 + 压缩点
    expect(history.length).toBe(2)
    expect(JSON.stringify(history[0])).toContain("原来那句话")
    // 但发给模型的只剩压缩点往后
    expect(compactionIndex(history)).toBe(1)
    const flat = JSON.stringify(toLLMMessages(history))
    expect(flat).not.toContain("原来那句话")
    expect(flat).toContain("交接说明")
    store.close()
  })
})

// ─────────────────────────────────────────────── 喂给压缩 agent 的材料

describe("压缩材料", () => {
  test("装得下的时候一条不丢,而且都包在 untrusted-data 里", () => {
    const material = describeSession([said("改一下 live.ts"), ran("read", { filePath: "live.ts" }, "内容"), replied("好了")], 50_000)
    expect(material.dropped).toBe(0)
    expect(material.text).toContain("<untrusted-data>")
    expect(material.text).toContain("改一下 live.ts")
    expect(material.text).toContain("好了")
  })

  test("★ 装不下时丢中间,两头必须留住 —— 开头是要干什么,末尾是现在怎么样", () => {
    const history = [
      said("最初的要求:把渲染器改对"),
      replied("好"),
      ...Array.from({ length: 40 }, (_, i) => ran("bash", { command: `step ${i}` }, "y".repeat(4_000))),
      said("现在卡在哪一步了"),
    ]
    const material = describeSession(history, 4_000)
    expect(material.dropped).toBeGreaterThan(0)
    expect(material.text).toContain("最初的要求")
    expect(material.text).toContain("现在卡在哪一步了")
    // 丢了东西必须说出来,否则模型会把看到的第一条当成会话的开头
    expect(material.text).toContain("did not fit")
  })

  test("上一次压缩留下的交接会原样带进去 —— 它就是这段历史的开头", () => {
    const history = [message("user", { type: "compact", text: "上一版交接", folded: 9, tokensBefore: 1 }), said("接着干")]
    expect(describeSession(history, 50_000).text).toContain("上一版交接")
  })

  test("空会话不发请求", () => {
    expect(describeSession([], 50_000).entries).toBe(0)
  })
})

// ─────────────────────────────────────────────── 压缩 agent

describe("压缩 agent", () => {
  /** 假的 stream:记下请求,吐一段固定文本 */
  function harness(text: string, fail?: Error) {
    const requests: LLMRequest[] = []
    const compact = createCompactor({
      stream(request) {
        requests.push(request)
        return {
          info: INFO,
          events: (async function* (): AsyncGenerator<LLMEvent> {
            if (fail) yield { type: "error", error: fail }
            else for (const chunk of text.split(" ")) yield { type: "text-delta", id: "t", text: chunk + " " }
          })(),
        }
      },
      model: () => ({ providerID: "anthropic", modelID: "test" }),
      language: () => "auto",
      budgetTokens: () => 50_000,
    })
    return { compact, requests }
  }

  const history = [said("修一下折行"), ran("read", { filePath: "a.ts" }, "内容"), replied("改好了")]

  test("★ 压缩请求一个工具都不给 —— 一次跑飞的压缩会在用户最没余地时动他的文件", async () => {
    const { compact, requests } = harness("GOAL: ...")
    await compact(history)
    expect(requests[0]!.tools).toEqual([])
    expect(requests[0]!.activeTools).toEqual([])
    expect(() => requests[0]!.makeToolContext({ callID: "x", abortSignal: new AbortController().signal })).toThrow()
  })

  test("收口:去掉「Here is the summary:」那种开场白", async () => {
    const { compact } = harness("Here is the handoff: GOAL: 修渲染器")
    const result = await compact(history)
    expect(result.text.startsWith("GOAL")).toBe(true)
    expect(result.failed).toBeUndefined()
  })

  test("★ 出错时返回原因,而且 text 是空的 —— 调用方绝不能把空摘要钉进历史", async () => {
    const { compact } = harness("", new Error("429 slow down\nstack..."))
    const result = await compact(history)
    expect(result.text).toBe("")
    expect(result.failed).toContain("429")
  })

  test("用户按 esc:说的是「已中断」,不是「超时」", async () => {
    const controller = new AbortController()
    const { compact } = harness("x")
    controller.abort()
    const result = await compact(history, { signal: controller.signal })
    expect(result.failed).toBe("interrupted")
  })

  test("没历史就不发请求", async () => {
    const { compact, requests } = harness("x")
    const result = await compact([])
    expect(requests.length).toBe(0)
    expect(result.failed).toContain("nothing")
  })

  test("★ 用户点名要保住的东西原样进请求 —— 哪一部分损不起只有他知道", async () => {
    const { compact, requests } = harness("GOAL: …")
    await compact(history, { focus: "那三行 429 报错的原文" })
    expect(JSON.stringify(requests[0]!.messages)).toContain("那三行 429 报错的原文")
  })

  test("不写重点的时候不多塞一段", async () => {
    const { compact, requests } = harness("GOAL: …")
    await compact(history)
    expect(requests[0]!.messages[0]!.content.length).toBe(1)
  })

  test("★ 改过的文件由程序钉进交接说明,不看模型写没写", async () => {
    const edited = message("assistant", {
      type: "tool",
      callID: "ce",
      tool: "edit",
      state: {
        status: "completed",
        input: { filePath: "src/renderer.ts" },
        output: "ok",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    })
    const { compact } = harness("GOAL: 改渲染器")
    const result = await compact([said("改一下"), edited, replied("好了")])
    expect(result.text).toContain("src/renderer.ts")
    expect(result.text).toContain("GOAL: 改渲染器")
  })

  test("留了尾巴时 system 会多一段,而且报出留了几条、从哪条开始", async () => {
    const live = [
      said("最初"),
      replied("好"),
      replied("嗯"),
      replied("哦"),
      said("接着说"),
      replied("看完了"),
    ]
    const { compact, requests } = harness("GOAL: …")
    const result = await compact(live)
    expect(result.kept).toBe(2)
    expect(result.folded).toBe(4)
    expect(result.keptFrom).toBe(live[4]!.info.id)
    expect(JSON.stringify(requests[0]!.system)).toContain("stay in the conversation verbatim")
    // 留下来的那几条不进材料 —— 它们原样跟在摘要后面,再复述一遍是重复
    expect(JSON.stringify(requests[0]!.messages)).not.toContain("接着说")
  })

  test("一条都没留时 system 不多那一段 —— 那句话在没有尾巴时是假的", async () => {
    const { compact, requests } = harness("GOAL: …")
    const result = await compact(history)
    expect(result.kept).toBe(0)
    expect(result.keptFrom).toBeUndefined()
    expect(JSON.stringify(requests[0]!.system)).not.toContain("stay in the conversation verbatim")
  })
})

// ─────────────────────────────────────────────── 画出来

describe("画", () => {
  test("量表两头都画得出来,而且宽度恒定", () => {
    expect(gauge(0, 10)).toBe("░".repeat(10))
    expect(gauge(1, 10)).toBe("▓".repeat(10))
    // 有一点就画一格:一格都没有会让人以为它坏了
    expect(gauge(0.001, 10).startsWith("▓")).toBe(true)
    expect([...gauge(0.37, 10)].length).toBe(10)
  })

  test("★ 渐变条:一格一个颜色,从绿走到红黑,而且**一列都不多占**", () => {
    setColorEnabled(true)
    try {
      const full = gradientGauge(1, 12)
      const codes = [...full.matchAll(/38;5;(\d+)m▓/g)].map((m) => Number(m[1]))
      expect(codes.length).toBe(12)
      // 头是纯绿(46),尾是红黑(88) —— 短条也要走完整条色阶
      expect(codes[0]).toBe(46)
      expect(codes[codes.length - 1]).toBe(88)
      expect(new Set(codes).size).toBeGreaterThan(8)
      // 上了色也还是 12 列
      expect(displayWidth(full)).toBe(12)
      // 没到的那几格不上色 —— 它们是「还没到」,不该有颜色
      const half = gradientGauge(0.5, 12)
      expect([...half.matchAll(/38;5;\d+m▓/g)].length).toBe(6)
      expect(displayWidth(half)).toBe(12)
    } finally {
      setColorEnabled(false)
    }
  })

  test("--no-color / 管道里退回纯字符 —— 转义序列绝不能进管道", () => {
    expect(gradientGauge(0.5, 8)).toBe("▓▓▓▓░░░░")
    expect(rampPaint(0.9)("90%")).toBe("90%")
  })

  test("★ 输入框上沿那条线:加了量表之后**宽度一列都不能变** —— 超一列整个边框就错位", () => {
    // 上色之后再量:note 里全是转义序列,按 length 算的话这条线必然超宽
    setColorEnabled(true)
    try {
      for (const width of [76, 52, 40, 30, 22, 14, 8]) {
        for (const ratio of [0, 0.34, 0.97, 1]) {
          const note = contextRule({ used: ratio * 900_000, budget: 900_000, limit: 1_000_000, ratio, estimated: false, spent: ZERO_SPENT }, Math.max(0, width - 8))
          expect(displayWidth(inputDivider(width, note))).toBe(width)
        }
      }
      expect(displayWidth(inputDivider(40))).toBe(40)
    } finally {
      setColorEnabled(false)
    }
  })

  test("★ 常驻的那条线上不写 token 绝对值 —— 决定只有「压不压」,百分比已经答完了", () => {
    const snapshot = { used: 306_000, budget: 900_000, limit: 1_000_000, ratio: 0.34, estimated: false, spent: ZERO_SPENT }
    for (const room of [40, 22, 6]) {
      expect(contextRule(snapshot, room)).not.toContain("306k")
      expect(contextRule(snapshot, room)).not.toContain("900k")
    }
    // 窄了先缩条,最后只剩百分比;再窄就什么都不画,绝不超宽
    expect(contextRule(snapshot, 40)).toContain("34%")
    expect(contextRule(snapshot, 6)).toBe("34%")
    expect(contextRule(snapshot, 1)).toBe("")
  })

  test("状态行那格:只有百分比,估出来的数带 ~", () => {
    expect(contextChip({ used: 306_000, budget: 900_000, limit: 1_000_000, ratio: 0.34, estimated: false, spent: ZERO_SPENT })).toBe(
      "ctx 34%",
    )
    expect(contextChip({ used: 12_000, budget: 900_000, limit: 1_000_000, ratio: 0.013, estimated: true, spent: ZERO_SPENT })).toBe(
      "ctx ~1%",
    )
  })

  test("报告里每一项都有标签,而且窗口是猜的时候要说出来", () => {
    const report = contextReport({
      history: [said("hi"), ran("bash", { command: "ls" }, "out"), replied("ok")],
      system: ["sys"],
      tools: registerBuiltins(new ToolRegistry()).list(),
      info: INFO,
    })
    const text = renderContextReport(report, "anthropic/test")
    for (const label of ["system prompt", "tool definitions", "tool results", "free"]) {
      expect(text).toContain(label)
    }
    // limitSource=default:这个数是兜底值,必须说明白
    expect(text).toContain("did not report a window size")
    expect(text).toContain("/compact")
  })

  test("一个字都不占的分项不列出来 —— 空行会盖住真正占地方的那几项", () => {
    const report = contextReport({ history: [said("hi")], system: ["sys"], tools: [], info: INFO })
    const text = renderContextReport(report, "anthropic/test")
    expect(text).not.toContain("thinking")
    expect(text).not.toContain("compacted summary")
  })
})

/**
 * 加一个分项忘了给它标签的话,那一行会画成空白而**不报错** —— 报告里凭空
 * 少一项,而总数照旧对得上,没人查得出来。
 */
test("每个分项都有一个不为空的标签", () => {
  for (const key of SLICE_KEYS) {
    expect(sliceLabel(key).length).toBeGreaterThan(0)
  }
})

// ─────────────────────────────────────────────── 模型自己看上下文

describe("★ context 工具", () => {
  const view = (over: Partial<ContextView> = {}): ContextView => ({
    used: 306_000,
    budget: 900_000,
    limit: 1_000_000,
    estimated: false,
    messages: 47,
    folded: 12,
    slices: [
      { key: "system", tokens: 12_000 },
      { key: "result", tokens: 180_000 },
      { key: "memory", tokens: 0 },
      { key: "reply", tokens: 114_000 },
    ],
    ...over,
  })

  const run = (context?: () => ContextView | undefined) =>
    ContextTool.execute(
      {},
      createToolContext(
        {
          cwd: "/tmp",
          root: "/tmp",
          sessionID: "s",
          async ask() {},
          onProgress() {},
          onMetadata() {},
          ...(context ? { context } : {}),
        },
        { messageID: "m", callID: "c", abortSignal: new AbortController().signal },
      ),
    )

  test("报总数、余量、条数,并按占比从大到小列分项", async () => {
    const result = await run(() => view())
    expect(result.output).toContain("306k of 900k used (34%)")
    expect(result.output).toContain("594k free")
    expect(result.output).toContain("47 messages in context, 12 more already folded")
    // 最大的一项排最前 —— 它就是"该砍哪一块"的答案
    const shown = result.output.slice(result.output.indexOf("What is filling it"))
    expect(shown.indexOf("tool results")).toBeLessThan(shown.indexOf("your replies"))
    // 0 的那一项不占地方:一份写着一串 0 的报告要读的人自己找重点
    expect(shown).not.toContain("project memory")
  })

  test("★ 快满了要说出来,而且说清压缩不是它能做的", async () => {
    const result = await run(() => view({ used: 800_000 }))
    expect(result.output).toContain("nearly full")
    expect(result.output).toContain("/compact")
    expect(result.output).toContain("cannot run it yourself")
  })

  test("还很空的时候不催 —— 每次都催等于没催", async () => {
    expect((await run(() => view({ used: 90_000 }))).output).not.toContain("nearly full")
  })

  test("估算和实报要说清是哪一种", async () => {
    expect((await run(() => view({ estimated: true }))).output).toContain("estimated locally")
    expect((await run(() => view())).output).toContain("reported by the provider")
  })

  test("★ 没接上的时候说「这里没有」,而不是报一个空窗口", async () => {
    const result = await run(undefined)
    expect(result.output).toContain("not available")
    expect(result.output).not.toContain("0 of 0")
    expect(result.metadata["available"]).toBe(false)
  })
})

describe("这一场的账", () => {
  const info: ModelInfo = { ...INFO, cacheInInput: true }
  const tk = (input: number, output: number, read = 0) => ({
    input,
    output,
    reasoning: 0,
    cache: { read, write: 0 },
  })

  /**
   * ★ 消息级的 `tokens` 存的是**占用**(processor.ts:`message.tokens =
   *   this.contextTokens`,取最后一个 step),不是账。拿它当账用,一个跑了
   *   三步的 turn 只会被算成最后一步那一份。
   */
  test("★ 从历史重建花费:扫 step-finish part,不看消息级的 tokens", () => {
    const history = [
      {
        // 消息级放一个明显错的数,确保没人图省事去读它
        info: { tokens: tk(999_999, 999_999) },
        parts: [
          { type: "step-finish", tokens: tk(100, 10) },
          { type: "text" },
          { type: "step-finish", tokens: tk(200, 20) },
        ],
      },
      { info: {}, parts: [{ type: "step-finish", tokens: tk(300, 30) }] },
    ]
    const billed = billedFromHistory(history as never)
    expect(billed.input).toBe(600)
    expect(billed.output).toBe(60)
  })

  test("没有 step-finish 就是零 —— 不炸", () => {
    expect(billedFromHistory([{ info: {}, parts: [{ type: "text" }] }] as never).input).toBe(0)
    expect(billedFromHistory([]).input).toBe(0)
  })

  test("★ 接上旧会话时花费要接着算,不是从零起", () => {
    const meter = new ContextMeter(info)
    meter.observe(tk(500, 50))
    meter.resetSpend(billedFromHistory([{ info: {}, parts: [{ type: "step-finish", tokens: tk(1000, 100) }] }] as never))
    expect(meter.spent.input).toBe(1000)
    // 开新会话那条路照旧从零
    meter.resetSpend()
    expect(meter.spent.input).toBe(0)
  })

  /**
   * ★ 子 agent 的账要进总账,但它的**占用**不能顶掉主对话的占用 ——
   *   走错的表现是:派出去一个子 agent,主界面的上下文百分比突然跳到
   *   那个子 agent 的占用上去。
   */
  test("★ bill() 只记账,不动上下文占用", () => {
    const meter = new ContextMeter(info)
    meter.observe(tk(1000, 100))
    expect(meter.real).toBe(1000)

    meter.bill(tk(50_000, 900))
    expect(meter.spent.input).toBe(51_000) // 账加上了
    expect(meter.real).toBe(1000) // 占用没动
  })

  test("observe() 照旧两件事都做", () => {
    const meter = new ContextMeter(info)
    meter.observe(tk(1000, 100))
    meter.observe(tk(1800, 200))
    expect(meter.real).toBe(1800) // 占用取最新
    expect(meter.spent.input).toBe(2800) // 花费累加
  })
})
