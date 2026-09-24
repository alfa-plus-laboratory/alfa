/** Late phase metadata must never turn a progress preamble into a persisted handoff. */
import { expect, test } from "bun:test"
import { collectFinalText } from "../src/agent/collect-text.ts"
import type { LLMEvent } from "../src/llm/types.ts"

const handle = (events: LLMEvent[]) => ({ events: (async function* () { yield* events })() })

test("late commentary releases the text budget for the final summary", async () => {
  const text = await collectFinalText(handle([
    { type: "text-start", id: "a" },
    { type: "text-delta", id: "a", text: "progress".repeat(20) },
    { type: "text-end", id: "a", responses: { phase: "commentary" } },
    { type: "text-start", id: "b" },
    { type: "text-delta", id: "b", text: "actual summary" },
    { type: "text-end", id: "b", responses: { phase: "final_answer" } },
  ]), 10)
  expect(text).toBe("actual sum")
})

test("legacy text without phase remains usable and reused stream IDs stay distinct", async () => {
  expect(await collectFinalText(handle([
    { type: "text-delta", id: "a", text: "first " },
    { type: "text-end", id: "a" },
    { type: "text-start", id: "a" },
    { type: "text-delta", id: "a", text: "second" },
    { type: "text-end", id: "a" },
  ]), 100)).toBe("first second")
})

test("an error after reaching the output cap still prevents saving a failed summary", async () => {
  await expect(collectFinalText(handle([
    { type: "text-delta", id: "a", text: "long answer" },
    { type: "error", error: new Error("stream failed") },
  ]), 3)).rejects.toThrow("stream failed")
})
