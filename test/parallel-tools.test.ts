/**
 * Multiple tool calls within one step run **concurrently**.
 *
 * ── Why this needs a test ──
 * The whole design rests on this assumption: file locks are per path (fs/mutex.ts, whose
 * entire reason to exist is "the model started calling edit in parallel"), permission
 * prompts queue up (Gate.ask in permission/gate.ts), and tool cards are claimed by callID
 * (AskInput.callID in tool/types.ts) — all three were written for concurrency. And the
 * concurrency itself comes from the SDK: if some version switches to serial, none of
 * those three will error; things just turn into "it could have read three files at once,
 * but read them one by one", with nothing anywhere to show it.
 *
 * ⚠ This is the **only** test allowed to import "ai". src/tool, src/agent, src/prompt and
 *   src/cli are all forbidden to. SDK integration belongs in src/llm; CI checks
 *   that production boundary by scanning src.
 */
import { describe, expect, test } from "bun:test"
import { streamText, stepCountIs } from "ai"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import { adaptTools } from "../src/llm/adapt-tools.ts"
import type { ToolContext, ToolDef } from "../src/tool/types.ts"
import { z } from "zod"

/**
 * A fake tool that sleeps a bit before replying. start/end are recorded to tell whether
 * they overlap
 */
function slowTool(id: string, ms: number, log: Array<{ id: string; at: string; time: number }>): ToolDef<any> {
  return {
    id,
    description: id,
    parameters: z.object({ x: z.string().optional() }),
    async execute() {
      log.push({ id, at: "start", time: Date.now() })
      await new Promise((resolve) => setTimeout(resolve, ms))
      log.push({ id, at: "end", time: Date.now() })
      return { output: `${id} done`, metadata: { truncated: false } }
    },
  }
}

const context = (): ToolContext => ({
  cwd: "/tmp",
  root: "/tmp",
  sessionID: "s",
  messageID: "m",
  callID: "c",
  abortSignal: new AbortController().signal,
  ask: async () => {},
  onProgress: () => {},
  metadata: () => {},
})

/** A fake model that emits two tool-calls in one step */
function twoCalls() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: 0,
        initialDelayInMs: 0,
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "c1", toolName: "slow_a", input: JSON.stringify({}) },
          { type: "tool-call", toolCallId: "c2", toolName: "slow_b", input: JSON.stringify({}) },
          {
            type: "finish",
            finishReason: "tool-calls",
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
        ] as never,
      }),
    }),
  })
}

describe("★ two tool calls in one step run concurrently, not queued", () => {
  test("two tools sleeping 150ms each start and end close together — queued, they'd be a full 150ms apart", async () => {
    const log: Array<{ id: string; at: string; time: number }> = []
    const tools = adaptTools({
      tools: [slowTool("slow_a", 150, log), slowTool("slow_b", 150, log)],
      makeToolContext: () => context(),
    })

    const result = streamText({
      model: twoCalls(),
      messages: [{ role: "user", content: "go" }],
      tools,
      stopWhen: stepCountIs(1),
      maxRetries: 0,
    })
    // fullStream has to be fully consumed before the tools count as finished
    for await (const _ of result.fullStream) void _

    const at = (id: string, when: string) => log.find((e) => e.id === id && e.at === when)!.time
    expect(log.filter((entry) => entry.at === "end")).toHaveLength(2)
    // ★ The criterion is **the two intervals overlapping**, not total duration. Total
    //   duration mixes in a pile of framework overhead unrelated to this (a few hundred
    //   ms on this machine); using it as the criterion only gets you a test that runs on
    //   luck
    expect(at("slow_b", "start")).toBeLessThan(at("slow_a", "end"))
    expect(at("slow_b", "start") - at("slow_a", "start")).toBeLessThan(100)
    // run in a queue, the second one would end a full 150ms after the first
    expect(Math.abs(at("slow_b", "end") - at("slow_a", "end"))).toBeLessThan(100)
  })
})
