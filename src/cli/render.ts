/**
 * 终端渲染。stdout 的唯一持有者。
 *
 * ── 为什么全流程只有这一个文件写 stdout ──
 * 流式文本是一个字一个字打出来的,中间任何一行别处来的 console.log 都会把
 * 正在打的句子从中间劈开。调试日志走 util/log.ts 落文件,不进 stdout。
 * 底部还钉着一个每帧重画的输入框(live.ts),绕过这里直接写会把它撕开。
 *
 * ── 换行状态 ──
 * 模型的文本不保证以换行结尾,而工具卡片必须从行首开始画。所以要知道"光标
 * 现在在不在行首",该补的时候补一个 \n。这个状态看起来微不足道,漏了就是
 * 满屏错位。它由 sink 维护 —— 半行文本是活动区的一部分,只有它知道。
 */
import { theme } from "./theme.ts"
import type { OutputSink } from "./live.ts"
import { MarkdownStream } from "./markdown.ts"
import { planRows } from "./plan.ts"
import type { UIEvent } from "../agent/events.ts"
import { t } from "../i18n/index.ts"
import type { Part, ToolPart } from "../session/schema.ts"
import type { Tokens } from "../llm/types.ts"
import { parseTodos } from "../tool/todo.ts"

export interface RenderOptions {
  /** 输出去处。交互模式下是活动区,-p 模式下是一个直通 stdout 的实现。 */
  sink: OutputSink
  /** 显示模型的思考过程 */
  showReasoning?: boolean
  /** 工作区根。路径按它相对化显示 —— 绝对路径会把每张卡片撑到换行。 */
  root?: string
  /**
   * 画哪些东西。
   *
   *   all   —— 全部(瀑布流)
   *   text  —— 只画模型的正文(session 视图的活动区,工具由看板画)
   *
   * 分出 text 这一档不是为了省事,是为了让两个视图里的**同一段回答**长得
   * 一模一样:markdown 的流式定稿、半行重画、悬挂缩进都在这个类里,活动区
   * 自己再写一遍的话,两边迟早在某个边角上分叉。
   */
  parts?: "all" | "text"
  /**
   * 每条 assistant 消息开口说话前打一行署名。
   *
   * 瀑布流里用户和模型的话原来只靠一个 `›` 区分,滚起来之后根本分不出谁在说 ——
   * 尤其是模型的回答里也有列表和代码块的时候。
   */
  speakers?: boolean
  /**
   * 把模型的正文按 markdown 渲染。
   *
   * 要求 sink 实现了 replaceTail —— 没有「重画半行」的能力就做不了流式
   * markdown,那种情况下静默退回原样输出,而不是渲染出一半再卡住。
   *
   * 管道和 -p 里默认关:那些输出是要给别的程序吃的,加粗和项目符号只会碍事。
   */
  markdown?: boolean
}

export class Renderer {
  private readonly sink: OutputSink
  private readonly showReasoning: boolean
  private readonly root: string
  /** 已经画过头部的 tool part(避免重复画) */
  private announced = new Set<string>()
  /**
   * 最后一个画过 ● 头的工具。
   *
   * 并行调用时(模型一次发起 read + glob),两个 ● 会先后打出来,结果却按
   * 各自完成的顺序回来 —— 于是 glob 的 ● 底下挂着 read 的 ↳,读起来完全是
   * 错的。所以结果行只有紧跟在自己的头后面时才省略工具名。
   */
  private lastAnnounced: string | undefined
  private stepStarted = 0
  /** 开着 markdown 时的正文渲染器。关着就是 undefined,正文原样写。 */
  private readonly md: MarkdownStream | undefined
  private readonly parts: "all" | "text"
  private readonly speakers: boolean
  /** 这条消息还没开口。真正说话时才打署名 —— 只调工具不说话的那些不该有头 */
  private headerPending = false

  constructor(options: RenderOptions) {
    this.sink = options.sink
    this.showReasoning = options.showReasoning ?? false
    this.root = options.root ?? process.cwd()
    this.parts = options.parts ?? "all"
    this.speakers = options.speakers ?? false
    this.md = options.markdown === true && typeof options.sink.replaceTail === "function" ? new MarkdownStream() : undefined
  }

  handle(event: UIEvent): void {
    const textOnly = this.parts === "text"
    switch (event.type) {
      case "part.delta":
        if (event.part.type === "text") this.text(event.delta)
        // 思考过程不走 markdown:它是模型的草稿,连贯性本来就差,渲染出
        // 半截标题和空列表反而更难读。整片压暗就够了。
        else if (event.part.type === "reasoning" && this.showReasoning) this.write(theme.dim(event.delta))
        break

      case "part.end":
        if (event.part.type === "text" || event.part.type === "reasoning") this.newlineIfNeeded()
        break

      case "part.start":
        if (!textOnly && event.part.type === "step-start") this.stepStarted = Date.now()
        break

      case "tool.state":
        if (!textOnly) this.tool(event.part)
        break

      case "step.finish":
        if (!textOnly) this.stepLine(event.part.tokens, event.part.finishReason)
        break

      case "retry":
        if (!textOnly) {
          this.line(
            theme.yellow(`  ↻ ${t.retrying(event.message, `${(event.delayMs / 1000).toFixed(1)}s`, event.attempt, event.maxAttempts)}`),
          )
        }
        break

      case "error":
        if (!textOnly) this.line(theme.red(`  ✗ ${event.error.message}`))
        break

      case "message.start":
        this.headerPending = this.speakers
        break

      case "message.end":
        break
    }
  }

  // ───────────────────────────────────────────── 工具

  private tool(part: ToolPart): void {
    const key = `${part.id}:${part.state.status}`
    if (this.announced.has(key)) return
    this.announced.add(key)

    switch (part.state.status) {
      case "pending":
        return // 参数还没齐,画出来只会闪一下
      case "running":
        this.newlineIfNeeded()
        this.line(theme.cyan(`  ● ${part.tool}`) + theme.dim(` ${summarize(part, this.root)}`))
        this.lastAnnounced = part.id
        return
      case "completed": {
        const ms = part.state.time.end - part.state.time.start
        this.line(theme.dim(`    ↳ ${this.owner(part)}${this.summaryOf(part)}  ${duration(ms)}`))
        // ★ diff 永远打印。edit 默认 allow 就是以"改了什么必须当场看见"为前提换来的,
        //   少打一次 diff,这个默认值就不再成立了。
        const diff = part.state.metadata["diff"]
        if (typeof diff === "string" && diff.length > 0) this.diff(diff)
        // 计划整份打印,和 diff 同一条理由:那次调用干的事**就是**这份清单,
        // 只打一行 `2/5` 等于把工具的全部内容藏起来
        const todos = parseTodos(part.state.metadata["todos"])
        if (todos.length > 0) for (const line of planRows(todos, 72)) this.line("    " + line)
        return
      }
      case "error":
        this.line(theme.red(`    ↳ ${this.owner(part)}${firstLine(part.state.error)}`))
        return
    }
  }

  /** 结果行错位时补上「是谁的结果」。 */
  private owner(part: ToolPart): string {
    if (this.lastAnnounced === part.id) return ""
    return `${part.tool}: `
  }

  private summaryOf(part: ToolPart): string {
    return outcomeLine(part, this.root)
  }

  /**
   * 带颜色的统一 diff。这是用户唯一一次看到文件被改成什么样的机会。
   *
   * 头部只留一行相对路径:`Index:` 的绝对路径和那条 67 个等号的分隔线是
   * 给 patch(1) 看的,对人是纯噪音;但文件名必须留 —— 并行编辑多个文件时,
   * 没有它就分不清这块 diff 是谁的。
   */
  private diff(patch: string): void {
    for (const line of diffLines(patch, this.root)) this.line("    " + line)
  }

  // ───────────────────────────────────────────── 状态行

  private stepLine(tokens: Tokens, finishReason: string): void {
    const ms = this.stepStarted > 0 ? Date.now() - this.stepStarted : 0
    const bits = [
      `${compact(tokens.input)} in`,
      `${compact(tokens.output)} out`,
      tokens.cache.read > 0 ? `${compact(tokens.cache.read)} cached` : "",
      ms > 0 ? duration(ms) : "",
      finishReason !== "stop" && finishReason !== "tool-calls" ? finishReason : "",
    ].filter(Boolean)
    this.newlineIfNeeded()
    this.line(theme.dim(`  · ${bits.join(" · ")}`))
  }

  // ───────────────────────────────────────────── 原语

  /** 用户提示前的分隔。 */
  banner(text: string): void {
    this.newlineIfNeeded()
    this.line(theme.dim(text))
  }

  line(text: string): void {
    this.newlineIfNeeded()
    this.sink.write(text + "\n")
  }

  write(text: string): void {
    if (text.length === 0) return
    // 原样写之前先把 markdown 缓冲收掉。思考过程和正文是两条路,交错着来的时候
    // 少了这一下,思考文本会被接在正文那条还没收口的半行后面
    this.flushText()
    this.sink.write(text)
  }

  /**
   * 模型正文。
   *
   * 每来一个增量就把「已定稿的整行」提交、把「还没完成的那部分」整个换掉 ——
   * 合成一次 replaceTail,一帧画完。
   */
  private text(delta: string): void {
    if (this.headerPending) {
      this.headerPending = false
      this.line("")
      this.line(theme.cyan(AGENT_MARK) + theme.dim(" agent"))
    }
    if (!this.md) {
      this.write(delta)
      return
    }
    this.md.push(delta)
    this.sink.replaceTail!(this.md.drain(), this.md.preview())
  }

  /**
   * 把 markdown 缓冲里剩的东西全部定稿。
   *
   * 任何非正文的输出(工具卡片、错误、统计行)之前都必须调 —— 否则那些内容
   * 会插到一个还没收口的代码块或者攒了一半的表格中间,而缓冲里的内容之后
   * 还会再吐一次,变成重复。
   */
  private flushText(): void {
    if (!this.md || this.md.idle) return
    this.sink.replaceTail!(this.md.end(), "")
  }

  newlineIfNeeded(): void {
    this.flushText()
    if (this.sink.atLineStart) return
    this.sink.write("\n")
  }

  /** 每个 turn 开始前清掉去重表,否则跨 turn 的同名 part 会被吞掉。 */
  reset(): void {
    this.flushText()
    this.announced.clear()
    this.stepStarted = 0
    this.headerPending = false
  }
}

/** 模型开口前那一行的记号。和用户那条竖杠不同形 —— 一眼就能分出谁在说。 */
const AGENT_MARK = "◆"
/** 用户那段话左边的竖杠。session 视图的提问区用的是同一根 —— 两个视图里「你说的话」必须长得一样 */
export const USER_BAR = "▌"

/**
 * 用户说的话,画成一整块。
 *
 * ── 为什么每一行都要带竖杠 ──
 * 原来只在第一行打一个 `›`,后面的续行顶格。于是一段三行的提问滚上去之后,
 * 后两行和模型的回答长得一模一样 —— 而「这句话是谁说的」是读一段对话时
 * 最先要回答的问题。竖杠通到底,块的边界就是自明的,不用去数缩进。
 *
 * 竖杠而不是背景色:浅色终端上背景色要么看不见要么糊成一片,而这个项目
 * 的用户用什么主题我们不知道。
 */
export function userLines(text: string): string[] {
  const bar = theme.green(USER_BAR)
  return ["", ...text.split("\n").map((line) => `${bar} ${line}`)]
}

/**
 * 统一 diff 上色。**导出**是因为右栏也要画同一份 diff —— 两处各写一遍的话,
 * 总有一天它们会在某个边角上分叉,而用户会以为那两处显示的是不同的东西。
 */
export function diffLines(patch: string, root = ""): string[] {
  const out: string[] = []
  for (const raw of patch.split("\n")) {
    // `Index:` 的绝对路径和那条 67 个等号的分隔线是给 patch(1) 看的,对人是噪音;
    // 但文件名必须留 —— 并行编辑多个文件时,没有它分不清这块 diff 是谁的
    if (raw.startsWith("=====")) continue
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) continue
    if (raw.startsWith("Index: ")) {
      out.push(theme.dim(shortenPaths(raw.slice("Index: ".length), root)))
      continue
    }
    if (raw.startsWith("@@")) out.push(theme.cyan(raw))
    else if (raw.startsWith("+")) out.push(theme.green(raw))
    else if (raw.startsWith("-")) out.push(theme.red(raw))
    else out.push(theme.dim(raw))
  }
  return out
}

// ───────────────────────────────────────────── 纯函数(可单测)

export function summarize(part: ToolPart, root = ""): string {
  const input = "input" in part.state ? part.state.input : undefined
  if (!input || typeof input !== "object") return ""
  const record = input as Record<string, unknown>
  // url / query 和 command 一样是**原样**的东西,不能拿去当路径解析 ——
  // relativize 一个 URL 会把它切得面目全非
  // question / description 同理:它们是散文,不是路径。没有它们的话,
  // `● ask` 和 `● task` 会是屏幕上唯一两条**不写自己在干什么**的工具行 ——
  // 而这两条恰恰是最需要写的:一个正要打断你,一个正要花钱
  const verbatim = new Set(["command", "url", "query", "question", "description"])
  for (const key of ["command", "filePath", "pattern", "path", "url", "query", "question", "description"]) {
    const value = record[key]
    if (typeof value !== "string" || value.length === 0) continue
    return truncate(verbatim.has(key) ? value : relativize(value, root), 72)
  }
  return ""
}

/**
 * 结果摘要。**优先用 metadata**,退回输出首行。
 *
 * 直接打输出首行对 read 这类工具毫无意义 —— 它的第一行是 `<path>…</path>`
 * 这种给模型看的结构标记,对用户是纯噪音。metadata 里才有真正该看的东西:
 * 改了几行、退出码多少、有没有被截断。
 */
export function outcomeLine(part: ToolPart, root = ""): string {
  if (part.state.status !== "completed") return ""
  const meta = part.state.metadata
  const bits: string[] = []

  // ★ 排在最前面。这一格装不下时是从后面开始丢的,而「这一页里有东西在冲着
  //   agent 下命令」是整行里唯一一条不能丢的 —— 别的都只是「干成了没有」。
  //   见 tool/untrusted.ts
  const flagged = numberOf(meta["flagged"])
  if (flagged !== undefined && flagged > 0) bits.push(`⚠ ${flagged} flagged`)

  const additions = numberOf(meta["additions"])
  const deletions = numberOf(meta["deletions"])
  if (additions !== undefined || deletions !== undefined) {
    bits.push(`+${additions ?? 0} -${deletions ?? 0}`)
  }

  const exit = meta["exit"]
  if (typeof exit === "number") bits.push(exit === 0 ? "exit 0" : `exit ${exit}`)
  else if (exit === null) bits.push("killed")

  const count = numberOf(meta["matches"]) ?? numberOf(meta["count"])
  if (count !== undefined) bits.push(`${count} match${count === 1 ? "" : "es"}`)

  const lines = numberOf(meta["lines"])
  if (lines !== undefined) bits.push(`${lines} line${lines === 1 ? "" : "s"}`)

  // 出网那两个。HTTP 状态和 exit 分开判 —— 200 和 exit 0 不是一回事,
  // 而一个 404 的页面照样"成功"取回来了
  const status = numberOf(meta["status"])
  if (status !== undefined) bits.push(String(status))
  const hits = numberOf(meta["hits"])
  if (hits !== undefined) bits.push(`${hits} result${hits === 1 ? "" : "s"}`)

  // 用户挑了什么(ask),或者派出去的那个叫什么(task / job)。
  // 这一行是回头翻记录时唯一看得见的东西 —— 少了它,一次提问在滚动记录里
  // 就只剩「ask 0.4s」
  const answer = meta["answer"]
  if (typeof answer === "string" && answer.length > 0) bits.push(truncate(answer, 48))
  const job = meta["job"]
  if (typeof job === "string" && job.length > 0) bits.push(job)

  if (meta["truncated"] === true) bits.push("truncated")

  if (bits.length > 0) return bits.join(" · ")
  // 退回输出首行时把工作区路径缩短 —— 一行绝对路径挤掉的全是真正有用的内容
  return shortenPaths(firstLine(part.state.output), root) || t.noOutput
}

/** 把一行文本里所有工作区内的绝对路径换成相对路径。 */
export function shortenPaths(text: string, root: string): string {
  if (!root) return text
  return text.split(root + "/").join("")
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** 工作区内的路径显示成相对路径,外面的保持绝对 —— 越界这件事必须看得见。 */
export function relativize(path: string, root: string): string {
  if (!root || !path.startsWith(root)) return path
  const rest = path.slice(root.length).replace(/^\/+/, "")
  return rest.length > 0 ? rest : "."
}

export function firstLine(text: string, max = 100): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? ""
  return truncate(line.trim(), max)
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…"
}

export function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m${Math.round((ms % 60_000) / 1000)}s`
}

/** 给 CLI 用的一次性提示,不经过事件流。 */
export function partLabel(part: Part): string {
  return part.type
}
