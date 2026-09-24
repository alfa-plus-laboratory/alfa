/**
 * Metering sits at the protocol boundary so it counts the main session, summaries,
 * compaction and subagents alike; an interrupted call that never returned usage is marked
 * unknown. Execution identity stays local: putting run IDs in request instructions would
 * fragment the cache prefix, while reading identity back from model text would be guesswork.
 */
import { enableCacheMetrics } from "./request-metrics.ts"
import type { RequestEffort } from "./cache/protocols.ts"
import type { CacheDiagnostic, CacheUsage } from "./cache/index.ts"
import type { AgentExecutionContext, ModelRef, Tokens } from "./types.ts"
export interface UsageRecord {
  model: ModelRef
  /** Final transmitted effort/thinking settings; absent means capture was unavailable. */
  effort?: RequestEffort
  requestId?: string
  execution?: AgentExecutionContext
  /** Preserves missing SDK counters before the legacy Tokens zero defaults. Includes cache. */
  measuredInputTokens?: number | null
  /** Output before the legacy missing-to-zero conversion. */
  measuredOutputTokens?: number | null
  tokens?: Tokens
  elapsedMs: number
  cacheInInput: boolean
  /** SDK counters before legacy missing-to-zero conversion; raw diagnostics take precedence. */
  observedCache?: CacheUsage
  cache?: CacheDiagnostic
}
const observers = new Set<(record: UsageRecord) => void>()
export function observeUsage(listener: (record: UsageRecord) => void, options?: { cache?: boolean }): () => void {
  const stopCache = options?.cache ? enableCacheMetrics() : undefined
  observers.add(listener)
  return () => { observers.delete(listener); stopCache?.() }
}
export function reportUsage(record: UsageRecord): void { for (const listener of observers) listener(record) }
