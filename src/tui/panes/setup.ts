/**
 * 第一次进一个文件夹时那张**全屏**卡片。
 *
 * ── 为什么从「问两行字」改成一整屏 ──
 * 上一版是两问 readLine:列四条,让用户敲个数字。它的问题不在按键数,在**说不清**。
 * 「conversation + panels」这几个字要求用户先在脑子里把界面画出来,而他此刻
 * 恰恰还没见过这个界面 —— 第一次进来正是他对这个程序一无所知的时刻。于是那张
 * 卡片实际上是在考他,而不是在帮他。
 *
 * 一屏解决的是这件事:**每一条旁边就画着它长什么样**。四个小框,一眼看完 ——
 * 侧栏是什么、对话在哪、这两种视图差在哪,全都不用读字。
 *
 * ── 为什么是纯的 ──
 * 这里不认识终端、不认识 Screen、不认识键盘。给一个按键返回该干什么,给一组
 * 宽高返回一屏字符 —— 和 panes/ 下别的模块同一条规矩。驱动它的那点胶水在
 * cli/folder-setup.ts,而这样这套问答**在测试里跑得起来**,不需要一个假 pty。
 *
 * ── 一屏,但**分两步** ──
 * 排布和信任都摆在同一屏的话,光标要在一个 2×2 的格子和一个两行的列表之间
 * 跳,上下左右四个键各有两套含义。分两步之后每一步只有一列候选,↑↓ 就够了 ——
 * 而右上角那个 `step 1 of 2` 把代价说清楚了:再按一次就完事。
 */
import type { Key } from "../../cli/keys.ts"
import type { FolderChoice } from "../../config/folders.ts"
import type { ViewMode } from "../../config/config.ts"
import { theme } from "../../cli/theme.ts"
import { displayWidth, padToWidth, truncateToWidth } from "../../cli/width.ts"
import { t } from "../../i18n/index.ts"

/** 四种排布。顺序就是列出来的顺序,第一条是默认 */
export const LAYOUTS: Array<{ view: ViewMode; panels: boolean }> = [
  { view: "session", panels: false },
  { view: "session", panels: true },
  { view: "stream", panels: false },
  { view: "stream", panels: true },
]

/** 预览小框有多大。六行是能同时画出"上下分区"和"左右分栏"的最小高度 */
const PREVIEW = { width: 34, height: 7 }
/** 左边那列候选占多宽。四条里最长的是 `conversation + panels` */
const LIST_WIDTH = 30
/** 整块内容离左边框多远。留白本身就是"这不是一条命令输出"的信号 */
const MARGIN = 4

export type SetupStep = "layout" | "trust"

export type SetupAction = "redraw" | "done" | "cancel" | "pass"

/**
 * 卡片的全部状态。
 *
 * ★ 没有"输错了"这一档。每一条都随时改得回来(`/setting`、ctrl-b、`/trust`),
 *   所以这张卡片不该有任何一条路通向"你选错了,再来一次"。
 */
export class SetupCard {
  readonly steps: SetupStep[]
  step = 0
  layout = 0
  /** 0 = 信任,1 = 先看一眼 */
  trust = 0
  /** 标题里写的那个路径。**已经缩过的样子**(`~/code/x`),由驱动方给 */
  private readonly where: string

  /**
   * @param emptyFolder 空目录不问信任 —— 里面没有任何东西能对模型说话,
   *   而每一个没有内容的问题都在训练用户闭着眼按回车。
   */
  constructor(options: { where: string; emptyFolder: boolean }) {
    this.where = options.where
    this.steps = options.emptyFolder ? ["layout"] : ["layout", "trust"]
  }

  get current(): SetupStep {
    return this.steps[this.step] ?? "layout"
  }

  get choice(): FolderChoice {
    const layout = LAYOUTS[this.layout] ?? LAYOUTS[0]!
    return { view: layout.view, panels: layout.panels, trust: this.trust === 1 ? "checking" : "trusted" }
  }

  /** 这一步有几条候选 */
  private get count(): number {
    return this.current === "layout" ? LAYOUTS.length : 2
  }

  private get at(): number {
    return this.current === "layout" ? this.layout : this.trust
  }

  private set at(value: number) {
    const clamped = Math.max(0, Math.min(this.count - 1, value))
    if (this.current === "layout") this.layout = clamped
    else this.trust = clamped
  }

  key(key: Key): SetupAction {
    // ★ Ctrl-C 是**取消整张卡片**,不是"用默认值"。取消什么都不存,下次再问 ——
    //   把一次逃跑存成他的答案,是拿他没做过的决定替他做决定
    if (key.ctrl && (key.name === "c" || key.name === "d")) return "cancel"
    // esc 是"就用默认的吧":两问的默认值恰好都是第一条,而它们已经高亮着
    if (key.name === "escape") return "done"

    switch (key.name) {
      case "up":
      case "left":
        this.at = this.at - 1
        return "redraw"
      case "down":
      case "right":
        this.at = this.at + 1
        return "redraw"
      case "tab":
        // 转圈。四条候选里 tab 比方向键快,而且不用先想清楚方向
        this.at = (this.at + 1) % this.count
        return "redraw"
      case "enter":
      case "return":
      case "space":
        if (this.step + 1 >= this.steps.length) return "done"
        this.step++
        return "redraw"
      case "backspace":
        // 退一步。中途改主意的唯一出路 —— 没有它,第一步选错了只能取消重来
        if (this.step === 0) return "pass"
        this.step--
        return "redraw"
      default:
        break
    }
    // 数字直选。四条候选按 1-4 比数着按方向键快,而且是这类清单的通用手势
    const digit = key.name.length === 1 ? Number(key.name) : Number.NaN
    if (Number.isInteger(digit) && digit >= 1 && digit <= this.count) {
      this.at = digit - 1
      return "redraw"
    }
    return "pass"
  }

  render(width: number, height: number): string[] {
    const body: string[] = []
    const room = Math.max(20, width - MARGIN * 2)
    const pad = " ".repeat(MARGIN)
    const line = (text = "") => body.push(pad + truncateToWidth(text, room))

    // 标题右端挂着第几步。用户按下第一个回车之前就该知道总共几步 ——
    // 一个不知道有多长的问答,人第一反应是找怎么跳过
    const step = this.steps.length > 1 ? t.setupStep(this.step + 1, this.steps.length) : ""
    line(rightAlign(theme.bold(t.folderSetupTitle(this.where)), theme.dim(step), room))
    line(theme.dim(t.folderSetupWhere))
    line()
    line(theme.bold(this.current === "layout" ? t.folderSetupLayout : t.folderSetupTrust))
    line()

    for (const row of this.current === "layout" ? this.layoutRows(room) : this.trustRows(room)) line(row)

    line()
    // 选中那条的说明单独一行,位置固定 —— 跟着高亮走的说明会让整块内容
    // 每按一次上下就重排一次,而人是靠"东西没动"来读列表的
    line(theme.dim(truncateToWidth(this.hint(), room)))

    // 整块往下压一点。顶着第一行的一屏读起来像一段命令输出,而这是一张卡片 ——
    // 上面那点空白是它和"程序刚才吐的字"之间唯一的分界
    const top = Math.max(1, Math.min(4, Math.floor((height - body.length - 2) / 3)))
    const out = [...Array.from({ length: top }, () => ""), ...body]
    // 底下两行钉在最下面,不跟着内容长短漂。
    //
    // ★ 「随时改得回来」那一句必须在。这是用户第一次见到这个程序的地方,而
    //   两个问题里有一个带着"信任"两个字 —— 不说清楚可以反悔的话,他要么在
    //   一张卡片上停下来想五分钟,要么随手按过去然后再也不知道自己选了什么
    while (out.length < height - 3) out.push("")
    out.push(pad + theme.dim(truncateToWidth(t.folderSetupSaved, room)))
    out.push(pad + theme.dim(truncateToWidth(t.setupKeys, room)))
    out.push("")
    return out.slice(0, height)
  }

  private hint(): string {
    if (this.current === "layout") return t.folderSetupLayoutOptions[this.layout]?.hint ?? ""
    return this.trust === 1 ? t.folderSetupTrustCheckHint : t.folderSetupTrustYesHint
  }

  /** 四条候选在左,选中那条的预览小框在右 —— 一眼看完侧栏是什么 */
  private layoutRows(room: number): string[] {
    const list = LAYOUTS.map((_, index) =>
      optionLine(index, t.folderSetupLayoutOptions[index]?.name ?? "", index === this.layout, LIST_WIDTH),
    )
    const shown = LAYOUTS[this.layout] ?? LAYOUTS[0]!
    const box = previewBox(shown, Math.min(PREVIEW.width, Math.max(12, room - LIST_WIDTH - 2)), PREVIEW.height)
    return zip(list, box, LIST_WIDTH)
  }

  private trustRows(room: number): string[] {
    // ★ 这一步的说明摆在选项**下面**,不摆在右边。
    //
    //   排布那一步右边是预览小框(一个必须挨着候选看的东西),而这里右边是
    //   三行散文 —— 挤进右栏就只剩五十来列,catalog 里那三行会各自超出一点,
    //   于是三行全以 `…` 收尾,吃掉的恰好是每句话的后半截。这一步只有两条
    //   候选,底下有的是地方。
    return [
      optionLine(0, t.folderSetupTrustYes, this.trust === 0, LIST_WIDTH),
      optionLine(1, t.folderSetupTrustCheck, this.trust === 1, LIST_WIDTH),
      "",
      ...t.folderSetupTrustWhy.map((one) => theme.dim(truncateToWidth(one, room))),
    ]
  }
}

/** `▸ 1  conversation` */
function optionLine(index: number, label: string, selected: boolean, width: number): string {
  const head = selected ? theme.cyan("▸ ") : "  "
  const body = `${index + 1}  ${label}`
  const painted = selected ? theme.bold(body) : theme.dim(body)
  return head + painted + " ".repeat(Math.max(0, width - 2 - displayWidth(body)))
}

/** 左右两栏拼成一行。右边那栏比左边长时,左边补空格 */
function zip(left: string[], right: string[], width: number): string[] {
  const rows = Math.max(left.length, right.length)
  return Array.from({ length: rows }, (_, i) => {
    const head = left[i] ?? " ".repeat(width)
    return padToWidth(head, width) + "  " + (right[i] ?? "")
  })
}

/** 标题在左、步数在右,中间用空格顶开 */
function rightAlign(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - displayWidth(left) - displayWidth(right))
  return left + " ".repeat(gap) + right
}

/**
 * 一个排布长什么样,画成一个小框。
 *
 * ── 为什么画结构而不是画内容 ──
 * 里面填几句假对话的话,四个框看起来只有"字不一样",而它们真正的差别是
 * **有没有左右两栏**和**中间那栏是分区的还是流水的**。所以框里只有分栏线、
 * 分区线和几个占位符号 —— 那正是切换这个开关会改变的全部东西。
 *
 * ⚠ 用的字符和真界面同一套(`╭─┬╮ ▸ ● ›`)。挑几个更好看的方块符号的代价是
 *   东亚宽度里它们多半是 Ambiguous —— 某些终端上按两列画,这个框当场就歪了。
 */
export function previewBox(layout: { view: ViewMode; panels: boolean }, width: number, height: number): string[] {
  const w = Math.max(12, width)
  const inner = w - 2
  // 三栏:左侧文件树窄一点,右侧预览再窄一点,中间全给对话
  const side = layout.panels ? Math.max(3, Math.round(inner * 0.22)) : 0
  const right = layout.panels ? Math.max(3, Math.round(inner * 0.22)) : 0
  const mid = inner - (layout.panels ? side + right + 2 : 0)

  const cell = (text: string, room: number) => padToWidth(truncateToWidth(text, room), room)
  const row = (left: string, middle: string, tail: string) =>
    theme.dim("│") +
    (layout.panels ? cell(left, side) + theme.dim("│") : "") +
    cell(middle, mid) +
    (layout.panels ? theme.dim("│") + cell(tail, right) : "") +
    theme.dim("│")

  const bar = (l: string, fill: string, joint: string, r: string) =>
    theme.dim(
      l +
        (layout.panels ? fill.repeat(side) + joint : "") +
        fill.repeat(mid) +
        (layout.panels ? joint + fill.repeat(right) : "") +
        r,
    )

  const body: string[] = []
  if (layout.view === "session") {
    // 分区:摘要 / 活动区 / 输入。这就是 session 视图和 stream 唯一看得见的差别
    body.push(row(" ▸ src", theme.dim(" so far ────"), ""))
    body.push(row(" ▸ test", "", ""))
    body.push(row("", theme.cyan(" ─[● ●]─ ───"), theme.dim(" diff")))
    body.push(row("", " ● edit", ""))
  } else {
    body.push(row(" ▸ src", theme.green(" ▌ you"), ""))
    body.push(row(" ▸ test", " it answers…", ""))
    body.push(row("", " ● read", theme.dim(" diff")))
    body.push(row("", " ● edit", ""))
  }
  body.push(row("", theme.dim(" › ask"), ""))

  const lines = [bar("╭", "─", "┬", "╮"), ...body, bar("╰", "─", "┴", "╯")]
  while (lines.length < height) lines.splice(lines.length - 1, 0, row("", "", ""))
  return lines.slice(0, Math.max(3, height))
}
