/**
 * 中间那一栏。两种形态,同一份数据。
 *
 *   session —— 摘要 / 当前提问 / 活动区(默认)
 *   stream  —— 经典的滚动对话记录
 *
 * ── 为什么两个视图都常驻 ──
 * Transcript 和 ChatModel 同时挂在事件流上,谁也不是谁的缓存。所以 `/view`
 * 是**立刻**生效的:切过去就是完整的历史,而不是「从现在开始记」。一个需要
 * 重启才完整的开关,用户只会按一次然后再也不碰。
 *
 * ── session 视图里只有一块能滚 ──
 * 摘要是定长的一段话,提问是钉住的,计划最多五行(装不下的部分以进行中那条
 * 为中心开窗),只有活动区会长。所以只有它能滚,上下键就一个含义。几个区
 * 各自能滚的话,用户每次按上下都得先想「现在焦点在哪块」—— 而这一栏存在的
 * 理由恰恰是不用再想这种事。
 *
 * 滚动条因此也**只画在活动区那几行**上:整栏画一条的话,那条在替上面两块
 * 不会动的内容说话。
 */
import type { UIEvent } from "../../agent/events.ts"
import { duration, USER_BAR, userLines } from "../../cli/render.ts"
import { renderInline } from "../../cli/markdown.ts"
import { planProgress, planRows, planWindow } from "../../cli/plan.ts"
import { theme } from "../../cli/theme.ts"
import { displayWidth, truncateToWidth, wrapToWidth } from "../../cli/width.ts"
import type { ViewMode } from "../../config/config.ts"
import { t } from "../../i18n/index.ts"
import type { BoardRow, NoteTone } from "../chat/board.ts"
import { inlineDiffRows, renderBoard, tailRows } from "../chat/board.ts"
import { MAX_PLAN_LINES, MAX_PROMPT_LINES, zones } from "../chat/layout.ts"
import { mascot, type Mood } from "../chat/mascot.ts"
import type { ChatModel } from "../chat/model.ts"
import type { TodoItem } from "../../tool/todo.ts"
import type { Transcript } from "../transcript.ts"
import { attachScrollbar, offsetForRow, scrollbarColumn } from "../scrollbar.ts"

export interface ChatRenderInput {
  width: number
  height: number
  busy: boolean
  /** 转圈的当前帧。小人放不下时的兜底,工具行也一直用它 */
  spinner: string
  /**
   * 计时器的当前 tick(100ms 一格,一直往上加)。小人按它挑姿势。
   *
   * 传 tick 而不是传画好的一帧:选哪个动作要看模型和看板的状态,而那两样
   * 只有这一栏看得见 —— app.ts 那边只管走表。
   */
  tick?: number
  /** 有一条权限正卡在用户身上。小人要转过来举问号,而不是继续踱步 */
  waiting?: boolean
  /** 右栏现在看得见吗。看不见的话 diff 要在看板里就地展开 */
  detailVisible: boolean
  /**
   * 计划**不归这一栏管**吗。
   *
   * 两种情况都是 true:已经在左下角画着了(同一份清单出现两处,用户第一反应是
   * 「这两个是不是不一样」),或者用户自己把它收起来了 —— 后者尤其重要:
   * 按 ctrl-p 收掉计划,结果它跑到中间栏去了,那不叫收起来,叫换了个地方碍事。
   *
   * 只有"本该显示、但左栏窄没了"时才轮到这一栏画它。
   */
  planElsewhere?: boolean
}

/** 排队那几句最多列几行。再多就只写还剩几句 —— 它是提醒,不是重读 */
const MAX_QUEUED_LINES = 3
/**
 * 排队那几行的行首。
 *
 * 用 `↳` 是因为**这个符号在这套界面里已经用过**(工具卡片的续行),宽度和
 * 终端支持都是验过的。挑一个没人用过的漂亮箭头,代价是某些终端里它按两列画,
 * 而这一栏的每一行都是按列算好的 —— 宽一格整块就错位。
 */
const QUEUED_MARK = "↳"

/** 折成一行:排队的那几句是提醒,不是重读,换行在这儿没有意义 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

export class ChatPane {
  readonly transcript: Transcript
  private readonly model: ChatModel
  /**
   * 往瀑布流写一行。**必须是 Renderer.line**,不能直接 transcript.push ——
   * 渲染器手里可能攒着半行没收口的 markdown,绕过去写的话,那半行会被劈开,
   * 而且缓冲里的内容之后还会再吐一次,变成重复。
   */
  private readonly write: (text: string) => void
  private mode: ViewMode
  /** 活动区从底部往上翻了多少行 */
  private scroll = 0
  /**
   * 上一帧活动区画在哪儿(相对面板顶部的行、行数、内容总行数)。
   *
   * session 视图里能滚的只有活动区,而它的位置每帧由高度预算算出来 ——
   * 鼠标点在滚动条上时得知道那一格对应活动区的第几行。记上一帧的结果是
   * 因为鼠标事件永远发生在**已经画出来的**那一帧上。
   */
  private live = { top: 0, height: 0, total: 0 }

  constructor(options: { model: ChatModel; transcript: Transcript; view: ViewMode; line(text: string): void }) {
    this.model = options.model
    this.transcript = options.transcript
    this.mode = options.view
    this.write = options.line
  }

  get view(): ViewMode {
    return this.mode
  }

  setView(view: ViewMode): void {
    this.mode = view
    this.scroll = 0
  }

  get title(): string {
    return this.mode === "stream" ? t.paneStream : t.paneSession
  }

  /** 当前的计划。左下角那块面板从这里取 —— 真值源只有 ChatModel 一个 */
  get plan(): readonly TodoItem[] {
    return this.model.plan
  }

  /** 做完的计划什么时候该消失。App 拿它安排一次性的重绘,见 app.scheduleRetire */
  get planRetireAt(): number {
    return this.model.planRetireAt
  }

  /** 排队中的插话。App 每次入队 / 取走都同步过来 */
  setQueued(items: readonly string[]): void {
    this.model.setQueued(items)
  }

  /** 这一轮的工具行。独立出去的那块看板从这里取,同样只有一个真值源 */
  get board(): readonly BoardRow[] {
    return this.model.board
  }

  get toolRows(): number {
    return this.model.board.length
  }

  /** 状态行要提示「你正看着旧内容」。 */
  get following(): boolean {
    return this.mode === "stream" ? this.transcript.following : this.scroll === 0
  }

  clear(): void {
    this.transcript.clear()
    this.model.clear()
    this.scroll = 0
  }

  // ───────────────────────────────────────────── 两个视图都要知道的事
  //
  // 这几个入口是**唯一**同时写两份投影的地方。散在 app.ts 和 main.ts 里的话,
  // 迟早出现「批准记录只在瀑布流里有」这种事 —— 而那正是切了视图就看不见
  // 自己批准过什么的开始。

  /** 模型那边的事件。瀑布流由主 Renderer 直接喂,这里只补 session 视图那一份。 */
  handle(event: UIEvent): void {
    this.model.handle(event)
  }

  /**
   * 用户说了一句话 —— 只管把它写进瀑布流。
   *
   * 模型那边的 beginTurn 由 runTurn 统一调:三种运行形态都要新起一轮,
   * 而只有 session 视图有这个面板。放在这里的话,--plain 下的摘要就会拿到
   * 一份没有提问的浓缩。
   */
  said(text: string): void {
    for (const line of userLines(text)) this.write(line)
    this.scroll = 0
  }

  /**
   * 程序对一条斜杠命令的回答。**两个视图都要有。**
   *
   * 只写瀑布流的话,session 视图下敲 `/help`、`/permission` 屏幕上一个字都不动 ——
   * 而「一条命令在不同视图下给出不同答案」正是最容易被当成 bug 的设计。
   */
  answer(text: string): void {
    for (const line of text.split("\n")) this.write(line)
    this.model.say(text)
    this.scroll = 0
  }

  /** 有一条权限正在等人。返回的 id 用来在按完键之后原地换掉那一行。 */
  asked(text: string): string {
    return this.model.permissionAsked(text)
  }

  /** 决定下来了:瀑布流追一行,看板原地改。 */
  decided(id: string, line: string, summary: { text: string; tone: NoteTone }): void {
    this.write(line)
    this.model.permissionDecided(id, summary.text, summary.tone)
  }

  /**
   * 只改看板那一行,不往瀑布流追记录。
   *
   * 中断和退出时用:那件事已经由「⌁ interrupted」说过了,再追一条「rejected」
   * 是在说一件用户没做过的事 —— 他没有拒绝,他是按了 esc。但看板上那行
   * 「等你确认」必须停止撒谎。
   */
  resolved(id: string, summary: { text: string; tone: NoteTone }): void {
    this.model.permissionDecided(id, summary.text, summary.tone)
  }

  /** 两个视图都要留的一行(中断、步数上限、检查结果)。 */
  note(line: string, tone: NoteTone, text: string): void {
    this.write(line)
    this.model.note(tone, text)
  }

  /**
   * trust 模式没问就放行了。
   *
   * 瀑布流照旧留整整一行(那里宽度够,风险标记也写得下);看板上**不另起一行**,
   * 只给那次调用本行做个记号 —— 收据紧贴在同一次调用下面,窄栏里两行都被截成
   * `webs…`,看着就是同一件事写了两遍。见 board.ts 的 ToolRow.trusted。
   */
  trusted(line: string, summary: string, callID?: string): void {
    this.write(line)
    // 对不上号才回落到追加一行:丢掉一条放行记录,比多一行糟糕得多
    if (!callID || !this.model.markTrusted(callID)) this.model.note("info", summary)
  }

  // ───────────────────────────────────────────── 滚动

  scrollBy(lines: number): void {
    if (this.mode === "stream") this.transcript.scrollBy(lines)
    else this.scroll = Math.max(0, this.scroll + lines)
  }

  scrollPage(direction: -1 | 1): void {
    if (this.mode === "stream") this.transcript.scrollPage(direction)
    else this.scrollBy(direction * 5)
  }

  scrollToTop(): void {
    if (this.mode === "stream") this.transcript.scrollToTop()
    else this.scroll = Number.MAX_SAFE_INTEGER
  }

  scrollToBottom(): void {
    if (this.mode === "stream") this.transcript.scrollToBottom()
    else this.scroll = 0
  }

  /**
   * 在滚动条上点/拖到第 row 行(相对面板顶部)。
   *
   * session 视图下点在活动区之外不做事 —— 那几行本来就没有滚动条,
   * 让它们"也能滚一下"等于在说摘要和提问也会动。
   */
  scrubTo(row: number, width: number, height: number): void {
    if (this.mode === "stream") {
      const inner = Math.max(1, width - 2)
      const total = this.transcript.totalRows(inner)
      // 面板的滚动量是「从底部往上翻了几行」,而 offsetForRow 给的是「顶上是第几行」
      this.transcript.scrollTo(Math.max(0, total - height - offsetForRow(row, { total, height })))
      return
    }
    const live = this.live
    if (live.height <= 0 || row < live.top || row >= live.top + live.height) return
    const top = offsetForRow(row - live.top, { total: live.total, height: live.height })
    this.scroll = Math.max(0, live.total - live.height - top)
  }

  // ───────────────────────────────────────────── 画

  render(input: ChatRenderInput): string[] {
    const lines = this.mode === "stream" ? this.stream(input) : this.session(input)
    while (lines.length < input.height) lines.push("")
    return lines.slice(0, input.height)
  }

  private stream(input: ChatRenderInput): string[] {
    // 左边一格缩进,右边一格留给滚动条
    const inner = Math.max(1, input.width - 2)
    const lines = this.transcript.view(inner, input.height).map((line) => " " + line)
    while (lines.length < input.height) lines.push("")
    // 跑着的时候最后一行让给转圈 —— 它必须落在视线里,藏到状态行去
    // 用户根本不知道程序还活着
    if (input.busy) lines[input.height - 1] = this.statusRow(input)
    const total = this.transcript.totalRows(inner)
    return attachScrollbar(
      lines,
      // 瀑布流的滚动量是「从底部往上翻了几行」,滚动条要的是「顶上那行是第几行」
      scrollbarColumn({ total, height: input.height, offset: Math.max(0, total - input.height - this.transcript.offset) }),
      input.width,
    )
  }

  private session(input: ChatRenderInput): string[] {
    const width = input.width
    const inner = Math.max(4, width - 2)

    const summaryBody = this.summaryLines(inner)
    const promptBody = this.promptLines(inner)
    // 归别处管的时候这里一行都不给 —— 高度预算也跟着不留
    const planned = input.planElsewhere === true ? { shown: [], hidden: 0 } : planWindow(this.model.plan, MAX_PLAN_LINES)
    // 跟在它最后那句话后面的那些调用。整轮的回顾不在这里 —— 摘要说结果,
    // stream 视图和右栏说细节。装不下时 renderBoard 会折成「更早还有 N 条」
    const rows = this.model.board
    // 看板还要为挂在最后一条下面的附加行多申请几行 —— 不先算进预算的话,轮到
    // 画它时一行都不剩,现象是「一收起右栏 diff 就没了」/「结果尾巴时有时无」。
    // 两者互斥(见 board.foldToHeight),所以取需要的那一个
    const showDiff = !input.detailVisible && inlineDiffRows(rows) > 0
    const boardRows = rows.length + (showDiff ? inlineDiffRows(rows) : tailRows(rows))

    /** 活动区顶上那一行:它在想什么(只有一行,见 thinkingLine) */
    const head = this.thinkingLine(inner, input)

    const zone = zones({
      height: input.height,
      summaryLines: summaryBody.length,
      promptLines: promptBody.length,
      planLines: planned.shown.length,
      boardRows,
      busy: input.busy,
      // 数到够填满就停,别为了问一句「够了吗」去折四百行
      speechLines: head.length + this.model.speech.rowCount(inner, input.height),
    })

    const out: string[] = []

    // ── 摘要 ──
    if (zone.summary > 0) {
      const shown = summaryBody.slice(0, zone.summary - 1)
      const hidden = summaryBody.length - shown.length
      // 截掉的是**结尾**,而摘要的结尾是「现在卡在哪」—— 最该看见的那句。
      // 所以不但要打省略号,还要在横线上写清还剩几行、去哪看全文
      out.push(
        sectionRule(t.summaryTitle, width, theme.dim, hidden > 0 ? t.summaryClipped(hidden) : this.summaryNote()),
      )
      if (hidden > 0 && shown.length > 0) {
        shown[shown.length - 1] = truncateToWidth(shown[shown.length - 1]!, Math.max(1, inner - 1)) + "…"
      }
      for (const line of shown) out.push(" " + line)
    }

    // ── 当前提问:紧贴摘要,位置固定 ──
    if (zone.prompt > 0) {
      out.push(sectionRule(t.promptTitle, width, theme.green))
      for (const line of promptBody.slice(0, zone.prompt - 1)) out.push(" " + line)
    }

    // ── 计划:排在提问下面,横线右边挂着进度 ──
    //
    // 进度写在横线上而不是单占一行:`2/5` 是扫一眼就要拿到的东西,而这一栏
    // 每多一行,留给正文的空地就少一行
    if (zone.plan > 0) {
      const progress = planProgress(this.model.plan)
      const note = planned.hidden > 0 ? t.planClipped(progress.done, progress.total, planned.hidden) : t.planProgress(progress.done, progress.total)
      out.push(sectionRule(t.planTitle, width, theme.yellow, note))
      for (const line of planRows(planned.shown, inner).slice(0, zone.plan - 1)) out.push(line)
    }

    // ── 活动区:这一段的名字就是那个小机器人 ──
    //
    // 别的两段用词(`so far` / `user`),这一段用他。那两段讲的是**内容是谁的**,
    // 而这一段讲的是**现在怎么样了** —— 一个会动的东西比「现在」两个字说得清楚
    // 得多:他在扫描就是在想,在抡胳膊就是在动手,歇着就是没在跑。
    if (zone.liveRule > 0) out.push(sectionRule(this.face(input), width, this.facePaint(input)))

    const speech = this.model.speech.view(inner, Math.max(0, zone.speech - head.length), this.scroll)
    /** 滚动条只画在这几行上 —— session 视图里能滚的**只有**它说的那段话 */
    const speechAt = out.length + Math.min(head.length, zone.speech)
    if (zone.speech > 0) {
      for (const line of head.slice(0, zone.speech)) out.push(line)
      if (speech.length === 0 && head.length === 0 && !input.busy && rows.length === 0) {
        out.push(theme.dim(" " + truncateToWidth(t.liveEmpty, inner)))
      }
      for (const line of speech) out.push(" " + line)
    }

    // ★ 工具行**紧跟在它那句话后面**,不是钉在这一栏最底下。
    //   它是「它说完那句话之后动的手」——「我查一下」底下跟着 read、bash、
    //   它们的结果,读下来是一条连贯的经过。钉在底部的话,那几行和上面的正文
    //   之间永远隔着一片空白,看着像另一块面板;而下一句话一开口,这几行
    //   跟着一起收走(见 ChatModel 的 boardFrom)
    if (zone.board > 0) {
      out.push(
        ...renderBoard({
          rows,
          width,
          height: zone.board,
          spinner: input.spinner,
          now: Date.now(),
          // 右栏看不见时 diff 必须在这里露出来 —— edit 默认放行是拿
          // 「改了什么当场看得见」换来的
          inlineDiff: !input.detailVisible,
        }),
      )
    }

    // 空白落在最后:上面那一串(话 + 动作)因此顶着活动区的上沿往下长,
    // 而不是浮在中间
    for (let i = 0; i < zone.pad; i++) out.push("")

    while (out.length < input.height - zone.status) out.push("")
    if (zone.status > 0) out.push(this.statusRow(input))

    // 摘要和提问是钉住的,看板贴着底 —— 会滚的只有它说的那段话,所以滚动条
    // 也只画在那几行上。整栏画一条的话,那条在替**不动的**内容说话
    this.live = { top: speechAt, height: speech.length, total: this.model.speech.rowCount(inner) }
    if (speech.length > 0) {
      const total = this.live.total
      const column = scrollbarColumn({
        total,
        height: speech.length,
        offset: Math.max(0, total - speech.length - this.scroll),
      })
      const painted = attachScrollbar(out.slice(speechAt, speechAt + speech.length), column, width)
      for (const [i, line] of painted.entries()) out[speechAt + i] = line
    }
    return out
  }

  // ───────────────────────────────────────────── 各区的内容

  /** 摘要那条横线右边挂的话:上一版没写成时说明原因。 */
  private summaryNote(): string {
    return this.model.summaryState === "ready" && this.model.summaryError.length > 0
      ? t.summaryFailed(this.model.summaryError)
      : ""
  }

  private summaryLines(width: number): string[] {
    const model = this.model
    if (model.summaryState === "writing" && model.summary.length === 0) {
      return wrapToWidth(theme.dim(t.summaryWorking), width)
    }
    // 行内 markdown:模型总会给文件名和标识符打反引号。不渲染的话那些反引号
    // 就原样躺在摘要里,看着像它写错了字
    if (model.summary.length > 0) return wrapToWidth(renderInline(model.summary), width)
    if (model.summaryState === "failed") {
      return wrapToWidth(theme.dim(t.summaryFailed(model.summaryError)), width)
    }
    return wrapToWidth(theme.dim(t.summaryEmpty), width)
  }

  /**
   * 当前提问。**和瀑布流里用的是同一根竖杠** —— 换了视图之后「你说的话」
   * 还是那个样子,否则每切一次都要重新认一遍。
   */
  private promptLines(width: number): string[] {
    const model = this.model
    if (model.prompt.length === 0 && model.queued.length === 0) return []
    const bar = theme.green(USER_BAR)
    const body = model.prompt
      .split("\n")
      .flatMap((line) => (line.length === 0 ? [""] : wrapToWidth(line, Math.max(1, width - 2))))
    const shown = body.slice(0, MAX_PROMPT_LINES)
    const lines = model.prompt.length === 0 ? [] : shown.map((line) => `${bar} ${line}`)
    if (body.length > MAX_PROMPT_LINES) lines[lines.length - 1] = `${bar} ${truncateToWidth(shown[shown.length - 1] ?? "", Math.max(1, width - 4))}…`
    return [...lines, ...this.queuedLines(width)]
  }

  /**
   * 排在后面还没轮到的那几句,一句一行,挂在提问下面。
   *
   * ── 为什么必须画出来 ──
   * 趁它还在跑的时候插一句,敲完回车输入框就清空了,而那句话除了状态行上一个
   * 「queued (1)」之外没有任何痕迹 —— 用户的第一反应是"我刚才打的字去哪了"。
   * 它已经被收下了,那就该看得见。
   *
   * ── 为什么用 `↳` 而不是再来一根 `▌` ──
   * `▌` 是「你现在这一轮说的话」。排队的还没轮到,和当前那句是两回事;同一个
   * 符号会让人以为它们是一段话的两行。`↳` 读起来就是"接着还有这一句"。
   */
  private queuedLines(width: number): string[] {
    const items = this.model.queued
    if (items.length === 0) return []
    const room = Math.max(1, width - 2)
    const shown = items.slice(0, MAX_QUEUED_LINES)
    const lines = shown.map((text) => theme.dim(`${QUEUED_MARK} ${truncateToWidth(oneLine(text), room)}`))
    const hidden = items.length - shown.length
    if (hidden > 0) lines.push(theme.dim(`${QUEUED_MARK} ${t.queuedMore(hidden)}`))
    return lines
  }

  /**
   * 最底下那一行:它在干嘛 · 多久了 · 怎么停。
   *
   * 这里**不再画机器人** —— 他搬到活动区那条横线上当标题去了,一个东西出现
   * 两处,用户第一反应是「这两个是不是不一样」。
   *
   * 「思考中 → 还在思考 → 继续思考 → 深度思考中」这套措辞在这儿。它一度挂在
   * 活动区顶上,和大机器人一起被撤了 —— 上面那片地方现在铺的是**思考内容
   * 本身**,而「想了多久」是个状态,状态归这一行管。
   */
  private statusRow(input: ChatRenderInput): string {
    // ★ 工具名从**看板**取,不用外面推进来的那个。推的那个是工具**开始**时设的,
    //   跑完没人清 —— 于是 bash 早结束了、模型在写回答,这一行还挂着 `bash`,
    //   旁边那个数还是**整轮**的秒数。并排写成 `bash · 46.0s`,读起来就是
    //   「bash 跑了 46 秒」,而那是假的。看板上哪条在跑就是哪条,不会过期。
    const running = this.model.board.find((row): row is Extract<BoardRow, { kind: "tool" }> =>
      row.kind === "tool" && row.status === "running",
    )
    // 秒数也跟着换:有工具在跑就写**它自己**跑了多久,否则写这一轮跑了多久。
    // 不写「思考中」—— 那句话连同它的秒数都在上面那行走马灯里了
    const bits = running
      ? [running.tool, duration(Date.now() - running.startedAt)]
      : [duration(this.model.elapsedMs)]
    bits.push(t.interruptHint)
    return truncateToWidth(theme.dim(`  ${bits.join(" · ")}`), input.width)
  }

  /**
   * 活动区顶上那一行:**措辞 + 秒数 + 一条走马灯**。永远只有一行。
   *
   * ── 为什么不是把思考整段铺出来 ──
   * 试过。模型一想就是几十行,正文和工具行全被顶走 —— 而那几十行里没有一句是
   * 结论,它是草稿。用户在等待期间真正要的只有两件事:**它还在动吗**、
   * **现在念叨到哪了**。一行都答得了。
   *
   * ── 为什么是尾巴而不是开头 ──
   * 新的字从右边推进来,旧的从左边挤出去 —— 于是这一行**自己会动**,而且动的
   * 快慢就是它想的快慢。不折行、不认 markdown、把换行压成空格:里面就算有代码
   * 也照旧一行滚过去,那是草稿,不是要读的东西。
   */
  private thinkingLine(inner: number, input: ChatRenderInput): string[] {
    const thinking = this.model.thinking
    if (!input.busy && !thinking.active) return []
    if (!thinking.active && this.model.speech.empty === false) return []

    const seconds = thinking.ms > 0 ? thinking.ms : this.model.elapsedMs
    // 措辞和读秒用**淡黄**:这一行是等待期间唯一在动的字,灰的和正文糊在一起,
    // 满色的又太抢 —— 而它右边那串念叨保持灰色,主次才分得开
    const phase = theme.dim(theme.yellow(`${thinkingPhase(seconds)}… ${duration(seconds)}`))
    const width = displayWidth(`${thinkingPhase(seconds)}… ${duration(seconds)}`)
    const murmur = flatten(thinking.text)
    if (murmur.length === 0) return [truncateToWidth(` ${phase}`, inner)]
    // 措辞占多少就减多少,剩下的全给走马灯 —— 它是这一行里唯一会变的东西
    const room = Math.max(8, inner - width - 4)
    return [truncateToWidth(` ${phase}  ` + theme.gray(tailToWidth(murmur, room)), inner)]
  }

  /** 活动区那条横线上的机器人。挂在标题的位置,所以他一直在,不随 busy 来去 */
  private face(input: ChatRenderInput): string {
    return mascot(this.mood(input), input.tick ?? 0)
  }

  /**
   * 他的颜色跟着状态走:「等你」是黄的,歇着是 dim,其余是青的。
   *
   * 黄色在这个界面里从头到尾只有一个含义 —— 轮到你了(权限收据、警告都是它);
   * 而 dim 的那张脸说的是「他在,但没在替你干活」,不必去读下面有没有秒数。
   */
  private facePaint(input: ChatRenderInput): (text: string) => string {
    const mood = this.mood(input)
    return mood === "wait" ? theme.yellow : mood === "idle" ? theme.dim : theme.cyan
  }

  /**
   * 他在干嘛。**顺序就是优先级**:卡在人身上 > 没在跑 > 动着手 > 想 > 说。
   *
   * 「等你」排第一是因为它是唯一一个**不会自己结束**的状态:工具跑得再久也
   * 会跑完,而没人按键的话那条权限会一直挂着。这时候他还在扫描的话,
   * 那个动画就是在撒谎。
   */
  private mood(input: ChatRenderInput): Mood {
    if (input.waiting === true) return "wait"
    if (!input.busy) return "idle"
    if (this.model.board.some((row) => row.kind === "tool" && row.status === "running")) return "work"
    if (this.model.thinking.active) return "think"
    return this.model.speech.empty ? "think" : "talk"
  }
}

/**
 * 一条带标签的分节线:` you ──────────────`。
 *
 * 三段各一条,颜色也各不同。**这是三段之间唯一的分界** —— 摘要和提问都是
 * 一段普通文字,不靠这条线就会揉在一起(已经揉过一次了)。
 * 少画一列:横线顶到右边框上会和框线连成一片,看着像画错了。
 */
function sectionRule(label: string, width: number, paint: (text: string) => string, note = ""): string {
  const head = ` ${label} `
  const tail = note.length > 0 ? ` ${note} ` : ""
  const room = Math.max(0, width - 1 - displayWidth(head) - displayWidth(tail))
  // 标题自己就可能比整栏还宽(活动区那条线的标题是个七列的机器人),截住 ——
  // 超一列就会盖到隔壁面板上,而且屏幕的差分从此再也对不回来
  return truncateToWidth(paint(head) + theme.dim("─".repeat(room) + tail), width)
}

/**
 * 想了多久 → 哪个措辞。
 *
 * 阈值一档比一档疏(10s → 25s → 45s → …):前半分钟每隔十几秒换一次,再往后
 * 换得越来越慢。等的时间越长,人对「它是不是卡住了」越敏感,而**换词本身**
 * 就是回答 —— 但每三秒换一次又会变成另一种噪音。
 */
const PHASE_AT = [10_000, 25_000, 45_000, 70_000, 100_000, 140_000, 200_000]

function thinkingPhase(ms: number): string {
  const phases = t.thinkingPhases
  let at = 0
  while (at < PHASE_AT.length && ms >= PHASE_AT[at]!) at++
  return phases[Math.min(at, phases.length - 1)] ?? phases[0] ?? ""
}

/**
 * 把思考压成一行:换行、制表、连着的空格全塌成一个空格。
 *
 * 它是**草稿**,里面有半截代码、有列表、有换行 —— 一律不认。这一行的职责不是
 * 让人读懂,是让人看见它还在动。
 */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/** 截取**末尾**能放下的那一段。displayWidth 认双宽,所以不能按字符数切。 */
function tailToWidth(text: string, width: number): string {
  const chars = [...text]
  let used = 0
  let at = chars.length
  while (at > 0) {
    const next = displayWidth(chars[at - 1]!)
    if (used + next > width) break
    used += next
    at--
  }
  return chars.slice(at).join("")
}
