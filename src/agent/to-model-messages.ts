/**
 * 存储里的 message/part → LLMMessage[]。
 *
 * ★ 一条不可违反的不变量:**每个 tool-call 都必须有配对的 tool result**。
 *
 * Anthropic 少一个就直接 400,而且错误信息里不会告诉你是哪个 callID。
 * 最容易踩到的场景是中断:用户 Ctrl-C 的时候有个 bash 正跑着,那条 tool part
 * 停在 running,如果原样丢弃,历史里就留下一个孤儿 tool_use —— 之后**每一轮**
 * 请求都会 400,会话彻底废掉,而用户只会看到"又报错了"。
 *
 * 所以 pending / running / error 三种状态在这里全部转成 error 结果。
 * 宁可告诉模型"这个工具没跑成",也不能让它消失。
 */
import type { LLMContent, LLMMessage, LLMToolResult, ModelRef } from "../llm/types.ts"
import type { MessageWithParts, Part, ToolPart } from "../session/schema.ts"

export interface ConvertOptions {
  /** 本次请求要用的模型。用来决定 reasoning 的签名还能不能带。 */
  model?: ModelRef
}

const INTERRUPTED = "Tool execution was interrupted by the user before it completed."
const NEVER_RAN = "Tool call was never executed."

/**
 * 从第几条开始才发给模型。
 *
 * 压缩点(`/compact` 落的那颗钉子)之前的历史全部折叠成一段摘要 —— 它们还在
 * 库里,只是不再发出去。取**最后一个**压缩点:压过两次的会话,只有最新那次
 * 的摘要成立,再往前的那段摘要早就被包进新的那段里了。
 *
 * ⚠ 上下文仪表盘用的是同一个函数(见 agent/context.ts)。两边各判一次的话,
 *   迟早出现「仪表盘说满了,而模型其实只收到一半」这种谁都查不出来的分叉。
 */
export function compactionIndex(history: MessageWithParts[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.parts.some((part) => part.type === "compact")) return i
  }
  return 0
}

export interface LiveHistory {
  /** 真正发出去的那几条,按发出去的顺序 */
  messages: MessageWithParts[]
  /** 库里有、但这一趟不发的有几条 */
  folded: number
}

/**
 * 这一趟到底发哪几条。**发给模型的、算进占用的、下次压缩要读的,三边共用这一份。**
 *
 * ── 为什么不是简单的 slice ──
 * 压缩点是一条**追加在末尾**的消息(它前面才是被折掉的那些),而它身上钉着一个
 * `keptFrom`:从那条消息开始的最近几轮是**原样留着**的。于是真正要发的顺序是
 *
 *     [交接摘要] + [留下来的那几轮原文] + [压缩之后新说的话]
 *
 * 也就是说这一份**不是连续的一段**,顺序也和库里的顺序不同(摘要在库里排在
 * 尾巴后面,发出去时要排在前面 —— 它讲的是更早的事)。这正是它必须是一个函数、
 * 而不是三处各写一个 slice 的原因。
 *
 * ── 三边必须是同一份 ──
 * 仪表盘和模型看到的分叉之后,会出现"仪表盘说满了,而模型其实只收到一半"这种
 * 谁都查不出来的错;压缩读到的和模型看到的分叉,则会把已经折掉的东西再折一遍。
 */
export function liveHistory(history: MessageWithParts[]): LiveHistory {
  let at = -1
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.parts.some((part) => part.type === "compact")) {
      at = i
      break
    }
  }
  if (at < 0) return { messages: history, folded: 0 }

  const mark = history[at]!.parts.find((part) => part.type === "compact")
  const keptFrom = mark?.type === "compact" ? mark.keptFrom : undefined
  // 认不出那条消息就当"什么都不留"(老会话没有这一列,或者那条被删过) ——
  // 退回压缩当初的行为,而不是猜一个位置
  const from = keptFrom === undefined ? -1 : history.findIndex((entry) => entry.info.id === keptFrom)
  /**
   * 原样留下的那几轮。
   *
   * ★ **旧的压缩点要从里面剔掉。** 压过两次的会话里,第二次的 keptFrom 完全
   *   可能落在第一次那颗钉子**之前**(连着压两次就一定会),于是这一段里夹着
   *   一条 compact 消息 —— 而它会被 userContent 翻成一整段
   *   「以上内容已被下面这份交接摘要取代」发出去。
   *
   *   后果:模型在一段活生生的历史中间读到一句"你前面看到的都不作数了",
   *   底下跟着一份**已经被现在这份取代**的旧摘要。两份摘要一新一旧同时在场,
   *   而旧的那份还带着一句权威的"原文已经没有了"。
   *
   *   压缩点自己独占一条消息(见 compact.ts 的 applyCompaction),所以整条丢掉
   *   不会连累任何别的内容。
   */
  const tail =
    from >= 0 && from < at
      ? history.slice(from, at).filter((entry) => !entry.parts.some((part) => part.type === "compact"))
      : []
  return {
    messages: [history[at]!, ...tail, ...history.slice(at + 1)],
    folded: at - tail.length,
  }
}

/**
 * 当前这一趟工具循环从哪开始 —— 也就是**最后一条 user 消息**的位置。
 *
 * ── 为什么这条线正好画在这里 ──
 * 思考块在一趟工具循环里是**必须原样带回**的:模型每做一个 tool_use 决策之前
 * 都先想一段,少了那段,它下一步只看得见自己调过什么工具、拿到什么结果,
 * 看不见当时为什么那么决定。Anthropic 那边更硬 —— 带 tool_use 的那条 assistant
 * 消息缺了签名思考块直接 400。
 *
 * 而这一趟结束、新的用户消息进来之后,前面那些思考就可以安全丢掉了:
 * Anthropic 收到也会自己剥掉(思考 token 只在生成那一刻按 output 计费一次,
 * 不会像对话和工具结果那样每轮重新按 input 计),OpenAI 兼容端点则根本不认。
 * 两边都是「留着没用」,而留着要占我们自己的上下文账。
 *
 * ── 合成 user 消息也算一道线 ──
 * 收口前那道检查塞回去的提醒(见 loop.ts)是 user 身份的。它之后模型会重新想
 * 一遍,所以按它切是对的 —— 前面那段思考同样已经不需要了。
 */
export function loopStartIndex(live: MessageWithParts[]): number {
  for (let i = live.length - 1; i >= 0; i--) {
    if (live[i]!.info.role === "user") return i
  }
  return 0
}

export function toLLMMessages(history: MessageWithParts[], options: ConvertOptions = {}): LLMMessage[] {
  const out: LLMMessage[] = []

  const live = liveHistory(history).messages
  const loopStart = loopStartIndex(live)

  for (const [index, entry] of live.entries()) {
    if (entry.info.role === "user") {
      const content = userContent(entry.parts)
      if (content.length > 0) out.push({ role: "user", content })
      continue
    }

    // pending 的整条丢弃(调用和结果一起),其余状态调用与结果必须成对出现。
    // 这里和 assistantContent 里的过滤条件必须完全一致 —— 两边不一致就是孤儿。
    const tools = entry.parts.filter(
      (part): part is ToolPart => part.type === "tool" && part.state.status !== "pending",
    )
    const sameModel =
      !options.model ||
      (options.model.providerID === entry.info.providerID && options.model.modelID === entry.info.modelID)

    // 思考只留这一趟循环里的。见 loopStartIndex 上那段
    const content = assistantContent(entry.parts, sameModel && index > loopStart)
    if (content.length === 0) {
      // 空 assistant 消息有的 provider 会 400。整条跳过 ——
      // 连带它的 tool 结果也必须跳过,否则就是孤儿 tool_result(同样 400)。
      continue
    }

    out.push({ role: "assistant", content })

    if (tools.length > 0) {
      out.push({ role: "tool", content: tools.map(toolResult) })
    }
  }

  return out
}

function userContent(parts: Part[]): LLMContent[] {
  const content: LLMContent[] = []
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text.length > 0) content.push({ type: "text", text: part.text })
    } else if (part.type === "file") {
      content.push({ type: "file", mediaType: part.mediaType, data: part.url })
    } else if (part.type === "memory") {
      // 项目记忆。以 user 的身份进去,因为它是**背景交代**,不是模型说过的话 ——
      // 和压缩点同一条理由。它排在这条消息的 text 前面,先给背景再给问题
      content.push({ type: "text", text: part.text })
    } else if (part.type === "compact") {
      // 压缩点本身就是这段历史的开头。它以 user 的身份出现,因为新历史的第一句
      // 必须是 user —— 而且这段话确实是"背景交代",不是模型自己说过的话
      content.push({ type: "text", text: compactionText(part.text) })
    }
  }
  return content
}

/**
 * 摘要包一层。**必须说清三件事**:前面的原文没了、这是摘要不是用户的指示、
 * 缺细节就自己去重新读。
 *
 * 少了最后一句,模型会拿着一份粗颗粒的摘要当成完整事实继续干活 —— 表现出来
 * 就是压缩之后它开始凭印象改文件。
 */
function compactionText(summary: string): string {
  return [
    "This session was compacted to free up context. Everything before this point has been replaced by the",
    "handoff summary below — the original messages are no longer available to you.",
    "",
    "<session-summary>",
    summary,
    "</session-summary>",
    "",
    "Continue from here. The summary is a summary: whenever you need detail it does not cover — exact file",
    "contents, command output, line numbers — read the files or run the commands again rather than recalling them.",
  ].join("\n")
}

/**
 * @param keepReasoning 这条消息的思考要不要带上。同时管两件事:换过模型
 *   (别家的签名回灌 Anthropic 会 400,去掉签名再回灌**也**会 400,丢掉是
 *   唯一安全的做法),以及它是不是在当前这趟工具循环里(见 loopStartIndex)。
 */
function assistantContent(parts: Part[], keepReasoning: boolean): LLMContent[] {
  const content: LLMContent[] = []
  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (part.text.length > 0) content.push({ type: "text", text: part.text })
        break
      case "reasoning":
        if (!keepReasoning) break
        if (part.text.length === 0) break
        content.push({
          type: "reasoning",
          text: part.text,
          ...(part.signature ? { signature: part.signature } : {}),
        })
        break
      case "tool":
        // pending 说明模型还没吐完参数就断了 —— 没有 input,回灌只会让 provider
        // 报参数错误。调用和结果必须**一起**丢,上面 tools 的过滤条件与此同步。
        if (part.state.status === "pending") break
        content.push({ type: "tool-call", callID: part.callID, tool: part.tool, input: part.state.input })
        break
      default:
        // step-start / step-finish / file 不进模型上下文
        break
    }
  }
  return content
}

function toolResult(part: ToolPart): LLMToolResult {
  const base = { callID: part.callID, tool: part.tool }
  switch (part.state.status) {
    case "completed":
      return { ...base, output: part.state.output }
    case "error":
      return { ...base, output: part.state.error, isError: true }
    case "running":
      return { ...base, output: INTERRUPTED, isError: true }
    case "pending":
      return { ...base, output: NEVER_RAN, isError: true }
  }
}

/**
 * 自检:tool-call 和 tool result 是否一一配对。
 *
 * 转换逻辑本身已经保证配对,但「保证」是靠人读代码得出的结论,改一行就可能
 * 破坏。这个函数让它变成可断言的事实,测试和调试模式都用它。
 */
export function findUnpairedToolCalls(messages: LLMMessage[]): string[] {
  const problems: string[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    if (message.role !== "assistant") continue
    const calls = message.content.filter((c) => c.type === "tool-call")
    if (calls.length === 0) continue

    const next = messages[i + 1]
    const results = next?.role === "tool" ? next.content : []
    const answered = new Set(results.map((r) => r.callID))
    for (const call of calls) {
      if (call.type === "tool-call" && !answered.has(call.callID)) problems.push(call.callID)
    }
    // 反向:有结果却没有对应调用,同样是 400
    const asked = new Set(calls.map((c) => (c.type === "tool-call" ? c.callID : "")))
    for (const result of results) {
      if (!asked.has(result.callID)) problems.push(`orphan-result:${result.callID}`)
    }
  }
  return problems
}
