/**
 * Native patch calls are not function calls on the Responses wire. Exercise the SDK,
 * real executor, SQLite reopen and replay together: a string-only success or error
 * output silently selects the wrong wire item type despite looking valid locally.
 */
import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ApplyPatchTool } from "../src/tool/apply-patch.ts"
import { createToolContext } from "../src/tool/context.ts"
import { LLMRegistry } from "../src/llm/registry.ts"
import { openAIProvider } from "../src/llm/providers/openai.ts"
import { stream } from "../src/llm/stream.ts"
import { Processor } from "../src/agent/processor.ts"
import { Emitter, type UIEvent } from "../src/agent/events.ts"
import { toLLMMessages } from "../src/agent/to-model-messages.ts"
import { Store } from "../src/session/store.ts"
import { newMessageID, newPartID, newSessionID } from "../src/session/id.ts"
import type { AssistantMessage } from "../src/session/schema.ts"
import type { LLMMessage } from "../src/llm/types.ts"

const model = { providerID: "native-patch-fixture", modelID: "codex-fixture" }
const operation = { type: "create_file", path: "created.ts", diff: "+export const created = true\n" }
function fixture(patch: boolean): Response {
  const item = { id: "ap_item_fixture", type: "apply_patch_call", call_id: "call_patch_fixture", operation }
  const events = [
    { type: "response.created", response: { id: "resp_fixture", created_at: 1, model: model.modelID } },
    ...(patch ? [
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } },
      { type: "response.output_item.done", output_index: 0, item: { ...item, status: "completed" } },
    ] : []),
    { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } },
  ]
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
}

for (const fails of [false, true]) test(`native patch ${fails ? "failure" : "success"} survives execution and persisted Responses replay`, async () => {
  const bodies: any[] = []
  const server = Bun.serve({ port: 0, async fetch(req) { bodies.push(await req.json()); return fixture(bodies.length === 1) } })
  const dir = mkdtempSync(join(tmpdir(), "alfa-native-patch-")), path = join(dir, "session.sqlite")
  let store = new Store(path)
  try {
    if (fails) writeFileSync(join(dir, "created.ts"), "user content")
    const registry = new LLMRegistry().register(openAIProvider({ id: model.providerID, apiKey: "fixture", baseURL: server.url.href, models: { [model.modelID]: { promptProfile: "openai-codex" } } }))
    const sessionID = newSessionID(), userID = newMessageID()
    store.createSession(sessionID, dir)
    store.upsertMessage({ id: userID, sessionID, role: "user", timeCreated: 1 })
    store.upsertPart({ id: newPartID(), messageID: userID, sessionID, timeCreated: 1, type: "text", text: "Create the fixture file." })
    const assistant: AssistantMessage = { id: newMessageID(), sessionID, parentID: userID, role: "assistant", ...model, cost: 0, timeCreated: 2 }
    store.upsertMessage(assistant)
    let processor: Processor
    const request = (messages: LLMMessage[], modelID = model.modelID) => stream(registry, {
      model: { ...model, modelID }, system: ["Fixture"], messages, tools: [ApplyPatchTool], abortSignal: new AbortController().signal,
      makeToolContext: call => createToolContext({ cwd: dir, root: dir, sessionID, ask: async () => {}, onProgress() {}, onMetadata: (id, metadata) => processor.setToolMetadata(id, metadata) }, { ...call, messageID: assistant.id }),
    })
    const handle = request(toLLMMessages(store.listAll(sessionID), { model }))
    processor = new Processor(store, new Emitter<UIEvent>(), assistant, handle.info)
    await processor.run(handle.events)
    expect(bodies[0].tools).toEqual([{ type: "apply_patch" }])
    expect(readFileSync(join(dir, "created.ts"), "utf8")).toBe(fails ? "user content" : "export const created = true\n")
    store.close(); store = new Store(path)
    const history = store.listAll(sessionID)
    const saved = history.find(entry => entry.info.id === assistant.id)!.parts.find(part => part.type === "tool")!
    expect(saved.type).toBe("tool")
    if (saved.type !== "tool" || saved.state.status === "pending") throw new Error("missing executed tool")
    expect(saved.callID).toBe("call_patch_fixture")
    expect(saved.state.input).toEqual({ callId: "call_patch_fixture", operation })
    expect(saved.state.status).toBe(fails ? "error" : "completed")
    const output = saved.state.status === "completed" ? saved.state.output : saved.state.status === "error" ? saved.state.error : ""
    expect(output).not.toContain('"status":"completed"')
    if (fails) expect(output).toContain("already exists")
    for await (const _ of request(toLLMMessages(history, { model })).events) {}
    const call = bodies[1].input.find((entry: any) => entry.type === "apply_patch_call")
    expect(call).toMatchObject({ call_id: "call_patch_fixture", status: "completed", operation })
    expect(bodies[1].input.find((entry: any) => entry.type === "apply_patch_call_output")).toEqual({ type: "apply_patch_call_output", call_id: "call_patch_fixture", status: fails ? "failed" : "completed", output })
    expect(bodies[1].input.some((entry: any) => entry.type === "function_call_output")).toBe(false)
    // A generic model must receive a matching generic pair, never half a native pair.
    for await (const _ of request(toLLMMessages(history, { model: { ...model, modelID: "generic-fixture" } }), "generic-fixture").events) {}
    expect(bodies[2].tools[0].type).toBe("function")
    expect(bodies[2].input.find((entry: any) => entry.type === "function_call").call_id).toBe("call_patch_fixture")
    expect(bodies[2].input.find((entry: any) => entry.type === "function_call_output").output).toBe(output)
    expect(bodies[2].input.some((entry: any) => entry.type?.startsWith("apply_patch"))).toBe(false)
  } finally { store.close(); await server.stop(true); rmSync(dir, { recursive: true, force: true }) }
}, 15_000)
