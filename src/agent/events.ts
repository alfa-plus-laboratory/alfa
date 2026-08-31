/**
 * UI 事件总线。
 *
 * 主循环和渲染之间**只走这条通道**。理由不是解耦洁癖:主循环里任何一处
 * 直接 console.log 都会和流式输出抢 stdout,把正在打字的行撕开。渲染层是
 * stdout 的唯一持有者,别人只能发事件。
 *
 * 事件里带的是**落库后的 part 对象**,不是增量片段 —— 渲染层随时可以重画
 * 一整块而不用自己攒状态。delta 只是顺手给的加速路径。
 */
import type { AssistantMessage, Part, StepFinishPart, ToolPart } from "../session/schema.ts"

export type UIEvent =
  | { type: "message.start"; message: AssistantMessage }
  | { type: "message.end"; message: AssistantMessage }
  | { type: "part.start"; part: Part }
  | { type: "part.delta"; part: Part; delta: string }
  | { type: "part.end"; part: Part }
  | { type: "tool.state"; part: ToolPart }
  | { type: "step.finish"; part: StepFinishPart }
  /** 重试中。attempt 是刚失败的那次。 */
  | { type: "retry"; attempt: number; maxAttempts: number; delayMs: number; message: string }
  | { type: "error"; error: Error }

export type Listener<E> = (event: E) => void

export class Emitter<E extends { type: string }> {
  private listeners = new Set<Listener<E>>()

  on(listener: Listener<E>): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 一个订阅者抛异常**不能**带崩主循环 —— 渲染层的 bug 不该让正在跑的
   * 工具调用中途死掉,那会留下一个没有 tool_result 的 tool_use,下一轮直接 400。
   */
  emit(event: E): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // 订阅者自己的问题,吞掉
      }
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}
