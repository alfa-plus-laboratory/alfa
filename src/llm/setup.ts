/**
 * provider 装配 —— 把 config.json + auth.json + 环境变量合成一张注册表。
 *
 * ── 优先级:环境变量 > 文件 ──
 * 理由是"临时的应该盖住长期的"。你为了跑一次 CI、或者临时换把 key 而 export
 * 的东西,不该被半年前存下来的配置悄悄顶掉 —— 那种失效最难查,因为一切看起来
 * 都是对的,只是用了另一把 key。
 *
 * ── 为什么要具名 provider ──
 * 早期只有 anthropic / openai-compat 两个固定 id,想同时用官方 Anthropic 和一个
 * 自建的 Anthropic 兼容网关,就得设 ANTHROPIC_BASE_URL 把 anthropic 这个位置
 * **劫持**掉,于是两者只能二选一。具名之后 anthropic、openai、公司网关可以同时
 * 存在,-m gateway/gpt-4o 直接切。
 *
 * 两个内置 id 永远注册,即使没有任何配置文件 —— 老的 ANTHROPIC_API_KEY
 * 用法必须继续能跑,包括 CI 里。
 */
import { LLMRegistry } from "./registry.ts"
import { anthropicProvider } from "./providers/anthropic.ts"
import { openAICompatProvider } from "./providers/openai-compat.ts"
import type { Config, ModelConfig, ProviderType } from "../config/config.ts"
import type { AuthStore } from "../config/auth.ts"
import { readEnv } from "../env/vars.ts"

/** 无论有没有配置都存在的两个 id,以及它们各自认的老环境变量。 */
const BUILTIN: Record<string, { type: ProviderType; keyEnv: string; baseURLEnv: string }> = {
  anthropic: { type: "anthropic", keyEnv: "ANTHROPIC_API_KEY", baseURLEnv: "ANTHROPIC_BASE_URL" },
  "openai-compat": { type: "openai-compat", keyEnv: "OPENAI_API_KEY", baseURLEnv: "OPENAI_BASE_URL" },
}

export interface ResolvedProvider {
  id: string
  type: ProviderType
  apiKey?: string
  baseURL?: string
  limit?: { context: number; output: number }
  /** 见 config.ts 的 ProviderConfig.replayReasoning。只对 openai-compat 有意义 */
  replayReasoning?: boolean
  /** `/model` 的候选 + 各自的窗口。见 config.ts 的 ProviderConfig.models */
  models?: Record<string, ModelConfig>
  /** 密钥是从哪来的,给 auth list 显示 */
  source: "env" | "file" | "none"
}

export interface SetupInput {
  config?: Config
  auth?: AuthStore
  env?: Record<string, string | undefined>
}

/**
 * 具名 provider 的环境变量覆盖:ALFA_KEY_MINIMAX / ALFA_BASE_URL_MINIMAX。
 * 让 CI 也能用具名 provider,而不必退回两个内置 id。
 */
function envSuffix(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9]/g, "_")
}

/** 纯函数,好测。真正决定"最后用的是哪把 key"就在这里。 */
export function resolveProviders(input: SetupInput = {}): ResolvedProvider[] {
  const config = input.config ?? {}
  const auth = input.auth ?? {}
  const env = input.env ?? process.env

  const ids = new Set<string>([...Object.keys(BUILTIN), ...Object.keys(config.providers ?? {}), ...Object.keys(auth)])

  const out: ResolvedProvider[] = []
  for (const id of [...ids].toSorted()) {
    const declared = config.providers?.[id]
    const builtin = BUILTIN[id]
    // 既没声明也不是内置的(只在 auth.json 里出现过)—— 当成 OpenAI 兼容,
    // 这是覆盖面最广的一种,猜错了用户在 config.json 里改一行就行。
    const type: ProviderType = declared?.type ?? builtin?.type ?? "openai-compat"

    const suffix = envSuffix(id)
    const apiKey =
      readEnv(`KEY_${suffix}`, env) || (builtin ? env[builtin.keyEnv] : undefined) || auth[id]?.apiKey
    const source: ResolvedProvider["source"] = !apiKey
      ? "none"
      : readEnv(`KEY_${suffix}`, env) || (builtin && env[builtin.keyEnv])
        ? "env"
        : "file"

    const baseURL =
      readEnv(`BASE_URL_${suffix}`, env) || (builtin ? env[builtin.baseURLEnv] : undefined) || declared?.baseURL

    out.push({
      id,
      type,
      ...(apiKey ? { apiKey } : {}),
      ...(baseURL ? { baseURL } : {}),
      ...(declared?.limit ? { limit: declared.limit } : {}),
      ...(declared?.replayReasoning !== undefined ? { replayReasoning: declared.replayReasoning } : {}),
      ...(declared?.models ? { models: declared.models } : {}),
      source,
    })
  }
  return out
}

export function buildRegistry(input: SetupInput = {}): LLMRegistry {
  const registry = new LLMRegistry()
  for (const provider of resolveProviders(input)) {
    registry.register(
      provider.type === "anthropic"
        ? anthropicProvider({
            id: provider.id,
            ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
            ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
            // ★ limit 一度漏在这里没传 —— 于是 type: "anthropic" 的 provider
            //   在 config 里写的 limit 被安静地忽略,而用户完全看不出来
            ...(provider.limit ? { limit: provider.limit } : {}),
            ...(provider.models ? { models: provider.models } : {}),
          })
        : openAICompatProvider({
            id: provider.id,
            ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
            ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
            ...(provider.limit ? { limit: provider.limit } : {}),
            ...(provider.replayReasoning !== undefined ? { replayReasoning: provider.replayReasoning } : {}),
            ...(provider.models ? { models: provider.models } : {}),
          }),
    )
  }
  return registry
}

/**
 * 没显式 -m 时用哪个模型。
 *
 * $ALFA_MODEL > config.model > 手里有凭据的第一个 provider。
 * 最后那条兜底比写死一个模型名有用:刚 auth login 完的人直接就能跑,
 * 不用再被告知"还要设一个默认模型"。
 */
export function defaultModelSpec(input: SetupInput = {}): string | undefined {
  const env = input.env ?? process.env
  const explicit = readEnv("MODEL", env)
  if (explicit) return explicit
  if (input.config?.model) return input.config.model

  const usable = resolveProviders(input).filter((p) => p.apiKey)
  const first = usable[0]
  if (!first) return undefined
  // 只知道 provider、不知道模型名。给一个该家最常见的,再不济用户会看到
  // provider 的报错,里面有可用模型列表。
  const fallback = first.type === "anthropic" ? "claude-sonnet-4-5" : "gpt-4o-mini"
  return `${first.id}/${fallback}`
}
