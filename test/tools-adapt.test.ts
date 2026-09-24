/**
 * The argument validation in the ToolDef → SDK translation layer.
 *
 * Origin: the model sent a write with **no arguments at all**, and what came back was
 * "Tool execution did not complete." — a line that says neither what was missing nor
 * whether the file was actually written. For a tool that changes the disk, that kind of
 * ambiguity causes real damage.
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { adaptTools } from "../src/llm/adapt-tools.ts"
import type { ToolContext, ToolDef } from "../src/tool/types.ts"

let ran = 0
const FakeTool: ToolDef<{ filePath: string; content: string }> = {
  id: "write",
  description: "writes",
  parameters: z.object({ filePath: z.string(), content: z.string() }),
  async execute(args) {
    ran++
    return { output: `wrote ${args.filePath}`, title: args.filePath, metadata: { truncated: false } }
  },
}

const ctx = (): ToolContext =>
  ({
    cwd: "/tmp",
    root: "/tmp",
    callID: "c1",
    messageID: "m1",
    abortSignal: new AbortController().signal,
    async ask() {},
    onProgress() {},
    metadata() {},
  }) as unknown as ToolContext

const call = async (input: unknown): Promise<string> => {
  const set = adaptTools({ tools: [FakeTool], makeToolContext: () => ctx() })
  const execute = (set["write"] as { execute: (input: unknown, options: unknown) => Promise<string> }).execute
  return execute(input, { toolCallId: "c1", abortSignal: new AbortController().signal, messages: [] })
}

describe("Argument validation", () => {
  test("runs normally when all arguments are present", async () => {
    ran = 0
    await expect(call({ filePath: "/tmp/a.txt", content: "x" })).resolves.toContain("wrote")
    expect(ran).toBe(1)
  })

  test("★ no arguments at all: names each missing one and says nothing ran", async () => {
    ran = 0
    const failure = await call({}).catch((error: Error) => error.message)
    expect(failure).toContain("write:")
    expect(failure).toContain("filePath is required")
    expect(failure).toContain("content is required")
    expect(failure).toContain("Nothing ran")
    // the one that matters most: it was **not** executed
    expect(ran).toBe(0)
  })

  test("wrong types are rejected too, never feeding the tool half the arguments", async () => {
    ran = 0
    const failure = await call({ filePath: 42, content: "x" }).catch((error: Error) => error.message)
    expect(failure).toContain("filePath")
    expect(ran).toBe(0)
  })
})
