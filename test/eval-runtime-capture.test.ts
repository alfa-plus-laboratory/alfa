/**
 * Generic models have no Responses phase labels. Guard the documented operational
 * commentary rule and validate real CLI capture using only a localhost protocol stub.
 */
import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { captureRuntime } from "../eval/capture.ts"
import { gradeRuntimeBatch } from "../eval/runtime.ts"
import type { MessageWithParts, Part } from "../src/session/schema.ts"

const identity = { scenario: "current-sandbox", model: "fixture/model", repetition: 1 }
const part = (value: Record<string, unknown>) => ({ id: "part", messageID: "assistant", sessionID: "session", timeCreated: 1, ...value } as Part)
const message = (parts: Part[], id = "assistant", timeCreated = 1): MessageWithParts => ({ info: { id, sessionID: "session", parentID: "user", role: "assistant", providerID: "fixture", modelID: "model", cost: 0, timeCreated }, parts })

test("capture separates generic progress from final answers and retains failed environment observations", () => {
  const history = [message([part({ type: "text", text: "Final answer." })], "final", 2), message([
    part({ id: "b", type: "tool", tool: "environment", callID: "env", state: { status: "error", input: {}, error: "Permission rejected", metadata: {}, time: { start: 1, end: 2 } } }),
    part({ id: "a", type: "text", text: "Checking facts." }),
    part({ id: "c", type: "text", text: "Synthetic", synthetic: true }),
    part({ id: "d", type: "reasoning", text: "Private reasoning" }),
  ])]
  const result = captureRuntime(history, identity)
  expect(result.events).toEqual([{ type: "commentary", text: "Checking facts." }, { type: "tool-call", tool: "environment" }, { type: "answer", text: "Final answer." }])
  expect(result.environmentObservations).toEqual([{ callID: "env", status: "error", output: "Permission rejected" }])
  expect(gradeRuntimeBatch([result]).results[0]!.factualErrors).toBeNull()
})

test("explicit phase takes precedence and pending tool input is not an executed call", () => {
  const result = captureRuntime([message([
    part({ id: "a", type: "text", text: "Explicit answer.", responses: { phase: "final_answer" } }),
    part({ id: "b", type: "tool", tool: "environment", callID: "pending", state: { status: "pending" } }),
    part({ id: "c", type: "text", text: "Explicit progress.", responses: { phase: "commentary" } }),
  ])], identity)
  expect(result.events).toEqual([{ type: "answer", text: "Explicit answer." }, { type: "commentary", text: "Explicit progress." }])
  expect(result.environmentObservations).toEqual([])
})

test("runtime runner captures all scenarios incrementally from the real CLI without provider calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alfa-runtime-capture-"))
  let calls = 0
  const server = Bun.serve({ port: 0, async fetch(request) {
    calls++
    const body: any = await request.json()
    const toolDone = body.input.some((item: any) => item.type === "function_call_output")
    const item = { id: "fc_fixture", type: "function_call", call_id: "env_fixture", name: "environment", arguments: "{}", status: "completed" }
    const events = [
      { type: "response.created", response: { id: "resp_fixture", created_at: 1, model: "fixture" } },
      ...(toolDone ? [
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_fixture" } },
        { type: "response.output_text.delta", output_index: 0, item_id: "msg_fixture", delta: "Fixture answer for capture only." },
        { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_fixture" } },
      ] : [
        { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_fixture", delta: "{}" },
        { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_fixture", arguments: "{}" },
        { type: "response.output_item.done", output_index: 0, item },
      ]),
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } },
    ]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  try {
    const config = join(dir, "config", "alfa"), output = join(dir, "evidence.json")
    mkdirSync(config, { recursive: true })
    const provider = `fixture-${crypto.randomUUID()}`
    writeFileSync(join(config, "config.json"), JSON.stringify({ check: false, providers: { [provider]: { type: "openai-responses", baseURL: server.url.href, noKey: true, models: { fixture: {} } } } }))
    const env = { ...process.env, XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data") }
    for (const key of Object.keys(env)) if (key.startsWith("ALFA_") || key.startsWith("APCODE_")) delete (env as Record<string, string | undefined>)[key]
    Object.assign(env, { ALFA_NO_UPDATE: "1" })
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../eval/runtime-run.ts"), "--model", `${provider}/fixture`, "--permission", "default", "--repeat", "3", "--out", output], { env, stdout: "pipe", stderr: "pipe" })
    const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text()
    const timeout = setTimeout(() => child.kill(), 30_000)
    try {
      expect({ exit: await child.exited, stderr: await stderr, stdout: await stdout }).toMatchObject({ exit: 0, stderr: "" })
    } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill() }
    const evidence = JSON.parse(readFileSync(output, "utf8")), sidecar = JSON.parse(readFileSync(`${output}.run.json`, "utf8"))
    expect(calls).toBe(42)
    expect(evidence).toHaveLength(21)
    expect(sidecar.attempts.every((attempt: any) => attempt.state === "finished" && attempt.exit === 0 && attempt.sessionID)).toBe(true)
    expect(sidecar.usage.requests).toBe(42)
    expect(evidence.filter((item: any) => item.environmentObservations[0]?.status !== "completed" || item.events[0]?.tool !== "environment")).toEqual([])
    expect(gradeRuntimeBatch(evidence).summaries.every(summary => summary.attempts === 3 && summary.factualErrors === null && summary.environmentFirstRate === 1)).toBe(true)
  } finally { await server.stop(true); rmSync(dir, { recursive: true, force: true }) }
}, 40_000)
