/**
 * 交互外壳:活动区 + 键盘 + 编辑器拼成的那个「底部输入框」。
 *
 * 屏幕自下而上是三段:
 *
 *   …滚动区(已完成的输出,归终端管,能往上翻)…
 *   ⠹ 运行状态 / 工具实时输出        ← 只在跑的时候有
 *   ╭─ 输入框 ─╮
 *   状态行
 *
 * 中间和下面这几段每帧重画,上面那段写出去就不动了。
 *
 * ── 按键语义 ──
 * 这几条是从 claude code / opencode 抄来的肌肉记忆,别自作主张改:
 *   Enter          提交(跑着的时候排队,不打断)
 *   Ctrl-J / Alt-Enter  插入换行
 *   Esc            跑着 → 中断这一轮;空闲 → 清空输入
 *   Ctrl-C         有内容 → 清空;跑着 → 中断;空且空闲 → 连按两次退出
 *   Ctrl-D         输入为空时退出
 *
 * 最容易写错的是 Ctrl-C:很多实现直接 process.exit,于是用户想停一条跑飞的
 * 命令,结果整个会话没了。
 */
import type { ContextSnapshot } from "../agent/context.ts"
import { contextChip, rampPaint, spentChip } from "./context.ts"
import { Editor, renderBox } from "./editor.ts"
import type { Key } from "./keys.ts"
import type { Keyboard } from "./keyboard.ts"
import type { LiveRegion } from "./live.ts"
import { modeInfo, nextMode, type PermissionMode } from "../permission/mode.ts"
import { t } from "../i18n/index.ts"
import { theme } from "./theme.ts"
import { mascot, MASCOT_MIN_WIDTH } from "../tui/chat/mascot.ts"
import { elideLeft, pathBudget, truncateToWidth } from "./width.ts"

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const SPINNER_MS = 100
/** 工具实时输出最多占几行。再多就把输入框挤出屏幕了。 */
const PREVIEW_LINES = 6

export interface ShellDeps {
  region: LiveRegion
  keyboard: Keyboard
  editor: Editor
  /** 状态行左边那截,通常是 provider/model */
  /** 当前模型那串字。**现取** —— `/model` 会在跑着的时候换掉它 */
  label(): string
  /**
   * 工作区路径。--plain 下横幅写过一次,但它会被输出顶走 ——
   * 状态行是唯一一处永远看得见的地方。
   */
  workspace?: string
  /** 权限模式。没接就不显示、shift-tab 也不做事 */
  mode?(): PermissionMode
  setMode?(mode: PermissionMode): void
  onSubmit(text: string): void
  /**
   * 跑着的时候提交的那一句。返回 true = 宿主已经把它递进正在跑的这一轮了
   * (见 cli/main.ts 的 injectUser),不用再排队;false = 还得等这一轮结束。
   */
  onSubmitBusy?(text: string): boolean
  /** 用户要停掉当前这一轮 */
  onCancel(): void
  onExit(): void
  /** 上下文占用。和全屏那边一样,给的必须是缓存好的快照,不是现算的 */
  context?(): ContextSnapshot
}

export class Shell {
  private readonly deps: ShellDeps
  private release: (() => void) | undefined
  private timer: ReturnType<typeof setInterval> | undefined

  private busy = false
  private startedAt = 0
  /** 动画的计时格子,100ms 一格。转圈和小人各自按自己的周期从它取帧 */
  private tick = 0
  private tokens = 0
  /** 正在跑的工具的实时输出尾巴 */
  private preview = ""
  private previewLabel = ""
  /** 一次性提示,下一次按键就消失 */
  private note = ""
  /** 空闲时按过一次 Ctrl-C */
  private armed = false
  private queued: string[] = []

  constructor(deps: ShellDeps) {
    this.deps = deps
  }

  start(): void {
    this.release = this.deps.keyboard.push(this.onKey)
    this.paint()
  }

  stop(): void {
    this.stopTimer()
    this.release?.()
    this.release = undefined
    this.deps.region.clear()
  }

  // ───────────────────────────────────────────── 状态

  setBusy(busy: boolean): void {
    if (this.busy === busy) return
    this.busy = busy
    this.armed = false
    this.note = ""
    if (busy) {
      this.startedAt = Date.now()
      this.tokens = 0
      this.startTimer()
    } else {
      this.stopTimer()
      this.clearPreview()
    }
    this.paint()
  }

  setTokens(count: number): void {
    this.tokens = count
    this.paint()
  }

  /** 工具的实时输出。这是 -p 之外唯一让长命令不显得「卡死」的东西。 */
  setPreview(label: string, text: string): void {
    this.previewLabel = label
    this.preview = text
    this.paint()
  }

  clearPreview(): void {
    if (this.preview === "" && this.previewLabel === "") return
    this.preview = ""
    this.previewLabel = ""
    this.paint()
  }

  /** 排在后面的消息。跑着的时候敲回车不会打断,而是排队。 */
  /**
   * 取走**全部**排队的话,拼成一条。
   *
   * ★ 不是一次取一条。一轮跑完的时候,排在后面的那几句是用户在**同一段时间里**
   *   补出来的同一件事的三个补充("顺便把测试跑一下"、"还有 README")——
   *   一条一条当成独立的轮次去答,它每答一句都不知道后面还有话,于是先按第一句
   *   改完、再按第二句改一遍、第三句再回头改前两句。用户看到的是它在原地打转。
   *
   * 拼成一条之后它一次看全,该怎么排顺序由它自己决定 —— 那本来就是它该做的判断。
   */
  takeQueued(): string | undefined {
    if (this.queued.length === 0) return undefined
    const all = this.queued.splice(0)
    // 「已排队」这句话的有效期到它真的开跑为止,不然会一直挂在状态行上
    this.note = ""
    this.paint()
    return all.join("\n")
  }

  get pending(): number {
    return this.queued.length
  }

  // ───────────────────────────────────────────── 按键

  private readonly onKey = (key: Key): void => {
    this.note = ""
    // shift-tab 换权限模式。和全屏那边同一个键 —— 两种界面手感不一致比
    // 少一个快捷键更让人别扭
    if (key.name === "tab" && key.shift && this.deps.mode && this.deps.setMode) {
      const mode = nextMode(this.deps.mode())
      this.deps.setMode(mode)
      this.note = t.permissionSwitched(modeInfo(mode).label, modeInfo(mode).hint)
      return this.paint()
    }
    const action = this.deps.editor.handle(key, this.innerWidth)

    switch (action?.type) {
      case "submit":
        if (this.busy) {
          // 先试着直接递进正在跑的这一轮 —— 排队要等它把整件事做完,而用户
          // 插这一句多半正是想拦住它现在在做的事
          if (this.deps.onSubmitBusy?.(action.text) === true) {
            this.note = t.queuedLive
          } else {
            this.queued.push(action.text)
            this.note = `queued — will run after this turn (${this.queued.length})`
          }
        } else {
          this.deps.onSubmit(action.text)
        }
        break

      case "interrupt":
        // 跑着的时候优先中断,哪怕输入框里有半句话 —— 用户按 Ctrl-C 十有八九
        // 是想让那条命令停下,而不是想清空草稿
        if (this.busy) this.deps.onCancel()
        else if (action.hasText) this.deps.editor.clear()
        else if (this.armed) return this.deps.onExit()
        else {
          this.armed = true
          this.note = t.pressCtrlCAgain
        }
        break

      case "escape":
        if (this.busy) this.deps.onCancel()
        else if (action.hasText) this.deps.editor.clear()
        break

      case "eof":
        return this.deps.onExit()
    }

    if (action?.type !== "interrupt") this.armed = false
    this.paint()
  }

  // ───────────────────────────────────────────── 画

  private get innerWidth(): number {
    return Math.max(8, this.deps.region.width - 6)
  }

  private startTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      // 一直往上加,不按转圈的帧数取模 —— 小人的一套动作和转圈不一样长
      this.tick++
      this.paint()
    }, SPINNER_MS)
    // 别让 spinner 拖着进程不退出
    this.timer.unref?.()
  }

  private stopTimer(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  paint(): void {
    const region = this.deps.region
    if (!region.active) return
    const width = region.width

    const above = [...this.previewLines(width), ...this.runningLine(width)]
    const box = renderBox({
      text: this.deps.editor.text,
      cursor: this.deps.editor.cursor,
      width,
      placeholder: t.placeholder,
      // 输入框最多占屏幕的一半:粘进来一大段时,上面的对话不能被顶光
      maxRows: Math.max(1, Math.min(12, Math.floor(region.rows / 2) - above.length)),
      style: {
        border: this.busy ? theme.dim : theme.gray,
        marker: theme.green,
        placeholder: theme.dim,
      },
    })
    const lines = [...above, ...box.lines, this.statusLine(width)]
    region.set(lines, { row: above.length + box.cursor.row, col: box.cursor.col })
  }

  /** 工具输出的尾巴。左边一道竖线,和模型正文区分开。 */
  private previewLines(width: number): string[] {
    if (this.preview.length === 0) return []
    const rows = this.preview.split("\n").filter((line) => line.trim().length > 0)
    return rows.slice(-PREVIEW_LINES).map((line) => theme.dim("  │ " + truncateToWidth(line, width - 4)))
  }

  private runningLine(width: number): string[] {
    if (!this.busy) return []
    const elapsed = (Date.now() - this.startedAt) / 1000
    const bits = [this.previewLabel || t.working, `${elapsed.toFixed(1)}s`]
    if (this.tokens > 0) bits.push(`${this.tokens} tok`)
    bits.push(t.interruptHint)
    // 小人和全屏那边是同一个 —— 两种运行形态下「它在干嘛」不该有两套画法。
    // 这里认得出的只有「在动手」和「在想」:--plain 下权限是另起一问,
    // 不会和这一行同时在。
    const glyph =
      width < MASCOT_MIN_WIDTH
        ? (SPINNER[this.tick % SPINNER.length] ?? "")
        : mascot(this.previewLabel ? "work" : "think", this.tick)
    // 必须截断。这一行一旦超宽,终端会自动换行 → 活动区少算一行 → 下一帧
    // 擦除时往上退少了一行,开始啃上面的输出。
    return [truncateToWidth(theme.cyan(`  ${glyph}`) + theme.dim(` ${bits.join(" · ")}`), width)]
  }

  /**
   * 状态行。**每一段自己上色** —— 上下文那格要能单独变黄变红,而整行统一
   * 上色的话它在 96% 时还是灰的,等于没有指示。
   */
  private statusLine(width: number): string {
    const workspace = this.deps.workspace
    // 和全屏那边同一条规矩:路径排最前,长了从左边收
    const bits = workspace ? [theme.dim(elideLeft(workspace, pathBudget(width)))] : []
    bits.push(theme.dim(this.deps.label()))
    // 和全屏那边同一个位置:紧挨着模型名
    const context = this.deps.context?.()
    // 和全屏那条量表同一套色阶:两种界面下同一个数不该是两个颜色
    if (context) bits.push(rampPaint(context.ratio)(contextChip(context)))
    // 花费是另一个数,不上色 —— 它没有「快满了」这种状态,只是一个事实
    const spent = context ? spentChip(context) : ""
    if (spent.length > 0) bits.push(theme.dim(spent))
    const mode = this.deps.mode?.()
    if (mode && mode !== "default") bits.push(theme.dim(modeInfo(mode).label))
    // 全屏那边这两句一直走 i18n(queuedStatus / keysHint),而 --plain 这边
    // 写死了英文 —— 同一件事在两个形态下说不同的语言
    if (this.queued.length > 0) bits.push(theme.dim(t.queuedStatus(this.queued.length)))
    if (!this.busy) bits.push(theme.dim(t.plainExitHint))
    const left = "  " + bits.join(theme.dim(" · "))
    if (this.note.length === 0) return truncateToWidth(left, width)
    return truncateToWidth(left + theme.yellow(`   ${this.note}`), width)
  }
}
