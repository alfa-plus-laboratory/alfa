/**
 * 每个会话最多一个在跑的 turn,以及唯一的中断入口。
 *
 * ── 为什么中断要收在一个地方 ──
 * Ctrl-C 的正确行为不是"停止渲染",是一条链:abort → 流断开 → 工具收到信号
 * 自己收尾(bash 杀整个进程组)→ 没落地的 tool part 改写成 error → 消息收尾。
 * 任何一环被跳过,症状都不是当场报错:
 *   - 漏了杀进程组 → `sleep 60` 变孤儿,继续占着 CPU
 *   - 漏了改写 tool part → 历史里留下没有结果的 tool_use,之后每轮都 400
 * CLI 的 SIGINT handler 只准调 cancel(),不准自己去动 store 或者进程。
 *
 * ── 为什么 cancel 要等 ──
 * 等到 turn 真正收尾再放行,是为了防止用户马上敲下一句时,两个 Processor
 * 同时往同一个会话写 part。等待有上限(默认 200ms),超时就算了 —— 卡住用户的
 * 终端比偶尔一次写竞争更糟,而且超时的那份仍然被 drain() 记着,进程退出前会等。
 */
import type { RunInput, RunResult } from "./loop.ts"
import type { Loop } from "./loop.ts"

/** 中断后等待收尾的上限。超过这个值就先把提示符还给用户。 */
export const CANCEL_TIMEOUT_MS = 200

export class SessionBusyError extends Error {
  constructor(sessionID: string) {
    super(`Session ${sessionID} already has a turn in flight`)
    this.name = "SessionBusyError"
  }
}

export interface Run {
  sessionID: string
  controller: AbortController
  promise: Promise<RunResult>
  startedAt: number
}

export type CancelOutcome = "idle" | "settled" | "timeout"

export class Runner {
  private active = new Map<string, Run>()
  /** cancel 超时后仍在收尾的 turn。进程退出前要等它们。 */
  private draining = new Set<Promise<unknown>>()

  constructor(private readonly loop: Loop) {}

  isBusy(sessionID?: string): boolean {
    if (sessionID === undefined) return this.active.size > 0
    return this.active.has(sessionID)
  }

  get(sessionID: string): Run | undefined {
    return this.active.get(sessionID)
  }

  /**
   * 起一个 turn。立刻返回,不等它跑完。
   *
   * 调用方**必须**处理返回的 promise(await 或挂 catch),否则 Loop 里
   * 意料之外的抛错会变成 unhandled rejection。
   */
  start(input: Omit<RunInput, "abortSignal">): Run {
    if (this.active.has(input.sessionID)) throw new SessionBusyError(input.sessionID)

    const controller = new AbortController()
    const run: Run = {
      sessionID: input.sessionID,
      controller,
      startedAt: Date.now(),
      promise: undefined as never,
    }

    run.promise = this.loop
      .run({ ...input, abortSignal: controller.signal })
      .finally(() => {
        // 只有还是自己那一份才删 —— 防止超时放行后新 turn 的记录被误删
        if (this.active.get(input.sessionID) === run) this.active.delete(input.sessionID)
      })

    this.active.set(input.sessionID, run)
    return run
  }

  /**
   * 中断并等它收尾。
   *
   * @returns "idle" 本来就没在跑 / "settled" 已完整收尾 / "timeout" 还在收尾,
   *          已转入 drain 队列
   */
  async cancel(sessionID: string, timeoutMs = CANCEL_TIMEOUT_MS): Promise<CancelOutcome> {
    const run = this.active.get(sessionID)
    if (!run) return "idle"

    run.controller.abort()
    // 这里不能让 Loop 的异常冒出来 —— cancel 的语义是"停下",不是"报告结果"
    const settled = run.promise.catch(() => undefined)

    const raced = await Promise.race([
      settled.then(() => "settled" as const),
      delay(timeoutMs).then(() => "timeout" as const),
    ])

    if (raced === "timeout") {
      this.active.delete(sessionID) // 放行,让用户能继续输入
      this.track(settled)
    }
    return raced
  }

  async cancelAll(timeoutMs = CANCEL_TIMEOUT_MS): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.cancel(id, timeoutMs)))
  }

  /**
   * 等所有还在收尾的 turn 结束。进程退出前调用。
   *
   * 不等的话,bash 的 killGroup 可能还没跑完就随主进程一起没了 —— 那些子进程
   * 会被 init 收养,继续在后台跑。用户以为自己退出了,实际留了一地进程。
   */
  async drain(timeoutMs = 2_000): Promise<void> {
    const pending = [
      ...this.draining,
      ...[...this.active.values()].map((run) => run.promise.catch(() => undefined)),
    ]
    if (pending.length === 0) return
    await Promise.race([Promise.all(pending), delay(timeoutMs)])
  }

  private track(promise: Promise<unknown>): void {
    this.draining.add(promise)
    void promise.finally(() => this.draining.delete(promise))
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
