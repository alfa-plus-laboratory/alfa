/**
 * 补全候选的浮层。
 *
 * 贴着输入框上沿画,由合成器 blit —— 和权限模态框同一条路。全屏下没有第二条
 * 路可走:直接往 stdout 写会盖穿画好的面板,而且合成器的前台缓冲还以为屏幕
 * 没变,之后每一帧的差分都对着错的基准算。
 *
 * 只产出行,不决定放在哪 —— 位置由 app.ts 算,因为只有它知道输入框有多高。
 */
import type { Completion, CompletionItem } from "../../cli/commands.ts"
import type { Key } from "../../cli/keys.ts"
import { theme } from "../../cli/theme.ts"
import { displayWidth, elideLeft, padToWidth, truncateToWidth } from "../../cli/width.ts"

/** 一次最多列这么多。再多就不是「提示」而是「另一个界面」了 */
export const MAX_ROWS = 6

export interface CompletionView {
  lines: string[]
  width: number
  height: number
}

/**
 * 这么多候选实际会画出几行。
 *
 * ★ 布局必须用这个数,别用 `items.length`。候选区**不是浮层**,布局给它留了
 *   真实的行(见 app.ts 的 drawCompletion);留 13 行只画 7 行的话,输入框上方
 *   就凭空多出 6 行空白 —— 而且是候选越多、空白越大。
 *
 * 摆在这里而不是 app.ts,是因为「画几行」这件事的真值在 renderCompletion 里:
 * 两边各算一遍,迟早会有一边先改。
 */
export function completionRows(count: number): number {
  return count > MAX_ROWS ? MAX_ROWS + 1 : count
}

export function renderCompletion(completion: Completion, selected: number, maxWidth: number): CompletionView {
  const items = completion.items
  const from = windowStart(selected, items.length)
  const shown = items.slice(from, from + MAX_ROWS)

  const width = Math.max(20, Math.min(maxWidth - 4, 72))
  // 值本身可能比整个浮层还宽(`@` 引用的候选是一整条路径)。列宽先按最长的算,
  // 再夹到浮层放得下的范围内 —— 不夹的话行会溢出去盖到隔壁面板上
  const nameWidth = Math.min(
    shown.reduce((max, item) => Math.max(max, displayWidth(item.label ?? item.value)), 0),
    Math.max(4, width - 6),
  )

  const lines = shown.map((item, i) => row(item, nameWidth, width, from + i === selected))
  if (items.length > shown.length) {
    lines.push(theme.dim(padToWidth(`  … ${items.length - shown.length} more`, width)))
  }
  return { lines, width, height: lines.length }
}

function row(item: CompletionItem, nameWidth: number, width: number, selected: boolean): string {
  // 截**左边**:一条路径里认得出它的是结尾那个文件名,开头的 `src/` 每条都一样。
  // label 只有「什么都不加」那条有(它的 value 是空的,见 cli/commands.ts)
  const name = padToWidth(elideLeft(item.label ?? item.value, nameWidth), nameWidth)
  const room = width - nameWidth - 5
  const hint = room > 4 ? truncateToWidth(item.hint, room) : ""
  // 选中项整行反色。只改前景色的话,在半数配色方案上根本看不出选中的是哪条
  if (selected) return theme.inverse(padToWidth(` ${name}  ${hint}`, width))
  const body = ` ${theme.cyan(name)}  ${theme.dim(hint)}`
  return body + " ".repeat(Math.max(0, width - displayWidth(body)))
}

/** 选中项要始终在窗口里,列表长了就跟着滚。 */
function windowStart(selected: number, total: number): number {
  if (total <= MAX_ROWS) return 0
  return Math.max(0, Math.min(selected - Math.floor(MAX_ROWS / 2), total - MAX_ROWS))
}

export type CompletionKey =
  | { kind: "move"; delta: number }
  | { kind: "accept" }
  | { kind: "dismiss" }
  | { kind: "pass" }

export interface CompletionState {
  /**
   * 高亮那一条**已经原样打全了**。
   *
   * 比的是「输入框里那一段」和候选的值,不含 tab 会顺手补的那个空格 ——
   * 为了一个空格去截回车,等于把 `/permission` + 回车这条现成的路堵掉。
   */
  exact: boolean
}

/**
 * 浮层开着时的按键。上、下、tab、esc 一律截走。
 *
 * ── 回车按「补了会不会变」分 ──
 * 一度是完全不截:理由是「打完 `/clear` 直接回车就该执行」。可是候选还高亮着
 * 的时候,回车的意思在任何一个补全界面里都是**选中它** —— 于是敲一个 `/` 再
 * 回车,得到的是一条内容为 `/` 的消息发给了模型。那不是"少一个便利",是
 * 界面在按用户没预期的方式动。
 *
 * 所以:补上去会改变文本 → 回车 = 选中;已经和高亮那条一模一样 → 回车照旧
 * 发出去。两边都不用先按 tab,`/clear` + 回车也还是一次执行。
 */
export function completionKey(key: Key, state: CompletionState = { exact: false }): CompletionKey {
  if (key.ctrl || key.meta) return { kind: "pass" }
  switch (key.name) {
    case "up":
      return { kind: "move", delta: -1 }
    case "down":
      return { kind: "move", delta: 1 }
    case "tab":
      return { kind: "accept" }
    case "enter":
      return state.exact ? { kind: "pass" } : { kind: "accept" }
    case "escape":
      return { kind: "dismiss" }
    default:
      return { kind: "pass" }
  }
}
