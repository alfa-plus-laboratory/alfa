/**
 * Invocation diagnostics keep keyed fingerprints, never prompt text. Comparing only the
 * previous request misses retries and older branches; counting characters as tokens makes
 * plausible-looking but false cache ceilings. Reuse completed request measurements when
 * their full input remains a prefix, or an Anthropic measured cache boundary still matches.
 * A changed partial segment without a measured boundary remains unknown.
 * ★ Segment agreement is not token LCP: hidden SDK/provider framing and token merges remain
 * unknown. Do not turn matching bytes into a cache prediction or persist this collector.
 * Contradictory counters stay visible as evidence, but cannot contribute valid ratios,
 * aggregate token totals, or a later request's measured structural ceiling.
 */
import { createHmac, randomBytes } from "node:crypto"

export interface CacheScope {
  provider: string
  model: string
  endpoint: string
  /** Required account/config identity, hashed immediately and never returned. */
  isolationKey: string
  /** Include all request-affecting settings, cache key, retention and effort. */
  options?: unknown
}
export type SegmentKind = "system_static" | "system_dynamic" | "tools" | "history" | "user_message" | "tool_result" | "other"
export interface CacheSegment { kind: SegmentKind; value: string }
export interface CacheUsage { totalInputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null }
export interface CacheDiagnostic {
  protocol?: "openai-responses" | "openai-chat" | "anthropic"
  breakpoints?: number[]
  inputTokenSource?: "raw" | "sdk-normalized"
  rawActual?: CacheUsage
  requestId: string
  scopeId: string
  actual: CacheUsage & { uncachedInputTokens: number | null }
  estimated: { structuralReusableTokens: number | null; expectedCacheReadTokens: number | null; basis?: "measured-input-prefix" | "measured-cache-prefix"; measuredPrefixSegments?: number }
  ratios: { ACHR: number | null; SRC: number | null; ECHC: number | null; CER: number | null }
  candidateRequestId?: string
  matchingSegments: number
  firstMismatch?: { ordinal: number; current?: SegmentKind; previous?: SegmentKind }
  expectedStatus: "cold" | "uncertain"
  confidence: "low"
  reasonCodes: string[]
  calculationVersion: string
}
interface Fingerprint { kind: SegmentKind; hash: string; bytes: number }
interface Candidate {
  requestId: string
  scopeId: string
  segments: Fingerprint[]
  pending: boolean
  usage?: CacheUsage
  ceilingBasis?: "input" | "cache-prefix"
  cachePrefixSegments?: number
  finishedAt?: number
}
export interface CacheTicket { requestId: string; finish(usage?: CacheUsage, now?: number): CacheDiagnostic }
const ratio = (a: number | null, b: number | null) => a !== null && b !== null && b > 0 ? a / b : null
const count = (value: number | null | undefined): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
export function normalizeCacheUsage(usage?: CacheUsage): CacheDiagnostic["actual"] {
  const totalInputTokens = count(usage?.totalInputTokens)
  const cacheReadTokens = count(usage?.cacheReadTokens)
  const cacheWriteTokens = count(usage?.cacheWriteTokens)
  const uncached = totalInputTokens !== null && cacheReadTokens !== null && cacheWriteTokens !== null
    ? totalInputTokens - cacheReadTokens - cacheWriteTokens : null
  return { totalInputTokens, cacheReadTokens, cacheWriteTokens, uncachedInputTokens: uncached !== null && uncached >= 0 ? uncached : null }
}

/** A cache subset cannot exceed total input, even when another counter is missing. */
function consistentUsage(usage: CacheUsage): boolean {
  const total = usage.totalInputTokens
  if (total === null) return true
  const read = usage.cacheReadTokens, write = usage.cacheWriteTokens
  return (read === null || read <= total) && (write === null || write <= total) &&
    (read === null || write === null || read <= total - write)
}

export class InvocationCache {
  #key = randomBytes(32)
  #candidates: Candidate[] = []
  #nextId = 0
  readonly capacity: number
  constructor(capacity = 32) {
    this.capacity = Number.isSafeInteger(capacity) ? Math.max(1, Math.min(256, capacity)) : 32
  }
  #hash(value: string): string { return createHmac("sha256", this.#key).update(value).digest("hex") }
  begin(input: { scope: CacheScope; segments: CacheSegment[]; now?: number; ceilingBasis?: "input" | "cache-prefix"; cachePrefixSegments?: number }): CacheTicket {
    const startedAt = input.now ?? Date.now()
    const current: Candidate = {
      requestId: `cache-${++this.#nextId}`,
      scopeId: this.#hash(JSON.stringify(input.scope)),
      segments: input.segments.map(segment => ({ kind: segment.kind, hash: this.#hash(segment.value), bytes: Buffer.byteLength(segment.value) })),
      pending: true,
      ceilingBasis: input.ceilingBasis,
      cachePrefixSegments: input.cachePrefixSegments,
    }
    let best: Candidate | undefined
    let matchingSegments = 0
    let bestBytes = -1
    let bestMeasurement: { tokens: number; segments: number; basis: "measured-input-prefix" | "measured-cache-prefix" } | undefined
    for (const candidate of this.#candidates) {
      if (candidate.scopeId !== current.scopeId) continue
      let matched = 0, bytes = 0
      while (matched < current.segments.length && matched < candidate.segments.length) {
        const a = current.segments[matched]!, b = candidate.segments[matched]!
        if (a.kind !== b.kind || a.hash !== b.hash) break
        bytes += a.bytes
        matched++
      }
      let measurement: typeof bestMeasurement
      if (!candidate.pending && candidate.usage) {
        if (candidate.ceilingBasis === "cache-prefix") {
          const boundary = candidate.cachePrefixSegments ?? candidate.segments.length
          const read = count(candidate.usage.cacheReadTokens), write = count(candidate.usage.cacheWriteTokens)
          if (boundary > 0 && boundary <= matched && read !== null && write !== null) {
            measurement = { tokens: read + write, segments: boundary, basis: "measured-cache-prefix" }
          }
        }
        // An absent write counter prevents measuring a cache breakpoint, but the full
        // previous input is still a usable anchor when every segment remains intact.
        if (!measurement && candidate.segments.length > 0 && candidate.segments.length <= matched) {
          const tokens = count(candidate.usage.totalInputTokens)
          if (tokens !== null) measurement = { tokens, segments: candidate.segments.length, basis: "measured-input-prefix" }
        }
      }
      // A longer unmeasured or in-flight branch must not hide an older usable measurement.
      if (measurement && (!bestMeasurement || measurement.tokens > bestMeasurement.tokens ||
          measurement.tokens === bestMeasurement.tokens && bytes >= bestBytes) ||
          !measurement && !bestMeasurement && bytes >= bestBytes) {
        best = candidate; bestBytes = bytes; matchingSegments = matched; bestMeasurement = measurement
      }
    }
    // Capture evidence at send time. A concurrent finish cannot retroactively warm this call.
    const prior = best ? { ...best } : undefined
    const identical = prior !== undefined && matchingSegments === current.segments.length && matchingSegments === prior.segments.length
    const mismatch = prior && !identical ? {
      ordinal: matchingSegments, current: current.segments[matchingSegments]?.kind, previous: prior.segments[matchingSegments]?.kind,
    } : undefined
    const reasons = ["tokenizer_unavailable", "hidden_provider_tokens", "provider_eligibility_unknown"]
    if (!prior) reasons.push(this.#candidates.length ? "model_or_scope_changed" : "no_compatible_candidate")
    else if (prior.pending) reasons.push("candidate_write_in_flight")
    else reasons.push("ttl_uncertain", "candidate_eviction_possible")
    if (prior && !identical) reasons.push(matchingSegments === prior.segments.length ? "new_suffix_only" :
      mismatch?.current === "tools" || mismatch?.previous === "tools" ? "tool_definition_changed" :
      mismatch?.current === "system_dynamic" ? "dynamic_field_changed" : "history_rewritten")
    this.#candidates.push(current)
    if (this.#candidates.length > this.capacity) this.#candidates.shift()
    // No full request object is captured by the returned closure; only keyed fingerprints.
    let result: CacheDiagnostic | undefined
    return { requestId: current.requestId, finish: (usage, now = Date.now()) => {
      if (result) return result
      const actual = normalizeCacheUsage(usage)
      const consistent = consistentUsage(actual)
      if (!consistent) reasons.push("inconsistent_cache_usage")
      current.usage = consistent ? actual : undefined
      current.pending = false
      current.finishedAt = now
      const structural = bestMeasurement?.tokens ?? null
      if (bestMeasurement) reasons.push(bestMeasurement.basis === "measured-cache-prefix" ? "measured_cache_prefix" : "measured_input_prefix")
      if (actual.totalInputTokens === null) reasons.push("usage_unknown")
      if (actual.cacheReadTokens !== null && structural !== null && actual.cacheReadTokens > structural) reasons.push("estimation_mismatch")
      if (now < startedAt) reasons.push("clock_changed")
      result = {
        requestId: current.requestId, scopeId: current.scopeId, actual,
        estimated: { structuralReusableTokens: structural, expectedCacheReadTokens: null, ...(bestMeasurement ? { basis: bestMeasurement.basis, measuredPrefixSegments: bestMeasurement.segments } : {}) },
        ratios: { ACHR: consistent ? ratio(actual.cacheReadTokens, actual.totalInputTokens) : null, SRC: consistent ? ratio(structural, actual.totalInputTokens) : null, ECHC: null, CER: null },
        candidateRequestId: prior?.requestId, matchingSegments, firstMismatch: mismatch,
        expectedStatus: prior ? "uncertain" : "cold", confidence: "low", reasonCodes: reasons,
        calculationVersion: "measured-prefix-v3",
      }
      return result
    } }
  }
}

/** Pair valid numerators with their own known denominators; exclude contradictory evidence. */
export function aggregateCacheDiagnostics(records: CacheDiagnostic[]) {
  const valid = records.filter(record => consistentUsage(record.actual))
  const sum = (pick: (record: CacheDiagnostic) => number | null) => {
    const values = valid.map(pick).filter((value): value is number => value !== null)
    return { tokens: values.length ? values.reduce((a, b) => a + b, 0) : null, knownRequests: values.length }
  }
  const weighted = (pick: (record: CacheDiagnostic) => number | null) => {
    let numerator = 0, denominator = 0, knownRequests = 0
    for (const record of valid) {
      const n = pick(record), d = record.actual.totalInputTokens
      if (n === null || d === null) continue
      numerator += n; denominator += d; knownRequests++
    }
    return { value: denominator > 0 ? numerator / denominator : null, knownRequests }
  }
  // Utilization is retrospective A/S, not predictive A/E. Only paired observations
  // with a positive ceiling belong in either sum; preserve ratios above one as evidence.
  const pairs = valid.filter(r => r.actual.cacheReadTokens !== null &&
    r.estimated.structuralReusableTokens !== null && r.estimated.structuralReusableTokens > 0)
  const ceiling = pairs.reduce((sum, r) => sum + r.estimated.structuralReusableTokens!, 0)
  const structuralUtilization = {
    value: ceiling > 0 ? pairs.reduce((sum, r) => sum + r.actual.cacheReadTokens!, 0) / ceiling : null,
    knownRequests: pairs.length,
  }
  // Comparable rates must share one cohort; including cold calls only in A/N makes
  // actual versus maximum look inefficient even when all reusable tokens were hit.
  const comparable = valid.filter(r => r.actual.totalInputTokens !== null && r.actual.totalInputTokens > 0 &&
    r.actual.cacheReadTokens !== null && r.estimated.structuralReusableTokens !== null && r.estimated.structuralReusableTokens > 0)
  const input = comparable.reduce((sum, r) => sum + r.actual.totalInputTokens!, 0)
  const read = comparable.reduce((sum, r) => sum + r.actual.cacheReadTokens!, 0)
  const reusable = comparable.reduce((sum, r) => sum + r.estimated.structuralReusableTokens!, 0)
  return {
    comparison: { requests: comparable.length, hitRate: ratio(read, input), maximumHitRate: ratio(reusable, input), efficiency: ratio(read, reusable) },
    structuralUtilization,
    requests: records.length,
    totalInput: sum(r => r.actual.totalInputTokens), cacheRead: sum(r => r.actual.cacheReadTokens),
    cacheWrite: sum(r => r.actual.cacheWriteTokens), uncachedInput: sum(r => r.actual.uncachedInputTokens),
    structuralReusable: sum(r => r.estimated.structuralReusableTokens),
    expectedCacheRead: sum(r => r.estimated.expectedCacheReadTokens),
    ACHR: weighted(r => r.actual.cacheReadTokens), SRC: weighted(r => r.estimated.structuralReusableTokens),
    ECHC: weighted(r => r.estimated.expectedCacheReadTokens), CER: { value: null, knownRequests: 0 },
  }
}
