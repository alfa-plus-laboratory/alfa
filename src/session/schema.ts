/**
 * 会话数据模型:message / part 两级。
 *
 * 为什么是两级而不是一条 message 存一坨 content:
 * 主循环每轮要回答「这轮答完没」,判据是「最后一条 assistant 的 finish 是什么」
 * 加上「它下面还有没有没收尾的 tool part」。part 必须能独立寻址、独立推进状态,
 * 否则流式落库和中断收尾都没地方落。
 *
 * M1 只用 6 种 part。压缩/快照/子任务那几种(compaction / snapshot / patch /
 * subtask / retry)不定义,但 DDL 的 type 列是自由文本,以后加不用迁移。
 */
import { z } from "zod"

// ─────────────────────────────────────────────────────────── 通用

export const TokensSchema = z.object({
  input: z.number().default(0),
  output: z.number().default(0),
  reasoning: z.number().default(0),
  cache: z
    .object({
      read: z.number().default(0),
      write: z.number().default(0),
    })
    .default({ read: 0, write: 0 }),
  /** provider 给的总数。有就用,没有就 input+output+cache 自己加。 */
  total: z.number().optional(),
})
export type Tokens = z.infer<typeof TokensSchema>

export const ModelRefSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
})
export type ModelRef = z.infer<typeof ModelRefSchema>

// ─────────────────────────────────────────────────────────── Part

const partBase = {
  id: z.string(),
  sessionID: z.string(),
  messageID: z.string(),
  /** 事件发生时间,不是 message 创建时间。排序用。 */
  timeCreated: z.number(),
}

export const TextPartSchema = z.object({
  ...partBase,
  type: z.literal("text"),
  text: z.string(),
  /** 合成注入的文本(环境块、提醒),不是模型产出,UI 不渲染。 */
  synthetic: z.boolean().optional(),
  time: z.object({ start: z.number(), end: z.number().optional() }).optional(),
})

export const ReasoningPartSchema = z.object({
  ...partBase,
  type: z.literal("reasoning"),
  text: z.string(),
  /**
   * Anthropic 的 thinking 签名。回灌历史时必须原样带回去,否则 400。
   * 换模型时要丢弃 —— 别的 provider 不认。
   */
  signature: z.string().optional(),
  time: z.object({ start: z.number(), end: z.number().optional() }).optional(),
})

export const ToolStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.literal("running"),
    input: z.unknown(),
    title: z.string().optional(),
    time: z.object({ start: z.number() }),
  }),
  z.object({
    status: z.literal("completed"),
    input: z.unknown(),
    output: z.string(),
    title: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    time: z.object({ start: z.number(), end: z.number() }),
  }),
  z.object({
    status: z.literal("error"),
    input: z.unknown().optional(),
    error: z.string(),
    /** interrupted=true 表示是被 Ctrl-C 收尾的,不是工具自己失败。 */
    metadata: z.record(z.string(), z.unknown()).default({}),
    time: z.object({ start: z.number(), end: z.number() }),
  }),
])
export type ToolState = z.infer<typeof ToolStateSchema>

export const ToolPartSchema = z.object({
  ...partBase,
  type: z.literal("tool"),
  /** provider 给的 toolCallId,回灌时用它配对 tool_result。 */
  callID: z.string(),
  tool: z.string(),
  state: ToolStateSchema,
})

export const StepStartPartSchema = z.object({
  ...partBase,
  type: z.literal("step-start"),
})

export const StepFinishPartSchema = z.object({
  ...partBase,
  type: z.literal("step-finish"),
  finishReason: z.string(),
  tokens: TokensSchema,
  cost: z.number().default(0),
})

export const FilePartSchema = z.object({
  ...partBase,
  type: z.literal("file"),
  mediaType: z.string(),
  filename: z.string().optional(),
  url: z.string(),
})

/**
 * 压缩点。`/compact` 落下的那颗钉子。
 *
 * ★ 它是**分界线,不是一条消息**。它前面的历史一条都不删 —— 照旧躺在库里、
 *   照旧能被 `/resume` 重放出来 —— 但从它往前的东西不再发给模型,取而代之的
 *   是 text 里这段摘要(见 to-model-messages.ts 的 compactionIndex)。
 *
 * 删历史和不发历史差着一整个数量级:前者不可逆,而用户按 `/compact` 要的从来
 * 不是"把刚才那半小时销毁"。
 */
export const CompactPartSchema = z.object({
  ...partBase,
  type: z.literal("compact"),
  /** 交接摘要。它会以 user 消息的身份成为新历史的第一句 */
  text: z.string(),
  /** 折叠掉了几条消息。重放时那条分界线上写的就是它 */
  folded: z.number().default(0),
  /**
   * 原样留下来的那一段**从哪条消息开始**(消息 id)。
   *
   * ── 为什么摘要之后还要留一段原文 ──
   * 交接说明是散文,而刚刚发生的那几轮里有的是散文复述不出来的东西:报错的
   * 原文、命令的确切写法、用户上一句话的措辞。压缩恰恰最常发生在活儿干到一半
   * 的时候,而那一半的细节是最贵的。所以最近那几轮**一个字不动地跟在摘要后面**,
   * 被折掉的只有更早的部分。
   *
   * 存**消息 id 不是下标**:下标会随着历史增长而漂,而这颗钉子要一直成立。
   * 老会话里没有这一列(压缩过但那时还不留尾巴),那就是"什么都不留" ——
   * 正好是它当初的行为。
   */
  keptFrom: z.string().optional(),
  /**
   * 折叠前占了多少 token。
   *
   * 压缩是有损的,而**有损的操作要留下自己的账**:隔几天回头看"这场会话
   * 是在什么情况下被压的",这个数是唯一的答案。它不参与任何计算。
   */
  tokensBefore: z.number().default(0),
})

/**
 * 项目记忆。新会话第一句话之前挂上去的那一份。
 *
 * ── 为什么它是 part 而不是 system prompt 里的一段 ──
 * 三个理由,每个都单独成立:
 *   1. **它要能被单独算账**。混进 system 那一坨里,`/context` 只会显示
 *      「system 12k」—— 而用户看那份报告时要决定的正是「砍哪一块」。
 *   2. **它是一次性的事实,不是每轮的指令**。system prompt 每轮重发,
 *      而记忆装进来一次就够了 —— 之后它自己写的、删的,tool result 里都有。
 *   3. **写它的是工具,不是 prompt**。见 tool/memory.ts:增删由模型显式调用,
 *      于是「它记住了什么」在对话里有一条看得见的记录,而不是某一轮之后
 *      system prompt 悄悄变长了一截。
 *
 * 和 text part 一样以 user 消息的身份进模型(它是背景交代),但界面不渲染 ——
 * 那不是用户说的话。
 */
export const MemoryPartSchema = z.object({
  ...partBase,
  type: z.literal("memory"),
  /** 拼好的那段文本,直接进模型 */
  text: z.string(),
  /** 装了几条。给 `/context` 那一行写 `memory 3 notes` */
  notes: z.number().default(0),
})

export const PartSchema = z.discriminatedUnion("type", [
  TextPartSchema,
  ReasoningPartSchema,
  ToolPartSchema,
  StepStartPartSchema,
  StepFinishPartSchema,
  FilePartSchema,
  CompactPartSchema,
  MemoryPartSchema,
])
export type Part = z.infer<typeof PartSchema>
export type TextPart = z.infer<typeof TextPartSchema>
export type ReasoningPart = z.infer<typeof ReasoningPartSchema>
export type ToolPart = z.infer<typeof ToolPartSchema>
export type StepFinishPart = z.infer<typeof StepFinishPartSchema>
export type CompactPart = z.infer<typeof CompactPartSchema>
export type MemoryPart = z.infer<typeof MemoryPartSchema>

// ─────────────────────────────────────────────────────────── Message

export const UserMessageSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  role: z.literal("user"),
  timeCreated: z.number(),
})

export const AssistantMessageSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  role: z.literal("assistant"),
  /**
   * 指向触发它的那条 user message。
   *
   * 这是主循环判定「这轮答完没」的关键:只有当最后一条 assistant 的 parentID
   * 等于最后一条 user 的 id 时,才说明它回答的是当前这一轮 —— 否则说明用户
   * 中途又发了新消息,得继续跑。
   */
  parentID: z.string(),
  providerID: z.string(),
  modelID: z.string(),
  /** 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'error' | 'other' */
  finish: z.string().optional(),
  error: z.object({ name: z.string(), message: z.string() }).optional(),
  cost: z.number().default(0),
  tokens: TokensSchema.optional(),
  timeCreated: z.number(),
  timeCompleted: z.number().optional(),
})

export const MessageSchema = z.discriminatedUnion("role", [UserMessageSchema, AssistantMessageSchema])
export type Message = z.infer<typeof MessageSchema>
export type UserMessage = z.infer<typeof UserMessageSchema>
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>

/** 历史的容器形态:一条 message 带它全部的 part。 */
export interface MessageWithParts {
  info: Message
  parts: Part[]
}
