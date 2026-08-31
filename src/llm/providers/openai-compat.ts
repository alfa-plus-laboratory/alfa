/**
 * OpenAI 兼容端点。
 *
 * 一个 provider 覆盖 OpenAI 官方、DeepSeek、Qwen、本地 vLLM/Ollama 和各种自建网关。
 * 刻意不装 @ai-sdk/openai:M1 只走 chat/completions,不碰 Responses API 的
 * itemId 那套坑;真要用官方特性再单独加一个 provider。
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { extractReasoningMiddleware, wrapLanguageModel } from "ai"
import type { Provider, ResolvedModel } from "../registry.ts"
import { DEFAULT_CONTEXT_LIMIT } from "../types.ts"

const DEFAULT_OUTPUT = 16_000

export function openAICompatProvider(options: {
  id?: string
  label?: string
  apiKey?: string
  baseURL?: string
  /** 这一家的默认窗口。某个模型没写自己的才用它 */
  limit?: { context: number; output: number }
  /** false = 不把历史里的思考发回去。见下面 replayReasoning 那段 */
  replayReasoning?: boolean
  /**
   * `/model` 的候选 + 各自的窗口。这边**没有**兜底的表 ——
   * 见 config.ts 的 ProviderConfig.models
   */
  models?: Record<string, { limit?: { context: number; output: number } }>
} = {}): Provider {
  const id = options.id ?? "openai-compat"
  const apiKey = options.apiKey ?? process.env["OPENAI_API_KEY"]
  const baseURL = options.baseURL ?? process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1"

  return {
    id,
    label: options.label ?? "OpenAI-compatible",
    missingCredentials() {
      if (apiKey) return undefined
      return `set OPENAI_API_KEY (and OPENAI_BASE_URL if not api.openai.com), or configure a provider with an explicit key`
    },
    models: () => Object.keys(options.models ?? {}),
    resolve(modelID): ResolvedModel {
      // 这个模型自己写的 > 这一家写的 > 兜底。这边没有内置的表可查 ——
      // 一个兼容端点后面挂的是谁,只有配置说得出
      const declared = options.models?.[modelID]?.limit ?? options.limit
      const client = createOpenAICompatible({
        name: id,
        apiKey: apiKey!,
        baseURL,
        // 不加这个,流式响应里根本不带 usage —— 实测 MiniMax 在
        // stream=true 时 in/out 全是 0,而非流式 curl 是有值的。
        // token 统计塌成 0 会让上下文预算和成本显示全部失真。
        includeUsage: true,
      })
      return {
        // 有些模型(DeepSeek-R1 那一类)在 OpenAI 兼容路径上把推理
        // **内联在 content 里**,用 <think></think> 包着。不处理的话,模型的
        // 私有思考会当成正文渲染给用户。Anthropic 兼容路径没有这个问题 ——
        // 这正是「一条 provider 路径验证过不等于验证过」的实例。
        model: wrapLanguageModel({
          model: client(modelID),
          middleware: extractReasoningMiddleware({ tagName: "think" }),
        }),
        /**
         * 这条路上没有签名可言,所以要么原样发文本,要么不发。
         *
         * 默认发:一趟工具循环里模型看不见自己上一步想过什么,下一步就只能
         * 从"我调了什么工具、拿到什么结果"里倒推当时的判断。SDK 那边接得住,
         * 序列化成 `reasoning_content`。
         *
         * 但这不是标准 —— 有的端点收到这个字段直接 400(而且 `<think>` 内联
         * 那一类模型,它当初根本不是从这个字段吐出来的)。所以留了开关:
         * config.json 里 `providers.<id>.replayReasoning: false`。
         */
        replayReasoning: options.replayReasoning === false ? "none" : "text",
        /**
         * system 并成一条。见 registry.ts 的 ResolvedModel.singleSystem。
         *
         * 平时拆两条只为 Anthropic 的显式缓存断点服务,而断点是
         * `{ anthropic: … }` 命名空间的 —— 到了这条路上是死数据。也就是说
         * 拆分在这里**买到的东西是零**,而代价是本地推理服务器直接 500:
         * 模型自己的 Jinja chat template 绝大多数只允许一条 system
         * (Llama / Mistral / Qwen / Gemma 的官方模板都有这道闸),第二条一来
         * 就是 `raise_exception('System message must be at the beginning.')`。
         *
         * ★ 不做成配置项:没有任何一个兼容端点会因为收到两条而变好。一个
         *   只有一个正确值的开关,是在请用户替我们做一次不存在的选择。
         */
        singleSystem: true,
        info: {
          ref: { providerID: id, modelID },
          limit: declared ?? { context: DEFAULT_CONTEXT_LIMIT, output: DEFAULT_OUTPUT },
          limitSource: declared ? "config" : "default",
          supportsThinking: false,
          promptTemplate: "default",
          // prompt_tokens 已经含 prompt_tokens_details.cached_tokens,不能再加
          cacheInInput: true,
        },
        temperature: 0,
      }
    },
  }
}
