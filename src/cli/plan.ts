/**
 * 计划清单画成行。**两个视图共用这一份。**
 *
 * 瀑布流里它跟在 todo 那次调用的结果行后面(和 diff 一个位置),session 视图里
 * 它是钉住的一段。分开写两份的话,同一份清单在两个视图里的标记、颜色、截断
 * 长度迟早会分叉 —— 而用户会以为那是两份不同的清单。
 *
 * ── 标记为什么是三个不同形状的字符 ──
 * 不靠颜色分状态:一半的终端配色里 dim 的绿和 dim 的灰看不出区别,而「这条
 * 做完了没有」是这份清单唯一要回答的问题。形状在单色终端上也活着。
 */
import { theme } from "./theme.ts"
import { truncateToWidth } from "./width.ts"
import type { TodoItem, TodoStatus } from "../tool/todo.ts"

/** 做完的、正在做的、还没做的 */
const MARKS: Record<TodoStatus, string> = { done: "✓", active: "▸", pending: "○" }

export interface PlanProgress {
  done: number
  total: number
  /** 正在做的那条,没有就是空串 */
  active: string
}

export function planProgress(items: readonly TodoItem[]): PlanProgress {
  return {
    done: items.filter((item) => item.status === "done").length,
    total: items.length,
    active: items.find((item) => item.status === "active")?.text ?? "",
  }
}

/**
 * 画出每一条。行首留两格,和别处的正文对齐。
 *
 * 做完的整条压暗:它已经不需要被读了,留在那儿只是为了让人看出「走了多远」。
 * 正在做的那条给一个亮色的 ▸ —— 一屏里只该有一个地方在喊「看这里」。
 */
export function planRows(items: readonly TodoItem[], width: number): string[] {
  return items.map((item) => {
    const text = truncateToWidth(item.text, Math.max(4, width - 4))
    if (item.status === "done") return theme.dim(` ${MARKS.done} ${text}`)
    if (item.status === "active") return theme.cyan(` ${MARKS.active} `) + text
    return theme.dim(` ${MARKS.pending} `) + theme.dim(text)
  })
}

/**
 * 装不下时留哪几条。
 *
 * 以**正在做的那条**为中心开窗,而不是从头截:清单一长,头上全是打完勾的
 * 历史,而「现在在哪一步、后面还有什么」才是要看的。做完的那些留一条在
 * 上面当锚点就够了。
 */
export function planWindow(items: readonly TodoItem[], room: number): { shown: readonly TodoItem[]; hidden: number } {
  if (room <= 0) return { shown: [], hidden: items.length }
  if (items.length <= room) return { shown: items, hidden: 0 }
  const at = items.findIndex((item) => item.status === "active")
  // 没有进行中的那条(全做完了 / 还没开工):按常识从头看
  const center = at === -1 ? 0 : at
  // 上面留一条已完成的当锚点,剩下的全给后面 —— 后面才是还没发生的事
  const from = Math.max(0, Math.min(center - 1, items.length - room))
  return { shown: items.slice(from, from + room), hidden: items.length - room }
}
