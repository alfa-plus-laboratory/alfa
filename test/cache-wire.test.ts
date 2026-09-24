/**
 * The SDK owns final serialization, so unit snapshots before streamText cannot prove cache
 * measurements describe the request. A local Responses endpoint tests the actual wire and
 * raw usage, including failures and missing fields, without provider credentials.
 */
import { expect, test } from "bun:test"
import { z } from "zod"
import { LLMRegistry } from "../src/llm/registry.ts"
import { openAIProvider } from "../src/llm/providers/openai.ts"
import { stream } from "../src/llm/stream.ts"
import { observeUsage, type UsageRecord } from "../src/llm/usage.ts"
import type { AgentExecutionContext, LLMMessage } from "../src/llm/types.ts"
import type { ToolDef } from "../src/tool/types.ts"

const model = { providerID: "cache-fixture", modelID: "gpt-5.4" }
const message = (text: string): LLMMessage => ({ role: "user", content: [{ type: "text", text }] })
const rawUsage = { input_tokens: 2048, output_tokens: 3, input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 512 } }
function fixture(usage: unknown = rawUsage) {
  const events = [
    { type: "response.created", response: { id: "response-fixture", model: model.modelID, created_at: 1 } },
    { type: "response.completed", response: { ...(usage !== null ? { usage } : {}) } },
  ]
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
}
function registry(baseURL: string, apiKey = "fixture-secret") {
  return new LLMRegistry().register(openAIProvider({ id: model.providerID, apiKey, baseURL }))
}
async function run(registry: LLMRegistry, options: { messages?: LLMMessage[]; tools?: ToolDef<any>[]; modelID?: string; thinking?: boolean; execution?: AgentExecutionContext; signal?: AbortSignal } = {}) {
  const handle = stream(registry, {
    model: { ...model, modelID: options.modelID ?? model.modelID }, system: ["Private static instructions", "Private dynamic instructions"],
    execution: options.execution, messages: options.messages ?? [message("Private question")], tools: options.tools ?? [], thinking: options.thinking,
    makeToolContext: () => { throw new Error("unexpected tool") }, abortSignal: options.signal ?? new AbortController().signal,
  })
  for await (const _ of handle.events) {}
}

test("report opt-in observes final Responses bytes without changing requests or leaking credentials", async () => {
  const bodies: string[] = []
  const server = Bun.serve({ port: 0, async fetch(req) { bodies.push(await req.text()); return fixture() } })
  const records: UsageRecord[] = []
  let stop = observeUsage(record => records.push(record))
  try {
    const llm = registry(server.url.href)
    await run(llm)
    expect(records[0]!.cache).toBeUndefined()
    stop()
    stop = observeUsage(record => records.push(record), { cache: true })
    await run(llm, { execution: { requestKind: "main", runId: "local-only-run", sessionId: "local-only-session", depth: 0 } })
    await run(llm, { execution: { requestKind: "compaction", runId: "different-local-run" } })
    expect(records[1]!.execution!.runId).toBe("local-only-run")
    expect(records[2]!.execution!.requestKind).toBe("compaction")
    expect(records[1]!.requestId).not.toBe(records[2]!.requestId)
    expect(bodies[1]).not.toContain("local-only")
    expect(bodies[0]).toBe(bodies[1])
    expect(bodies[1]).toBe(bodies[2])
    const first = records[1]!.cache!, second = records[2]!.cache!
    expect(first.actual).toEqual({ totalInputTokens: 2048, cacheReadTokens: 1024, cacheWriteTokens: 512, uncachedInputTokens: 512 })
    expect(second.candidateRequestId).toBe(first.requestId)
    expect(second.estimated.structuralReusableTokens).toBe(2048)
    expect(second.ratios.ACHR).toBe(0.5)
    const report = JSON.stringify(records)
    for (const secret of ["fixture-secret", "Private question", "Private static", server.url.href]) expect(report).not.toContain(secret)
    expect(JSON.parse(bodies[1]!).store).toBe(false)
  } finally { stop(); await server.stop(true) }
})

test("wire snapshots find append-only history and changed SDK tool definitions", async () => {
  const server = Bun.serve({ port: 0, fetch() { return fixture() } })
  const records: UsageRecord[] = []
  const stop = observeUsage(record => records.push(record), { cache: true })
  const tool = (description: string): ToolDef<any> => ({ id: "fixture", description, parameters: z.object({ path: z.string() }), async execute() { return { output: "unused", title: "fixture", metadata: { truncated: false } } } })
  try {
    const llm = registry(server.url.href)
    await run(llm, { tools: [tool("Read a file")] })
    await run(llm, { tools: [tool("Read a file")], messages: [message("Private question"), message("Next question")] })
    expect(records[1]!.cache!.reasonCodes).toContain("new_suffix_only")
    expect(records[1]!.cache!.estimated.structuralReusableTokens).toBe(2048)
    await run(llm, { tools: [tool("Read a file.")] })
    expect(records[2]!.cache!.firstMismatch?.current).toBe("tools")
    expect(records[2]!.cache!.reasonCodes).toContain("tool_definition_changed")
  } finally { stop(); await server.stop(true) }
})

test("wire scope isolates actual account, endpoint, selected model and thinking settings", async () => {
  const server = Bun.serve({ port: 0, fetch() { return fixture() } })
  const records: UsageRecord[] = []
  const stop = observeUsage(record => records.push(record), { cache: true })
  try {
    const llm = registry(server.url.href)
    await run(llm)
    await run(registry(server.url.href, "another-account"))
    await run(registry(`${server.url.href}another-base/`))
    await run(llm, { modelID: "gpt-5.5" })
    await run(llm, { thinking: true })
    for (const record of records.slice(1)) {
      expect(record.cache!.candidateRequestId).toBeUndefined()
      expect(record.cache!.reasonCodes).toContain("model_or_scope_changed")
    }
    await run(llm)
    expect(records[5]!.cache!.candidateRequestId).toBe(records[0]!.cache!.requestId)
  } finally { stop(); await server.stop(true) }
})

test("missing raw usage and HTTP failure remain unknown rather than fabricated zero cache tokens", async () => {
  let calls = 0
  const server = Bun.serve({ port: 0, fetch() {
    calls++
    if (calls === 1) return fixture({ input_tokens: 10, output_tokens: 3 })
    if (calls === 2) return fixture(null)
    return new Response(JSON.stringify({ error: { message: "fixture failure" } }), { status: 503, headers: { "content-type": "application/json" } })
  } })
  const records: UsageRecord[] = []
  const stop = observeUsage(record => records.push(record), { cache: true })
  try {
    const llm = registry(server.url.href)
    await run(llm)
    await run(llm)
    await run(llm)
    expect(records[0]!.cache!.actual.cacheReadTokens).toBeNull()
    expect(records[0]!.cache!.actual.cacheWriteTokens).toBeNull()
    for (const record of records.slice(1)) {
      expect(record.cache!.actual.totalInputTokens).toBeNull()
      expect(record.cache!.ratios.ACHR).toBeNull()
      expect(record.cache!.reasonCodes).toContain("usage_unknown")
    }
  } finally { stop(); await server.stop(true) }
})

test("an aborted in-flight request keeps a captured unknown-usage diagnostic", async () => {
  const controller = new AbortController()
  const server = Bun.serve({ port: 0, async fetch() {
    controller.abort()
    return fixture()
  } })
  const records: UsageRecord[] = []
  const stop = observeUsage(record => records.push(record), { cache: true })
  try {
    await run(registry(server.url.href), { signal: controller.signal })
    expect(records).toHaveLength(1)
    expect(records[0]!.cache!.actual.totalInputTokens).toBeNull()
    expect(records[0]!.cache!.reasonCodes).toContain("usage_unknown")
  } finally { stop(); await server.stop(true) }
})


test("concurrent SDK fetches keep request-local tickets and observe a cold prefix already in flight", async () => {
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const server = Bun.serve({ port: 0, async fetch() {
    if (++calls === 2) release()
    await barrier
    return fixture()
  } })
  const records: UsageRecord[] = []
  const stop = observeUsage(record => records.push(record), { cache: true })
  try {
    const llm = registry(server.url.href)
    await Promise.all([run(llm), run(llm)])
    expect(records).toHaveLength(2)
    expect(new Set(records.map(record => record.cache!.requestId)).size).toBe(2)
    expect(records.some(record => record.cache!.reasonCodes.includes("candidate_write_in_flight"))).toBe(true)
    expect(records.every(record => record.cache!.estimated.structuralReusableTokens === null)).toBe(true)
  } finally { release(); stop(); await server.stop(true) }
})

test("usage records retain final transmitted effort and effort changes isolate cache candidates", async () => {
  const bodies: any[] = []
  const server = Bun.serve({ port: 0, async fetch(req) { bodies.push(await req.json()); return fixture() } })
  const records: UsageRecord[] = []
  const stop = observeUsage(record => records.push(record), { cache: true })
  const provider = openAIProvider({ id: model.providerID, apiKey: "fixture", baseURL: server.url.href })
  const resolve = provider.resolve.bind(provider)
  let effort = "low"
  provider.resolve = (modelID, options) => {
    const resolved = resolve(modelID, options)
    return { ...resolved, providerOptions: { ...resolved.providerOptions, openai: { ...resolved.providerOptions?.openai, reasoningEffort: effort } } }
  }
  try {
    const llm = new LLMRegistry().register(provider)
    await run(llm)
    effort = "high"
    await run(llm)
    expect(bodies[0].reasoning.effort).toBe("low")
    expect(bodies[1].reasoning.effort).toBe("high")
    expect(records.map(record => record.effort?.level)).toEqual(["low", "high"])
    expect(records[1]!.cache!.candidateRequestId).toBeUndefined()
  } finally { stop(); await server.stop(true) }
})
