/**
 * 唯一调用 streamText 的地方。
 *
 * 职责只有两件:
 *   1. 把 LLMRequest 翻成 SDK 参数(严格限定传哪些,别把 SDK 的全部能力漏给上层)
 *   2. 把 fullStream 归一化成我们自己的 LLMEvent
 *
 * ── 几个刻意的选择 ──
 * - `maxRetries: 0`:SDK 的重试没有 UI 反馈、不区分错误类型、也不认
 *   retry-after。我们在 retry.ts 里自己做,包在整条流外面。
 * - 不传 `stopWhen`:AI SDK 默认单 step。多轮由主循环控制 —— 压缩、最大轮数、
 *   权限阻断、重读历史都要在轮与轮之间发生,交给 SDK 就拿不回控制权了。
 * - text / reasoning 的 id 由我们兜底生成:有些兼容端点根本不给 id,
 *   依赖它会让 part 全部串成一条。
 */
import { jsonSchema, streamText, tool, type ModelMessage, type TextStreamPart, type ToolSet } from "ai"
import { adaptTools } from "./adapt-tools.ts"
import type { LLMRegistry } from "./registry.ts"
import { toInstructions, toModelMessages } from "./to-model-messages.ts"
import type { LLMEvent, LLMRequest, ModelInfo, Tokens } from "./types.ts"
import { logger } from "../util/log.ts"

const log = logger("llm")

/**
 * ★ SDK 的告警**一律进日志文件,绝不落终端**。
 *
 * 默认实现走 `process.emitWarning`,而那是 stderr —— 全屏界面正在那儿画,
 * 一条告警糊上去就把整帧撕开(现象:对话中间插进几行 `at emitWarning
 * (/$bunfs/root/...)`,而且差分从此对不回来)。它还会随每一次请求重复,
 * 于是聊几句屏幕就烂了。
 *
 * 关掉不是把问题藏起来:`ALFA_DEBUG=1` 时它们照旧落进日志,
 * 而这里恰恰是这个进程里**唯一**允许决定"告警去哪"的地方。
 */
const globals = globalThis as { AI_SDK_LOG_WARNINGS?: unknown }
globals.AI_SDK_LOG_WARNINGS = (options: { warnings?: unknown[]; provider?: string; model?: string }) => {
  log.warn("sdk warning", {
    provider: options.provider,
    model: options.model,
    warnings: options.warnings,
  })
}

export interface StreamHandle {
  info: ModelInfo
  events: AsyncGenerator<LLMEvent>
}

/**
 * 「这一步一个工具都不许调」在 Anthropic 上的落法。
 *
 * ── 为什么需要它 ──
 * 上层表达"禁用工具"的方式是 `activeTools: []`(见 agent/loop.ts 撞顶那一轮、
 * agent/compact.ts、agent/summarize.ts)。SDK 把它翻成 `toolChoice: "none"`,
 * 而 @ai-sdk/anthropic 的 prepareTools 对 none 和空 tools 是同一个处理:
 * `return { tools: undefined, toolChoice: undefined }` —— **整个 tools 字段
 * 消失**。
 *
 * ⚠ 而 Anthropic 的 Messages API 有一条硬规矩:请求的历史里但凡出现过
 *   `tool_use` / `tool_result` 块,就**必须**声明 tools。两者一撞就是 400。
 *
 * 现场是这样的:一轮干满 100 步(见 prompt/max-steps.ts),历史里全是工具调用,
 * 最后那一轮"关掉工具、用纯文字交代进度"的收尾请求直接被拒 —— 用户等了很久,
 * 拿到的是一条报错,而那一轮**恰恰是设计来避免"半截会话"的**。
 * openai-compat 那条路不挑这个,所以它只在一家上现形。
 *
 * ── 为什么是一个假工具而不是别的 ──
 * 要让请求合法,tools 就必须非空;而任何一个**真**工具放进去都可能被调用,
 * 那就不叫禁用了。所以放一个声明得清清楚楚、调了也只会得到一句"这一步没有
 * 工具"的空壳:请求合法,历史完整,而且一个字节的副作用都没有。
 *
 * 压缩和摘要走不到这里 —— 它们的 messages 是现搓的一条 user 消息,历史里
 * 没有工具块,tools 缺席完全合法(见下面的 hasToolCalls)。
 *
 * 顺带一提缓存:这一步的 tools 前缀跟平时不一样,必然 miss。这不是新增的
 * 代价 —— 撞顶那一轮往 system 里塞了 MAX_STEPS_PROMPT,前缀本来就已经断了。
 */
const TOOLS_DISABLED: ToolSet = {
  tools_unavailable: tool({
    description:
      "Not callable. It is declared only because this request's history contains tool calls and the API " +
      "requires at least one tool to be defined. Answer with text.",
    inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }) as never,
    execute: async () => "No tools are available on this step. Answer with text only.",
  }),
}

/**
 * 历史里有没有工具块。有的话 tools 就不能缺席 —— 见 TOOLS_DISABLED。
 *
 * **导出**是为了能直接测它:这一句是"上假工具还是照常禁用"的全部判据,而
 * 判错的两个方向都很贵 —— 判成 false 是撞顶那一轮 400,判成 true 是压缩和
 * 摘要的请求里凭空多出一个模型不该看见的工具。
 */
export function hasToolCalls(messages: ModelMessage[]): boolean {
  return messages.some((message) => {
    if (message.role === "tool") return true
    if (!Array.isArray(message.content)) return false
    return message.content.some((part) => part.type === "tool-call" || part.type === "tool-result")
  })
}

export function stream(registry: LLMRegistry, request: LLMRequest): StreamHandle {
  const resolved = registry.resolve(`${request.model.providerID}/${request.model.modelID}`, {
    thinking: request.thinking,
  })

  const tools: ToolSet = adaptTools({
    tools: request.tools,
    makeToolContext: request.makeToolContext,
  })

  const messages: ModelMessage[] = toModelMessages(request.messages, resolved.replayReasoning ?? "signed")
  const instructions = toInstructions(request.system, resolved.singleSystem ?? false)

  /** 说了"一个都不许调",而历史里又有工具块 —— 见 TOOLS_DISABLED 那一整段 */
  const shimTools = request.activeTools?.length === 0 && hasToolCalls(messages)

  const result = streamText({
    model: resolved.model,
    // v7:system 必须走 instructions,放进 messages 会抛 InvalidPromptError
    ...(instructions.length > 0 ? { instructions } : {}),
    messages,
    tools: shimTools ? TOOLS_DISABLED : tools,
    // ★ 走假工具那条路时 activeTools / toolChoice 都**不能带上** —— 带上任何
    //   一个,provider 又会把 tools 抹掉,这个 shim 就白做了
    ...(shimTools ? {} : request.activeTools ? { activeTools: request.activeTools as never } : {}),
    ...(shimTools ? {} : request.activeTools?.length === 0 ? { toolChoice: "none" as const } : {}),
    ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
    maxOutputTokens: Math.min(resolved.info.limit.output, 32_000) || 32_000,
    ...(resolved.providerOptions ? { providerOptions: resolved.providerOptions } : {}),
    abortSignal: request.abortSignal,
    maxRetries: 0, // 我们自己重试,见 retry.ts
    // ⚠ 必须传。streamText 的 onError **默认是 console.error**,而错误同时
    //   还会作为 error part 进 fullStream —— 也就是说不覆盖它的话,每一次
    //   会被 retry.ts 悄悄重试掉的 429,都会先往 stderr 喷一整坨 SDK 堆栈,
    //   把正在渲染的界面冲烂。这里改成落调试日志。
    onError: ({ error }) => log.error("stream error", { message: String(error) }),
  })

  return { info: resolved.info, events: normalize(result.fullStream) }
}

/**
 * fullStream → LLMEvent。
 *
 * 不认识的 part 一律丢弃(source / file / raw / custom / approval 等)。
 * 丢弃是刻意的:加一个 case 是显式决定,默认透传才是抽象层腐化的开始。
 *
 * 导出是为了能直接喂事件序列测它 —— 这半个模块的 bug(比如签名捡漏)不会当场
 * 报错,只会在**下一轮**变成一条告警和一段丢掉的思考。
 */
export async function* normalize(fullStream: AsyncIterable<TextStreamPart<ToolSet>>): AsyncGenerator<LLMEvent> {
  let synthetic = 0
  const nextID = (prefix: string) => `${prefix}_${synthetic++}`
  /** provider 不给 id 时的兜底映射 */
  let currentText: string | undefined
  let currentReasoning: string | undefined
  /**
   * 这一段思考的签名。
   *
   * ★ 它挂在**一条正文为空的 reasoning-delta** 上(SDK 把 Anthropic 的
   *   `signature_delta` 翻成那个),**不在 reasoning-end 上**。只在结束事件里
   *   找的话永远拿不到 —— 而没有签名的思考回灌时会被 SDK 整块丢掉并告警
   *   ("unsupported reasoning metadata"),一条历史里的思考就告警一次。
   */
  let pendingSignature: string | undefined

  for await (const part of fullStream) {
    switch (part.type) {
      case "text-start":
        currentText = part.id || nextID("txt")
        yield { type: "text-start", id: currentText }
        break
      case "text-delta":
        if (!currentText) {
          currentText = part.id || nextID("txt")
          yield { type: "text-start", id: currentText }
        }
        yield { type: "text-delta", id: part.id || currentText, text: part.text }
        break
      case "text-end":
        yield { type: "text-end", id: part.id || currentText || nextID("txt") }
        currentText = undefined
        break

      case "reasoning-start":
        currentReasoning = part.id || nextID("rsn")
        pendingSignature = undefined
        yield { type: "reasoning-start", id: currentReasoning }
        break
      case "reasoning-delta": {
        if (!currentReasoning) {
          currentReasoning = part.id || nextID("rsn")
          yield { type: "reasoning-start", id: currentReasoning }
        }
        pendingSignature = extractSignature(part.providerMetadata) ?? pendingSignature
        // 带签名的那条 delta 正文是空的,不用往外发
        if (part.text.length > 0) yield { type: "reasoning-delta", id: part.id || currentReasoning, text: part.text }
        break
      }
      case "reasoning-end": {
        const signature = extractSignature(part.providerMetadata) ?? pendingSignature
        yield {
          type: "reasoning-end",
          id: part.id || currentReasoning || nextID("rsn"),
          ...(signature ? { signature } : {}),
        }
        currentReasoning = undefined
        pendingSignature = undefined
        break
      }

      case "tool-input-start":
        yield { type: "tool-input-start", callID: part.id, tool: part.toolName }
        break
      case "tool-call":
        yield { type: "tool-call", callID: part.toolCallId, tool: part.toolName, input: part.input }
        break
      case "tool-result":
        yield {
          type: "tool-result",
          callID: part.toolCallId,
          tool: part.toolName,
          output: typeof part.output === "string" ? part.output : JSON.stringify(part.output),
        }
        break
      case "tool-error":
        yield {
          type: "tool-error",
          callID: part.toolCallId,
          tool: part.toolName,
          error: errorText(part.error),
        }
        break

      case "start-step":
        yield { type: "step-start" }
        break
      case "finish-step":
        yield { type: "step-finish", finishReason: part.finishReason, tokens: toTokens(part.usage) }
        break

      case "error":
        yield { type: "error", error: part.error instanceof Error ? part.error : new Error(errorText(part.error)) }
        break

      default:
        // 显式忽略:start / finish / abort / source / file / raw / custom /
        // tool-input-delta / tool-input-end / approval-* / tool-output-denied
        break
    }
  }
}

/** Anthropic 的 thinking 签名。回灌历史时必须原样带回,否则 400。 */
function extractSignature(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined
  const anthropic = (metadata as Record<string, unknown>)["anthropic"]
  if (!anthropic || typeof anthropic !== "object") return undefined
  const signature = (anthropic as Record<string, unknown>)["signature"]
  return typeof signature === "string" ? signature : undefined
}

function toTokens(usage: {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number }
  outputTokenDetails?: { reasoningTokens?: number }
}): Tokens {
  const safe = (value: number | undefined) => (Number.isFinite(value) && value! > 0 ? value! : 0)
  return {
    input: safe(usage.inputTokens),
    output: safe(usage.outputTokens),
    reasoning: safe(usage.outputTokenDetails?.reasoningTokens),
    cache: {
      read: safe(usage.inputTokenDetails?.cacheReadTokens),
      write: safe(usage.inputTokenDetails?.cacheWriteTokens),
    },
    ...(safe(usage.totalTokens) > 0 ? { total: safe(usage.totalTokens) } : {}),
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
