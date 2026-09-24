/**
 * A cache hit still occupies context. Amplification therefore uses all measured input,
 * including cache reads, and the first root main request as its denominator. Missing calls
 * or unknown ownership cannot silently turn a partial token sum into a session cost claim.
 * Agent identity here is the existing stored session ID, not a guessed template or role.
 */
import type { UsageRecord } from "./usage.ts"

export function aggregateExecutionUsage(records: UsageRecord[]) {
  const groups = new Map<string, UsageRecord[]>()
  let unattributedRequests = 0
  for (const record of records) {
    const root = record.execution?.rootSessionId ?? record.execution?.sessionId
    if (!root) { unattributedRequests++; continue }
    const group = groups.get(root) ?? []
    group.push(record)
    groups.set(root, group)
  }
  const measured = (record: UsageRecord): number | null => {
    const value = record.measuredInputTokens
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  return {
    denominator: "First root main request input tokens for each root session in this invocation; includes cached input. Failed or unattributed calls make amplification unknown.",
    unattributedRequests,
    sessions: [...groups].map(([rootSessionId, calls]) => {
      const firstMain = calls.find(record => record.execution?.requestKind === "main" && record.execution.depth === 0)
      const rootInputTokens = firstMain ? measured(firstMain) : null
      const known = calls.filter(record => measured(record) !== null)
      const inputTokens = known.reduce((sum, record) => sum + measured(record)!, 0)
      const complete = known.length === calls.length && unattributedRequests === 0
      return {
        rootSessionId, requests: calls.length, knownInputRequests: known.length,
        measuredInputTokens: known.length ? inputTokens : null, rootInputTokens,
        contextAmplification: complete && rootInputTokens !== null && rootInputTokens > 0 ? inputTokens / rootInputTokens : null,
        byKind: Object.fromEntries([...new Set(calls.map(record => record.execution!.requestKind))].map(kind => {
          const selected = calls.filter(record => record.execution!.requestKind === kind)
          const observed = selected.filter(record => measured(record) !== null)
          return [kind, { requests: selected.length, knownInputRequests: observed.length, measuredInputTokens: observed.length ? observed.reduce((sum, record) => sum + measured(record)!, 0) : null }]
        })),
      }
    }),
  }
}
