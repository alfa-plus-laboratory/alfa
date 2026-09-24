/**
 * OpenAI cache accounting changed with newer model families. A global 1024/128 rule and
 * defaulting a missing cache-write field to zero would silently misstate both eligibility
 * and ordinary input cost. Keep absent fields unknown and leave eligibility/TTL predictions
 * unavailable until the actual request framing and model rules can be established.
 * Source: https://developers.openai.com/api/docs/guides/prompt-caching
 * Verified 2026-09-22. This adapter observes raw Responses usage; SDK-normalized counters
 * must not be passed as raw API usage (some SDK versions discard cache-write detail).
 */
import type { CacheUsage } from "./index.ts"

export const OPENAI_CACHE_RULES = {
  version: "openai-responses-observation-v1",
  verifiedAt: "2026-09-22",
  source: "https://developers.openai.com/api/docs/guides/prompt-caching",
  eligibility: "unknown_without_model_and_final_request",
  ttl: { startsAt: "unknown", refreshOnRead: "unknown", guaranteedMinimum: false },
} as const

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
export function openAIResponsesCacheUsage(rawUsage: unknown): CacheUsage {
  const usage = object(rawUsage)
  const details = object(usage?.input_tokens_details)
  return {
    totalInputTokens: count(usage?.input_tokens),
    cacheReadTokens: count(details?.cached_tokens),
    cacheWriteTokens: count(details?.cache_write_tokens),
  }
}
