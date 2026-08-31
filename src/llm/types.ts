/**
 * ★ LLM 接入边界。
 *
 * 这个文件**不许** import "ai" 或 "@ai-sdk/*" —— 它是 src/agent 唯一认识的
 * LLM 词汇表。SDK 的类型只能出现在 src/llm 的其它文件里。
 *
 * ── 为什么事件要自己命名而不是透传 SDK 的 ──
 * 最大的返工风险是把抽象层做成透传层。如果 LLMEvent 直接照抄 AI SDK 的
 * fullStream part 形状,那么:
 *   - 接自有 provider(将来的记忆层/计费网关)时形状对不上;
 *   - AI SDK 升个大版本改了事件名,下游全线塌方(我们已经从 v6 跳到 v7 了)。
 * 所以:自己的命名、自己的字段,连 text/reasoning 的 id 都由我们兜底生成,
 * 不依赖 provider 给。
 */
import type { ToolContext, ToolDef } from "../tool/types.ts"

// ─────────────────────────────────────────────── 模型标识

export interface ModelRef {
  providerID: string
  modelID: string
}

/**
 * 模型元数据查不到时的窗口默认值。
 *
 * ── 为什么是 100 万而不是一个保守的小数 ──
 * 这个默认值只在「我们不认识这个模型」时生效,而现在不认识的模型基本都是新的
 * ——新的模型窗口只会更大。默认给小了的代价是天天看着一个假的 87%,还会被
 * 无谓地劝去压缩;默认给大了的代价是撞到真上限时才发现,而那条路上有 provider
 * 的报错兜着(见 ContextOverflowError)。前者每天都疼,后者是一次性的。
 *
 * 知道自己模型窗口多大的人,在 config.json 里写 providers.<id>.limit 压过它,
 * `/context` 会写明这个数是**认识的**还是**猜的**。
 */
export const DEFAULT_CONTEXT_LIMIT = 1_000_000

export interface ModelInfo {
  ref: ModelRef
  /** 上下文与输出预算。拿不到就给默认值,见 DEFAULT_CONTEXT_LIMIT。 */
  limit: { context: number; output: number }
  /**
   * 上面那个 limit 是哪来的:模型自己的元数据 / 用户在配置里写的 / 兜底默认值。
   *
   * 只用来在 `/context` 里说一句实话。一个把猜出来的窗口画成进度条的仪表盘,
   * 比没有仪表盘更容易让人做错决定。
   */
  limitSource?: "model" | "config" | "default"
  supportsThinking: boolean
  /** 选 system prompt 模板用 */
  promptTemplate: "anthropic" | "default"
  /**
   * 交到**我们手里**的 input token 里,是否已经包含缓存命中的部分。
   *
   * ★ 判的是 AI SDK 交出来的那个数,**不是 provider 原始 API 的口径**。
   *   这两者可以不一样,而分不清正是这个字段唯一会填错的地方:
   *
   *     Anthropic 原始 API 把 input_tokens 和 cache_read_input_tokens 分开报,
   *     照着文档填就是 false —— 曾经就是这么填的,错的。@ai-sdk/anthropic 的
   *     convertAnthropicUsage 已经先加过一遍(inputTokens.total = input_tokens
   *     + cache_creation + cache_read),ai 核心取的就是 .total。到这里已经含了。
   *
   *   所以填之前去看 SDK 那一层怎么算,别看 provider 文档怎么写。
   *
   * 这两种口径无法从数字本身分辨,猜错就是成倍的误差:当成不含而实际含,
   * 上下文用量会被算成两倍,压缩在半程就触发。所以让 provider 显式声明 ——
   * 新写 provider 的人必须停下来想一想这件事。
   */
  cacheInInput: boolean
}

export interface Tokens {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
  total?: number
}

// ─────────────────────────────────────────────── 请求

/** 与 SDK 无关的消息形态。agent 层组装它,llm 层负责翻译。 */
export type LLMMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: LLMContent[] }
  | { role: "assistant"; content: LLMContent[] }
  | { role: "tool"; content: LLMToolResult[] }

export type LLMContent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; signature?: string }
  | { type: "tool-call"; callID: string; tool: string; input: unknown }
  | { type: "file"; mediaType: string; data: string }

export interface LLMToolResult {
  callID: string
  tool: string
  output: string
  isError?: boolean
}

export interface LLMRequest {
  model: ModelRef
  /** 会被拼成恰好两条 system message(为了 prompt cache 前缀稳定) */
  system: string[]
  messages: LLMMessage[]
  /**
   * 本轮可用的工具。带 execute —— 工具由 LLM 层在同一个 step 内执行,
   * 主循环负责的是「要不要再来一轮」,不是「这个工具怎么跑」。
   *
   * ToolDef 本身是 SDK 无关的(src/tool/types.ts),所以这里不破边界。
   */
  tools: ToolDef<any>[]
  /** 为某次工具调用构造上下文。由 agent 层注入,LLM 层只负责在对的时机调它。 */
  makeToolContext(call: { callID: string; abortSignal: AbortSignal }): ToolContext
  /** 本轮允许调用的工具子集。空数组 = 禁止调用工具。undefined = 全部。 */
  activeTools?: string[]
  thinking?: boolean
  abortSignal: AbortSignal
}

// ─────────────────────────────────────────────── 流事件

export type LLMEvent =
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; text: string }
  | { type: "text-end"; id: string }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; text: string }
  | { type: "reasoning-end"; id: string; signature?: string }
  /** 模型开始吐这个工具调用的参数(此时参数还没齐) */
  | { type: "tool-input-start"; callID: string; tool: string }
  /** 参数齐了,工具即将执行 */
  | { type: "tool-call"; callID: string; tool: string; input: unknown }
  | { type: "tool-result"; callID: string; tool: string; output: string }
  | { type: "tool-error"; callID: string; tool: string; error: string }
  | { type: "step-start" }
  | { type: "step-finish"; finishReason: string; tokens: Tokens }
  | { type: "error"; error: Error }

/**
 * 一条流。
 *
 * 主循环只认这个接口,不认 streamText —— 于是 loop.ts 可以拿假事件序列测,
 * 也可以在将来换成自有网关而一行不改。真实实现见 llm/stream.ts 与 llm/retry.ts。
 */
export interface LLMStreamHandle {
  info: ModelInfo
  events: AsyncIterable<LLMEvent>
}

export type LLMStreamFn = (request: LLMRequest) => LLMStreamHandle

// ─────────────────────────────────────────────── 错误

export class ContextOverflowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ContextOverflowError"
  }
}

export class NoCredentialsError extends Error {
  constructor(providerID: string, hint: string) {
    super(`No credentials for provider "${providerID}": ${hint}`)
    this.name = "NoCredentialsError"
  }
}

export class UnknownModelError extends Error {
  constructor(spec: string, known: string[]) {
    super(`Unknown model "${spec}". Known providers: ${known.join(", ") || "(none registered)"}`)
    this.name = "UnknownModelError"
  }
}
