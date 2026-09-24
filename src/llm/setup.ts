/**
 * Provider assembly — merges config.json + auth.json + environment variables into one
 * registry.
 *
 * ── Precedence: environment variables > files ──
 * The reasoning is "the temporary should override the long-lived". Something you exported
 * to run CI once, or to swap keys temporarily, must not be quietly overridden by config
 * saved half a year ago — that kind of failure is the hardest to track down, because
 * everything looks right; it's just using a different key.
 *
 * ── Why named providers ──
 * Early on there were only two fixed ids, anthropic / openai-chat. To use official
 * Anthropic and a self-hosted Anthropic-compatible gateway at the same time, you had to set
 * ANTHROPIC_BASE_URL and **hijack** the anthropic slot, so it was one or the other. With
 * names, anthropic, openai and a company gateway can coexist, and -m gateway/gpt-4o
 * switches directly.
 *
 * The three built-in ids are always registered, even with no config file at all — the old
 * ANTHROPIC_API_KEY usage must keep working, CI included.
 */
import { registerSecret } from "../util/redact.ts"
import { LLMRegistry } from "./registry.ts"
import { anthropicProvider } from "./providers/anthropic.ts"
import { openAIProvider } from "./providers/openai.ts"
import { openAICompatProvider } from "./providers/openai-compat.ts"
import type { Config, ModelConfig, ProviderType } from "../config/config.ts"
import type { AuthStore } from "../config/auth.ts"
import { readEnv } from "../env/vars.ts"

/** The three ids that exist with or without config, and the old env vars each honors. */
const BUILTIN: Record<string, { type: ProviderType; keyEnv: string; baseURLEnv: string }> = {
  anthropic: { type: "anthropic", keyEnv: "ANTHROPIC_API_KEY", baseURLEnv: "ANTHROPIC_BASE_URL" },
  openai: { type: "openai-responses", keyEnv: "OPENAI_API_KEY", baseURLEnv: "OPENAI_BASE_URL" },
  "openai-chat": { type: "openai-chat", keyEnv: "OPENAI_API_KEY", baseURLEnv: "OPENAI_BASE_URL" },
}

export interface ResolvedProvider {
  disabled?: boolean
  noKey?: boolean
  keyHeader?: string
  baseURLSource: "env" | "file" | "default"
  id: string
  type: ProviderType
  apiKey?: string
  baseURL?: string
  limit?: { context: number; output: number }
  /** See ProviderConfig.replayReasoning in config.ts. Only meaningful for openai-chat */
  replayReasoning?: boolean
  /** See ModelConfig.images in config.ts */
  images?: boolean
  /** `/model` candidates + their windows. See ProviderConfig.models in config.ts */
  models?: Record<string, ModelConfig>
  /** Where the key came from, shown by auth list */
  source: "env" | "file" | "none"
}

export interface SetupInput {
  includeDisabled?: boolean
  config?: Config
  auth?: AuthStore
  env?: Record<string, string | undefined>
}

/**
 * Environment variable overrides for named providers: ALFA_KEY_GATEWAY /
 * ALFA_BASE_URL_GATEWAY. Lets CI use named providers too, without falling back to the three
 * built-in ids.
 */
function envSuffix(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9]/g, "_")
}

/** Pure function, easy to test. This is where "which key ends up used" is decided. */
export function resolveProviders(input: SetupInput = {}): ResolvedProvider[] {
  const config = input.config ?? {}
  const auth = input.auth ?? {}
  const env = input.env ?? process.env

  const ids = new Set<string>([...Object.keys(BUILTIN), ...Object.keys(config.providers ?? {}), ...Object.keys(auth)])

  const out: ResolvedProvider[] = []
  for (const id of [...ids].toSorted()) {
    const declared = config.providers?.[id]
    const builtin = BUILTIN[id]
    if (declared?.disabled && !input.includeDisabled) continue
    // Neither declared nor built-in (only ever appeared in auth.json) — treat it as
    // OpenAI-compatible, the kind with the widest coverage; if that guess is wrong the user
    // just changes one line in config.json.
    const type: ProviderType = declared?.type ?? builtin?.type ?? "openai-chat"

    const suffix = envSuffix(id)
    const apiKey =
      readEnv(`KEY_${suffix}`, env) || (builtin ? env[builtin.keyEnv] : undefined) || auth[id]?.apiKey
    registerSecret(apiKey)
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
      disabled: declared?.disabled,
      noKey: declared?.noKey,
      keyHeader: declared?.keyHeader,
      baseURLSource: readEnv(`BASE_URL_${suffix}`, env) || (builtin && env[builtin.baseURLEnv]) ? "env" : declared?.baseURL ? "file" : "default",
      ...(apiKey ? { apiKey } : {}),
      ...(baseURL ? { baseURL } : {}),
      ...(declared?.limit ? { limit: declared.limit } : {}),
      ...(declared?.replayReasoning !== undefined ? { replayReasoning: declared.replayReasoning } : {}),
      ...(declared?.images !== undefined ? { images: declared.images } : {}),
      ...(declared?.models ? { models: declared.models } : {}),
      source,
    })
  }
  return out
}

export function buildRegistry(input: SetupInput = {}): LLMRegistry {
  const registry = new LLMRegistry()
  for (const provider of resolveProviders(input)) {
    const common = {
      id: provider.id,
      noKey: provider.noKey,
      keyHeader: provider.keyHeader,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
      ...(provider.limit ? { limit: provider.limit } : {}),
      ...(provider.images !== undefined ? { images: provider.images } : {}),
      ...(provider.models ? { models: provider.models } : {}),
    }
    registry.register(
      provider.type === "anthropic"
        ? anthropicProvider({
            ...common,
            // ★ limit was once left out here and never passed — so for a type: "anthropic"
            //   provider, the limit written in config was quietly ignored, and the user had
            //   no way of telling
          })
        : provider.type === "openai-responses"
          ? openAIProvider(common)
        : openAICompatProvider({
            ...common,
            ...(provider.replayReasoning !== undefined ? { replayReasoning: provider.replayReasoning } : {}),
          }),
    )
  }
  return registry
}

/**
 * Which model to use when there's no explicit -m.
 *
 * $ALFA_MODEL > config.model > the first provider we hold credentials for.
 * That last fallback is more useful than a hard-coded model name: someone who just ran
 * auth login can go straight away, without being told "you also need to set a default
 * model".
 */
export function defaultModelSpec(input: SetupInput = {}): string | undefined {
  const env = input.env ?? process.env
  const explicit = readEnv("MODEL", env)
  if (explicit) return explicit
  if (input.config?.model) return input.config.model

  const first = resolveProviders(input).find((p) => p.apiKey || p.noKey)
  if (!first) return undefined
  // We know the provider but not the model name. Give that provider's most common one;
  // at worst the user sees the provider's error, which lists the available models.
  const fallback = first.type === "anthropic" ? "claude-sonnet-4-5" : "gpt-4o-mini"
  return `${first.id}/${fallback}`
}
