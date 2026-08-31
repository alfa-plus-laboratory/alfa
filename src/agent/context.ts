/**
 * 上下文占用:现在装了多少,分别是谁占的。
 *
 * ── 为什么要自己估,而不是只报 provider 给的数 ──
 * provider 只给一个总数(input + cache),而用户问的是**「谁把窗口吃满了」**。
 * 那个问题只有本地能答:一条 tool result 有多长、一段思考有多长,只有历史
 * 本身知道。所以这里做两件事:按本地估算切出各部分的占比,再把总数对齐到
 * provider 报的那个数上(见 scale)。给出来的分项永远和标题上的总数自洽 ——
 * 一份加起来对不上总数的明细,读的人只会两个数都不信。
 *
 * ── 估算法则:宁可粗,不可假精确 ──
 * 不装分词器。真正的 tokenizer 要按模型换表,而这里的用途是「还剩多少地方」,
 * 差 10% 不改变任何决定。规则只有两条:方块字约 1 个字一个 token,其余按
 * 3.6 个字符一个 token。每条消息再加一点结构开销 —— 消息的封装、角色名、
 * tool_use 的 id 都是真实要花钱的位置。
 *
 * ── 数的是**下一次请求**要发的东西 ──
 * 压缩点之前的历史留在库里,但不会再发给模型(见 to-model-messages.ts)。
 * 所以这里从压缩点开始数:一个把已经被折叠掉的历史算进去的仪表盘,压缩完
 * 之后会纹丝不动,而那正是用户最需要它动的时刻。
 */
import { z } from "zod"
import type { ModelInfo, Tokens } from "../llm/types.ts"
import type { MessageWithParts } from "../session/schema.ts"
import type { ToolDef } from "../tool/types.ts"
import { isMcpTool } from "../mcp/tools.ts"
import { accumulateBilled, contextTokens, emptyTokens, safe, usable } from "./tokens.ts"
import { liveHistory, loopStartIndex } from "./to-model-messages.ts"

/**
 * 一条消息的结构开销。
 *
 * 角色名、分隔符、content 数组的包装 —— 每条都要花,而一场长会话里消息条数
 * 是几百的量级,忽略它整份估算会系统性偏低。
 */
const PER_MESSAGE = 4
/** 一次工具调用额外的壳:callID、工具名、JSON 的括号和引号 */
const PER_TOOL_CALL = 10
/** 一条工具定义的壳:名字、schema 的外层包装 */
const PER_TOOL_DEF = 12

/**
 * `skill` 工具的 id。
 *
 * 写死一个字符串而不是 import 那个工具:这条路上每轮都要走一遍,不该为一个
 * 常量把 prompt/skills.ts 那一串(fs、配置路径解析)拖进计量模块。对不对得上
 * 由测试盯着(test/context.test.ts 里那条 `expect(SkillTool.id)`)。
 */
const SKILL_TOOL = "skill"

/** 分项。顺序就是显示顺序 —— 从「一直都在」到「越聊越多」 */
// memory 紧跟着 summary:两者都是「装进来的背景」,不是这一场里产生的东西。
// 它一度混在 system 那一栏里 —— 而这份报告要回答的正是「砍哪一块」,一块
// 砍不动的(system)和一块删几个文件就没了的(memory)混在一起,答案就错了
// ★ env 和 handoff 是**从 user 那一栏里拆出来的**。
//
//   这三样在库里长得一模一样:都是 role 为 user 的消息上的 text part。而它们
//   里头只有一样是用户敲的 —— 另外两样一个是开场挂上去的仓库快照,一个是程序
//   塞回去的材料(子 agent 交回来的报告、收口检查的回执)。合在一栏里的后果,
//   在 agentflow 下会直接把这份报告变成废纸:十几个子 agent 各交一份三百字的
//   报告,仪表盘上写着「你说的话 120k」,而用户一共敲了两句。
//
//   分栏的判据和这份报告存在的理由是同一条(见 SLICE_KEYS 上面那段):一块
//   砍不动的和一块「让它们把报告交给下家而不是交给我」就能消掉的,混在一起
//   答案就错了。
export const SLICE_KEYS = [
  "system",
  "tools",
  // 别人家的工具单独一栏:它是**每轮都发**的固定开销,而它是用户唯一能一键
  // 关掉的那种(/mcp 里看得见谁装了几个)。混在 tools 里的话,一个吐三十个
  // 工具的 server 看起来就和我们自己的十五个内建工具一样不可动
  "mcp",
  // skills:目录(每轮都发)**加上**这一场已经打开的那几份正文。两半合在一栏,
  // 因为用户问的是"skills 一共花了我多少" —— 只数目录的话,恰好把贵的那一半
  // (一份正文是一行目录的二十倍)藏进 result 里,而那正是这套设计成不成立的凭据
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
  /** 现在占了多少 */
  used: number
  /** 这个数是本地估的(provider 还没报过,或者报的那个已经不作数了) */
  estimated: boolean
  /** 模型的上下文窗口 */
  limit: number
  /** 算作 100% 的那条线。见 tokens.usable —— 它比 limit 小,压缩和输出要留地方 */
  budget: number
  /** used / budget,封顶 1 */
  ratio: number
  /** budget 减掉已用,负数按 0 */
  free: number
  slices: ContextSlice[]
  /** 会发给模型的消息条数 */
  messages: number
  /** 被压缩折叠掉、不再发给模型的消息条数 */
  folded: number
  /** 窗口大小是哪来的。见 ModelInfo.limitSource */
  limitSource: NonNullable<ModelInfo["limitSource"]>
  /**
   * 这一趟累计花掉的。**和上面所有数都不是一回事** —— 那些讲窗口里装着什么,
   * 这个讲一共发出去过多少,只增不减,而且远大于窗口(每轮重发整段历史)。
   */
  spent: { total: number; input: number; output: number; cached: number }
}

export interface ContextInput {
  history: MessageWithParts[]
  /** 这一轮实际会发的 system。现取 —— 它每轮重新组装 */
  system: string[]
  tools: ToolDef<any>[]
  /**
   * system 里 skills **目录**那一段的原文(见 prompt/skills.ts)。
   *
   * 传进来是为了把它从 system 那一栏里分出来 —— 它回答的是"多加一份 skill 值多少钱",
   * 而 system 那个数是砍不动的。不传就是这条路上没有 skills,一切照旧。
   */
  skills?: string
  info: ModelInfo
  /**
   * provider 报的占用(已经过 contextTokens 折算)。
   *
   * 有它就以它为准,本地估算只用来切分项 —— 它是唯一一个**真数**,
   * 而分项本来就只是比例问题。
   */
  reported?: number
  /** 这一趟累计花掉的(ContextMeter.spent)。不给就当零 */
  spent?: Tokens
}

// ─────────────────────────────────────────────── 估算

/**
 * 一段文本大概几个 token。
 *
 * 方块字(汉字、假名、谚文)一个字约一个 token,拉丁文约 3.6 个字符一个。
 * 这两个系数是拿常见 BPE 词表的经验值,不精确到个位,但足够回答「还剩多少」。
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

/** 方块字:一个字就是一个(有时不止一个)token,不能按字符数除。 */
function isIdeograph(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // 平假名 / 片假名
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // 基本区
    (code >= 0xac00 && code <= 0xd7af) || // 谚文
    (code >= 0xf900 && code <= 0xfaff) || // 兼容表意
    (code >= 0x20000 && code <= 0x2ebef) // 扩展 B–F
  )
}

/**
 * 工具定义占多少。
 *
 * schema 只跟代码走、不跟会话走,所以按 id 缓存 —— 每次开仪表盘都重新生成
 * 一遍 JSON Schema 是白花的功夫。说明文字**不缓存**:bash 的说明是惰性函数,
 * 会随 shell 和上限常量变。
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
 * 参数 schema 的大小。
 *
 * 转不出 JSON Schema 的(带 transform / refine 的 zod)给一个保守的常数 ——
 * 这一项估歪了只是那一栏的数字偏一点,而抛异常会让整个 `/context` 打不开。
 */
function schemaTokens(tool: ToolDef<any>): number {
  try {
    return estimateTokens(JSON.stringify(z.toJSONSchema(tool.parameters as never)))
  } catch {
    return 120
  }
}

// ─────────────────────────────────────────────── 分项

/**
 * 把会发给模型的那段历史切成分项。
 *
 * ⚠ 发哪几条由 liveHistory 说了算,和 toLLMMessages 是同一个函数 ——
 * 两边各写一遍判断的话,迟早出现「仪表盘说满了,而模型其实只收到一半」。
 * 思考那条线同理,用的是同一个 loopStartIndex:只有这一趟工具循环里的思考
 * 会发出去,之前的早就丢了(见 to-model-messages.ts)。一度是无条件全算的,
 * 于是仪表盘上挂着一大栏根本没发出去的 thinking。
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
    // 整条都是合成的 = 程序塞回去的材料,不是用户说的话(见 SLICE_KEYS 上那段)。
    // 判据是「这条里有没有一句真人敲的」—— 仓库快照挂在**用户那条真消息**上,
    // 而报告和检查回执自己独占一条
    const injected =
      entry.info.role === "user" &&
      !entry.parts.some((part) => part.type === "text" && !part.synthetic && part.text.length > 0)
    const own: SliceKey = entry.info.role === "user" ? (injected ? "handoff" : "user") : "reply"
    // 消息本身的壳算在它自己那一栏上:分项加起来必须等于总数,不能有一笔挂在账外
    add(own, PER_MESSAGE)
    for (const part of entry.parts) {
      switch (part.type) {
        case "text":
          // 真人那条消息上还挂着开场的仓库快照(见 loop.ts 的 attachGitContext)
          add(part.synthetic && !injected ? "env" : own, estimateTokens(part.text))
          break
        case "compact":
          add("summary", estimateTokens(part.text))
          break
        case "memory":
          add("memory", estimateTokens(part.text))
          break
        case "reasoning":
          // 这一趟循环之外的思考根本不会发出去,算进来就是虚报
          if (index > loopStart) add("thinking", estimateTokens(part.text))
          break
        case "tool": {
          const state = part.state
          if (state.status === "pending") break // 整条丢弃,不进模型
          add("call", estimateTokens(json(state.input)) + PER_TOOL_CALL + estimateTokens(part.tool))
          const output = state.status === "completed" ? state.output : state.status === "error" ? state.error : ""
          // ★ 打开的那份 skill 算到 skills 头上,不算 result。
          //
          //   它长得像工具输出,但它不是:`read` 吐的是用户要看的那个文件,是**活儿**;
          //   一份 skill 的正文是**提示词**——模型拿它改自己接下来怎么做,而且它在这一轮
          //   剩下的时间里一直躺在窗口里。按来源归类的话它离 system 比离 result 近。
          //
          //   更要紧的是这一栏要回答的问题:skills 这套设计的全部卖点是"目录便宜、
          //   正文按需",而一栏只数目录的 skills 恰好把**验证这句话的那个数**藏进了
          //   result 里。看得见"四份目录 262 token、开过两份花了 2.4k",这个取舍才成立。
          add(part.tool === SKILL_TOOL ? "skills" : "result", estimateTokens(output) + PER_TOOL_CALL)
          break
        }
        default:
          // step-start / step-finish / file 不进模型上下文
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

// ─────────────────────────────────────────────── 报告

export function contextReport(input: ContextInput): ContextReport {
  const { slices, messages } = sliceHistory(input.history)
  const system = input.system.reduce((sum, part) => sum + estimateTokens(part), 0)
  /**
   * ★ 分出来的都要从原来那栏里**减掉**。
   *
   * 这份报告的总数是拿来和窗口比的,而分项的和必须等于它 —— 一栏算两遍的后果不是
   * 数字难看,是它开始骗人:用户照着一个虚高的 system 去砍东西,砍完发现没变。
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
   * 分项对齐到总数。
   *
   * provider 报的那个数才是真的,而分项是估的 —— 不缩放的话,标题写着 306k、
   * 底下几行加起来 270k,读的人会开始怀疑两个数都是编的。误差按比例摊到各项上,
   * 因为估算的偏差本来就是全局性的(系数偏了),不是某一项特别歪。
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

// ─────────────────────────────────────────────── 仪表

export interface ContextSnapshot {
  used: number
  budget: number
  limit: number
  ratio: number
  estimated: boolean
  /**
   * 这一趟**累计烧掉**多少 token(见 ContextMeter.spent)。
   *
   * 和 used 是两个完全不同的数,别混:used 是「现在窗口里装着多少」,它会因为
   * 压缩掉下来;spent 是「一共发出去过多少」,它只增不减。一场聊了二十轮、
   * 窗口占用 300k 的会话,spent 轻松是 6M —— 因为每一轮都把整段历史重发了一遍。
   *
   * 进出分开,因为**它们的单价差一个数量级**:in 是每轮重发历史堆出来的
   * (缓存命中还更便宜),out 是模型真写出来的字。只报一个总数的话,
   * 「4.4M」既可能是很便宜的一场,也可能是很贵的一场。
   */
  spent: { total: number; input: number; output: number }
}

/**
 * 状态行上那个数的来源。
 *
 * ── 为什么要一个对象,不是每帧现算 ──
 * 状态行每 50ms 画一次,而算一次占用要扫全量历史。现算的话,一场大会话每秒
 * 要扫二十遍库 —— 而这个数**一轮才变一次**。所以由 main 在轮次边界喂进来,
 * 界面只管读。
 *
 * ── reported 和 estimate 两个数 ──
 * provider 报的那个是真数,但它只在请求发出去之后才有;开局、压缩完、换会话
 * 之后手里只有本地估的。两个都存着,取真数优先,并把「这是估的」显示出来 ——
 * 一个不说自己是估的估数,和一个假数没有区别。
 */
export class ContextMeter {
  private reported: number | undefined
  private estimate = 0
  private billed: Tokens = emptyTokens()

  constructor(private info: ModelInfo) {}

  /**
   * 换模型了。窗口大小、缓存口径(见 ModelInfo.cacheInInput)全跟着换。
   *
   * ★ 顺手把 provider 报的那个数扔掉。它是**上一个模型的分词器**数出来的,
   *   拿去除新模型的窗口是在拿两把尺子量同一段话 —— 20 万换 3 万的时候,
   *   那一格会显示成"还很空",而下一轮请求直接超限。
   */
  retarget(info: ModelInfo): void {
    this.info = info
    this.reported = undefined
  }

  /** provider 报了一次(step 结束)。占用取最新的那次,花费累加。 */
  observe(tokens: Tokens): void {
    const used = contextTokens(tokens, this.info)
    if (used > 0) this.reported = used
    // ⚠ 花费必须**累加**,占用必须**取最新** —— 这两个口径反过来用是这个模块
    //   最容易犯的错:累加占用会让一个十步的 turn 被算成十倍(压缩会在完全没
    //   必要的时候触发),而只取最新的花费永远只报最后一步,那个数没有意义
    this.billed = accumulateBilled(this.billed, tokens)
  }

  /**
   * 只记账,不碰占用。
   *
   * ★ 子 agent 的账走这条,**不能走 observe()** —— observe 会顺手把 `reported`
   *   更新成传进来的那个数,而子 agent 的上下文是它自己那一份,和主对话没有
   *   关系。走错了的表现是:派出去一个子 agent,主界面的上下文百分比突然
   *   跳到那个子 agent 的占用上去。
   */
  bill(tokens: Tokens): void {
    this.billed = accumulateBilled(this.billed, tokens)
  }

  /** 这一趟累计花掉的。分项留着 —— `/context` 要把 in/out/缓存拆开说 */
  get spent(): Tokens {
    return this.billed
  }

  /**
   * 换了一场会话,花费重新起算。
   *
   * ★ **压缩不清它** —— 那些 token 是真花掉了,压缩不退款。一个会因为压缩而
   *   变小的「已花费」,是这一行里唯一会骗人的读法。
   *
   * @param seed 接上一场旧会话时,把它已经花掉的喂回来(见 tokens.ts 的
   *   billedFromHistory)。不给就是从零起 —— 那是开新会话该有的样子。
   *   不喂的话,`--continue` 回来一场跑了半天的会话,账面显示花了 0。
   */
  resetSpend(seed?: Tokens): void {
    this.billed = seed ?? emptyTokens()
  }

  /** 本地估了一次。 */
  assume(estimate: number): void {
    this.estimate = Math.max(0, estimate)
  }

  /**
   * 报上来的那个数不再成立 —— 压缩、清空、换会话。
   *
   * 不清的话,压缩完仪表盘还停在压缩前的位置,而那正是用户盯着它看的那一刻。
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
 * 累计花费的总数。
 *
 * 缓存命中按 provider 的口径归位(见 ModelInfo.cacheInInput)—— 它是 input 的
 * 一部分,不是额外的一笔。**便宜不等于没花**:缓存读进去的 token 照样占窗口、
 * 照样计费(只是便宜),漏掉它这个数会比账单小一大截。
 */
export function spentTotal(tokens: Tokens | undefined, info?: Pick<ModelInfo, "cacheInInput">): number {
  return contextTokens(tokens, info) + safe(tokens?.output)
}
