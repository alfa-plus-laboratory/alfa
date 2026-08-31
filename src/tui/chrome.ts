/**
 * 画外框:三条横线 + 每一行的竖线 + 标题。
 *
 * 单独拿出来是因为它是唯一一处需要同时知道**所有**面板位置的代码。面板自己
 * 只认自己那块矩形,谁都不知道邻居在哪 —— 竖线画在谁头上这种事交给它们商量
 * 只会互相踩。
 *
 * 有焦点的那一栏标题加亮。这是全屏界面里唯一能表达"现在按键会打给谁"的地方,
 * 没有它,用户按 ↑ 之前得先猜。
 */
import type { Layout, PaneName } from "./layout.ts"
import { theme } from "../cli/theme.ts"
import { displayWidth, padToWidth, truncateToWidth } from "../cli/width.ts"

const H = "─"
const V = "│"
const TOP_LEFT = "╭"
const TOP_RIGHT = "╮"
const BOTTOM_LEFT = "╰"
const BOTTOM_RIGHT = "╯"
const T_DOWN = "┬"
const T_UP = "┴"
const T_RIGHT = "├"
const T_LEFT = "┤"

export interface ChromeInput {
  layout: Layout
  /** 每一栏的标题,按列位置给。collapsible 的那几栏标题右端画一个收起按钮 */
  titles: Array<{ x: number; width: number; text: string; pane: PaneName; collapsible?: boolean }>
  focus: PaneName
}

/**
 * 收起按钮:标题栏右端的 `[-]`。
 *
 * ── 为什么必须有这个东西 ──
 * 「ctrl-b 收起文件栏」这条只写在 /help 里的话,等于没有 —— 帮助是用户遇到
 * 麻烦时才翻的东西,而"这一栏能收起来"是他在**看着屏幕**的时候才会想到的事。
 * 一个画出来的按钮同时回答了两个问题:这块能收,以及怎么收。
 *
 * 按钮占 3 列,后面留一根横线不让它贴着竖线 —— 贴上去看着像边框的一部分。
 *
 * ── 命中判断认的是**整条标题**,不只是这三列 ──
 * 按钮负责说"这块能收",不负责考验用户点得准不准。两边各算一次坐标的话,
 * 某个宽度下它们会差一列,而那种 bug 的现象是"按钮点不动",没有任何报错。
 */
const BUTTON_WIDTH = 3
const BUTTON_ROOM = BUTTON_WIDTH + 1
/** 标题栏窄于这个数就不画按钮了 —— 画了也只剩按钮,标题反而没了 */
const BUTTON_MIN_TITLE = 12

export function buttonX(x: number, width: number): number | undefined {
  return width >= BUTTON_MIN_TITLE ? x + width - BUTTON_ROOM : undefined
}

/**
 * 上边框:`╭─ files ────┬─ conversation ───╮`
 *
 * 标题嵌在横线里而不是单占一行 —— 三栏各占一行标题就是三行没有信息的空间,
 * 在 24 行的终端上那是 1/8 的屏幕。
 */
export function topBorder(input: ChromeInput): string {
  const { layout } = input
  let out = theme.dim(TOP_LEFT)
  for (let x = 1; x < layout.width - 1; x++) {
    // 收起来的栏在原地留一条轨,顶上就是那个 `[+]` —— 它是"把它叫回来"这件事
    // 在屏幕上的位置。没有它,收完之后那块地方什么都不剩
    const rail = layout.rails.find((r) => r.x === x)
    if (rail) {
      out += expandButton()
      x += rail.width - 1
      continue
    }
    const title = input.titles.find((t) => t.x === x)
    if (title) {
      out += renderTitle(title.text, title.width, input.focus === title.pane, title.collapsible === true)
      x += title.width - 1
      continue
    }
    out += theme.dim(layout.dividers.includes(x) ? T_DOWN : H)
  }
  return out + theme.dim(TOP_RIGHT)
}

function renderTitle(text: string, width: number, focused: boolean, collapsible: boolean): string {
  const button = collapsible && buttonX(0, width) !== undefined
  // 「─ 标题 」之后用横线填满。标题太长就截,截了也要保证这一段正好是 width 列,
  // 差一列整条边框就断了
  const label = truncateToWidth(text, Math.max(1, width - 4 - (button ? BUTTON_ROOM : 0)))
  const head = theme.dim(H) + " " + (focused ? theme.bold(theme.cyan(label)) : theme.dim(label)) + " "
  const used = 1 + 1 + displayWidth(label) + 1
  const fill = Math.max(0, width - used - (button ? BUTTON_ROOM : 0))
  return head + theme.dim(H.repeat(fill)) + (button ? collapseButton() + theme.dim(H) : "")
}

/** `[-]`:方括号在终端里就是「这是个可以点的东西」的通用暗号 */
export function collapseButton(): string {
  return theme.dim("[") + theme.cyan("-") + theme.dim("]")
}

/** `[+]`:收起来之后留在原地的那个。和 `[-]` 同一套语汇,反过来 */
export function expandButton(): string {
  return theme.dim("[") + theme.cyan("+") + theme.dim("]")
}

/** 状态行上「把它叫回来」的那个片:`[ctrl-b files]`。 */
export function recallChip(label: string): string {
  return theme.dim("[") + theme.cyan(label) + theme.dim("]")
}

/** 中线:body 和输入框之间,竖线在这里收口成 ┴ */
/**
 * 输入区上沿那条线。**只跨中间栏**,两端接在竖线上(`├────┤`)。
 *
 * 和工具看板那条线是同一套画法 —— 它们都是「一栏内部又切了一刀」,而不是
 * 「整个界面横过来一刀」。整栏那种画法会把左右两栏也切断,而它们底下什么
 * 都没变。
 *
 * ── note 挂在**右端** ──
 * 这条线上现在写着上下文量表,而它是**状态**,不是这一栏的标题。这个界面里
 * 所有「附在一条线右端的小字」都是状态(计划那条线右端挂着 `2/5`),左端留给
 * 名字 —— 摆到左边它会读成"这块面板叫 41%"。而且左端正对着输入框第一个字,
 * 光标在下面闪,量表在上面变,两个会动的东西挨在同一列上很吵。
 *
 * note 是**已经上过色**的,所以量宽度必须用 displayWidth:按 length 算的话,
 * 转义序列会被算成字符,这条线立刻超宽,而超宽在合成器里是会把边框顶出去的。
 */
/**
 * 输入区上沿那条线。右端挂着上下文量表,**左端挂着模式牌**。
 *
 * ── 为什么模式牌要在这儿,而不是状态行 ──
 * 状态行上已经有七八样东西在抢位置(路径、模型、花费、权限、排队、召回),
 * 而且挤的时候是从右往左丢的。agentflow 这种「它接下来每一件事的做法都变了」
 * 的开关,不能是一条挤一挤就没了的提示 —— 它得钉在你打字的地方正上方。
 * 开机横幅说过一次就滚走了,而这个开关会一直生效。
 */
export function inputDivider(width: number, note = "", lead = ""): string {
  // ⚠ 这条线一度会**超宽**。原来的写法是 `fill = max(0, width - used - w(note) - 4)`,
  //   而 fill 夹到 0 之后总宽是 `used + w(note) + 4`,和 width 再没有关系 ——
  //   放不下的时候它不截断,只是不再补横线。
  //
  //   现场:窄屏 + `/agentflow` 开着。牌子 `agentflow` 占 9 列(used = 13),
  //   量表按 `ruleWidth - 8` 算(调用方不知道左边还挂着一块牌子),两边加起来
  //   稳定超出十几列。而合成器里超宽的一行会把右边框顶出去 —— README 那「四条
  //   规矩」的第一条就是这个。所以宽度在**这里**兜住,不指望调用方算对。
  const room = Math.max(0, width)
  // 左端那块牌子:`├─ lead ` = 1 + 1 + 1 + w(lead) + 1。装不下就整块不要 ——
  // 一个被截成 `agent…` 的模式牌既读不出是什么,又照样占着位置
  const leadWidth = lead.length > 0 ? displayWidth(lead) + 4 : 0
  const showLead = leadWidth > 0 && leadWidth + 1 <= room
  const head = showLead ? theme.dim(T_RIGHT + H) + " " + lead + " " : theme.dim(T_RIGHT)
  const used = showLead ? leadWidth : 1

  // ├ + 横线 + ` note ` + 一根横线 + ┤。末尾那根不能省 —— 贴着 ┤ 的字会和
  // 边框糊成一片(和上边框的收起按钮同一条理由,见 renderTitle)
  // 右端量表最多能占多宽:总宽减掉左端,再减掉它自己那 4 格边距和收口
  const noteRoom = room - used - 4
  const shown = note.length > 0 && noteRoom > 0 ? truncateToWidth(note, noteRoom) : ""
  if (shown.length === 0) return head + theme.dim(H.repeat(Math.max(0, room - used - 1)) + T_LEFT)

  const fill = Math.max(0, room - used - displayWidth(shown) - 4)
  return head + theme.dim(H.repeat(fill)) + " " + shown + " " + theme.dim(H + T_LEFT)
}

/**
 * 状态行上沿那条线:`├────┴────────┴─────┤`。**横穿整个界面**。
 *
 * 竖线在这里收口成 `┴` —— 状态行是全宽的,底下不再分栏。少了这条线,三栏的
 * 分隔线会一路插进状态文字中间,读起来像是那行字被切成了三段。
 */
export function statusDivider(layout: Layout): string {
  let out = theme.dim(T_RIGHT)
  for (let x = 1; x < layout.width - 1; x++) {
    out += theme.dim(layout.dividers.includes(x) ? T_UP : H)
  }
  return out + theme.dim(T_LEFT)
}

/**
 * 下框。
 *
 * 有状态行的时候竖线已经在它上面那条线收口过了,这里就是一条干净的横线;
 * 没有状态行(矮终端)时竖线一直通到这里,得在每条竖线的位置画 `┴` ——
 * 少了它,三栏的分隔线看着就像悬在半空中断掉了。
 */
export function bottomBorder(layout: Layout): string {
  let out = theme.dim(BOTTOM_LEFT)
  const closed = layout.statusRow >= 0
  for (let x = 1; x < layout.width - 1; x++) {
    out += theme.dim(!closed && layout.dividers.includes(x) ? T_UP : H)
  }
  return out + theme.dim(BOTTOM_RIGHT)
}

/**
 * 状态行那一行的左右两条边:`│ …… │`。
 *
 * 文字**在框里**,所以要自己补齐到整宽 —— 差一列,右边那条竖线就落不到
 * 该在的位置上,整个下半框看着是歪的。
 */
export function statusFrame(width: number, text: string): string {
  const room = Math.max(0, width - 2)
  // 补齐**和**截断都要:padToWidth 只补不截(见它的注释),而这一行超一列的话,
  // 右边那条竖线就被挤出屏幕 —— 调用方已经截过一次了,这里是最后一道
  return theme.dim(V) + padToWidth(truncateToWidth(text, room), room) + theme.dim(V)
}

/**
 * 左栏内部那条把文件树和计划分开的横线:`├─ plan ──── 2/5 ─┤`。
 *
 * ── 为什么它要顶到两边的框上 ──
 * 画成一条不碰边的短横线的话,它看起来像是**文件树里的一行内容**(树里本来就
 * 有各种符号),而不是两块面板的分界。顶到框上,`├` 和 `┤` 就把"这里换了一块"
 * 说清楚了 —— 和中线 midBorder 是同一套语汇。
 *
 * 宽度是**左栏 + 两条竖线**,由调用方从 x=0 贴上去。
 */
export function panelDivider(
  width: number,
  title: string,
  note: string,
  focused: boolean,
  collapsed = false,
  /**
   * 右端画不画收起按钮。
   *
   * 给「自己会消失」的那种块用(后台任务:最后一个跑完再过几秒就没了)——
   * 它不需要手动开关,而一个点了没反应的 `[-]` 比没有按钮糟得多。
   */
  button_ = true,
): string {
  const button = button_ && buttonX(0, width) !== undefined
  const label = truncateToWidth(title, Math.max(1, width - 6))
  const tail = note.length > 0 ? ` ${note} ` : ""
  const head = theme.dim(T_RIGHT + H) + " " + (focused ? theme.bold(theme.cyan(label)) : theme.dim(label)) + " "
  const used = 2 + 1 + displayWidth(label) + 1 + displayWidth(tail) + 1 + (button ? BUTTON_ROOM : 0)
  return (
    head +
    theme.dim(H.repeat(Math.max(0, width - used)) + tail) +
    // ★ 按钮之后**必须补上那一列横线**。BUTTON_ROOM 给它留的是 3+1 列
    //   (第 4 列是不让它贴着竖线的那个空档,上边框那边也是这么画的),
    //   只画 3 列的话整条线就短一格 —— 现象是 `┤` 落在真竖线**左边一格**,
    //   而右边那根是底下 bodyRow 透上来的:看着就是"边框错位了"
    (button ? (collapsed ? expandButton() : collapseButton()) + theme.dim(H) : "") +
    theme.dim(T_LEFT)
  )
}

/**
 * 收起来那条轨的正文:竖着写的栏名。
 *
 * ── 为什么必须写字,不能只留一个 `[+]` ──
 * 三个 `[+]` 长得一模一样。收掉两栏之后,"左边这条是文件树还是别的"只能靠
 * 位置去猜 —— 而位置恰恰是收起来之后最不可靠的东西(两栏都收了就更分不清)。
 * 竖着写的栏名占的是本来就空着的地方,一个字都不多花。
 *
 * ── 为什么是字不是图标 ──
 * 试过图标。终端里能用的那几个符号(▤ ☰ 之类)多半是**歧义宽度**的:同一个
 * 字符在不同字体里占 1 列或 2 列,而这个界面的前提是"每一行都不超宽"——
 * 一个会变宽的字符放在三列的轨里,某些终端上就会把竖线挤出去。
 * 字没有这个问题,而且不用猜它是什么意思。
 */
export function railBody(width: number, height: number, label: string): string[] {
  const chars = [...label].slice(0, Math.max(0, height - 2))
  return Array.from({ length: height }, (_, row) => {
    const char = row >= 1 ? chars[row - 1] : undefined
    if (char === undefined) return " ".repeat(width)
    // 居中:中日韩是双宽,所以按显示宽度算,不按字符数
    const left = Math.max(0, Math.floor((width - displayWidth(char)) / 2))
    const body = " ".repeat(left) + theme.dim(char)
    return body + " ".repeat(Math.max(0, width - left - displayWidth(char)))
  })
}

/** body 区某一行的竖线骨架(面板内容会盖在中间那些格子上)。 */
export function bodyRow(layout: Layout): string {
  let out = ""
  for (let x = 0; x < layout.width; x++) {
    out += layout.dividers.includes(x) ? theme.dim(V) : " "
  }
  return out
}


/**
 * overlay 面板的独立边框。它盖在对话上,得有自己的四条边,
 * 否则和底下的内容糊在一起分不清哪是哪。
 */
export function overlayFrame(width: number, height: number, title: string): string[] {
  const label = truncateToWidth(title, Math.max(1, width - 6))
  const used = 2 + 1 + displayWidth(label) + 1
  const top = theme.cyan(TOP_LEFT + H + " ") + theme.bold(theme.cyan(label)) + theme.cyan(" " + H.repeat(Math.max(0, width - used - 1)) + TOP_RIGHT)
  const bottom = theme.cyan(BOTTOM_LEFT + H.repeat(Math.max(0, width - 2)) + BOTTOM_RIGHT)
  const middle = theme.cyan(V) + " ".repeat(Math.max(0, width - 2)) + theme.cyan(V)
  return [top, ...Array.from({ length: Math.max(0, height - 2) }, () => middle), bottom]
}
