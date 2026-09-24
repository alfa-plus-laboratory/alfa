/**
 * Aggregate requests, not percentages: a tiny cached request cannot outweigh a large
 * miss. Missing reports and failed calls without usage remain unknown; known subtotals
 * are useful diagnostics but must not masquerade as complete billing totals.
 */
export interface Usage {
  model: { providerID: string; modelID: string }
  tokens?: { input: number; output: number; cache: { read: number; write: number } }
  cacheInInput: boolean
}
export interface Report { requests?: Usage[]; approvals?: number; interruptions?: number }
export type Prices = Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0

export function aggregateReports(reports: (Report | null)[], prices?: Prices) {
  const missingReports = reports.filter(report => !Array.isArray(report?.requests)).length
  const requests = reports.flatMap(report => report?.requests ?? [])
  const known = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, uncachedInput: 0 }
  let unknownRequests = 0, cost = 0, priced = !!prices
  for (const request of requests) {
    const t = request.tokens
    if (!t || ![t.input, t.output, t.cache?.read, t.cache?.write].every(count) || typeof request.cacheInInput !== "boolean") {
      unknownRequests++; continue
    }
    const cached = t.cache.read + t.cache.write
    const input = request.cacheInInput ? Math.max(t.input, cached) : t.input + cached
    known.input += input; known.output += t.output
    known.cacheRead += t.cache.read; known.cacheWrite += t.cache.write
    known.uncachedInput += input - cached
    const price = prices?.[`${request.model.providerID}/${request.model.modelID}`]
    if (!price || ![price.input, price.output, price.cacheRead, price.cacheWrite].every(count)) priced = false
    else cost += ((input - cached) * price.input + t.output * price.output + t.cache.read * price.cacheRead + t.cache.write * price.cacheWrite) / 1_000_000
  }
  const complete = missingReports === 0 && unknownRequests === 0
  const sum = (field: "approvals" | "interruptions") => reports.every(r => count(r?.[field])) ? reports.reduce((n, r) => n + r![field]!, 0) : null
  return {
    requests: missingReports ? null : requests.length, observedRequests: requests.length,
    missingReports, unknownRequests, knownTokens: known, tokens: complete ? known : null,
    cacheReadRate: complete && known.input > 0 ? known.cacheRead / known.input : null,
    apiCostUSD: complete && priced ? cost : null,
    approvals: sum("approvals"), interruptions: sum("interruptions"),
  }
}
