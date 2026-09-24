/**
 * Wire protocols count input differently. Anthropic input excludes cache reads/writes;
 * Chat prompt_tokens already includes them. Missing fields remain unknown, not zero.
 * Compatible endpoints inherit no model eligibility or retention rules from their syntax.
 * Chat schema: https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions/methods/retrieve
 * Anthropic accounting is also checked against the installed SDK's convertAnthropicUsage.
 */
import type { CacheUsage } from "./index.ts"
import { openAIResponsesCacheUsage, OPENAI_CACHE_RULES } from "./openai.ts"
export type CacheProtocol = "openai-responses" | "openai-chat" | "anthropic"
export const CACHE_ADAPTERS = {
  "openai-responses": OPENAI_CACHE_RULES,
  "openai-chat": { version: "chat-observation-v1", accounting: "prompt_tokens includes cached_tokens", eligibility: "provider_specific_unknown" },
  anthropic: { version: "anthropic-observation-v1", accounting: "input_tokens + cache_read_input_tokens + cache_creation_input_tokens", eligibility: "explicit_breakpoints_and_provider_rules" },
} as const
export const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
export function protocolCacheUsage(protocol: CacheProtocol, raw: unknown): CacheUsage {
  const usage = object(raw)
  if (protocol === "openai-responses") return openAIResponsesCacheUsage(raw)
  if (protocol === "openai-chat") {
    const details = object(usage?.prompt_tokens_details)
    return { totalInputTokens: count(usage?.prompt_tokens), cacheReadTokens: count(details?.cached_tokens) ?? count(usage?.prompt_cache_hit_tokens), cacheWriteTokens: count(details?.cache_write_tokens) }
  }
  const input = count(usage?.input_tokens), read = count(usage?.cache_read_input_tokens), write = count(usage?.cache_creation_input_tokens)
  // Server-side iterations can have a different aggregation contract. Do not mix their
  // total input with the final iteration's cache fields.
  const iterations = Array.isArray(usage?.iterations) && usage.iterations.length > 0
  return { totalInputTokens: !iterations && input !== null && read !== null && write !== null ? input + read + write : null, cacheReadTokens: iterations ? null : read, cacheWriteTokens: iterations ? null : write }
}

/** Read final wire settings, not model-name guesses or the UI's thinking toggle. Omitted
 * effort means provider default, whose actual level is not observable from this request. */
export interface RequestEffort { level: string | null; thinking: string | null; budgetTokens: number | null }
export function requestEffort(protocol: CacheProtocol, body: Record<string, unknown>): RequestEffort {
  const text = (value: unknown) => typeof value === "string" && value.length > 0 ? value : null
  const thinking = object(body.thinking)
  const level = protocol === "openai-responses" ? object(body.reasoning)?.effort
    : protocol === "anthropic" ? object(body.output_config)?.effort : body.reasoning_effort
  return { level: text(level), thinking: text(thinking?.type), budgetTokens: count(thinking?.budget_tokens) }
}
