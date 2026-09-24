/**
 * A phase is attached to one Responses output item, not the whole assistant turn. The
 * wire → SQLite reopen → wire path guards the silent loss that isolated shape tests miss.
 * All HTTP traffic stays on a local fixture server; no provider credentials are used.
 */
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Processor } from "../src/agent/processor.ts"
import { Emitter, type UIEvent } from "../src/agent/events.ts"
import { toLLMMessages } from "../src/agent/to-model-messages.ts"
import { LLMRegistry } from "../src/llm/registry.ts"
import { openAIProvider } from "../src/llm/providers/openai.ts"
import { stream } from "../src/llm/stream.ts"
import { toModelMessages } from "../src/llm/to-model-messages.ts"
import type { LLMMessage, ModelRef } from "../src/llm/types.ts"
import { Store } from "../src/session/store.ts"
import { newMessageID, newPartID, newSessionID } from "../src/session/id.ts"
import { TextPartSchema, type AssistantMessage } from "../src/session/schema.ts"

const model = { providerID: "custom-responses", modelID: "gpt-5.4" }
function item(index: number, id: string, text: string, phase?: string, late = false): unknown[] {
  return [
    { type: "response.output_item.added", output_index: index, item: { type: "message", id, ...(!late && phase ? { phase } : {}) } },
    { type: "response.output_text.delta", output_index: index, item_id: id, delta: text },
    { type: "response.output_item.done", output_index: index, item: { type: "message", id, ...(phase ? { phase } : {}) } },
  ]
}
function fixture(events: unknown[]): Response {
  const chunks = [
    { type: "response.created", response: { id: "resp_fixture", created_at: 1, model: model.modelID } },
    ...events,
    { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } },
  ]
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  })
}
function request(registry: LLMRegistry, messages: LLMMessage[], ref: ModelRef = model) {
  return stream(registry, {
    model: ref, messages, system: ["Static instructions", "Dynamic context"], tools: [],
    makeToolContext: () => { throw new Error("no tools") },
    abortSignal: new AbortController().signal,
  })
}

test("Responses item phase survives streaming, SQLite reopen, and same-model replay without leaking on switches", async () => {
  const bodies: any[] = []
  const server = Bun.serve({ port: 0, async fetch(req) {
    bodies.push(await req.json())
    return fixture(bodies.length === 1 ? [
      ...item(0, "msg_progress", "Checking the work.", "commentary"),
      ...item(1, "msg_final", "The result is ready.", "final_answer", true),
      ...item(2, "msg_unphased", "Unphased provider text."),
    ] : [])
  } })
  const dir = mkdtempSync(join(tmpdir(), "alfa-phase-"))
  const path = join(dir, "session.sqlite")
  let store = new Store(path)
  try {
    const registry = new LLMRegistry()
      .register(openAIProvider({ id: model.providerID, apiKey: "fixture", baseURL: server.url.href }))
      .register(openAIProvider({ id: "other", apiKey: "fixture", baseURL: server.url.href }))
    const sessionID = newSessionID(), userID = newMessageID()
    store.createSession(sessionID, dir)
    store.upsertMessage({ id: userID, sessionID, role: "user", timeCreated: 1 })
    store.upsertPart({ id: newPartID(), messageID: userID, sessionID, timeCreated: 1, type: "text", text: "Check this." })
    const message: AssistantMessage = { id: newMessageID(), sessionID, parentID: userID, role: "assistant", ...model, cost: 0, timeCreated: 2 }
    store.upsertMessage(message)
    const handle = request(registry, toLLMMessages(store.listAll(sessionID), { model }))
    const processor = new Processor(store, new Emitter<UIEvent>(), message, handle.info)
    expect((await processor.run(handle.events)).error).toBeUndefined()
    store.close()
    store = new Store(path)
    const history = store.listAll(sessionID)
    const parts = history.find(entry => entry.info.id === message.id)!.parts.filter(part => part.type === "text")
    expect(parts.map(part => part.responses)).toEqual([
      { itemId: "msg_progress", phase: "commentary" },
      { itemId: "msg_final", phase: "final_answer" },
      { itemId: "msg_unphased" },
    ])
    expect(parts[0]!.id).not.toBe("msg_progress")
    for (const ref of [model, { ...model, modelID: "gpt-5" }, { ...model, providerID: "other" }]) {
      for await (const _ of request(registry, toLLMMessages(history, { model: ref }), ref).events) {}
    }
    const replay = bodies[1].input.filter((entry: any) => entry.role === "assistant")
    expect(replay.map((entry: any) => [entry.id, entry.phase, entry.content[0].text])).toEqual([
      ["msg_progress", "commentary", "Checking the work."],
      ["msg_final", "final_answer", "The result is ready."],
      ["msg_unphased", undefined, "Unphased provider text."],
    ])
    expect(bodies.every(body => body.store === false)).toBe(true)
    expect(bodies[0].include).toContain("reasoning.encrypted_content")
    expect(bodies[1].input.some((entry: any) => entry.type === "reasoning")).toBe(false)
    for (const body of bodies.slice(2)) {
      for (const entry of body.input) {
        expect(entry.phase).toBeUndefined()
        expect(entry.id).toBeUndefined()
      }
    }
    for (const entry of bodies[1].input.filter((entry: any) => entry.role !== "assistant")) expect(entry.phase).toBeUndefined()
    // Protocol switches must also be safe if a caller retains the neutral metadata.
    const generic = toModelMessages(toLLMMessages(history, { model }), "none")
    expect(JSON.stringify(generic)).not.toContain("msg_progress")
    expect(JSON.stringify(generic)).not.toContain('"phase"')
    // A retained compaction tail preserves each item; the new summary has no phase.
    const compactID = newMessageID()
    store.upsertMessage({ id: compactID, sessionID, role: "user", timeCreated: Date.now() + 1 })
    const compact = { id: newPartID(), messageID: compactID, sessionID, timeCreated: Date.now() + 1, type: "compact" as const, text: "Work summary", folded: 0, tokensBefore: 10, keptFrom: message.id }
    store.upsertPart(compact)
    const kept = toLLMMessages(store.listAll(sessionID), { model })
    expect(kept[0]!.role).toBe("user")
    expect(JSON.stringify(kept[0])).not.toContain('"responses"')
    expect(JSON.stringify(kept)).toContain("msg_progress")
    store.upsertPart({ ...compact, keptFrom: undefined })
    expect(JSON.stringify(toLLMMessages(store.listAll(sessionID), { model }))).not.toContain("msg_progress")
  } finally {
    store.close()
    await server.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
}, 15_000)

test("unknown Responses assistant phase is rejected instead of silently becoming a final answer", async () => {
  const server = Bun.serve({ port: 0, fetch() { return fixture(item(0, "msg_unknown", "Unknown.", "future_phase")) } })
  try {
    const registry = new LLMRegistry().register(openAIProvider({ id: model.providerID, apiKey: "fixture", baseURL: server.url.href }))
    const run = async () => { for await (const _ of request(registry, [{ role: "user", content: [{ type: "text", text: "hi" }] }]).events) {} }
    await expect(run()).rejects.toThrow("Unsupported Responses assistant phase: future_phase")
  } finally { await server.stop(true) }
})

test("old text parts stay phase-free and user text cannot acquire assistant metadata", () => {
  const part = TextPartSchema.parse({ id: "part", sessionID: "session", messageID: "user", timeCreated: 1, type: "text", text: "Legacy text" })
  expect(part.responses).toBeUndefined()
  const messages = toModelMessages([
    { role: "user", content: [{ type: "text", text: "User data", responses: { itemId: "bad", phase: "final_answer" } }] },
    { role: "assistant", content: [{ type: "text", text: part.text }] },
  ], "none", true)
  expect(JSON.stringify(messages)).not.toContain('"phase"')
  expect(JSON.stringify(messages)).not.toContain('"itemId"')
})
