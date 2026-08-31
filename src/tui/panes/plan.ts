/**
 * 左下角:计划。
 *
 * ── 为什么从中间栏搬到这儿 ──
 * 它一开始和摘要、提问排在中间栏。那个位置有个结构性问题:中间栏是**会变的**
 * (正文在长、工具行在滚),而计划是**要一直看得见的**。挤在同一栏里,两者
 * 互相抢高度 —— 计划一长,正文那片空地就没了;正文一长,计划就被砍。
 *
 * 左栏没有这个问题:文件树的高度本来就没有下限压力(它可以滚),而"这个仓库
 * 里有什么"和"接下来要干什么"恰好是同一类东西 —— **上下文**,不是**内容**。
 * 于是眼睛的分工变成:左边看状态,中间看它在说什么,右边看细节。
 *
 * ── 窄屏没有左栏时怎么办 ──
 * 退回中间栏那一段(见 panes/chat.ts 的 planVisible)。两处共用 cli/plan.ts 的
 * 同一份行渲染,所以搬来搬去它长得一样 —— 换个宽度就变成另一副样子的面板,
 * 用户会以为那是别的东西。
 */
import { theme } from "../../cli/theme.ts"
import { planProgress } from "../../cli/plan.ts"
import { truncateToWidth, wrapToWidth } from "../../cli/width.ts"
import type { TodoItem, TodoStatus } from "../../tool/todo.ts"
import { t } from "../../i18n/index.ts"
import { attachScrollbar, offsetForRow, scrollbarColumn } from "../scrollbar.ts"

/** 进度条最多占几格。再长在 26 列的左栏里就把标题挤没了 */
const BAR = 10
/** 做完的、正在做的、还没做的 */
const MARKS: Record<TodoStatus, string> = { done: "✓", active: "▸", pending: "○" }
/** 续行缩进到内容起始列:`✓ ` 两格 + 行首一格 */
const HANG = "   "

export class PlanPane {
  private items: readonly TodoItem[] = []
  private scroll = 0

  set(items: readonly TodoItem[]): void {
    // 换了一份清单就回到顶上。停在旧的滚动位置的话,新清单短一截时会显示成空白
    if (items.length !== this.items.length) this.scroll = 0
    this.items = items
  }

  get empty(): boolean {
    return this.items.length === 0
  }

  /** 标题栏右边挂的进度。横线上那一格是这一栏唯一"扫一眼就够"的信息 */
  get progress(): string {
    const { done, total } = planProgress(this.items)
    return total === 0 ? "" : t.planProgress(done, total)
  }

  /** 全部画出来要几行 —— 布局按它决定给多高。 */
  rowsNeeded(width: number): number {
    return this.lines(width).length
  }

  render(width: number, height: number): string[] {
    if (height <= 0) return []
    // 右边那一列留给滚动条,和别的面板一样 —— 列永远留着,装得下时不画
    const inner = Math.max(1, width - 1)
    const all = this.lines(inner)
    const max = Math.max(0, all.length - height)
    if (this.scroll > max) this.scroll = max
    const shown = all.slice(this.scroll, this.scroll + height)
    while (shown.length < height) shown.push("")
    return attachScrollbar(shown, scrollbarColumn({ total: all.length, height, offset: this.scroll }), width)
  }

  scrollBy(lines: number): void {
    this.scroll = Math.max(0, this.scroll + lines)
  }

  scrubTo(row: number, width: number, height: number): void {
    this.scroll = offsetForRow(row, { total: this.lines(Math.max(1, width - 1)).length, height })
  }

  // ───────────────────────────────────────────── 私有

  /**
   * 每一条画成一到几行。
   *
   * ── 为什么折行而不是截断 ──
   * 左栏只有二十几列,截断会把「把滚动条拆成独立模块」变成「把滚动条拆…」——
   * 而清单项的信息量全在动词后面那半句。折下来的续行缩进到内容起始列,
   * 于是三行的一条仍然读得出是**一条**。
   */
  private lines(width: number): string[] {
    if (this.items.length === 0) return []
    const out = [this.bar(width)]
    for (const item of this.items) {
      const body = wrapToWidth(item.text, Math.max(4, width - 3))
      for (const [i, part] of body.entries()) {
        out.push(i === 0 ? ` ${paintMark(item.status)} ${paintText(item.status, part)}` : HANG + paintText(item.status, part))
      }
    }
    return out.map((line) => truncateToWidth(line, width))
  }

  /**
   * 进度条。
   *
   * 一行字符画的代价是一行,换来的是**不用读就知道走到哪了** —— `2/5` 要读,
   * 一条填了五分之二的条子不用。清单本身回答"还剩哪几件",这一行回答"还剩多少"。
   */
  private bar(width: number): string {
    const { done, total } = planProgress(this.items)
    if (total === 0) return ""
    const cells = Math.max(1, Math.min(BAR, Math.max(1, width - 8)))
    // 一件都没做完时**不给**满格的第一格:那一格会被读成"已经开始了一件"
    const filled = done === 0 ? 0 : Math.max(1, Math.round((done / total) * cells))
    return (
      " " +
      theme.green("▰".repeat(filled)) +
      theme.dim("▱".repeat(cells - filled)) +
      theme.dim(`  ${done}/${total}`)
    )
  }
}

function paintMark(status: TodoStatus): string {
  if (status === "done") return theme.green(MARKS.done)
  if (status === "active") return theme.bold(theme.cyan(MARKS.active))
  return theme.dim(MARKS.pending)
}

/**
 * 正文的颜色分三档,而**记号的形状已经把状态说清楚了** —— 颜色只负责让眼睛
 * 先落在正在做的那条上。做完的压暗(不必再读),正在做的加粗,没做的原样。
 */
function paintText(status: TodoStatus, text: string): string {
  if (status === "done") return theme.dim(text)
  if (status === "active") return theme.bold(text)
  return text
}
