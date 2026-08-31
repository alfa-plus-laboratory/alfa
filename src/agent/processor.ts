/**
 * 消费 LLMEvent,落库,发 UI 事件。
 *
 * 一次 Processor 实例对应**一条 assistant message**,不跨 turn 复用。
 *
 * ── 为什么每个事件都要立刻落库 ──
 * 主循环的正确性建立在「存储是唯一真值源」上:它每轮从 Store 重读全量历史,
 * 而不是拿着内存里的数组接着往下走。只有这样,中断收尾、外部改历史、崩溃
 * 后恢复才都是同一条代码路径。代价是每个 delta 一次 SQLite 写 —— bun:sqlite
 * 同步写 WAL,单条几微秒,和网络延迟比可以忽略。
 *
 * ── 中断时最重要的一件事 ──
 * 停在 running 的 tool part 必须被改写成 error。留着 running 不是"状态不准"
 * 这么轻的问题:回灌历史时它会变成一个没有结果的 tool_use,之后**每一轮**
 * 请求都 400。见 to-model-messages.ts 顶部。
 */
import type { LLMEvent, ModelInfo, Tokens } from "../llm/types.ts"
import {
  type AssistantMessage,
  type Part,
  type ReasoningPart,
  type StepFinishPart,
  type TextPart,
  type ToolPart,
} from "../session/schema.ts"
import { newPartID } from "../session/id.ts"
import type { Store } from "../session/store.ts"
import { Emitter, type UIEvent } from "./events.ts"
import { accumulateBilled, emptyTokens } from "./tokens.ts"

export interface ProcessorOutcome {
  /** 最后一个 step 报的 finishReason。流没跑到 step-finish 就是 undefined。 */
  finishReason?: string
  /** 上下文口径:**最后一个** step 的用量,不是累加值 */
  contextTokens: Tokens
  /** 计费口径:所有 step 相加 */
  billedTokens: Tokens
  /** 流里出现的错误(已落到 message.error) */
  error?: Error
  /** 是否被中断收尾过 */
  interrupted: boolean
  /** 本次流里模型发起了几个工具调用 */
  toolCalls: number
}

export class Processor {
  private text = new Map<string, TextPart>()
  private reasoning = new Map<string, ReasoningPart>()
  private tools = new Map<string, ToolPart>()
  /** 工具上报但 part 还没落地时暂存的 metadata */
  private toolMetadata = new Map<string, Record<string, unknown>>()
  private finishReason: string | undefined
  private contextTokens: Tokens = emptyTokens()
  private billedTokens: Tokens = emptyTokens()
  private error: Error | undefined
  private interrupted = false
  private toolCalls = 0
  private done = false

  constructor(
    private readonly store: Store,
    private readonly emitter: Emitter<UIEvent>,
    private readonly message: AssistantMessage,
    private readonly info: ModelInfo,
  ) {}

  async run(events: AsyncIterable<LLMEvent>): Promise<ProcessorOutcome> {
    for await (const event of events) {
      this.handle(event)
    }
    return this.outcome()
  }

  private handle(event: LLMEvent): void {
    switch (event.type) {
      // ── 正文 ──
      case "text-start":
        this.openText(event.id)
        break
      case "text-delta": {
        const part = this.openText(event.id)
        part.text += event.text
        this.save(part)
        this.emitter.emit({ type: "part.delta", part, delta: event.text })
        break
      }
      case "text-end": {
        const part = this.text.get(event.id)
        if (!part) break
        if (part.time) part.time.end = Date.now()
        this.save(part)
        this.emitter.emit({ type: "part.end", part })
        this.text.delete(event.id)
        break
      }

      // ── 推理 ──
      case "reasoning-start":
        this.openReasoning(event.id)
        break
      case "reasoning-delta": {
        const part = this.openReasoning(event.id)
        part.text += event.text
        this.save(part)
        this.emitter.emit({ type: "part.delta", part, delta: event.text })
        break
      }
      case "reasoning-end": {
        const part = this.reasoning.get(event.id)
        if (!part) break
        // 签名必须存下来。下一轮回灌时缺了它,Anthropic 拒收整段 thinking。
        if (event.signature) part.signature = event.signature
        if (part.time) part.time.end = Date.now()
        this.save(part)
        this.emitter.emit({ type: "part.end", part })
        this.reasoning.delete(event.id)
        break
      }

      // ── 工具 ──
      case "tool-input-start": {
        // 参数还没齐,先占位。UI 这时就能显示"正在准备调用 xxx"。
        const part = this.openTool(event.callID, event.tool)
        this.emitter.emit({ type: "tool.state", part })
        break
      }
      case "tool-call": {
        const part = this.openTool(event.callID, event.tool)
        this.toolCalls++
        part.state = { status: "running", input: event.input, time: { start: Date.now() } }
        this.save(part)
        this.emitter.emit({ type: "tool.state", part })
        break
      }
      case "tool-result": {
        const part = this.openTool(event.callID, event.tool)
        const start = startOf(part)
        part.state = {
          status: "completed",
          input: inputOf(part),
          output: event.output,
          metadata: this.toolMetadata.get(event.callID) ?? {},
          time: { start, end: Date.now() },
        }
        this.save(part)
        this.emitter.emit({ type: "tool.state", part })
        break
      }
      case "tool-error": {
        const part = this.openTool(event.callID, event.tool)
        const start = startOf(part)
        part.state = {
          status: "error",
          input: inputOf(part),
          error: event.error,
          metadata: this.toolMetadata.get(event.callID) ?? {},
          time: { start, end: Date.now() },
        }
        this.save(part)
        this.emitter.emit({ type: "tool.state", part })
        break
      }

      // ── step ──
      case "step-start": {
        const part: Part = {
          id: newPartID(),
          sessionID: this.message.sessionID,
          messageID: this.message.id,
          timeCreated: Date.now(),
          type: "step-start",
        }
        this.save(part)
        this.emitter.emit({ type: "part.start", part })
        break
      }
      case "step-finish": {
        this.finishReason = event.finishReason
        // 上下文口径取最后一个 step,不累加 —— 每个 step 的 input 都含全量历史
        this.contextTokens = event.tokens
        this.billedTokens = accumulateBilled(this.billedTokens, event.tokens)
        const part: StepFinishPart = {
          id: newPartID(),
          sessionID: this.message.sessionID,
          messageID: this.message.id,
          timeCreated: Date.now(),
          type: "step-finish",
          finishReason: event.finishReason,
          tokens: event.tokens,
          cost: 0,
        }
        this.save(part)
        this.emitter.emit({ type: "step.finish", part })
        break
      }

      case "error":
        this.error = event.error
        this.emitter.emit({ type: "error", error: event.error })
        break
    }
  }

  /**
   * 工具在执行期间上报的 metadata(diff、exitCode、落盘路径……)。
   *
   * 时序:它**先于** tool-result 到达(工具还没返回时就调了 ctx.metadata),
   * 所以要先攒着,等 part 变成 completed/error 时一起写进去。
   * 已经落地的话就地补写并重发一次事件。
   */
  setToolMetadata(callID: string, patch: Record<string, unknown>): void {
    const merged = { ...(this.toolMetadata.get(callID) ?? {}), ...patch }
    this.toolMetadata.set(callID, merged)

    const part = this.tools.get(callID)
    if (!part) return
    if (part.state.status !== "completed" && part.state.status !== "error") return
    part.state.metadata = { ...part.state.metadata, ...patch }
    this.save(part)
    this.emitter.emit({ type: "tool.state", part })
  }

  // ───────────────────────────────────────────── 收尾

  /**
   * 收尾。正常结束和中断都要走,而且**必须只走一次**。
   *
   * @param reason "done" 正常结束 / "interrupted" 被中断 / "error" 出错中止
   */
  cleanup(reason: "done" | "interrupted" | "error", error?: Error): ProcessorOutcome {
    if (this.done) return this.outcome()
    this.done = true
    if (error) this.error = error
    if (reason === "interrupted") this.interrupted = true
    const now = Date.now()

    // 没收到 text-end / reasoning-end 的块补上结束时间,否则 UI 会一直转圈
    for (const part of [...this.text.values(), ...this.reasoning.values()]) {
      if (part.time) part.time.end = now
      this.save(part)
      this.emitter.emit({ type: "part.end", part })
    }
    this.text.clear()
    this.reasoning.clear()

    // ★ 关键:任何没落地的 tool part 都要改写成 error。
    //   留一个 pending/running 在历史里 = 之后每一轮都 400。
    for (const part of this.tools.values()) {
      if (part.state.status === "completed" || part.state.status === "error") continue
      const start = startOf(part)
      part.state = {
        status: "error",
        input: inputOf(part),
        error:
          reason === "interrupted"
            ? "Tool execution was interrupted by the user before it completed."
            : // ★ 这句话要说清**什么都没发生**。
              //
              // 走到这儿的意思是:调用的参数还没送完,这一轮就结束了(输出被截断、
              // provider 中途断流、撞上步数上限),工具**根本没有被调用过**。
              // 原来只写一句 "Tool execution did not complete." —— 模型读完不知道
              // 文件到底写没写,于是要么当它写了(接着往下改),要么再写一遍。
              // 对 write / edit 这种会改磁盘的工具,这个歧义是会真出事的
              `The ${part.tool} call never arrived complete — its arguments stopped mid-stream, so the tool was NOT run and nothing changed. Call it again with all required arguments.`,
        metadata: { interrupted: reason === "interrupted" },
        time: { start, end: now },
      }
      this.save(part)
      this.emitter.emit({ type: "tool.state", part })
    }

    this.message.timeCompleted = now
    this.message.tokens = this.contextTokens
    if (reason === "interrupted") this.message.finish = "interrupted"
    else if (this.error) this.message.finish = "error"
    else this.message.finish = this.finishReason ?? "unknown"
    if (this.error) this.message.error = { name: this.error.name, message: this.error.message }
    this.store.upsertMessage(this.message)
    this.store.touchSession(this.message.sessionID)
    this.emitter.emit({ type: "message.end", message: this.message })

    return this.outcome()
  }

  // ───────────────────────────────────────────── 内部

  private openText(id: string): TextPart {
    const existing = this.text.get(id)
    if (existing) return existing
    const part: TextPart = {
      id: newPartID(),
      sessionID: this.message.sessionID,
      messageID: this.message.id,
      timeCreated: Date.now(),
      type: "text",
      text: "",
      time: { start: Date.now() },
    }
    this.text.set(id, part)
    this.save(part)
    this.emitter.emit({ type: "part.start", part })
    return part
  }

  private openReasoning(id: string): ReasoningPart {
    const existing = this.reasoning.get(id)
    if (existing) return existing
    const part: ReasoningPart = {
      id: newPartID(),
      sessionID: this.message.sessionID,
      messageID: this.message.id,
      timeCreated: Date.now(),
      type: "reasoning",
      text: "",
      time: { start: Date.now() },
    }
    this.reasoning.set(id, part)
    this.save(part)
    this.emitter.emit({ type: "part.start", part })
    return part
  }

  /**
   * 按 callID 拿 tool part,没有就建。
   *
   * 必须容忍事件缺失:有些 provider 不发 tool-input-start,直接给 tool-call;
   * 更糟的是 tool-result 先于 tool-call 到达(重试或乱序时见过)。所以每个
   * 分支都走这个函数,而不是假设前一个事件一定来过。
   */
  private openTool(callID: string, tool: string): ToolPart {
    const existing = this.tools.get(callID)
    if (existing) return existing
    // 同一条 message 里 callID 唯一(DDL 上有唯一索引),重启后能捞回来
    const stored = this.store.findToolPart(this.message.id, callID)
    if (stored && stored.type === "tool") {
      this.tools.set(callID, stored)
      return stored
    }
    const part: ToolPart = {
      id: newPartID(),
      sessionID: this.message.sessionID,
      messageID: this.message.id,
      timeCreated: Date.now(),
      type: "tool",
      callID,
      tool,
      state: { status: "pending" },
    }
    this.tools.set(callID, part)
    this.save(part)
    return part
  }

  private save(part: Part): void {
    this.store.upsertPart(part)
  }

  private outcome(): ProcessorOutcome {
    return {
      ...(this.finishReason ? { finishReason: this.finishReason } : {}),
      contextTokens: this.contextTokens,
      billedTokens: this.billedTokens,
      ...(this.error ? { error: this.error } : {}),
      interrupted: this.interrupted,
      toolCalls: this.toolCalls,
    }
  }

  /** 给主循环判断上下文压力用 */
  modelInfo(): ModelInfo {
    return this.info
  }
}

function startOf(part: ToolPart): number {
  const state = part.state
  return "time" in state && state.time ? state.time.start : part.timeCreated
}

/**
 * 已知的调用参数,拿不到就给 {}。
 *
 * ⚠ 不能返回 undefined。part 是 JSON.stringify 后落库的,undefined 的键会
 *   **整个消失**,再读回来时 completed 状态缺 input 字段 → zod 解析失败 →
 *   那条 message 从此永远读不出来,整个会话作废。
 *   而且 tool_use.input 在 Anthropic 侧必须是对象,{} 也正是回灌时该发的值。
 *
 *   触发路径不罕见:provider 乱序把 tool-result 发在 tool-call 之前。
 */
function inputOf(part: ToolPart): unknown {
  const state = part.state
  if ("input" in state && state.input !== undefined) return state.input
  return {}
}
