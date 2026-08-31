/**
 * ToolDef → SDK 的翻译层里那道参数校验。
 *
 * 起因:模型发了一个**没有任何参数**的 write,而回给它的是一句
 * "Tool execution did not complete." —— 一句既没说少了什么、也没说
 * 文件到底写没写的话。对会改磁盘的工具,这种歧义是会真出事的。
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

describe("参数校验", () => {
  test("参数齐了照常跑", async () => {
    ran = 0
    await expect(call({ filePath: "/tmp/a.txt", content: "x" })).resolves.toContain("wrote")
    expect(ran).toBe(1)
  })

  test("★ 一个参数都没有:点名少了哪个,而且明说什么都没跑", async () => {
    ran = 0
    const failure = await call({}).catch((error: Error) => error.message)
    expect(failure).toContain("write:")
    expect(failure).toContain("filePath is required")
    expect(failure).toContain("content is required")
    expect(failure).toContain("Nothing ran")
    // 最要紧的一条:它**没有**被执行
    expect(ran).toBe(0)
  })

  test("类型不对也拦,而且不把半个参数喂给工具", async () => {
    ran = 0
    const failure = await call({ filePath: 42, content: "x" }).catch((error: Error) => error.message)
    expect(failure).toContain("filePath")
    expect(ran).toBe(0)
  })
})
