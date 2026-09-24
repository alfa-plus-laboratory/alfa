/**
 * Eval bookkeeping must not turn incomplete billing or fixture oracles into live-model
 * wins. All tests are pure or local; none invokes a provider or needs credentials.
 */
import { test, expect } from "bun:test"
import { aggregateReports, type Report, type Usage } from "../eval/metrics.ts"
import { parseOptions } from "../eval/options.ts"
import { gradeRuntimeBatch, gradeRuntimeEvidence, validateRuntimeScenarios, type RuntimeEvidence } from "../eval/runtime.ts"

const usage = (input: number, read: number, cacheInInput = true): Usage => ({ model: { providerID: "fixture", modelID: "fixture" }, cacheInInput, tokens: { input, output: 10, cache: { read, write: 0 } } })
const report = (...requests: Usage[]): Report => ({ requests, approvals: 1, interruptions: 0 })

test("eval cache aggregation weights input tokens and handles both provider conventions", () => {
  const result = aggregateReports([report(usage(100, 100), usage(900, 0))])
  expect(result.cacheReadRate).toBe(0.1)
  expect(result.tokens?.input).toBe(1000)
  expect(aggregateReports([report(usage(900, 100, false))]).tokens?.input).toBe(1000)
  expect(result.apiCostUSD).toBeNull()
})

test("failed and interrupted requests with missing usage keep complete totals unknown", () => {
  const failed: Usage = { model: { providerID: "fixture", modelID: "fixture" }, cacheInInput: true }
  const result = aggregateReports([report(usage(100, 50), failed), null])
  expect(result.tokens).toBeNull()
  expect(result.cacheReadRate).toBeNull()
  expect(result.apiCostUSD).toBeNull()
  expect(result.requests).toBeNull()
  expect(result.unknownRequests).toBe(1)
  expect(result.missingReports).toBe(1)
  expect(result.knownTokens.input).toBe(100)
  expect(result.interruptions).toBeNull()
  expect(aggregateReports([{ ...report(failed), interruptions: 1 }]).interruptions).toBe(1)
})

test("cost combines initial and recovery usage without double charging cached tokens", () => {
  const result = aggregateReports([report(usage(100, 50)), report(usage(50, 50, false))], { "fixture/fixture": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } })
  expect(result.apiCostUSD).toBeCloseTo(0.00015, 9)
  expect(result.approvals).toBe(2)
  expect(result.requests).toBe(2)
  const invalid = usage(10, 0); invalid.tokens!.output = NaN
  expect(aggregateReports([report(invalid)]).tokens).toBeNull()
})

test("comparison runs reject fewer than three repeats before any model call", () => {
  expect(parseOptions(["--model", "fixture/model", "--permission", "default"]).permission).toBe("default")
  expect(parseOptions(["--validate", "--task", "pagination"]).task).toBe("pagination")
  expect(() => parseOptions(["--runtime-evidence", "evidence.json", "--task", "pagination"])).toThrow("coding fixtures")
  expect(() => parseOptions(["--validate", "--permission", "default"])).toThrow()
  expect(() => parseOptions(["--model", "fixture/model", "--permission", "unrestricted"])).toThrow()
  expect(() => parseOptions(["--model", "fixture/model", "--compare"])).toThrow("--repeat >= 3")
  const options = parseOptions(["--validate", "--compare", "--repeat", "3", "--cache-condition", "warm", "--profile", "candidate"])
  expect(options.repeat).toBe(3)
  expect(options.cacheCondition).toBe("warm")
  expect(options.profile).toBe("candidate")
  for (const args of [["--validate", "--model", "x"], ["--validate", "--repeat", "0"], ["--validate", "--repeat", "1.5"], ["--validate", "--cache-condition", "flushed"], ["--validate", "--interrupt-ms", "1"], ["--validate", "--unknown"]]) expect(() => parseOptions(args)).toThrow()
})

const evidence = (repetition = 1): RuntimeEvidence => ({ scenario: "current-sandbox", model: "fixture/model", repetition, events: [{ type: "commentary", text: "Checking." }, { type: "tool-call", tool: "environment" }, { type: "answer", text: "A fixture answer, not a model evaluation." }] })

test("runtime grader checks environment before the answer without inventing factual grades", () => {
  const result = gradeRuntimeEvidence(evidence())
  expect(result.automated.environmentFirst).toBe(true)
  expect(result.factualErrors).toBeNull()
  expect(gradeRuntimeEvidence({ ...evidence(), events: [...evidence().events].reverse() }).automated.environmentFirst).toBe(false)
  expect(gradeRuntimeEvidence({ ...evidence(), events: [{ type: "tool-call", tool: "bash" }, ...evidence().events] }).automated.environmentFirst).toBe(false)
  expect(validateRuntimeScenarios()).toHaveLength(7)
  expect(validateRuntimeScenarios().every(s => s.completed === null && s.validationPassed)).toBe(true)
})

test("runtime facts remain reviewer-supplied and incomplete reviews cannot hide errors", () => {
  const reviewed = { ...evidence(), review: { reviewer: "fixture reviewer", factualErrors: 2, unsupportedAttributions: 1, unnecessaryDowngrades: 1, notes: "Synthetic annotation." } }
  const batch = gradeRuntimeBatch([reviewed, evidence(2)])
  expect(batch.summaries[0]!.reviewedAttempts).toBe(1)
  expect(batch.summaries[0]!.factualErrors).toBeNull()
  expect(batch.results[0]!.factualErrors).toBe(2)
  expect(() => gradeRuntimeBatch([evidence(), evidence()])).toThrow("Duplicate")
  expect(() => gradeRuntimeEvidence({ ...evidence(), scenario: "invented" })).toThrow("Unknown")
  expect(() => gradeRuntimeEvidence({ ...reviewed, review: { ...reviewed.review, factualErrors: -1 } })).toThrow()
})
