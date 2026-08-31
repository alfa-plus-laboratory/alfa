/**
 * ★ provider 注册表。
 *
 * 加一个新 provider = 新建 src/llm/providers/<x>.ts + 在这里 register 一行。
 * 零修改 src/agent。将来接自有计费网关 / 记忆层增强的模型,走的就是这条路。
 *
 * 这个文件可以 import SDK 类型(它在 src/llm 内),但 src/llm/types.ts 不行 ——
 * 那个是给 src/agent 看的边界。
 */
import type { LanguageModel } from "ai"
import type { ModelInfo, ModelRef } from "./types.ts"
import { NoCredentialsError, UnknownModelError } from "./types.ts"

/**
 * 历史里的思考块怎么回灌。
 *
 * 这件事**没有跨家的标准**,所以只能按 provider 定:
 *
 *   "signed" —— 只回灌带签名的。Anthropic 的路子:一个没签名的 thinking 块
 *               它根本收不了(SDK 会整块丢掉再吐一条告警)。
 *   "text"   —— 原样回灌纯文本。OpenAI 兼容端点把它序列化成 `reasoning_content`
 *               (见 @ai-sdk/openai-compatible 的 assistant 分支)。
 *   "none"   —— 一条都不回灌。给那些收到 `reasoning_content` 直接 400 的端点。
 *
 * ⚠ 无论哪一档,**只有当前这一趟工具循环里的思考**会走到这里 —— 更早的在
 *   agent 层就切掉了(见 agent/to-model-messages.ts 的 loopStartIndex)。
 */
export type ReasoningReplay = "signed" | "text" | "none"

export interface ResolvedModel {
  model: LanguageModel
  info: ModelInfo
  /** 见 ReasoningReplay。缺省按 "signed" —— 最保守的那一档 */
  replayReasoning?: ReasoningReplay
  /**
   * system 只发一条(把两段并起来)。
   *
   * ── 为什么要有这个开关 ──
   * 平时是**两条**,而那个拆分只为一件事服务:Anthropic 的显式缓存断点 ——
   * 最长那截静态前缀必须自己一条,否则每天日期一变整个前缀作废(见
   * prompt/system.ts)。断点本身是 `{ anthropic: … }` 命名空间的,到了 OpenAI
   * 兼容端点是死数据。
   *
   * ★ 也就是说在那条路上,拆两条**买到的东西是零**,而代价是真的:本地推理
   *   服务器跑的是模型自己的 Jinja chat template,而那些模板绝大多数只允许
   *   一条 system、且必须在最前面(Llama / Mistral / Qwen / Gemma 的官方模板
   *   都有这道闸)。第二条一来就是
   *   `raise_exception('System message must be at the beginning.')` —— 一个 500,
   *   而报错里一个字都没提"你发了两条"。
   *
   * OpenAI 的 wire format 本身是允许多条的,所以这不是谁写错了,是两边的契约
   * 不一样宽。让的是我们:那边零收益,而用户改不动模型作者写的模板。
   */
  singleSystem?: boolean
  /**
   * 传给 streamText 的 providerOptions(thinking budget、cache 控制等)。
   * 值必须是 JSON 可序列化的 —— SDK 会直接塞进请求体,用 unknown 过不了类型。
   */
  providerOptions?: Record<string, Record<string, any>>
  /** 有些模型不接受 temperature(推理模型),返回 undefined 表示不传 */
  temperature?: number
}

export interface Provider {
  id: string
  /** 人类可读名,报错时用 */
  label: string
  /** 凭据缺失时返回提示文本;可用则返回 undefined */
  missingCredentials(): string | undefined
  resolve(modelID: string, options: { thinking?: boolean }): ResolvedModel
  /**
   * `/model` 按 tab 时列哪几个。**不是**「只能用这几个」——
   * 任何 provider/model 都照旧能切,这只是省掉每次手打一长串。
   *
   * 空着完全正常:一个 OpenAI 兼容端点认哪些模型名问不出来,而猜出来的候选
   * 比没有候选更糟 —— 它看起来是能选的(见 config.ts 的 ProviderConfig.models)。
   */
  models?(): string[]
}

export class LLMRegistry {
  private providers = new Map<string, Provider>()

  register(provider: Provider): this {
    this.providers.set(provider.id, provider)
    return this
  }

  ids(): string[] {
    return [...this.providers.keys()].toSorted()
  }

  /**
   * `/model` 的候选清单,形如 ["anthropic/claude-opus-4-1", …]。
   *
   * ★ 只列**手里有凭据**的那几家。列一个切过去必然报「没有 key」的模型,
   *   是在让用户替我们试错 —— 而这条清单存在的全部意义就是不用试。
   */
  catalog(): string[] {
    const out: string[] = []
    for (const id of this.ids()) {
      const provider = this.providers.get(id)!
      if (provider.missingCredentials()) continue
      for (const model of provider.models?.() ?? []) out.push(`${id}/${model}`)
    }
    return out
  }

  /** 解析 "anthropic/claude-opus-5" 这种规格串。 */
  resolve(spec: string, options: { thinking?: boolean } = {}): ResolvedModel {
    const ref = parseModelRef(spec)
    const provider = this.providers.get(ref.providerID)
    if (!provider) throw new UnknownModelError(spec, this.ids())

    const missing = provider.missingCredentials()
    if (missing) throw new NoCredentialsError(provider.id, missing)

    return provider.resolve(ref.modelID, options)
  }
}

/**
 * "provider/model" → ModelRef。
 * 模型名里可以带斜杠(如 openai-compat/org/model),只在第一个斜杠处切。
 */
export function parseModelRef(spec: string): ModelRef {
  const index = spec.indexOf("/")
  if (index === -1) throw new UnknownModelError(spec, [])
  return { providerID: spec.slice(0, index), modelID: spec.slice(index + 1) }
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.providerID}/${ref.modelID}`
}
