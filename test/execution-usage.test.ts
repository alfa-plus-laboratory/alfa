/**
 * Auxiliary calls and unknown usage must not disappear behind a cache hit percentage.
 * These accounting tests use measured counters only and do not infer inherited tokens.
 */
import { expect, test } from "bun:test"
import { aggregateExecutionUsage } from "../src/llm/execution-usage.ts"
import type { UsageRecord } from "../src/llm/usage.ts"
import type { AgentExecutionContext, LLMRequest } from "../src/llm/types.ts"
import { createLLMClassifier } from "../src/permission/auto/llm.ts"
import { QUESTIONS } from "../src/permission/auto/rubric.ts"

const record = (kind: AgentExecutionContext["requestKind"], input: number | null, child = false): UsageRecord => ({
  model: { providerID: "fixture", modelID: "fixture" }, elapsedMs: 1, cacheInInput: true, measuredInputTokens: input,
  execution: { requestKind: kind, runId: crypto.randomUUID(), sessionId: child ? "child" : "root", rootSessionId: "root", depth: child ? 1 : 0 },
})
test("amplification includes child and auxiliary input with a measured root denominator", () => {
  const result = aggregateExecutionUsage([record("main", 100), record("subagent", 200, true), record("compaction", 50)])
  expect(result.sessions[0]!.contextAmplification).toBe(3.5)
  expect(result.sessions[0]!.byKind.subagent!.measuredInputTokens).toBe(200)
})
test("failed, unattributed and missing-root calls cannot produce a complete amplification ratio", () => {
  expect(aggregateExecutionUsage([record("main", 100), record("review", null)]).sessions[0]!.contextAmplification).toBeNull()
  expect(aggregateExecutionUsage([record("subagent", 100, true)]).sessions[0]!.contextAmplification).toBeNull()
  const unowned = { ...record("other", 100), execution: undefined }
  const result = aggregateExecutionUsage([record("main", 100), unowned])
  expect(result.unattributedRequests).toBe(1)
  expect(result.sessions[0]!.contextAmplification).toBeNull()
  // A later successful retry cannot replace the unknown first root request denominator.
  expect(aggregateExecutionUsage([record("main", null), record("main", 100)]).sessions[0]!.rootInputTokens).toBeNull()
})
test("review identities remain separate from the model-visible evidence", async () => {
  const seen: LLMRequest[] = []
  const stream = (request: LLMRequest) => {
    seen.push(request)
    return { info: { ref: request.model, limit: { context: 10000, output: 1000 }, supportsThinking: false, promptTemplate: "default" as const, cacheInInput: true },
      events: (async function* () { yield { type: "text-delta" as const, id: "text", text: request.execution?.requestKind === "review" ? JSON.stringify(Object.fromEntries(QUESTIONS.map(question => [question.id, 0]))) : "Summary" } })() }
  }
  const classifier = createLLMClassifier({ stream, model: () => ({ spec: "fixture/fixture", ref: { providerID: "fixture", modelID: "fixture" } }) })
  await classifier.score({ workspace: "/tmp", operation: { tool: "write", targets: [], details: {} }, user: { messages: [], answers: [] } }, QUESTIONS, new AbortController().signal, { sessionId: "trace-only-child", parentAgentInstanceId: "trace-only-parent", depth: 1 })
  expect(seen[0]!.execution!.requestKind).toBe("review")
  expect(seen[0]!.execution!.sessionId).toBe("trace-only-child")
  for (const request of seen) expect(JSON.stringify({ system: request.system, messages: request.messages })).not.toContain("trace-only")
})
