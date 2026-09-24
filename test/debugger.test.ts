/**
 * Diagnostics must distinguish an unmeasured cache from a real zero and keep browsing
 * independent of model execution. Bounded history must never masquerade as lifetime totals.
 */
import { afterEach, expect, test } from "bun:test"
import { setInterfaceLanguage } from "../src/i18n/index.ts"
import { InvocationCache } from "../src/llm/cache/index.ts"
import { Diagnostics, cacheObservation, summarizeDiagnostics } from "../src/llm/diagnostics.ts"
import { observedCacheUsage } from "../src/llm/stream.ts"
import type { UsageRecord } from "../src/llm/usage.ts"
import { debuggerMenu, renderCacheSummary, renderCacheOverview, renderCacheGroups, renderCacheRequest } from "../src/cli/debugger.ts"
import { InputCancelled } from "../src/cli/secret-input.ts"

afterEach(() => setInterfaceLanguage("auto"))
const record = (input: number | null, read: number | null): UsageRecord => ({
  model: { providerID: "fixture", modelID: "test" }, elapsedMs: 12, cacheInInput: true,
  observedCache: { totalInputTokens: input, cacheReadTokens: read, cacheWriteTokens: null },
  measuredInputTokens: input,
  execution: { requestKind: "main", sessionId: "session", rootSessionId: "session", runId: "run", depth: 0 },
})

test("SDK observation preserves absent counters and genuine zero cache reads", () => {
  expect(observedCacheUsage({ inputTokens: 100 })).toEqual({ totalInputTokens: 100, cacheReadTokens: null, cacheWriteTokens: null })
  expect(observedCacheUsage({ inputTokens: 0, inputTokenDetails: { cacheReadTokens: 0 } }).cacheReadTokens).toBe(0)
  expect(observedCacheUsage({ inputTokens: NaN }).totalInputTokens).toBeNull()
})

test("cache summaries weight paired token counts and exclude contradictory observations", () => {
  const ledger = new Diagnostics()
  ledger.add(record(100, 100)); ledger.add(record(900, 0)); ledger.add(record(1000, null))
  ledger.add(record(10, 20)); ledger.add(record(null, null))
  const s = summarizeDiagnostics(ledger.snapshot().entries)
  expect(s.hitRate).toBe(0.1)
  expect(s.hitRateKnown).toBe(2)
  expect(s.input).toEqual({ tokens: 2000, known: 3 })
  expect(s.invalid).toBe(1)
  expect(s.write).toEqual({ tokens: null, known: 0 })
  expect(s.uncached.tokens).toBeNull()
})

test("raw Responses diagnostics override lossy SDK counters and keep request evidence", () => {
  const collector = new InvocationCache()
  const usage = record(999, 0)
  usage.cache = collector.begin({ scope: { provider: "fixture", model: "test", endpoint: "private-endpoint", isolationKey: "private-key" }, segments: [{ kind: "tools", value: "private-tool" }] }).finish({ totalInputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 10 })
  const ledger = new Diagnostics(); ledger.add(usage)
  expect(cacheObservation(usage).uncachedInputTokens).toBe(40)
  setInterfaceLanguage("en")
  const detail = renderCacheRequest(ledger.snapshot().entries[0]!)
  expect(detail).toContain('"cacheReadTokens": 50')
  expect(detail).toContain('"reasonCodes"')
  for (const secret of ["private-endpoint", "private-key", "private-tool"]) expect(detail).not.toContain(secret)
})

test("ring eviction is explicit and cannot invent a new amplification denominator", () => {
  setInterfaceLanguage("en")
  const ledger = new Diagnostics(2)
  ledger.add(record(100, 0)); ledger.add(record(200, 0)); ledger.add(record(300, 0))
  const snapshot = ledger.snapshot()
  expect(snapshot.entries.map(e => e.sequence)).toEqual([2, 3])
  expect(snapshot.totalRequests).toBe(3)
  expect(renderCacheSummary(snapshot)).toContain("latest 2/3")
  expect(renderCacheGroups(snapshot)).toContain('"contextAmplification": null')
  expect(renderCacheSummary(snapshot)).toContain("/debugger")
})

test("an empty debugger shows unknown rather than a fabricated zero-percent cache rate", () => {
  setInterfaceLanguage("en")
  const text = renderCacheOverview(new Diagnostics().snapshot())
  expect(text).toContain("Actual hit rate: unknown")
  expect(text).toContain("observed 0/0")
  expect(text).toContain('"value": null')
})

test("debugger drills into paginated requests and cancellation returns one menu level", async () => {
  setInterfaceLanguage("en")
  const ledger = new Diagnostics()
  for (let i = 0; i < 12; i++) ledger.add(record(100, 0))
  const actions = ["cache", "overview", "requests", "next", "1", "cancel", "groups", "rules", "back", "back"]
  const output: string[] = []
  await debuggerMenu({ ask: async () => { throw new Error("unexpected input") }, say: text => output.push(text), choose: async (_label, items) => {
    const action = actions.shift()
    if (action === "cancel") throw new InputCancelled()
    expect(action).toBeDefined()
    expect(items.some(item => item.value === action)).toBe(true)
    return action!
  } }, () => ledger.snapshot())
  expect(actions).toHaveLength(0)
  expect(output.some(text => text.includes("Request #1"))).toBe(true)
  expect(output.some(text => text.includes("By model and task type"))).toBe(true)
  expect(output.some(text => text.includes("--report PATH"))).toBe(true)
  expect(ledger.snapshot().totalRequests).toBe(12)
})

test("context cache metrics use compact aligned rows and never paint unknown ceilings as zero", async () => {
  const { renderCacheMetrics } = await import("../src/cli/context.ts")
  setInterfaceLanguage("en")
  const ledger = new Diagnostics()
  ledger.add(record(1000, 800))
  const text = renderCacheMetrics(ledger.snapshot()).replace(/\x1b\[[0-9;]*m/g, "")
  expect(text).toContain("80%")
  expect(text).toContain("Actual cache hit rate")
  for (const label of ["Maximum cache hit rate", "Cache hit efficiency"]) {
    const row = text.split("\n").find(line => line.includes(label))!
    expect(row).toContain("—")
    expect(row).not.toContain("0%")
    expect(row).not.toContain("░")
  }
  expect(text).toContain("Details: /debugger")
  expect(text).not.toContain("SDK")
  expect(text).not.toContain("Expected ceiling")
  expect(text).toContain("Total output")
  expect(text.split("\n").length).toBeLessThanOrEqual(17)
})

test("context theoretical reuse remains visibly estimated even for identical measured requests", async () => {
  const { renderCacheMetrics } = await import("../src/cli/context.ts")
  const collector = new InvocationCache()
  const request = { scope: { provider: "p", model: "m", endpoint: "e", isolationKey: "k" }, segments: [{ kind: "tools" as const, value: "same" }] }
  collector.begin(request).finish({ totalInputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 })
  const r = record(1000, 800)
  r.cache = collector.begin(request).finish({ totalInputTokens: 1000, cacheReadTokens: 800, cacheWriteTokens: 0 })
  const ledger = new Diagnostics(); ledger.add(r)
  setInterfaceLanguage("en")
  const text = renderCacheMetrics(ledger.snapshot()).replace(/\x1b\[[0-9;]*m/g, "")
  const ceiling = text.split("\n").find(line => line.includes("Maximum cache hit rate"))!
  expect(ceiling).toContain("~100%")
  expect(text.split("\n").find(line => line.includes("Cache hit efficiency"))).toContain("~80%")
})


test("cache overview separates model and final effort without mixing their hit rates", async () => {
  const { renderCacheMetrics } = await import("../src/cli/context.ts")
  const { groupDiagnosticsByModelEffort } = await import("../src/llm/diagnostics.ts")
  setInterfaceLanguage("en")
  const ledger = new Diagnostics()
  const low = record(1000, 100), high = record(1000, 900), other = record(1000, 500)
  low.effort = { level: "low", thinking: null, budgetTokens: null }
  high.effort = { level: "high", thinking: null, budgetTokens: null }
  other.model = { providerID: "another", modelID: "test" }
  other.effort = { level: "low", thinking: null, budgetTokens: null }
  ledger.add(low); ledger.add(high); ledger.add(other)
  expect(groupDiagnosticsByModelEffort(ledger.snapshot().entries)).toHaveLength(3)
  const text = renderCacheMetrics(ledger.snapshot()).replace(/\x1b\[[0-9;]*m/g, "")
  expect(text).toMatch(/fixture\/test · effort: low[\s\S]*?10%/)
  expect(text).toMatch(/fixture\/test · effort: high[\s\S]*?90%/)
  expect(text).toContain("another/test")
  expect(text).toContain("latest 3/3")
})

test("provider-default effort, unknown capture and different thinking budgets remain distinct", async () => {
  const { groupDiagnosticsByModelEffort } = await import("../src/llm/diagnostics.ts")
  const { renderCacheMetrics } = await import("../src/cli/context.ts")
  setInterfaceLanguage("en")
  const ledger = new Diagnostics()
  for (const effort of [undefined, { level: null, thinking: null, budgetTokens: null }, { level: null, thinking: "enabled", budgetTokens: 1024 }, { level: null, thinking: "enabled", budgetTokens: 8192 }]) ledger.add({ ...record(100, 0), effort })
  expect(groupDiagnosticsByModelEffort(ledger.snapshot().entries)).toHaveLength(4)
  const text = renderCacheMetrics(ledger.snapshot()).replace(/\x1b\[[0-9;]*m/g, "")
  expect(text).toContain("effort: unknown")
  expect(text).toContain("effort: provider default")
  expect(text).toContain("budget: 1024")
  expect(text).toContain("budget: 8192")
})

test("task cache overview excludes auxiliary usage even on the same model while debugger retains it", async () => {
  const { renderCacheMetrics } = await import("../src/cli/context.ts")
  setInterfaceLanguage("en")
  const ledger = new Diagnostics()
  ledger.add(record(100, 50))
  ledger.add({ ...record(100, 50), execution: { requestKind: "subagent", runId: "child", depth: 1 } })
  for (const requestKind of ["title", "review", "compaction", "other"] as const) {
    ledger.add({ ...record(1000, 1000), execution: { requestKind, runId: requestKind } })
  }
  ledger.add({ ...record(1000, 1000), model: { providerID: "aux", modelID: "classifier" }, execution: { requestKind: "review", runId: "classifier" } })
  const snapshot = ledger.snapshot()
  const compact = renderCacheMetrics(snapshot)
  expect(compact).toContain("50%")
  expect(compact).toContain("2/2 requests")
  expect(compact).not.toContain("aux/classifier")
  expect(compact).toContain("main/subagents: 2")
  expect(compact).toContain("latest 7/7")
  expect(renderCacheOverview(snapshot)).toContain("aux/classifier")
  expect(renderCacheOverview(snapshot)).toContain("all calls: 7")
  expect(snapshot.entries).toHaveLength(7)
})

test("cache overview separates token totals from percentages and labels partial observations", async () => {
  const { renderCacheMetrics } = await import("../src/cli/context.ts")
  setInterfaceLanguage("en")
  const ledger = new Diagnostics()
  ledger.add({ ...record(1000, 800), measuredOutputTokens: 200 })
  ledger.add({ ...record(500, null), measuredOutputTokens: 0 })
  ledger.add(record(null, null))
  const stats = summarizeDiagnostics(ledger.snapshot().entries)
  expect(stats.output).toEqual({ tokens: 200, known: 2 })
  const text = renderCacheMetrics(ledger.snapshot()).replace(/\x1b\[[0-9;]*m/g, "")
  expect(text).toMatch(/Total input\s+1\.5k\s+2\/3 requests/)
  expect(text).toMatch(/Cached input\s+800\s+1\/3 requests/)
  expect(text).toMatch(/Total output\s+200\s+2\/3 requests/)
  expect(text).toMatch(/Overall hit rate \(incl\. first\)\s+80%[^\n]+1\/3 requests/)
  expect(text).toMatch(/Actual cache hit rate\s+—[^\n]+0\/3 requests/)
  expect(text).toMatch(/Maximum cache hit rate\s+—[^\n]+0\/3 requests/)
  for (const label of ["Total input", "Cached input", "Total output"]) {
    expect(text.split("\n").find(line => line.includes(label))).not.toContain("%")
  }
  expect(summarizeDiagnostics([{ sequence: 1, completedAt: 0, usage: record(100, 0) }]).output.tokens).toBeNull()
})

test("overall cache hit rate includes cold requests while all comparison rates share one cohort", async () => {
  const { renderCacheMetrics } = await import("../src/cli/context.ts")
  const { aggregateCacheDiagnostics } = await import("../src/llm/cache/index.ts")
  const collector = new InvocationCache()
  const request = { scope: { provider: "p", model: "m", endpoint: "e", isolationKey: "k" }, segments: [{ kind: "history" as const, value: "same" }] }
  const ledger = new Diagnostics()
  for (const read of [0, 900, 900, null]) {
    const usage = record(1000, read)
    usage.cache = collector.begin(request).finish({ totalInputTokens: 1000, cacheReadTokens: read, cacheWriteTokens: null })
    ledger.add(usage)
  }
  const comparison = aggregateCacheDiagnostics(ledger.snapshot().entries.map(e => e.usage.cache!)).comparison
  expect(comparison).toEqual({ requests: 2, hitRate: 0.9, maximumHitRate: 1, efficiency: 0.9 })
  setInterfaceLanguage("en")
  const text = renderCacheMetrics(ledger.snapshot()).replace(/\x1b\[[0-9;]*m/g, "")
  expect(text).toMatch(/Overall hit rate \(incl\. first\)\s+60%[^\n]+3\/4 requests/)
  expect(text).toMatch(/Actual cache hit rate\s+90%[^\n]+2\/4 requests/)
  expect(text).toMatch(/Maximum cache hit rate\s+~100%[^\n]+2\/4 requests/)
  expect(text).toMatch(/Cache hit efficiency\s+~90%[^\n]+2\/4 requests/)
  setInterfaceLanguage("zh")
  expect(renderCacheMetrics(ledger.snapshot())).toContain("本次调用的缓存命中情况")
})
