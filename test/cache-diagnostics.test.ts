/**
 * Cache reports are evidence, not billing promises. These scenarios guard older-branch
 * lookup, scope isolation, failed usage and honest unknown ceilings without live API calls.
 */
import { expect, test } from "bun:test"
import { InvocationCache, aggregateCacheDiagnostics, normalizeCacheUsage, type CacheScope, type CacheSegment } from "../src/llm/cache/index.ts"
import { openAIResponsesCacheUsage, OPENAI_CACHE_RULES } from "../src/llm/cache/openai.ts"

const scope: CacheScope = { provider: "openai", model: "gpt-5.4", endpoint: "responses", isolationKey: "account-a" }
const segments = (...values: string[]): CacheSegment[] => values.map((value, index) => ({ kind: index === 0 ? "system_static" : "history", value }))
const usage = (totalInputTokens = 2000, cacheReadTokens = 1024) => ({ totalInputTokens, cacheReadTokens, cacheWriteTokens: 0 })

test("best candidate can be an older branch and never skips a changed middle segment", () => {
  const cache = new InvocationCache()
  const first = cache.begin({ scope, segments: segments("a", "b", "c") }).finish(usage())
  cache.begin({ scope, segments: segments("a", "x", "c") }).finish(usage())
  const third = cache.begin({ scope, segments: segments("a", "b", "d") }).finish(usage())
  expect(third.candidateRequestId).toBe(first.requestId)
  expect(third.matchingSegments).toBe(2)
  expect(third.firstMismatch).toEqual({ ordinal: 2, current: "history", previous: "history" })
  expect(third.estimated.structuralReusableTokens).toBeNull()
  expect(third.ratios.SRC).toBeNull()
})

test("model, account, endpoint and options boundaries prevent candidate leakage", () => {
  for (const changed of [{ model: "gpt-5.5" }, { isolationKey: "account-b" }, { endpoint: "chat" }, { options: { effort: "high" } }]) {
    const cache = new InvocationCache()
    cache.begin({ scope, segments: segments("secret") }).finish(usage())
    const result = cache.begin({ scope: { ...scope, ...changed }, segments: segments("secret") }).finish(usage())
    expect(result.candidateRequestId).toBeUndefined()
    expect(result.reasonCodes).toContain("model_or_scope_changed")
    expect(JSON.stringify(result)).not.toContain("secret")
    expect(JSON.stringify(result)).not.toContain("account-")
  }
})

test("switching back to an old model can find its bounded candidate", () => {
  const cache = new InvocationCache()
  const first = cache.begin({ scope, segments: segments("a") }).finish(usage())
  cache.begin({ scope: { ...scope, model: "other" }, segments: segments("a") }).finish(usage())
  expect(cache.begin({ scope, segments: segments("a") }).finish(usage()).candidateRequestId).toBe(first.requestId)
})

test("whole equality uses only prior measured tokens with low confidence and no expected hit claim", () => {
  const cache = new InvocationCache()
  cache.begin({ scope, segments: segments("a"), now: 0 }).finish(usage(), 1)
  const result = cache.begin({ scope, segments: segments("a"), now: 1e9 }).finish(usage())
  expect(result.estimated.structuralReusableTokens).toBe(2000)
  expect(result.estimated.expectedCacheReadTokens).toBeNull()
  expect(result.ratios.ECHC).toBeNull()
  expect(result.ratios.CER).toBeNull()
  expect(result.confidence).toBe("low")
  expect(result.expectedStatus).toBe("uncertain")
  expect(result.reasonCodes).toContain("ttl_uncertain")
})

test("parallel request cannot retroactively gain evidence from an in-flight candidate", () => {
  const cache = new InvocationCache()
  const first = cache.begin({ scope, segments: segments("a") })
  const second = cache.begin({ scope, segments: segments("a") })
  first.finish(usage())
  const result = second.finish(usage())
  expect(result.reasonCodes).toContain("candidate_write_in_flight")
  expect(result.estimated.structuralReusableTokens).toBeNull()
})

test("failed usage stays unknown and does not silently enter aggregate denominators", () => {
  const cache = new InvocationCache()
  const failed = cache.begin({ scope, segments: segments("a") }).finish()
  const success = cache.begin({ scope, segments: segments("a") }).finish(usage())
  expect(failed.actual.totalInputTokens).toBeNull()
  expect(failed.ratios.ACHR).toBeNull()
  expect(success.estimated.structuralReusableTokens).toBeNull()
  const aggregate = aggregateCacheDiagnostics([failed, success])
  expect(aggregate.requests).toBe(2)
  expect(aggregate.ACHR).toEqual({ value: 1024 / 2000, knownRequests: 1 })
  expect(aggregate.totalInput).toEqual({ tokens: 2000, knownRequests: 1 })
})

test("aggregation weights actual tokens rather than averaging percentages", () => {
  const cache = new InvocationCache()
  const a = cache.begin({ scope, segments: segments("a") }).finish(usage(100, 100))
  const b = cache.begin({ scope, segments: segments("b") }).finish(usage(900, 0))
  expect(aggregateCacheDiagnostics([a, b]).ACHR.value).toBe(0.1)
})

test("candidate capacity evicts old fingerprints and invocation keys are unrelated", () => {
  const cache = new InvocationCache(1)
  cache.begin({ scope, segments: segments("a", "b") }).finish(usage())
  const last = cache.begin({ scope, segments: segments("z") }).finish(usage())
  const current = cache.begin({ scope, segments: segments("a", "b") }).finish(usage())
  expect(current.candidateRequestId).toBe(last.requestId)
  expect(current.matchingSegments).toBe(0)
  const other = new InvocationCache().begin({ scope, segments: segments("a", "b") }).finish(usage())
  expect(current.scopeId).not.toBe(other.scopeId)
})

test("finish is idempotent and cannot rewrite request evidence", () => {
  const ticket = new InvocationCache().begin({ scope, segments: segments("a") })
  const first = ticket.finish()
  expect(ticket.finish(usage())).toBe(first)
  expect(first.actual.totalInputTokens).toBeNull()
})

test("invalid counters do not become plausible zero usage or negative uncached tokens", () => {
  expect(normalizeCacheUsage({ totalInputTokens: NaN, cacheReadTokens: -1, cacheWriteTokens: Infinity })).toEqual({
    totalInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, uncachedInputTokens: null,
  })
  expect(normalizeCacheUsage(usage(10, 20)).uncachedInputTokens).toBeNull()
})

test("Responses usage fixtures preserve missing write detail across API generations", () => {
  // Synthetic fixtures mirror the documented raw usage shape; they are not live recordings.
  const legacy = openAIResponsesCacheUsage({ input_tokens: 2048, input_tokens_details: { cached_tokens: 1024 } })
  expect(legacy.cacheWriteTokens).toBeNull()
  expect(normalizeCacheUsage(legacy).uncachedInputTokens).toBeNull()
  const explicit = openAIResponsesCacheUsage({ input_tokens: 4096, input_tokens_details: { cached_tokens: 2048, cache_write_tokens: 1024 } })
  expect(normalizeCacheUsage(explicit).uncachedInputTokens).toBe(1024)
  expect(openAIResponsesCacheUsage(undefined).totalInputTokens).toBeNull()
  expect(OPENAI_CACHE_RULES.verifiedAt).toBe("2026-09-22")
})


test("contradictory cache subsets remain evidence but never count as valid usage or ratios", () => {
  for (const counters of [
    { totalInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0 },
    { totalInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: null },
    { totalInputTokens: 10, cacheReadTokens: null, cacheWriteTokens: 20 },
    { totalInputTokens: 10, cacheReadTokens: 6, cacheWriteTokens: 5 },
  ]) {
    const cache = new InvocationCache()
    const invalid = cache.begin({ scope, segments: segments("a") }).finish(counters)
    expect(invalid.actual.totalInputTokens).toBe(counters.totalInputTokens)
    expect(invalid.actual.cacheReadTokens).toBe(counters.cacheReadTokens)
    expect(invalid.reasonCodes).toContain("inconsistent_cache_usage")
    expect(invalid.ratios).toEqual({ ACHR: null, SRC: null, ECHC: null, CER: null })
    const invalidOnly = aggregateCacheDiagnostics([invalid])
    expect(invalidOnly.requests).toBe(1)
    expect(invalidOnly.ACHR).toEqual({ value: null, knownRequests: 0 })
    expect(invalidOnly.totalInput).toEqual({ tokens: null, knownRequests: 0 })
    const valid = cache.begin({ scope, segments: segments("a") }).finish(usage(100, 50))
    expect(valid.estimated.structuralReusableTokens).toBeNull()
    const mixed = aggregateCacheDiagnostics([invalid, valid])
    expect(mixed.requests).toBe(2)
    expect(mixed.ACHR).toEqual({ value: 0.5, knownRequests: 1 })
    expect(mixed.totalInput).toEqual({ tokens: 100, knownRequests: 1 })
    expect(mixed.cacheRead).toEqual({ tokens: 50, knownRequests: 1 })
  }
})

test("retrospective ceiling utilization weights paired tokens and excludes unknown or zero ceilings", () => {
  const make = (ceiling: number | null, read: number | null) => {
    const d = new InvocationCache().begin({ scope, segments: segments("same") }).finish({ totalInputTokens: 2000, cacheReadTokens: read, cacheWriteTokens: 0 })
    d.estimated.structuralReusableTokens = ceiling
    return d
  }
  const result = aggregateCacheDiagnostics([make(100, 100), make(900, 0), make(null, 1000), make(0, 100), make(200, null)])
  expect(result.structuralUtilization).toEqual({ value: 0.1, knownRequests: 2 })
  expect(aggregateCacheDiagnostics([make(0, 0)]).structuralUtilization.value).toBeNull()
  // A ceiling mismatch is useful evidence, not a reason to silently cap the raw ratio.
  expect(aggregateCacheDiagnostics([make(100, 200)]).structuralUtilization.value).toBe(2)
})

test("growing histories reuse completed input measurements without requiring whole-request equality", () => {
  const cache = new InvocationCache()
  const first = cache.begin({ scope, segments: segments("system", "user") }).finish(usage(2000, 0))
  const next = cache.begin({ scope, segments: segments("system", "user", "assistant", "tool") }).finish(usage(3000, 1800))
  expect(next.candidateRequestId).toBe(first.requestId)
  expect(next.estimated.structuralReusableTokens).toBe(2000)
  expect(next.estimated.basis).toBe("measured-input-prefix")
  expect(next.reasonCodes).toContain("new_suffix_only")
  const third = cache.begin({ scope, segments: segments("system", "user", "assistant", "tool", "next") }).finish(usage(4000, 2800))
  expect(third.estimated.structuralReusableTokens).toBe(3000)
})

test("a pending or longer changed branch cannot hide an older measured common prefix", () => {
  const cache = new InvocationCache()
  const first = cache.begin({ scope, segments: segments("system", "user") }).finish(usage(2000, 0))
  cache.begin({ scope, segments: segments("system", "user", "a", "wrong") }).finish(usage(4000, 1000))
  const pending = cache.begin({ scope, segments: segments("system", "user", "a", "b") })
  const current = cache.begin({ scope, segments: segments("system", "user", "a", "b", "c") })
  pending.finish(usage(5000, 1000))
  const result = current.finish(usage(6000, 1800))
  expect(result.candidateRequestId).toBe(first.requestId)
  expect(result.estimated.structuralReusableTokens).toBe(2000)
})

test("an Anthropic measured cache boundary survives suffix edits but not changes before that boundary", () => {
  const cache = new InvocationCache()
  cache.begin({ scope, segments: segments("system", "cached", "old-tail"), ceilingBasis: "cache-prefix", cachePrefixSegments: 2 }).finish({ totalInputTokens: 3000, cacheReadTokens: 1500, cacheWriteTokens: 500 })
  const next = cache.begin({ scope, segments: segments("system", "cached", "new-tail"), ceilingBasis: "cache-prefix", cachePrefixSegments: 2 }).finish(usage(3000, 1800))
  expect(next.estimated.structuralReusableTokens).toBe(2000)
  expect(next.estimated.measuredPrefixSegments).toBe(2)
  expect(next.estimated.basis).toBe("measured-cache-prefix")
  const rewritten = cache.begin({ scope, segments: segments("system", "changed", "new-tail"), ceilingBasis: "cache-prefix", cachePrefixSegments: 2 }).finish(usage(3000, 0))
  expect(rewritten.estimated.structuralReusableTokens).toBeNull()
})
