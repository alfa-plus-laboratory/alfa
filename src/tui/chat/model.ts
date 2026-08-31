/**
 * session 视图的状态。
 *
 * 它是**事件流的一个投影**,不是第二份真值:同一条 UIEvent 同时喂给瀑布流的
 * Transcript 和这里,所以两个视图任何时候都能互切,切过去看到的都是完整的。
 * 谁也不是谁的缓存。
 *
 * ── 它比 Transcript 记得少,这是重点 ──
 * Transcript 存整场会话的每一行。这里只存:一段摘要、当前那句提问、**它最后
 * 想的或说的那一段**、这一轮的工具行。轮次一开始,活动区就清空 —— 于是这一栏
 * 的高度不随会话长度增长,而「往上滑」这件事也就不再是必需品。要回头看有
 * `/view stream`。
 *
 * ── 思考不进这块缓冲 ──
 * 它只留**最后那几百个字**(reasoningText),由界面拿去在活动区顶上滚一行
 * 走马灯。整段铺出来试过:模型一想就是几十行,正文和工具行全被顶走,而那几十行
 * 里没有一句是结论 —— 用户要的是「它还在动、现在念叨到哪了」,不是通读草稿。
 *
 * ── 摘要不在这里生成 ──
 * 这里只管存和显示状态(写着 / 写好了 / 这一版没写成)。真正派 agent 去写的是
 * main.ts —— 界面层不该持有一个能自己发起 LLM 请求的东西,那样中断、超时、
 * 换模型三件事就没有一个统一的地方管了。
 */
import type { UIEvent } from "../../agent/events.ts"
import type { DigestTool, TurnDigest } from "../../agent/summarize.ts"
import { firstLine, outcomeLine, Renderer, shortenPaths, summarize as toolTarget } from "../../cli/render.ts"
import type { ToolPart } from "../../session/schema.ts"
import { parseTodos, type TodoItem } from "../../tool/todo.ts"
import { MAX_TAIL, type BoardRow, type NoteTone, type ToolRow } from "./board.ts"
import { SpeechBuffer } from "./speech.ts"

/**
 * 看板留多少条。
 *
 * 八条,不是六十条。看板独立成一块**只有两行、能往上翻**的面板之后,这个数的
 * 含义变了:它不再是「缓冲区多大」,而是**用户能翻回去看多远**。八条是「这一轮
 * 刚才干了什么」和「这不是一份日志」之间的那个数 —— 再往前的属于 `/view stream`,
 * 那边本来就是完整记录,而这一栏存在的理由恰恰是不必去翻它。
 */
const MAX_ROWS = 8
/**
 * 思考留最后这么多字。
 *
 * 它只喂活动区顶上那一行走马灯,而那一行一次也就看得见几十列 —— 留几百字是
 * 给「窗口比一行宽的终端」留的余量,不是要给人通读的。
 */
const MAX_REASONING = 600
/** 喂给摘要 agent 的正文上限 */
const MAX_REPLY = 4_000

export type SummaryState = "empty" | "writing" | "ready" | "failed"

export interface Thinking {
  /** 最后那几百个字。界面只在一行里滚它的**尾巴** */
  text: string
  /** 想了多久 */
  ms: number
  /** 还在想(还没开口) */
  active: boolean
  /**
   * 这一轮到底想过没有。
   *
   * 不能拿 `ms > 0` 当判据:模型吐一段思考再吐正文,中间可能不到一毫秒,
   * 于是「想了 0ms」这条痕迹就消失了。想过这件事要留痕,想了多久是另一回事。
   */
  seen: boolean
}

/**
 * 计划全做完之后再留多久。
 *
 * 留一会儿而不是当场消失:最后那一条打上勾的瞬间是有信息量的(「它真的做完了」),
 * 当场撤掉的话用户只会看到一块地方突然空了。留太久又没道理 —— 这一块回答的是
 * 「接下来还有什么」,而答案已经是"没有了"。
 */
export const PLAN_LINGER_MS = 15_000

/** 两份清单是不是同一份(文字和状态都一样)。 */
function sameplan(a: readonly TodoItem[], b: readonly TodoItem[]): boolean {
  if (a.length !== b.length) return false
  return a.every((item, i) => item.text === b[i]!.text && item.status === b[i]!.status)
}

export class ChatModel {
  /**
   * 状态变了。宿主挂上它去要一帧 —— 见 tui/transcript.ts 上同名那颗星。
   *
   * 只在 handle() 末尾喊:别的改法(said / note / plan …)都是界面自己调的,
   * 那些调用点本来就跟着一次 requestFrame。事件流是**唯一**从外面推进来、
   * 界面自己不知道的那条路。
   */
  onChange: (() => void) | undefined

  /** 最后一段它说的话。渲染由内部那个只画正文的 Renderer 负责 */
  readonly speech = new SpeechBuffer()
  private readonly renderer: Renderer
  private readonly root: string

  private rows: BoardRow[] = []
  /**
   * 看板从第几条开始算「现在这一段」。
   *
   * 它**每开一段新正文就往前推**:工具行是跟在它某句话后面的动作,那句话被
   * 下一句盖掉之后,挂在它下面的调用也就不再属于「现在」。rows 本身一条不删 ——
   * 这一轮的浓缩要拿全部(见 endTurn)。
   */
  private boardFrom = 0
  private noteSeq = 0
  private promptText = ""
  /**
   * 你趁它还在跑的时候插的那几句。
   *
   * 放在这里而不是只放在 App 上,是因为它要被**画出来**:一句话敲完就从输入框
   * 消失、只在状态行留个「queued (1)」,用户的第一反应是"我刚才那句去哪了"。
   * 它属于「你说的话」那一段,所以真值源和提问放在一起。
   */
  private queuedItems: string[] = []

  private summaryText = ""
  private summaryStatus: SummaryState = "empty"
  private summaryWhy = ""

  /**
   * 当前的计划。**跨轮次活着** —— 和摘要一样讲的是整段活儿,不是这一轮。
   *
   * 真值源是 todo 工具那次调用的 metadata,所以它跟着事件流走:恢复会话时
   * replay 把工具 part 翻回事件,这份清单自己就装回来了,不需要第二条路。
   */
  private planItems: TodoItem[] = []
  /** 整份计划变成"全做完"的那一刻。见 plan 的 getter */
  private planDoneAt = 0

  private reasoningText = ""
  private reasoningStart = 0
  private reasoningMs = 0
  private reasoningActive = false

  /** 攒给摘要 agent 的材料。和显示用的 speech 分开 —— 那个只留最后一段 */
  private replyText = ""
  private turnStarted = 0

  constructor(options: { root: string }) {
    this.root = options.root
    this.renderer = new Renderer({
      sink: this.speech,
      root: options.root,
      markdown: true,
      // 工具、统计、重试都归看板画,思考归上面那行走马灯。这里只要正文
      parts: "text",
    })
  }

  // ───────────────────────────────────────────── 读

  get prompt(): string {
    return this.promptText
  }

  /** 排在后面还没轮到的那几句。轮到了就会变成 prompt */
  get queued(): readonly string[] {
    return this.queuedItems
  }

  setQueued(items: readonly string[]): void {
    this.queuedItems = [...items]
  }

  get summary(): string {
    return this.summaryText
  }

  get summaryState(): SummaryState {
    return this.summaryStatus
  }

  get summaryError(): string {
    return this.summaryWhy
  }

  /**
   * 换一份计划。
   *
   * 「全做完了」的时刻只在**刚刚变成全做完**的那一次记 —— 每次覆盖都重置的话,
   * 模型在做完之后又调一次 todo(内容一样)就会把倒计时重新拨满,那份清单
   * 就再也不会消失了。
   */
  private setPlan(items: TodoItem[]): void {
    const done = items.length > 0 && items.every((item) => item.status === "done")
    const wasDone = this.planDoneAt > 0
    const same = wasDone && sameplan(this.planItems, items)
    this.planItems = items
    if (!done) this.planDoneAt = 0
    else if (!same) this.planDoneAt = Date.now()
  }

  /** 界面看得见的那几条:跟在它最后那句话后面的动作 */
  get board(): readonly BoardRow[] {
    return this.rows.slice(this.boardFrom)
  }

  /**
   * 计划。**全做完了就自己退场** —— 见 PLAN_LINGER_MS。
   *
   * ★ 退场判定必须在这里,不能在面板里。这一份是真值源,而它有两个消费者
   *   (全屏的 PlanPane 和窄屏时对话栏里那一段)。判两次的话,一边撤了另一边
   *   还在,现象是「窗口一窄,做完的计划又回来了」。
   */
  get plan(): readonly TodoItem[] {
    if (this.planDoneAt > 0 && Date.now() - this.planDoneAt >= PLAN_LINGER_MS) return []
    return this.planItems
  }

  /**
   * 全做完的计划什么时候该消失。0 = 还没做完 / 已经消失了。
   *
   * 界面空闲时不重绘(见 tui/app.ts 的 startTimer),所以到点了得有人叫一声 ——
   * App 拿这个时间点安排一次一次性的重绘。
   */
  get planRetireAt(): number {
    if (this.planDoneAt === 0) return 0
    const at = this.planDoneAt + PLAN_LINGER_MS
    return at > Date.now() ? at : 0
  }

  get thinking(): Thinking {
    return {
      text: this.reasoningText,
      ms: this.reasoningActive && this.reasoningStart > 0 ? Date.now() - this.reasoningStart : this.reasoningMs,
      active: this.reasoningActive,
      seen: this.reasoningStart > 0,
    }
  }

  // ───────────────────────────────────────────── 轮次

  /**
   * 新的一轮。活动区整个清空 —— 上一轮的工具行和话留在这里只会让人以为
   * 它们还在跑。摘要不动:它讲的是整场会话,不是这一轮。
   */
  beginTurn(prompt: string): void {
    this.promptText = prompt
    this.rows = []
    this.boardFrom = 0
    this.wipe()
    this.replyText = ""
    this.reasoningText = ""
    this.reasoningMs = 0
    this.reasoningStart = 0
    this.reasoningActive = false
    this.turnStarted = Date.now()
  }

  /** 这一轮结束,交出给摘要 agent 的材料。 */
  endTurn(result: { interrupted?: boolean; hitStepLimit?: boolean; error?: string } = {}): TurnDigest {
    this.reasoningActive = false
    return {
      prompt: this.promptText,
      reply: this.replyText,
      tools: this.rows.filter(isTool).map(toDigestTool),
      ...(result.interrupted ? { interrupted: true } : {}),
      ...(result.hitStepLimit ? { hitStepLimit: true } : {}),
      ...(result.error ? { error: result.error } : {}),
    }
  }

  get elapsedMs(): number {
    return this.turnStarted > 0 ? Date.now() - this.turnStarted : 0
  }

  // ───────────────────────────────────────────── 事件

  handle(event: UIEvent): void {
    switch (event.type) {
      case "part.start":
        // 新的一段正文开始 —— 之前那段(想的也好说的也好)丢掉。
        // 「只显示最后那一段」就是这一行:这个区域回答的是现在怎么样了
        if (event.part.type === "text") {
          this.wipe()
          // 新的一段话开始:挂在**上一句**下面的那些调用跟着一起收走 ——
          // 它们是那句话的动作,不是这一句的
          this.boardFrom = this.rows.length
          this.closeThinking()
        }
        // 思考**一个字都不进这块缓冲** —— 它归上面那行走马灯,见 MAX_REASONING
        if (event.part.type === "reasoning") this.openThinking()
        break

      case "part.delta":
        if (event.part.type === "text") {
          this.closeThinking()
          this.replyText = clip(this.replyText + event.delta, MAX_REPLY)
        } else if (event.part.type === "reasoning") {
          this.openThinking()
          this.reasoningText = clip(this.reasoningText + event.delta, MAX_REASONING, "tail")
        }
        break

      case "part.end":
        if (event.part.type === "reasoning") this.closeThinking()
        break

      case "tool.state":
        this.tool(event.part)
        break

      case "retry":
        this.note("warn", event.message)
        break

      case "error":
        this.note("bad", firstLine(event.error.message))
        break

      case "step.finish":
      case "message.start":
      case "message.end":
        break
    }
    // 正文的 markdown 渲染整个交给 Renderer —— 见构造函数
    this.renderer.handle(event)
    this.onChange?.()
  }

  private tool(part: ToolPart): void {
    if (part.state.status === "pending") return
    const existing = this.rows.find((row): row is ToolRow => row.kind === "tool" && row.id === part.id)
    const row: ToolRow = existing ?? {
      kind: "tool",
      id: part.id,
      callID: part.callID,
      tool: part.tool,
      target: "",
      status: "running",
      startedAt: Date.now(),
      outcome: "",
    }
    row.target = toolTarget(part, this.root) || row.target
    switch (part.state.status) {
      case "running":
        row.status = "running"
        row.startedAt = part.state.time.start
        break
      case "completed": {
        row.status = "completed"
        row.endedAt = part.state.time.end
        row.startedAt = part.state.time.start
        row.outcome = outcomeLine(part, this.root)
        row.tail = tailOf(part.tool, part.state.output, this.root)
        const diff = part.state.metadata["diff"]
        // ★ diff 必须留着。右栏被收掉时看板会就地展开它 —— edit 默认放行
        //   是拿「改了什么当场看得见」换来的,少一次就不成立了
        if (typeof diff === "string" && diff.length > 0) row.diff = diff
        // 整份覆盖,和工具的语义一致:模型每次发的都是完整清单,合并只会
        // 让界面上留着一条它已经删掉的步骤
        if (part.tool === "todo") this.setPlan(parseTodos(part.state.metadata["todos"]))
        break
      }
      case "error":
        row.status = "error"
        row.endedAt = part.state.time.end
        row.outcome = firstLine(part.state.error, 60)
        // 报错的**全文**比一行摘要有用得多:第一行常常只是 "Command failed",
        // 真正说清楚是哪儿错了的在后面
        row.tail = tailOf(part.tool, part.state.error, this.root)
        break
    }
    if (!existing) this.push(row)
  }

  // ───────────────────────────────────────────── 收据

  /**
   * 有一条权限正在问。返回的 id 用来在用户按完键之后原地换成结果。
   *
   * 做成「先占一行、再原地改」而不是「批准之后补一行」:正在等你的时候,
   * 那一行就得在看板上 —— 否则用户看到的是一个停住不动的 agent,
   * 而模态框可能被别的东西盖着,或者他刚好没在看屏幕。
   */
  permissionAsked(text: string): string {
    const id = `note-${++this.noteSeq}`
    this.push({ kind: "note", id, tone: "warn", text })
    return id
  }

  permissionDecided(id: string, text: string, tone: NoteTone): void {
    const row = this.rows.find((item) => item.kind === "note" && item.id === id)
    if (row && row.kind === "note") {
      row.tone = tone
      row.text = text
      return
    }
    this.note(tone, text)
  }

  note(tone: NoteTone, text: string): void {
    this.push({ kind: "note", id: `note-${++this.noteSeq}`, tone, text })
  }

  /**
   * trust 模式没问就放行了 —— 把记号打在**那次调用本行**上。
   *
   * 返回 false 表示没找到对应的行(理论上不该发生:询问是从工具的 execute
   * 里发出来的,那时候卡片一定已经在了)。调用方据此回落到追加一行 ——
   * 一条丢掉的放行记录比一条多余的行糟糕得多。见 board.ts 的 ToolRow.trusted。
   */
  markTrusted(callID: string): boolean {
    const row = this.rows.find((item): item is ToolRow => item.kind === "tool" && item.callID === callID)
    if (!row) return false
    row.trusted = true
    return true
  }

  // ───────────────────────────────────────────── 摘要

  summaryWriting(): void {
    this.summaryStatus = "writing"
  }

  setSummary(text: string): void {
    this.summaryText = text
    this.summaryStatus = text.length > 0 ? "ready" : "empty"
    this.summaryWhy = ""
  }

  /** 这一版没写成。**旧的那份留着** —— 有一份过时的摘要,好过一片空白。 */
  setSummaryFailed(why: string): void {
    this.summaryStatus = this.summaryText.length > 0 ? "ready" : "failed"
    this.summaryWhy = why
  }

  /**
   * 程序自己说的话:斜杠命令的回答。
   *
   * 和「它最后说的那段话」占**同一块地方**。你刚敲了一条命令,答案就该出现在
   * 「现在」里 —— 之前它只写进瀑布流,于是在默认的 session 视图下按 `/help`
   * 屏幕上一个字都不动,看着就是这条命令坏了。
   *
   * 会盖掉模型上一段话,和模型自己开新一段时的规矩一样:这个区域回答的是
   * 「现在怎么样了」。要翻回去有 `/view stream`。
   */
  say(text: string): void {
    this.wipe()
    for (const line of text.split("\n")) this.speech.write(line + "\n")
  }

  /**
   * 这一栏上的东西**不再属于当前这一场**了 —— 全部清掉,摘要也一样。
   *
   * 两个调用方都要这个语义:`/clear` 开一场新的,`/resume` 换到另一场。
   *
   * ── 摘要为什么必须一起清 ──
   * 它一度留着,理由是「/clear 只是擦屏幕」。但屏幕上留下的那句「到目前为止」
   * 讲的是一场已经不在了的会话 —— 用户看到的现象就是「clear 了但好像没 clear
   * 干净」。而换会话时更糟:上一场的摘要会挂在新会话头上,一直挂到新的那份
   * 写出来为止(新会话如果没有摘要,就是永远)。
   *
   * 钉着的那句提问、没做完的计划同理。模型手里那几份还在(它们在上下文里),
   * 所以 `/resume` 接回来时会由重放补上,而 `/clear` 之后本来就该是空的。
   */
  clear(): void {
    this.rows = []
    this.boardFrom = 0
    this.promptText = ""
    this.planItems = []
    this.planDoneAt = 0
    this.queuedItems = []
    this.summaryText = ""
    this.summaryStatus = "empty"
    this.summaryWhy = ""
    this.wipe()
  }

  // ───────────────────────────────────────────── 私有

  /**
   * 清掉这一栏上的话。
   *
   * ★ 顺序同上:先 reset 再清,否则 markdown 手里攒着的那半行会落进一个刚
   * 清空的缓冲,于是上一段的尾巴粘在新一段的开头。
   */
  private wipe(): void {
    this.renderer.reset()
    this.speech.reset()
  }

  private push(row: BoardRow): void {
    this.rows.push(row)
    const over = this.rows.length - MAX_ROWS
    if (over <= 0) return
    this.rows.splice(0, over)
    // ★ boardFrom 是**下标**,不是标记。数组从头切掉几条,它必须跟着往回退。
    //
    //   不退的话:rows.length 被钉在 MAX_ROWS,而 boardFrom 在下一次开口说话时
    //   被设成 rows.length —— 从此 board = rows.slice(boardFrom) 永远是空的。
    //   现象是「agent 连着跑十几条 bash,右栏里看得见,对话那一栏一行都没有」,
    //   而且**一轮里调够八次之后才开始**,所以短会话里怎么试都试不出来。
    this.boardFrom = Math.max(0, this.boardFrom - over)
  }

  private openThinking(): void {
    if (this.reasoningActive) return
    this.reasoningActive = true
    this.reasoningStart = Date.now()
  }

  private closeThinking(): void {
    if (!this.reasoningActive) return
    this.reasoningActive = false
    this.reasoningMs = Date.now() - this.reasoningStart
  }
}

/**
 * 结果的最后两行,给看板挂在那条调用下面。
 *
 * ── read 不给 ──
 * 它的输出是**文件内容**,最后两行就是那个文件的最后两行 —— 和这次调用干了
 * 什么毫无关系,而且右栏本来就整篇铺着。`218 lines` 那句摘要已经说完了。
 *
 * ── 空行、行号标记都扔掉 ──
 * 留着的话两行的额度会被一行空白吃掉一半。
 */
function tailOf(tool: string, output: string, root: string): string[] | undefined {
  if (tool === "read") return undefined
  const lines = shortenPaths(output, root)
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim().length > 0)
  if (lines.length === 0) return undefined
  return lines.slice(-MAX_TAIL)
}

function isTool(row: BoardRow): row is ToolRow {
  return row.kind === "tool"
}

function toDigestTool(row: ToolRow): DigestTool {
  return {
    tool: row.tool,
    target: row.target,
    outcome: row.outcome,
    ...(row.status === "error" ? { failed: true } : {}),
  }
}

/** 掐头还是掐尾:正文留开头(它先说结论),思考留结尾(它最后想的才是现在)。 */
function clip(text: string, max: number, keep: "head" | "tail" = "head"): string {
  if (text.length <= max) return text
  return keep === "head" ? text.slice(0, max) : text.slice(text.length - max)
}
