/**
 * Anthropic 及 Anthropic 兼容端点。
 *
 * baseURL 可覆盖 —— 除了官方 API,不少网关也提供 /anthropic 兼容端点。
 * 这让同一份代码能对着同一个后端跑两条 provider 路径做对比,是验证
 * 「事件归一化真的抹平了差异」的唯一办法。
 */
import { createAnthropic } from "@ai-sdk/anthropic"
import type { Provider, ResolvedModel } from "../registry.ts"
import { DEFAULT_CONTEXT_LIMIT } from "../types.ts"

/** 认识的模型走下面那张表,不认识的走公共默认值(见 DEFAULT_CONTEXT_LIMIT)。 */
const DEFAULT_OUTPUT = 32_000

/** 已知模型的预算表。查不到就用默认值,不阻塞。 */
const LIMITS: Record<string, { context: number; output: number }> = {
  "claude-opus-5": { context: 1_000_000, output: 128_000 },
  "claude-opus-4-8": { context: 1_000_000, output: 128_000 },
  "claude-opus-4-7": { context: 1_000_000, output: 128_000 },
  "claude-opus-4-6": { context: 1_000_000, output: 128_000 },
  "claude-sonnet-5": { context: 1_000_000, output: 128_000 },
  "claude-sonnet-4-6": { context: 1_000_000, output: 128_000 },
  "claude-opus-4-5": { context: 200_000, output: 64_000 },
  "claude-opus-4-1": { context: 200_000, output: 32_000 },
  "claude-sonnet-4-5": { context: 200_000, output: 64_000 },
  "claude-haiku-4-5": { context: 200_000, output: 64_000 },
}

/**
 * 请求形状按世代分档 —— **这不是调优,是能不能发出去的问题**。
 *
 * Anthropic 在 4.7 那一代把两个参数**删了**,不是弃用:
 *   · `temperature` / `top_p` / `top_k`
 *   · `thinking.budgetTokens`(固定思考预算这个概念本身被 adaptive 取代)
 * 带着它们发过去是 400,而且报错不会告诉你是哪个字段多余的。
 *
 * ★ 只对**官方端点**分档。设了 baseURL 就是别人家的 Anthropic 兼容端点,
 *   那边认哪一套只有它自己知道 —— 按老规矩发,因为那正是今天在跑的组合。
 */

/** 当前世代:不收 temperature,不收 budgetTokens,思考走 adaptive。 */
const MODERN = new Set([
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-mythos-5",
])

/** 认 adaptive(而且官方推荐用它),但 temperature 还照收。 */
const ADAPTIVE_OK = new Set(["claude-opus-4-6", "claude-sonnet-4-6"])

export function anthropicProvider(
  options: {
    apiKey?: string
    baseURL?: string
    id?: string
    /** 候选模型 + 各自的窗口。见 config.ts 的 ProviderConfig.models */
    models?: Record<string, { limit?: { context: number; output: number } }>
    /** 这一家的默认窗口。某个模型没写自己的才用它 */
    limit?: { context: number; output: number }
  } = {},
): Provider {
  const id = options.id ?? "anthropic"
  const apiKey = options.apiKey ?? process.env["ANTHROPIC_API_KEY"]
  const baseURL = options.baseURL ?? process.env["ANTHROPIC_BASE_URL"]

  return {
    id,
    label: "Anthropic",
    missingCredentials() {
      if (apiKey) return undefined
      return "set ANTHROPIC_API_KEY, or configure a provider with an explicit key"
    },
    /**
     * ★ 那张表讲的是**真 Anthropic**,所以只在对着官方端点时才拿它当候选。
     *
     * 设了 baseURL 就说明这是别人家的 Anthropic 兼容端点(公司网关、本地代理、
     * 第三方转发)。把 claude-opus-4-1 列成"这台机器上能用的模型"是在凭空造事实:
     * 那些名字在那边多半根本不存在,而列表看起来就是一张可选清单 —— 用户照着
     * 选一个,拿到的是一条谁也看不懂的 provider 报错。
     *
     * 那边有哪几个模型只有配置说得出:providers.<id>.models。
     */
    models: () => (options.models ? Object.keys(options.models) : baseURL ? [] : Object.keys(LIMITS)),
    resolve(modelID, { thinking }): ResolvedModel {
      const client = createAnthropic({ apiKey: apiKey!, ...(baseURL ? { baseURL } : {}) })

      /**
       * 窗口按这个顺序取:**这个模型自己写的 > 这一家写的 > 内置那张表 > 兜底**。
       *
       * 配置排在表前面是硬要求 —— 表讲的是真 Anthropic,而一个把 model 字段
       * 映射掉的第三方兼容端点完全可能给你另一个窗口。用户明确写下的数,
       * 任何时候都比我们查出来的更接近事实。
       *
       * ★ 这里一度**根本不看 options.limit**:装配时压根没往这个 provider 传过它
       *   (只传给了 openai-compat)。表现是"在 config 里写了 limit 却毫无动静",
       *   而且不报错 —— 一个安静地忽略用户配置的程序,比一个报错的糟得多。
       */
      const declared = options.models?.[modelID]?.limit ?? options.limit
      const known = LIMITS[modelID]
      const limit = declared ?? known ?? { context: DEFAULT_CONTEXT_LIMIT, output: DEFAULT_OUTPUT }

      // 见 MODERN 上面那段:只有对着官方端点时才敢按世代裁参数
      const official = baseURL === undefined
      const modern = official && MODERN.has(modelID)
      const adaptive = modern || (official && ADAPTIVE_OK.has(modelID))

      /**
       * ★ 关着 thinking 时也要**显式**发 disabled,不能省略 —— Claude Opus 5 起
       *   思考是默认开的,省略等于开着。而省略在旧模型上等于关着,两边相反。
       *
       *   这里刻意不带 effort。官方对编码类任务推荐 xhigh,但 Opus 5 上
       *   `disabled` + `xhigh` 是 400,而默认档(high)配 disabled 是合法的 ——
       *   在没有真机验证过之前,不引入一个只在特定组合下才炸的参数。
       */
      const thinkingOption = adaptive
        ? thinking
          ? ({ type: "adaptive" } as const)
          : ({ type: "disabled" } as const)
        : thinking
          ? ({ type: "enabled", budgetTokens: Math.min(16_000, Math.floor(limit.output / 2)) } as const)
          : undefined

      return {
        model: client(modelID),
        // 一趟工具循环里的思考必须原样带回,而带回的前提是签名在。没签名的
        // 那几条(流被中途打断,签名跟在 reasoning-end 上)只能丢 —— 带着回去
        // 是 400,去掉签名再回去**也**是 400
        replayReasoning: "signed",
        info: {
          ref: { providerID: id, modelID },
          limit,
          // 顺序要和上面取 limit 的顺序一致。`/context` 靠这个字段说一句实话:
          // 一个把猜出来的窗口画成进度条的仪表盘,比没有仪表盘更容易让人做错决定
          limitSource: declared ? "config" : known ? "model" : "default",
          supportsThinking: true,
          promptTemplate: "anthropic",
          // ★ 这一栏说的是**到我们手里时**的口径,不是 Anthropic 原始 API 的。
          //
          //   原始 API 确实把 input_tokens 和 cache_read_input_tokens 分开报,
          //   照着填就是 false —— 一度就是这么填的。但 @ai-sdk/anthropic 的
          //   convertAnthropicUsage 已经先加过一遍:
          //       inputTokens.total = input_tokens + cache_creation + cache_read
          //   而 ai 核心取的正是 .total。也就是说到 stream.ts 时它**已经含缓存**,
          //   再当成「不含」加第二遍,上下文用量直接翻倍。
          //
          //   翻倍不只是显示难看:contextTokens() 是自动压缩的触发依据,
          //   命中率越高、算出来的数越接近真实值的两倍,压缩就在真实用量
          //   一半的地方触发。实测(MiniMax 的 /anthropic 端点,命中率 99%):
          //   真实 11,425 → 算成 22,665。
          cacheInInput: true,
        },
        ...(thinkingOption ? { providerOptions: { anthropic: { thinking: thinkingOption } } } : {}),
        // 开了 thinking 的模型不接受 temperature,不传比传 0 安全。
        // 当前世代**任何时候**都不接受(见 MODERN):关着 thinking 也不能传
        temperature: modern || thinking ? undefined : 0,
      }
    },
  }
}
