/**
 * 同一步里的多个工具调用是**并发**跑的。
 *
 * ── 为什么这条要有测试 ──
 * 整个设计都压在这个假设上:文件锁按路径分(fs/mutex.ts,它存在的全部理由就是
 * "模型开始并行调 edit"),权限框排队(tui/app.ts 的 promptQueue),工具卡片按
 * callID 认领(types.ts 的 AskInput.callID)—— 这三处都是为并发写的。而并发本身
 * 是 SDK 给的:一旦哪个版本改成串行,上面三处不会报错,只会变成"它明明可以一次
 * 读三个文件,却一个一个读",而且没有任何地方看得出来。
 *
 * ⚠ 这是**唯一**允许 import "ai" 的测试。src/tool、src/agent、src/prompt、src/cli
 *   一律不许(见 README 的架构边界,CI 拿 grep 守着,那条 grep 只扫 src)。
 */
import { describe, expect, test } from "bun:test"
import { streamText, stepCountIs } from "ai"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import { adaptTools } from "../src/llm/adapt-tools.ts"
import type { ToolContext, ToolDef } from "../src/tool/types.ts"
import { z } from "zod"

/** 睡一会儿再回话的假工具。start/end 记下来用来判有没有重叠 */
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

/** 一步里发两个 tool-call 的假模型 */
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

describe("★ 一步里的两个工具调用是并发的,不是排队", () => {
  test("两个各睡 150ms 的工具,开始和结束都挨在一起 —— 排队的话会差出整整一个 150ms", async () => {
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
    // fullStream 要被消费完,工具才算跑完
    for await (const _ of result.fullStream) void _

    const at = (id: string, when: string) => log.find((e) => e.id === id && e.at === when)!.time
    expect(log.filter((entry) => entry.at === "end")).toHaveLength(2)
    // ★ 判据是**两段区间重叠**,不是总时长。总时长里混着一堆和这件事无关的
    //   框架开销(这台机器上几百毫秒),拿它当判据只会得到一个看运气的测试
    expect(at("slow_b", "start")).toBeLessThan(at("slow_a", "end"))
    expect(at("slow_b", "start") - at("slow_a", "start")).toBeLessThan(100)
    // 排队跑的话,后一个的结束会比前一个晚整整一个 150ms
    expect(Math.abs(at("slow_b", "end") - at("slow_a", "end"))).toBeLessThan(100)
  })
})
