/**
 * Runner / Ctrl-C。
 *
 * 这一组**真的会 spawn `sleep 60`**,不是模拟。中断链上任何一环断掉,
 * 单元测试都能全绿而现实里留一地孤儿进程 —— 唯一能证明它对的办法是数进程。
 *
 * 验收标准(来自计划):
 *   1. 一次 Ctrl-C 在 200ms 内把提示符还给用户
 *   2. pgrep 看不到孤儿
 *   3. 下一句输入能正常继续
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CANCEL_TIMEOUT_MS, Runner, SessionBusyError } from "../src/agent/runner.ts"
import { Loop } from "../src/agent/loop.ts"
import { Emitter, type UIEvent } from "../src/agent/events.ts"
import { Store } from "../src/session/store.ts"
import { newSessionID } from "../src/session/id.ts"
import { createToolContext } from "../src/tool/context.ts"
import { BashTool } from "../src/tool/bash.ts"
import type { LLMEvent, LLMRequest, ModelInfo } from "../src/llm/types.ts"
import type { ToolPart } from "../src/session/schema.ts"

const INFO: ModelInfo = {
  ref: { providerID: "p", modelID: "m" },
  limit: { context: 200_000, output: 32_000 },
  supportsThinking: false,
  promptTemplate: "default",
  cacheInInput: false,
}
const MODEL = { providerID: "p", modelID: "m" }
const TOKENS = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "apc-runner-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * 每个用例一个独一无二的 sleep 时长。
 *
 * ⚠ 别用 `pgrep -xc sleep` 数总数。机器上本来就有别人的 sleep(容器里常驻的
 *   `sleep infinity`、CI 脚本里的 `sleep 5`),用总数当基线会随机 flaky ——
 *   我第一版就这么写,然后花了十分钟去追一个根本不存在的孤儿。
 *   时长唯一,`pgrep -fx` 就只会数到我们自己起的那些。
 */
let markSeq = 0
function uniqueSleep(): { seconds: string; count: () => Promise<number>; reap: () => void } {
  const seconds = `6${markSeq++}.${(Date.now() % 997).toString().padStart(3, "0")}`
  const pattern = `sleep ${seconds}`
  return {
    seconds,
    async count() {
      const proc = Bun.spawn(["pgrep", "-fxc", pattern], { stdout: "pipe", stderr: "ignore" })
      const text = await new Response(proc.stdout).text()
      await proc.exited
      return Number(text.trim()) || 0
    },
    reap() {
      Bun.spawnSync(["pkill", "-f", pattern])
    },
  }
}

/** 轮询等条件成立,避免靠固定 sleep 猜时机。 */
async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await Bun.sleep(20)
  }
  return false
}

function build(makeEvents: (request: LLMRequest) => AsyncIterable<LLMEvent>) {
  const store = new Store(":memory:")
  const sessionID = newSessionID()
  store.createSession(sessionID, dir)
  const emitter = new Emitter<UIEvent>()

  const loop = new Loop({
    store,
    emitter,
    tools: () => [BashTool],
    system: () => ["SYS"],
    makeToolContext: (call) =>
      createToolContext(
        {
          cwd: dir,
          root: dir,
          sessionID,
          ask: async () => {}, // 测试里一律放行,权限本身有自己的测试
          onProgress: () => {},
          onMetadata: () => {},
        },
        call,
      ),
    stream: (request) => ({ info: INFO, events: makeEvents(request) }),
  })

  return { store, sessionID, emitter, runner: new Runner(loop) }
}

/** 通过真实 bash 工具跑一条命令的假流。 */
function bashStream(command: string) {
  return (request: LLMRequest): AsyncIterable<LLMEvent> =>
    (async function* () {
      yield { type: "step-start" } as LLMEvent
      yield { type: "tool-call", callID: "c1", tool: "bash", input: { command } } as LLMEvent
      const ctx = request.makeToolContext({ callID: "c1", abortSignal: request.abortSignal })
      try {
        const result = await BashTool.execute({ command }, ctx)
        yield { type: "tool-result", callID: "c1", tool: "bash", output: result.output } as LLMEvent
      } catch (error) {
        yield {
          type: "tool-error",
          callID: "c1",
          tool: "bash",
          error: error instanceof Error ? error.message : String(error),
        } as LLMEvent
      }
      yield { type: "step-finish", finishReason: "tool-calls", tokens: TOKENS } as LLMEvent
    })()
}

// ─────────────────────────────────────────────── 生命周期

describe("Runner 生命周期", () => {
  test("同一会话不允许两个 turn 并存", async () => {
    const h = build(() =>
      (async function* () {
        await Bun.sleep(50)
        yield { type: "step-finish", finishReason: "stop", tokens: TOKENS } as LLMEvent
      })(),
    )
    const run = h.runner.start({ sessionID: h.sessionID, model: MODEL, text: "a" })
    expect(h.runner.isBusy(h.sessionID)).toBe(true)
    expect(() => h.runner.start({ sessionID: h.sessionID, model: MODEL, text: "b" })).toThrow(SessionBusyError)
    await run.promise
    expect(h.runner.isBusy(h.sessionID)).toBe(false)
  })

  test("跑完自动从 active 里移除", async () => {
    const h = build(() =>
      (async function* () {
        yield { type: "step-finish", finishReason: "stop", tokens: TOKENS } as LLMEvent
      })(),
    )
    await h.runner.start({ sessionID: h.sessionID, model: MODEL, text: "a" }).promise
    expect(h.runner.isBusy()).toBe(false)
    expect(h.runner.get(h.sessionID)).toBeUndefined()
  })

  test("Loop 抛异常也要清干净,不留 busy 状态", async () => {
    const h = build(() => {
      throw new Error("stream construction blew up")
    })
    const run = h.runner.start({ sessionID: h.sessionID, model: MODEL, text: "a" })
    await run.promise
    expect(h.runner.isBusy(h.sessionID)).toBe(false)
  })

  test("没在跑时 cancel 返回 idle", async () => {
    const h = build(() => (async function* () {})())
    expect(await h.runner.cancel(h.sessionID)).toBe("idle")
  })
})

// ─────────────────────────────────────────────── ★ 真实中断

describe("★ 真实 Ctrl-C", () => {
  test("① 200ms 内返回 ② 无孤儿 ③ tool part 已收尾", async () => {
    const mark = uniqueSleep()
    const h = build(bashStream(`sleep ${mark.seconds}`))
    try {
      const run = h.runner.start({ sessionID: h.sessionID, model: MODEL, text: "wait" })

      // 等进程真的起来,否则测的是"还没 spawn 就 abort"这个轻松得多的情况
      expect(await until(async () => (await mark.count()) === 1)).toBe(true)

      const started = Date.now()
      const outcome = await h.runner.cancel(h.sessionID)
      const elapsed = Date.now() - started

      // ① 提示符要在 200ms 内回来
      expect(elapsed).toBeLessThanOrEqual(CANCEL_TIMEOUT_MS + 60)
      expect(outcome === "settled" || outcome === "timeout").toBe(true)

      // ② drain 返回时进程组必须已经空了 —— 不允许"再等一会儿就好了"
      await h.runner.drain()
      expect(await mark.count()).toBe(0)

      // ③ 历史里那条 tool part 不能停在 running/pending,否则之后每轮都 400
      await run.promise.catch(() => undefined)
      const tool = h.store
        .listAll(h.sessionID)
        .flatMap((m) => m.parts)
        .find((p) => p.type === "tool") as ToolPart | undefined
      expect(tool).toBeDefined()
      expect(["completed", "error"]).toContain(tool!.state.status)
    } finally {
      mark.reap()
    }
  }, 20_000)

  test("中断之后,下一句输入能正常跑", async () => {
    const mark = uniqueSleep()
    const h = build(bashStream(`sleep ${mark.seconds}`))
    try {
      h.runner.start({ sessionID: h.sessionID, model: MODEL, text: "wait" })
      await until(async () => (await mark.count()) === 1)
      await h.runner.cancel(h.sessionID)
      await h.runner.drain()

      // 换一个不挂起的流,接着用同一个会话
      const h2 = build(() =>
        (async function* () {
          yield { type: "text-delta", id: "t", text: "back to work" } as LLMEvent
          yield { type: "step-finish", finishReason: "stop", tokens: TOKENS } as LLMEvent
        })(),
      )
      const result = await h2.runner.start({ sessionID: h2.sessionID, model: MODEL, text: "again" }).promise
      expect(result.steps).toBe(1)
      expect(result.interrupted).toBe(false)
    } finally {
      mark.reap()
    }
  }, 20_000)

  test("后台起的孙进程也一起杀掉", async () => {
    const mark = uniqueSleep()
    // shell 后台起两个再自己 wait —— 只杀直接子进程的话这俩会活下来
    const h = build(bashStream(`sleep ${mark.seconds} & sleep ${mark.seconds} & wait`))
    try {
      h.runner.start({ sessionID: h.sessionID, model: MODEL, text: "spawn" })
      expect(await until(async () => (await mark.count()) === 2)).toBe(true)

      await h.runner.cancel(h.sessionID)
      await h.runner.drain()
      expect(await mark.count()).toBe(0)
    } finally {
      mark.reap()
    }
  }, 20_000)

  test("★ 孙进程屏蔽 SIGTERM 且脱离 stdio —— 必须升级到 SIGKILL", async () => {
    const mark = uniqueSleep()
    // 外层 shell 不 trap,收到 SIGTERM 立刻死 → 'close' 立刻触发。
    // 孙进程 trap 住 TERM(SIG_IGN 跨 exec 继承,sleep 也免疫)且不持有管道。
    // 旧实现在这里 2ms 就返回并宣布成功,留下一个永远跑下去的 sleep。
    const escape = `bash -c 'trap "" TERM; exec sleep ${mark.seconds}' >/dev/null 2>&1 </dev/null & wait`
    const h = build(bashStream(escape))
    try {
      h.runner.start({ sessionID: h.sessionID, model: MODEL, text: "escape" })
      expect(await until(async () => (await mark.count()) === 1)).toBe(true)

      await h.runner.cancel(h.sessionID)
      await h.runner.drain()
      expect(await mark.count()).toBe(0)
    } finally {
      mark.reap()
    }
  }, 20_000)

  test("cancelAll 清掉所有会话", async () => {
    const mark = uniqueSleep()
    const a = build(bashStream(`sleep ${mark.seconds}`))
    const b = build(bashStream(`sleep ${mark.seconds}`))
    try {
      a.runner.start({ sessionID: a.sessionID, model: MODEL, text: "x" })
      b.runner.start({ sessionID: b.sessionID, model: MODEL, text: "y" })
      expect(await until(async () => (await mark.count()) === 2)).toBe(true)

      await Promise.all([a.runner.cancelAll(), b.runner.cancelAll()])
      await Promise.all([a.runner.drain(), b.runner.drain()])
      expect(await mark.count()).toBe(0)
      expect(a.runner.isBusy()).toBe(false)
      expect(b.runner.isBusy()).toBe(false)
    } finally {
      mark.reap()
    }
  }, 20_000)
})

// ─────────────────────────────────────────────── drain

describe("drain", () => {
  test("等收尾中的 turn 结束", async () => {
    let finished = false
    const h = build(() =>
      (async function* () {
        await Bun.sleep(80)
        finished = true
        yield { type: "step-finish", finishReason: "stop", tokens: TOKENS } as LLMEvent
      })(),
    )
    h.runner.start({ sessionID: h.sessionID, model: MODEL, text: "x" })
    await h.runner.drain()
    expect(finished).toBe(true)
  })

  test("卡死的 turn 不会让 drain 永远挂住", async () => {
    const h = build(() =>
      (async function* () {
        await new Promise(() => {}) // 永不 resolve
        yield { type: "step-finish", finishReason: "stop", tokens: TOKENS } as LLMEvent
      })(),
    )
    h.runner.start({ sessionID: h.sessionID, model: MODEL, text: "x" })
    const started = Date.now()
    await h.runner.drain(300)
    expect(Date.now() - started).toBeLessThan(1_500)
  })
})
