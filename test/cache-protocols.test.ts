/**
 * These local SSE endpoints exercise the installed SDKs, not pre-serialization guesses.
 * Raw observation must survive SDK field stripping without changing transmitted requests,
 * and partial Anthropic cache-prefix measurements must never include the uncached suffix.
 * A fully matching prior request can instead anchor its entire normalized input.
 */
import { expect, test } from "bun:test"
import { LLMRegistry } from "../src/llm/registry.ts"
import { anthropicProvider } from "../src/llm/providers/anthropic.ts"
import { openAICompatProvider } from "../src/llm/providers/openai-compat.ts"
import type { LLMMessage } from "../src/llm/types.ts"
import { stream } from "../src/llm/stream.ts"
import { observeUsage, type UsageRecord } from "../src/llm/usage.ts"
import { protocolCacheUsage, type CacheProtocol } from "../src/llm/cache/protocols.ts"

const chatUsage = { prompt_tokens: 1000, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 200 } }
const anthropicUsage = { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 500, cache_creation_input_tokens: 300 }
function response(protocol: CacheProtocol, missing = false) {
  const events = protocol === "anthropic" ? [
    { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: "fixture-model", content: [], stop_reason: null, stop_sequence: null, usage: missing ? { input_tokens: 100, output_tokens: 0 } : anthropicUsage } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: missing ? { output_tokens: 3 } : { output_tokens: 3, cache_read_input_tokens: 600 } },
    { type: "message_stop" },
  ] : [
    { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
    { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: missing ? { prompt_tokens: 1000, completion_tokens: 3 } : chatUsage },
  ]
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("") + (protocol === "anthropic" ? "" : "data: [DONE]\n\n"), { headers: { "content-type": "text/event-stream" } })
}
const registry = (protocol: CacheProtocol, baseURL: string, apiKey = "private-fixture-key") => new LLMRegistry().register(
  protocol === "anthropic" ? anthropicProvider({ id: "fixture", baseURL, apiKey }) : openAICompatProvider({ id: "fixture", baseURL, apiKey }),
)
async function run(llm: LLMRegistry, text = "private-prompt", messages?: LLMMessage[]) {
  const handle = stream(llm, { model: { providerID: "fixture", modelID: "fixture-model" }, system: ["private-system", "dynamic-system"], messages: messages ?? [{ role: "user", content: [{ type: "text", text }] }], tools: [], makeToolContext: () => { throw new Error("unexpected tool") }, abortSignal: new AbortController().signal })
  for await (const _ of handle.events) {}
}

for (const protocol of ["anthropic", "openai-chat"] as const) {
  test(`${protocol} captures actual final requests, scopes candidates and preserves raw usage without secrets`, async () => {
    const bodies: string[] = []
    const server = Bun.serve({ port: 0, async fetch(req) { bodies.push(await req.text()); return response(protocol) } })
    const records: UsageRecord[] = []
    let stop = observeUsage(r => records.push(r))
    try {
      const llm = registry(protocol, server.url.href)
      await run(llm)
      expect(records[0]!.cache).toBeUndefined()
      stop(); stop = observeUsage(r => records.push(r), { cache: true })
      await run(llm); await run(llm)
      expect(bodies[0]).toBe(bodies[1])
      expect(bodies[1]).toBe(bodies[2])
      const first = records[1]!.cache!, second = records[2]!.cache!
      expect(first.protocol).toBe(protocol)
      expect(first.actual.totalInputTokens).toBe(1000)
      expect(first.actual.cacheReadTokens).toBe(600)
      expect(first.actual.cacheWriteTokens).toBe(protocol === "anthropic" ? 300 : 200)
      expect(first.actual.uncachedInputTokens).toBe(protocol === "anthropic" ? 100 : 200)
      expect(second.candidateRequestId).toBe(first.requestId)
      expect(second.estimated.structuralReusableTokens).toBe(protocol === "anthropic" ? 900 : 1000)
      if (protocol === "anthropic") expect(first.breakpoints!.length).toBeGreaterThan(0)
      await run(llm, "different-message")
      expect(records[3]!.cache!.firstMismatch).toBeDefined()
      expect(records[3]!.cache!.estimated.structuralReusableTokens).toBeNull()
      await run(registry(protocol, server.url.href, "different-key"))
      expect(records[4]!.cache!.candidateRequestId).toBeUndefined()
      for (const secret of ["private-prompt", "private-system", "private-fixture-key", "different-key", server.url.href]) expect(JSON.stringify(records)).not.toContain(secret)
    } finally { stop(); await server.stop(true) }
  })

  test(`${protocol} missing cache fields remain unknown even when the SDK normalizes them to zero`, async () => {
    const server = Bun.serve({ port: 0, fetch() { return response(protocol, true) } })
    const records: UsageRecord[] = []
    const stop = observeUsage(r => records.push(r), { cache: true })
    try {
      await run(registry(protocol, server.url.href))
      expect(records[0]!.cache!.actual.cacheReadTokens).toBeNull()
      expect(records[0]!.cache!.actual.cacheWriteTokens).toBeNull()
      expect(records[0]!.cache!.actual.totalInputTokens).toBe(protocol === "anthropic" ? null : 1000)
    } finally { stop(); await server.stop(true) }
  })
}

test("protocol accounting does not reuse another protocol's fields or fabricate multi-iteration totals", () => {
  expect(protocolCacheUsage("anthropic", chatUsage).totalInputTokens).toBeNull()
  expect(protocolCacheUsage("openai-chat", anthropicUsage).cacheReadTokens).toBeNull()
  expect(protocolCacheUsage("anthropic", { ...anthropicUsage, iterations: [{}] }).totalInputTokens).toBeNull()
  expect(protocolCacheUsage("openai-chat", { prompt_tokens: 1000, prompt_cache_hit_tokens: 700 }).cacheReadTokens).toBe(700)
})

for (const protocol of ["anthropic", "openai-chat"] as const) {
  test(`${protocol} ordinary multi-turn growth keeps measured prefix ceilings including moved breakpoints`, async () => {
    const bodies: Record<string, any>[] = []
    const server = Bun.serve({ port: 0, async fetch(req) { bodies.push(await req.json() as Record<string, any>); return response(protocol) } })
    const records: UsageRecord[] = []
    const stop = observeUsage(r => records.push(r), { cache: true })
    const messages: LLMMessage[] = [{ role: "user", content: [{ type: "text", text: "first" }] }]
    try {
      const llm = registry(protocol, server.url.href)
      for (let turn = 0; turn < 4; turn++) {
        await run(llm, "unused", messages)
        messages.push({ role: "assistant", content: [{ type: "text", text: `answer ${turn}` }] }, { role: "user", content: [{ type: "text", text: `question ${turn}` }] })
      }
      expect(records[0]!.cache!.estimated.structuralReusableTokens).toBeNull()
      for (const r of records.slice(1)) {
        expect(r.cache!.estimated.structuralReusableTokens).toBe(protocol === "anthropic" ? 900 : 1000)
        expect(r.cache!.estimated.basis).toBe(protocol === "anthropic" ? "measured-cache-prefix" : "measured-input-prefix")
      }
      if (protocol === "anthropic") {
        expect(bodies[0]!.messages[0].content[0].cache_control).toBeDefined()
        expect(bodies[3]!.messages[0].content[0].cache_control).toBeUndefined()
      }
    } finally { stop(); await server.stop(true) }
  })
}

test("effort parsing follows each protocol's transmitted field and never infers a model default", async () => {
  const { requestEffort } = await import("../src/llm/cache/protocols.ts")
  expect(requestEffort("openai-responses", { reasoning: { effort: "high" } }).level).toBe("high")
  expect(requestEffort("openai-chat", { reasoning_effort: "low" }).level).toBe("low")
  expect(requestEffort("anthropic", { output_config: { effort: "max" }, thinking: { type: "enabled", budget_tokens: 4096 } })).toEqual({ level: "max", thinking: "enabled", budgetTokens: 4096 })
  expect(requestEffort("openai-responses", { model: "a-reasoning-model", reasoning: { summary: "auto" } })).toEqual({ level: null, thinking: null, budgetTokens: null })
})


test("Anthropic nullable stream updates preserve measured input and cache counters but accept explicit zero", async () => {
  let calls = 0
  const server = Bun.serve({ port: 0, async fetch() {
    calls++
    const source = await response("anthropic").text()
    const replacement = calls === 3
      ? { input_tokens: null, output_tokens: 3, cache_creation_input_tokens: null, cache_read_input_tokens: 0 }
      : { input_tokens: null, output_tokens: 3, cache_creation_input_tokens: null, cache_read_input_tokens: null }
    return new Response(source.replace(JSON.stringify({ output_tokens: 3, cache_read_input_tokens: 600 }), JSON.stringify(replacement)), { headers: { "content-type": "text/event-stream" } })
  } })
  const records: UsageRecord[] = []
  const stop = observeUsage(record => records.push(record), { cache: true })
  try {
    const llm = registry("anthropic", server.url.href)
    await run(llm); await run(llm); await run(llm)
    for (const record of records.slice(0, 2)) {
      expect(record.cache!.actual.totalInputTokens).toBe(900)
      expect(record.cache!.actual.cacheReadTokens).toBe(500)
      expect(record.cache!.actual.cacheWriteTokens).toBe(300)
      expect(record.cache!.ratios.ACHR).toBeCloseTo(500 / 900)
    }
    expect(records[1]!.cache!.estimated.structuralReusableTokens).toBe(800)
    expect(records[2]!.cache!.actual.cacheReadTokens).toBe(0)
    expect(records[2]!.cache!.actual.totalInputTokens).toBe(400)
  } finally { stop(); await server.stop(true) }
})

test("omitted Anthropic cache-write usage keeps SDK input totals usable without inventing raw writes", async () => {
  const server = Bun.serve({ port: 0, async fetch() {
    const source = (await response("anthropic").text())
      .replace(JSON.stringify(anthropicUsage), JSON.stringify({ input_tokens: 583, output_tokens: 0, cache_read_input_tokens: 27073 }))
      .replace(JSON.stringify({ output_tokens: 3, cache_read_input_tokens: 600 }), JSON.stringify({ output_tokens: 1279 }))
    return new Response(source, { headers: { "content-type": "text/event-stream" } })
  } })
  const records: UsageRecord[] = []
  const stop = observeUsage(record => records.push(record), { cache: true })
  const messages: LLMMessage[] = [{ role: "user", content: [{ type: "text", text: "first request" }] }]
  try {
    const llm = registry("anthropic", server.url.href)
    await run(llm, "unused", messages)
    messages.push({ role: "assistant", content: [{ type: "text", text: "reply" }] }, { role: "user", content: [{ type: "text", text: "continue" }] })
    await run(llm, "unused", messages)
    for (const record of records) {
      expect(record.measuredOutputTokens).toBe(1279)
      expect(record.cache!.actual.totalInputTokens).toBe(27656)
      expect(record.cache!.actual.cacheReadTokens).toBe(27073)
      expect(record.cache!.actual.cacheWriteTokens).toBeNull()
      expect(record.cache!.rawActual!.totalInputTokens).toBeNull()
      expect(record.cache!.inputTokenSource).toBe("sdk-normalized")
      expect(record.cache!.ratios.ACHR).toBeCloseTo(27073 / 27656)
      expect(record.cache!.reasonCodes).not.toContain("usage_unknown")
    }
    expect(records[0]!.cache!.estimated.structuralReusableTokens).toBeNull()
    expect(records[1]!.cache!.estimated.structuralReusableTokens).toBe(27656)
    expect(records[1]!.cache!.estimated.basis).toBe("measured-input-prefix")
    expect(records[1]!.cache!.reasonCodes).toContain("new_suffix_only")
    const { Diagnostics } = await import("../src/llm/diagnostics.ts")
    const { renderCacheMetrics } = await import("../src/cli/context.ts")
    const ledger = new Diagnostics()
    records.forEach(record => ledger.add(record))
    const overview = renderCacheMetrics(ledger.snapshot(), "all")
    expect(overview).toContain("98%")
    expect(overview).toContain("SDK")
  } finally { stop(); await server.stop(true) }
})
