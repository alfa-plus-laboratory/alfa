/**
 * 主循环。
 *
 * ── 每轮从存储重读全量历史 ──
 * 不是保守,是正确性要求。中断收尾会**改写**已经落库的 part(running → error),
 * 将来的压缩会**替换**整段历史。如果循环攥着一份内存副本往下走,这些改写就
 * 不会生效,模型看到的和存储里的会分叉 —— 而这种分叉不报错,只表现为"它怎么
 * 又去读那个已经读过的文件"。重读的成本是一次 SQLite 全表扫,几百微秒。
 *
 * ── 为什么不用 SDK 的 stopWhen ──
 * AI SDK 交出多轮控制权的同时也交出了轮与轮之间的一切:压缩、最大步数、
 * 权限阻断后的重新规划、历史重读。这些全都发生在**轮的边界上**,只能自己写。
 *
 * ── 退出判定为什么不看 finishReason ──
 * 见 needsAnotherRound()。这是本文件最容易写错的地方。
 */
import {
  ContextOverflowError,
  type LLMRequest,
  type LLMStreamFn,
  type ModelRef,
  type Tokens,
} from "../llm/types.ts"
import { MAX_STEPS, MAX_STEPS_PROMPT } from "../prompt/max-steps.ts"
import { newMessageID, newPartID } from "../session/id.ts"
import type { AssistantMessage, MessageWithParts, ToolPart } from "../session/schema.ts"
import type { Store } from "../session/store.ts"
import type { ToolContext } from "../tool/types.ts"
import { Emitter, type UIEvent } from "./events.ts"
import { Processor } from "./processor.ts"
import { toLLMMessages } from "./to-model-messages.ts"
import { accumulateBilled, emptyTokens } from "./tokens.ts"

export interface LoopDeps {
  store: Store
  emitter: Emitter<UIEvent>
  stream: LLMStreamFn
  /** 本轮可用工具。每轮重新问一次,权限层可以在中途禁用某个工具。 */
  tools(): import("../tool/types.ts").ToolDef<any>[]
  /** 每次请求重新组装 —— 日期会变,AGENTS.md 也可能被改。 */
  system(): string[]
  makeToolContext(call: { messageID: string; callID: string; abortSignal: AbortSignal }): ToolContext
  /**
   * 它准备收口了,再验一道。
   *
   * 返回一段话 = 有问题,把这段话作为**合成 user 消息**塞回去,循环接着转,
   * 它就得先把问题处理掉才能真的说完。返回 undefined = 没问题 / 不适用 / 没配。
   *
   * 为什么挂在这里而不是挂在 edit 工具上:一轮里改十个文件就要跑十次检查,
   * 而其中九次的报错是"你才改了一半"——那种噪音会把真问题淹掉,还慢十倍。
   * 收口这一刻只跑一次,而且这一刻正好是"它要开口说好了"的前一秒。
   */
  verify?(input: VerifyInput): Promise<string | undefined>
  /**
   * 一场新会话的第一句话之前,先挂上项目记忆。
   *
   * ── 为什么挂在这里,而不是拼进 system prompt ──
   * 见 session/schema.ts 的 MemoryPart。要点是它得能被单独算账(`/context` 里
   * 自成一栏),而且它是**一次性的事实**不是每轮的指令 —— 之后模型自己记的、
   * 删的,tool result 里都有(见 tool/memory.ts)。
   *
   * ── 为什么只在第一句 ──
   * 「新对话自动带上」就是这个意思。接回一场老会话时不再注入:那一场开头挂的
   * 那份还在历史里,再挂一份就是同一批便条在同一条上下文里出现两次。
   */
  memory?(sessionID: string): { text: string; notes: number } | undefined
  /**
   * 一场新会话的第一句话之前,再挂一份仓库快照(分支、没提交的改动、最近的提交)。
   *
   * ── 为什么不拼进 system prompt ──
   * 那三样是一场会话里变得最勤的东西,而 system 是最长的可缓存前缀 —— 模型自己
   * commit 一次就让 tools + system 全部按原价重算(见 prompt/git.ts 开头那段)。
   * 挂在历史上则不然:历史只增不改,挂上去的文本此后一个字不动。
   *
   * ── 为什么只在第一句 ──
   * 和记忆同一条理由,外加一条更硬的:之后的变化**多半是它自己造成的**,
   * 而它每一次 edit / commit 的结果都已经在历史里了。真要准的,块里写着让它
   * 自己去跑 git。
   */
  gitContext?(): string | undefined
}

export interface VerifyInput {
  /** 这一轮 edit/write 动过的文件(绝对路径,去重) */
  touched: string[]
  abortSignal: AbortSignal
}

/**
 * 一轮里最多验几次。
 *
 * 要大于 1:验出问题 → 它改 → **改完得再验一次**,否则"修好了"同样只是它自己
 * 说的。也不能大,一个修不动的问题会让它在这里反复烧钱 —— 到顶就放它去回答,
 * 界面上那条收据照旧写着检查没过,用户看得见。
 */
const MAX_VERIFY_ROUNDS = 2

export interface RunInput {
  sessionID: string
  model: ModelRef
  /** 用户这轮说的话。不给就是"接着上次继续"(恢复会话用)。 */
  text?: string
  abortSignal: AbortSignal
  thinking?: boolean
}

export interface RunResult {
  /** 实际发出去的请求轮数 */
  steps: number
  /** 计费口径的累计用量 */
  billedTokens: Tokens
  interrupted: boolean
  error?: Error
  /** 因为撞到 MAX_STEPS 而停 */
  hitStepLimit: boolean
}

export class Loop {
  constructor(private readonly deps: LoopDeps) {}

  async run(input: RunInput): Promise<RunResult> {
    const { store, emitter } = this.deps

    if (input.text !== undefined) this.appendUserMessage(input.sessionID, input.text)

    let steps = 0
    let billed = emptyTokens()
    let interrupted = false
    let error: Error | undefined
    let hitStepLimit = false
    let verifyRounds = 0

    while (true) {
      if (input.abortSignal.aborted) {
        interrupted = true
        break
      }

      const history = store.listAll(input.sessionID)
      if (isSettled(history)) {
        // ★ 收口前的最后一道。塞回去的是**合成** user 消息:模型看得见,
        //   界面不当成用户说的话(见 session/schema.ts 的 TextPart.synthetic)
        const reminder = await this.verify(input, history, verifyRounds)
        if (reminder === undefined) break
        verifyRounds++
        this.appendUserMessage(input.sessionID, reminder, true)
        continue
      }

      steps++
      const isLastStep = steps >= MAX_STEPS

      const parentID = latestUser(history)?.info.id
      if (!parentID) break // 没有任何 user 消息,没什么可回答的

      const message = this.createAssistantShell(input.sessionID, parentID, input.model)
      emitter.emit({ type: "message.start", message })

      // ⚠ 建流和消费流必须共用**同一条**错误路径。
      //   分成两个 try 的话,stream() 同步抛出的错误就绕过了中断识别和
      //   ContextOverflowError 的改写 —— 用户 Ctrl-C 会看到 "Error: aborted",
      //   上下文超了会看到原始的 provider 报错。两者都不是 bug 报错,是体验塌掉。
      //
      // processor 在 makeToolContext 之后才建得出来(要 handle.info),所以这里
      // 先声明,闭包捕获它 —— 工具真正执行时它必然已经赋值。
      let processor: Processor | undefined

      const system = this.deps.system()
      const request: LLMRequest = {
        model: input.model,
        // 撞顶这一轮:塞进 system 而不是历史 —— 它不该被持久化,
        // 下一个 turn 不需要再看到这段话。
        system: isLastStep ? [...system, MAX_STEPS_PROMPT] : system,
        messages: toLLMMessages(history, { model: input.model }),
        tools: this.deps.tools(),
        makeToolContext: (call) => {
          const ctx = this.deps.makeToolContext({
            messageID: message.id,
            callID: call.callID,
            abortSignal: call.abortSignal,
          })
          return {
            ...ctx,
            // 工具上报的 metadata 要同时进 part —— diff / exitCode / 落盘路径
            // 全走这条通道,断了 UI 就什么细节都拿不到。
            metadata: (patch) => {
              ctx.metadata(patch)
              processor?.setToolMetadata(call.callID, patch)
            },
          }
        },
        // 空数组 = 禁止调用工具(stream.ts 会顺带把 toolChoice 设成 none)
        ...(isLastStep ? { activeTools: [] } : {}),
        ...(input.thinking ? { thinking: true } : {}),
        abortSignal: input.abortSignal,
      }

      try {
        const handle = this.deps.stream(request)
        processor = new Processor(store, emitter, message, handle.info)
        const outcome = await processor.run(handle.events)
        billed = accumulateBilled(billed, outcome.billedTokens)
        // ★ abort **不会**从这里抛出来,所以判据必须是信号本身。
        //
        //   下面那个 catch 里有一条完整的中断处理,而生产环境里它到不了:
        //   AI SDK 在 abort 时不抛异常,它推一个 `{type:"abort"}` 然后正常关流,
        //   而 llm/stream.ts 的 normalize 显式忽略 abort —— 于是生成器正常结束、
        //   outcome.error 是 undefined,这一行按 "done" 收口。
        //
        //   后果不是少一句提示:cleanup("done") 给每个没收完的工具写的是
        //   「the tool was NOT run and nothing changed. Call it again」,而
        //   killGroup 是真的把命令杀掉了 —— 它跑过了。模型据此重做一次已经
        //   落盘的 write/edit。而且 metadata.interrupted=false 会让
        //   needsAnotherRound 为真,于是 `alfa -p` 里 SIGINT **停不下来**,
        //   它再起一整轮去重跑刚被打断的活。
        //
        //   拿信号判而不是拿事件判,是为了不依赖上游的事件词表:SDK 换个方式
        //   表达 abort,这里照旧成立。
        const aborted = input.abortSignal.aborted
        processor.cleanup(outcome.error ? "error" : aborted ? "interrupted" : "done")
        if (aborted) {
          interrupted = true
          break
        }
        if (outcome.error) {
          error = outcome.error
          break
        }
      } catch (thrown) {
        const failure = toError(thrown)
        if (isAbort(failure, input.abortSignal)) {
          interrupted = true
          if (processor) processor.cleanup("interrupted")
          else this.closeShell(message, "interrupted", failure)
          break
        }
        error = describe(failure)
        if (processor) processor.cleanup("error", error)
        else this.closeShell(message, "error", error)
        emitter.emit({ type: "error", error })
        // 出错就停。重试已经在 llm/retry.ts 里做过了,到这里说明是不可重试的
        // 错误或者已经重试到顶 —— 再循环一轮只是换个姿势继续烧钱。
        break
      }

      if (input.abortSignal.aborted) {
        interrupted = true
        break
      }
      if (isLastStep) {
        hitStepLimit = true
        break
      }
    }

    return {
      steps,
      billedTokens: billed,
      interrupted,
      hitStepLimit,
      ...(error ? { error } : {}),
    }
  }

  // ───────────────────────────────────────────── 内部

  private appendUserMessage(sessionID: string, text: string, synthetic = false): void {
    const now = Date.now()
    const id = newMessageID()
    // ★ 「这是不是第一句」必须在插入**之前**问。插完再问的话,刚插进去的这条
    //   自己就是那个 user 消息,判据永远成立不了
    const first = !synthetic && !this.hasUserMessage(sessionID)
    this.deps.store.upsertMessage({ id, sessionID, role: "user", timeCreated: now })
    // 快照和记忆都挂在**这条消息上**,不是单独一条 user 消息:连着两条 user
    // 有的 provider 会合并、有的会报错,而这两份本来就是这句话的背景交代
    if (first) {
      this.attachGitContext(sessionID, id, now)
      this.attachMemory(sessionID, id, now)
    }
    this.deps.store.upsertPart({
      id: newPartID(),
      sessionID,
      messageID: id,
      timeCreated: now,
      type: "text",
      text,
      ...(synthetic ? { synthetic: true } : {}),
    })
    this.deps.store.touchSession(sessionID)
  }

  /**
   * 这一场里用户开过口没有。
   *
   * 判据是「库里有没有 user 消息」而不是「进程刚起来」:`/clear` 换的是会话,
   * `/resume` 接的是一场已经有开头的会话 —— 两边都靠这一条自然分开。
   */
  private hasUserMessage(sessionID: string): boolean {
    return this.deps.store.listAll(sessionID).some((entry) => entry.info.role === "user")
  }

  /**
   * 仓库快照挂到这条 user 消息上。只在一场会话的第一条上调用。
   *
   * 用的是 synthetic 的 text part,不是自己的一种 part:界面本来就不渲染它
   * (见 session/schema.ts 的 TextPart.synthetic —— 那个字段说的正是"环境块"),
   * 压缩、重放、"这轮答完没"三处判定也早就把 synthetic 排除在外了。
   * 为一份定长的背景再开一种 part,要同时改 schema、转换、`/context` 三处,
   * 换来的只是报表上多一栏 —— 而这一栏用户既砍不动也删不掉。
   */
  private attachGitContext(sessionID: string, messageID: string, now: number): void {
    if (!this.deps.gitContext) return
    const text = this.deps.gitContext()
    if (!text || text.length === 0) return
    this.deps.store.upsertPart({
      id: newPartID(),
      sessionID,
      messageID,
      // 比记忆(now-1)再早一毫秒。三块的次序是:仓库现状 → 项目记忆 → 用户的话。
      // 先摆事实,再摆约定,最后才是问题 —— 越靠后越容易被照做,而这一块
      // 恰恰是三者里最不需要被强调的
      timeCreated: now - 2,
      type: "text",
      text,
      synthetic: true,
    })
  }

  /** 项目记忆挂到这条 user 消息上。只在一场会话的第一条上调用 */
  private attachMemory(sessionID: string, messageID: string, now: number): void {
    if (!this.deps.memory) return
    const memory = this.deps.memory(sessionID)
    if (!memory || memory.text.length === 0) return
    this.deps.store.upsertPart({
      id: newPartID(),
      sessionID,
      messageID,
      // ★ 比正文早一毫秒。part 是按 (time_created, id) 排的,而 id 是随机的 ——
      //   同一个时间戳下谁在前面纯看运气,而这一份必须排在问题**前面**:
      //   先给背景再给问题
      timeCreated: now - 1,
      type: "memory",
      text: memory.text,
      notes: memory.notes,
    })
  }

  /**
   * 跑一次收口前的验证,返回要塞回去的话。
   *
   * ⚠ 这里**吞掉一切异常**。验证是加分项:它自己坏掉不该让一轮已经答完的对话
   *   变成一条报错 —— 用户会以为是模型的回答失败了。
   */
  private async verify(
    input: RunInput,
    history: MessageWithParts[],
    rounds: number,
  ): Promise<string | undefined> {
    if (!this.deps.verify) return undefined
    if (rounds >= MAX_VERIFY_ROUNDS) return undefined
    if (input.abortSignal.aborted) return undefined
    const touched = touchedFiles(history)
    if (touched.length === 0) return undefined
    try {
      return await this.deps.verify({ touched, abortSignal: input.abortSignal })
    } catch {
      return undefined
    }
  }

  private createAssistantShell(sessionID: string, parentID: string, model: ModelRef): AssistantMessage {
    const message: AssistantMessage = {
      id: newMessageID(),
      sessionID,
      role: "assistant",
      parentID,
      providerID: model.providerID,
      modelID: model.modelID,
      cost: 0,
      timeCreated: Date.now(),
    }
    // 必须先落库再交给 processor —— part 上有外键指向它
    this.deps.store.upsertMessage(message)
    return message
  }

  /**
   * 连 Processor 都没建起来就失败了(stream() 同步抛)。壳子已经落库,
   * 这里补上收尾状态 —— 否则历史里留一条永远"未完成"的空 assistant,
   * 而 isSettled() 看到没有 timeCompleted 会认为这轮还没答完,下次进来直接空转。
   */
  private closeShell(message: AssistantMessage, finish: "error" | "interrupted", error: Error): void {
    message.finish = finish
    if (finish === "error") message.error = { name: error.name, message: error.message }
    message.timeCompleted = Date.now()
    this.deps.store.upsertMessage(message)
    this.deps.emitter.emit({ type: "message.end", message })
  }
}

// ─────────────────────────────────────────────── 退出判定

/**
 * 这一轮答完了没。四个条件全满足才算完:
 *
 *   ① 有 assistant 回答
 *   ② 它回答的是**当前这条** user 消息(parentID 对得上)
 *   ③ 没有还等着被消化的工具结果
 *   ④ 它已经收过尾(timeCompleted 有值)
 *
 * 条件 ② 不再是恒真的了:子 agent 的报告是一条**合成 user 消息**,它可能在
 * 这一轮跑到一半的时候进来(见 cli/main.ts 的 deliverReport)。那时候最后一条
 * assistant 回答的是上一条 user,parentID 对不上 —— 循环因此知道"还有新活",
 * 于是接着转一轮把报告消化掉。这一项当初留着是对的。
 *
 * ★ 导出是给 CLI 用的:它要回答"现在有没有一条没人答的话"(有的话就得叫醒
 *   主 agent)。那个判断和这里必须是**同一份** —— 各写一遍迟早出现"界面以为
 *   答完了,而循环还想再转一轮"。
 */
export function isSettled(history: MessageWithParts[]): boolean {
  const user = latestUser(history)
  if (!user) return true
  const assistant = latestAssistant(history)
  if (!assistant || assistant.info.role !== "assistant") return false
  if (assistant.info.parentID !== user.info.id) return false
  if (!assistant.info.timeCompleted) return false
  return !needsAnotherRound(assistant)
}

/**
 * ★ 是否还要再发一轮。
 *
 * 判据是「这轮有没有跑过工具」,**不是 finishReason**。
 *
 * 原因:一堆 OpenAI 兼容端点(MiniMax 就是)在明明发起了 tool call 的情况下
 * 仍然报 finishReason: "stop"。信它的话,工具跑完了、结果落库了,却永远不会
 * 再发一轮把结果给模型看 —— 用户看到的是"它执行了命令然后一句话不说就结束了"。
 * 这个 bug 极难从日志上看出来,因为每一步单独看都成功了。
 *
 * 反过来,被中断的工具**不能**算数,否则 Ctrl-C 之后循环会一直转:
 * 它看到有工具 part,以为要送结果,发一轮,又被 abort,再看到工具 part……
 */
function needsAnotherRound(message: MessageWithParts): boolean {
  const tools = message.parts.filter((part): part is ToolPart => part.type === "tool")
  return tools.some((part) => !isInterrupted(part))
}

function isInterrupted(part: ToolPart): boolean {
  return part.state.status === "error" && part.state.metadata["interrupted"] === true
}

/**
 * 这一轮改过哪些文件。
 *
 * 从尾往前走,撞上**用户真的说过的那句话**就停。合成消息(验证自己塞回去的
 * 那一段)不算边界 —— 否则第二次验证只看得见第一次之后的改动,而那时候要验的
 * 是整轮的结果。
 */
function touchedFiles(history: MessageWithParts[]): string[] {
  const out = new Set<string>()
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!
    if (entry.info.role === "user") {
      if (entry.parts.some((part) => part.type === "text" && !part.synthetic && part.text.length > 0)) break
      continue
    }
    for (const part of entry.parts) {
      if (part.type !== "tool") continue
      if (part.tool !== "edit" && part.tool !== "write") continue
      if (part.state.status !== "completed") continue
      const path = part.state.metadata["filePath"]
      if (typeof path === "string" && path.length > 0) out.add(path)
    }
  }
  return [...out]
}

/**
 * 最后一条**要人答**的 user 消息。
 *
 * ★ 压缩点不算。它是以 user 身份落库的(那段交接要作为新历史的第一句进去,
 *   见 session/schema.ts),但它不是一句话,而是**同一段历史换了个写法** ——
 *   谁也没有提出新的要求。算成一条待答的话,压缩一落地循环就会再转一轮,
 *   而那一轮的输入是"一份摘要,外加没有问题":模型只能对着自己的交接说明
 *   自言自语,或者更糟 —— 把刚交接完的活儿重做一遍。自动压缩之后这条路每次
 *   都会走到,所以它必须在这里就断掉。
 */
function latestUser(history: MessageWithParts[]): MessageWithParts | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!
    if (entry.info.role !== "user") continue
    if (entry.parts.length > 0 && entry.parts.every((part) => part.type === "compact")) continue
    return entry
  }
  return undefined
}

function latestAssistant(history: MessageWithParts[]): MessageWithParts | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.info.role === "assistant") return history[i]
  }
  return undefined
}

// ─────────────────────────────────────────────── 错误

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function isAbort(error: Error, signal: AbortSignal): boolean {
  return signal.aborted || error.name === "AbortError"
}

/** 上下文溢出:给一句能直接照做的话,而不是把 provider 的原文甩出去。 */
function describe(error: Error): Error {
  if (error instanceof ContextOverflowError) {
    const hint = new ContextOverflowError(
      `Context window exceeded. Run /compact to fold this session into a summary and keep going, ` +
        `or /clear to start fresh. (${error.message})`,
    )
    hint.cause = error
    return hint
  }
  return error
}
