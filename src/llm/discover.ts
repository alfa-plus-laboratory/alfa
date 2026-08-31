/**
 * 问端点:你这儿有哪些模型。
 *
 * ── 为什么值得专门做这件事 ──
 * 一份只写了 baseURL 和一个模型名的配置是**半份配置**:`/model` 按 tab 没有候选,
 * 用户得自己去翻文档抄模型名。而这个信息几乎所有端点都提供 —— Anthropic 官方、
 * OpenAI 官方、以及各种兼容网关都实现了 `GET /models`,一次请求就拿全了。
 * 让用户手抄一份机器两秒就能问到的清单,是把我们的偷懒转嫁成他的功课。
 *
 * ── 只拿名字,不拿窗口 ──
 * `/models` 的返回里**没有上下文长度**这个字段的统一叫法:官方两家干脆不给,
 * 兼容端点有的叫 context_length、有的叫 max_model_len、有的什么都不给。从一堆
 * 猜出来的字段名里凑一个数,比不填更危险 —— 窗口决定什么时候压缩,估大了的
 * 表现是聊到一半突然被 provider 拒收,而用户会以为是这个程序坏了。
 *
 * 所以窗口有三条来路,一条都不猜:内置那张表(真 Anthropic)、用户在 config 里
 * 写的、引导里当面问的。见 config.ts 的 ProviderConfig.models。
 *
 * ── 失败一律当没问到 ──
 * 这是加分项。端点不提供 /models、返回了个 HTML 登录页、网络不通 —— 任何一种
 * 都不该让"配置一个 provider"这件事失败。
 */
import type { ProviderType } from "../config/config.ts"

const TIMEOUT_MS = 10_000
/**
 * 最多收多少个。OpenAI 官方那张表就有几十条,而一个划不到底的候选列表
 * 和没有候选差不多 —— 真需要更多的人手改 config 就是了。
 */
const MAX_MODELS = 40

/**
 * 明显不是拿来聊天的。
 *
 * ★ 这是**按名字猜**,所以它只砍掉几个一眼可辨的家族,不做"只保留 gpt-* "
 *   那种白名单 —— 白名单会把明天出的新模型全挡在外面,而那正是用户最想切过去的
 *   那一个。砍掉多少条要说出来(见 DiscoverResult.dropped):一份安静地少了几行的
 *   清单,比一份带噪音的更难查。
 */
const NOT_CHAT = /embed|whisper|\btts\b|audio|dall-?e|moderation|rerank|speech|image|video|ocr/i

export interface DiscoverResult {
  /** 端点报出来的模型名,已经过滤和截断 */
  models: string[]
  /** 按名字判掉的条数(嵌入、语音那些) */
  dropped: number
  /** 撞上限被截掉的条数 */
  truncated: number
}

export interface DiscoverInput {
  type: ProviderType
  apiKey: string
  /** 不给就用该家的官方端点 */
  baseURL?: string
  timeoutMs?: number
}

/** 问不到就 undefined —— 调用方据此什么都不写,而不是写一份空清单 */
export async function discoverModels(input: DiscoverInput): Promise<DiscoverResult | undefined> {
  const base = (input.baseURL ?? defaultBase(input.type)).replace(/\/+$/, "")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? TIMEOUT_MS)
  try {
    const response = await fetch(`${base}/models`, {
      headers:
        input.type === "anthropic"
          ? { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" }
          : { authorization: `Bearer ${input.apiKey}` },
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as { data?: unknown }
    if (!Array.isArray(body.data)) return undefined

    const all: string[] = []
    for (const entry of body.data) {
      const id = (entry as { id?: unknown })?.id
      if (typeof id === "string" && id.length > 0) all.push(id)
    }
    if (all.length === 0) return undefined

    const chat = all.filter((id) => !NOT_CHAT.test(id))
    const kept = chat.slice(0, MAX_MODELS)
    return { models: kept, dropped: all.length - chat.length, truncated: chat.length - kept.length }
  } catch {
    // 超时、DNS、证书、返回的不是 JSON —— 全都是"问不到",不是错误
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

function defaultBase(type: ProviderType): string {
  return type === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"
}
