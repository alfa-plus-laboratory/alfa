/**
 * Interactive diagnostics must exist before the user opens the debugger, but a terminal
 * can run for days. Keep a bounded completion ledger separate from the optional full report.
 * Only usage and keyed fingerprints enter it; prompt text and credentials never do.
 */
import { normalizeCacheUsage } from "./cache/index.ts"
import type { UsageRecord } from "./usage.ts"

export interface DiagnosticEntry { sequence: number; completedAt: number; usage: UsageRecord }
export interface DiagnosticSnapshot { startedAt: number; totalRequests: number; capacity: number; entries: DiagnosticEntry[] }
export class Diagnostics {
  private entries: DiagnosticEntry[] = []
  private totalRequests = 0
  readonly startedAt = Date.now()
  constructor(readonly capacity = 500) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Diagnostic capacity must be a positive integer")
  }
  add(usage: UsageRecord): void {
    this.entries.push({ sequence: ++this.totalRequests, completedAt: Date.now(), usage })
    if (this.entries.length > this.capacity) this.entries.shift()
  }
  snapshot(): DiagnosticSnapshot {
    return { startedAt: this.startedAt, totalRequests: this.totalRequests, capacity: this.capacity, entries: [...this.entries] }
  }
}

export function cacheObservation(record: UsageRecord) {
  return record.cache?.actual ?? normalizeCacheUsage(record.observedCache)
}

/** Ratios use paired observations: partial counters cannot share an unrelated denominator. */
export function summarizeDiagnostics(entries: DiagnosticEntry[]) {
  const samples = entries.map(entry => cacheObservation(entry.usage))
  const valid = samples.filter(s => s.totalInputTokens === null ||
    ((s.cacheReadTokens === null || s.cacheReadTokens <= s.totalInputTokens) &&
     (s.cacheWriteTokens === null || s.cacheWriteTokens <= s.totalInputTokens) &&
     (s.cacheReadTokens === null || s.cacheWriteTokens === null || s.cacheReadTokens + s.cacheWriteTokens <= s.totalInputTokens)))
  const sum = (key: keyof typeof samples[number]) => {
    const values = valid.map(s => s[key]).filter((value): value is number => value !== null)
    return { tokens: values.length ? values.reduce((a, b) => a + b, 0) : null, known: values.length }
  }
  const paired = valid.filter(s => s.totalInputTokens !== null && s.cacheReadTokens !== null)
  const denominator = paired.reduce((sum, s) => sum + s.totalInputTokens!, 0)
  const outputs = entries.map(entry => entry.usage.measuredOutputTokens)
    .filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  return {
    output: { tokens: outputs.length ? outputs.reduce((a, b) => a + b, 0) : null, known: outputs.length },
    requests: entries.length, captured: entries.filter(e => e.usage.cache).length,
    invalid: samples.length - valid.length,
    input: sum("totalInputTokens"), read: sum("cacheReadTokens"), write: sum("cacheWriteTokens"), uncached: sum("uncachedInputTokens"),
    hitRate: denominator > 0 ? paired.reduce((sum, s) => sum + s.cacheReadTokens!, 0) / denominator : null,
    hitRateKnown: paired.length,
  }
}

/** Keep provider aliases distinct and never equate an omitted effort with a guessed model
 * default. Anthropic thinking budgets are also part of the grouping to avoid hiding changes. */
export function groupDiagnosticsByModelEffort(entries: DiagnosticEntry[]) {
  const groups = new Map<string, { model: UsageRecord["model"]; effort: UsageRecord["effort"]; entries: DiagnosticEntry[] }>()
  for (const entry of entries) {
    const { model, effort } = entry.usage
    const key = JSON.stringify([model.providerID, model.modelID, effort ? [effort.level, effort.thinking, effort.budgetTokens] : null])
    let group = groups.get(key)
    if (!group) { group = { model, effort, entries: [] }; groups.set(key, group) }
    group.entries.push(entry)
  }
  return [...groups.values()]
}
