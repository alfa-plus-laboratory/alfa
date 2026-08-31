/**
 * 工具看板:这一轮它动了哪些手。
 *
 * ── 为什么不是流水账 ──
 * 一次 read 在瀑布流里是两行(发起一行、结果一行),再加 diff 就是十几行。
 * 一轮跑十个工具,正文就被挤到看不见了 —— 而正文才是它在跟你说的话。
 * 这里**一次调用一行**,状态在原地变:⠹ 变 ✓,右边补上结果。行数不再随
 * 时间增长,只随「这一轮调了几个工具」增长。
 *
 * ── 定高,老的折起来 ──
 * 装不下时保留**最后几条**并在顶上写一行「更早还有 N 条」。丢掉的是已经
 * 结束的旧调用,留下的是正在跑的和刚发生的 —— 这两样才有人看。
 *
 * ── 收据也是一行 ──
 * 权限批准、自动放行的理由、重试、中断,和工具行排在同一列时间线里。
 * 「我批过什么」必须留痕,而留在别处就等于没留:用户不会为了找它去翻第二个地方。
 */
import { theme } from "../../cli/theme.ts"
import { duration } from "../../cli/render.ts"
import { t } from "../../i18n/index.ts"
import { displayWidth, truncateToWidth } from "../../cli/width.ts"

export interface ToolRow {
  kind: "tool"
  /** part id。状态推进时按它原地更新 */
  id: string
  /**
   * provider 给的 toolCallId。**和 id 不是一回事** —— 权限那边只认得这个,
   * 用它把「这次没问你就放行了」画回本行,见 markTrusted。
   */
  callID: string
  tool: string
  /** 命令原文 / 相对路径 / 匹配式 */
  target: string
  status: "running" | "completed" | "error"
  startedAt: number
  endedAt?: number
  /** 结果摘要:+4 -1 / exit 0 / 3 matches */
  outcome: string
  /** 有 diff 的话在右栏被收掉时就地展开 */
  diff?: string
  /**
   * 这次调用**本来是要问你的**,trust 模式没问就放行了。
   *
   * ── 为什么是本行的一个记号,不是下面再来一行 ──
   * 「先占一行、等你按键、原地换成结果」那套是为**要问**设计的(见
   * model.ts 的 permissionAsked):模态框可能被盖着,所以看板上得有一行说
   * 「它在等你」。trust 之下没有人被问过,那一行于是变成了纯粹的事后记录 ——
   * 而它紧贴在同一次调用的下面,窄栏里两行都截成 `webs…`,看着就是同一件事
   * 被写了两遍。
   *
   * 记号只花一点颜色,不花一列。真正要读的那句话(以及触发它的风险标记)
   * 照旧写进瀑布流,`/view stream` 和 `--plain` 里一个字不少。
   */
  trusted?: boolean
  /**
   * 结果的**最后两行**。已经切好、去掉空行,由 ChatModel 填。
   *
   * ── 为什么是尾巴,不是开头 ──
   * 命令的结论在最后:测试跑完的那句 `3 failed`、编译的最后一条报错、
   * `git status` 的最后一行。开头多半是版本号和一堆进度。
   *
   * ── 为什么只有两行 ──
   * 这一栏是「现在怎么样了」,不是日志。两行装得下一句结论加一行上下文,
   * 再多就该去右栏或者 `/view stream` 看了。
   */
  tail?: string[]
}

export type NoteTone = "info" | "good" | "warn" | "bad"

export interface NoteRow {
  kind: "note"
  id: string
  tone: NoteTone
  /** 行首那个符号后面的全部内容,已经上过色 */
  text: string
}

export type BoardRow = ToolRow | NoteRow

/** 工具名占的列宽。八个内建工具里最长的是 write/grep/glob/todo 四个字母,留五列够。 */
const NAME_WIDTH = 5
/** 就地展开的 diff 最多占几行。再多就该去右栏看了 */
const MAX_INLINE_DIFF = 10
/** 结果尾巴留几行。见 ToolRow.tail */
export const MAX_TAIL = 2

/**
 * 就地展开 diff 需要几行。
 *
 * 高度预算要**先**知道这个数,否则看板只按工具行数申请高度,轮到画 diff 时
 * 发现一行都不剩 —— 现象是「右栏一收起来,diff 就没了」,而那恰恰是它最该
 * 出现的时候。
 */
export function inlineDiffRows(rows: readonly BoardRow[]): number {
  const diff = lastDiff(rows)
  return diff ? Math.min(diff.length, MAX_INLINE_DIFF) : 0
}

/**
 * 结果尾巴要几行。**和 diff 一样要先进高度预算** —— 不先算进去的话,轮到画它
 * 的时候一行都不剩,现象是「有时候有、有时候没有」。
 *
 * 只算**最后一条**:同一条规矩,展开全部等于把瀑布流搬回来了。
 */
export function tailRows(rows: readonly BoardRow[]): number {
  return lastTail(rows).length
}

/** 最后一条调用的结果尾巴。跑着的那条没有结果,自然是空的 */
function lastTail(rows: readonly BoardRow[]): string[] {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    if (row.kind !== "tool") continue
    return row.tail ?? []
  }
  return []
}

export interface BoardInput {
  rows: readonly BoardRow[]
  width: number
  height: number
  /** 转圈的当前帧 */
  spinner: string
  now: number
  /** 右栏看不见时,最后一条改动的 diff 就地展开 */
  inlineDiff: boolean
}

/**
 * 画看板。
 *
 * 返回的行数**恰好** ≤ height。装不下就折叠,而不是让调用方去截 —— 截断会把
 * 「更早还有 N 条」那行截掉,于是隐藏起来的调用彻底没有痕迹。
 */
export function renderBoard(input: BoardInput): string[] {
  if (input.height <= 0 || input.rows.length === 0) return []

  const diff = input.inlineDiff ? lastDiff(input.rows) : undefined
  return foldToHeight(input, diff)
}

/**
 * 每一条各画一行,**不折叠**。
 *
 * 留着不删:它是「把整份画出来」那一档,和上面 renderBoard 的「折叠到指定
 * 高度」正好互补。工具看板一度是块能滚的独立面板,用的就是这个;那块面板撤了
 * (工具回到回答里),但「不折叠地画完」这件事本身没有毛病,而重新写一遍
 * 只会和 renderRow 的对齐规则分叉。
 */
export function boardLines(input: Omit<BoardInput, "height">): string[] {
  if (input.rows.length === 0) return []
  const full = { ...input, height: Number.MAX_SAFE_INTEGER }
  const painted = input.rows.map((row) => renderRow(row, full))
  const diff = input.inlineDiff ? lastDiff(input.rows) : undefined
  const extra = diff ? diff.slice(0, MAX_INLINE_DIFF) : lastTail(input.rows).map((line) => "│ " + line)
  painted.push(...extra.map((line) => theme.dim(truncateToWidth("   " + line, input.width))))
  return painted
}

function foldToHeight(input: BoardInput, diff: string[] | undefined): string[] {
  /**
   * 挂在最后一条下面的附加行:**要么是 diff,要么是结果尾巴,不会两个都有**。
   *
   * 同一条调用只展开一种 —— edit 展开 diff(改了什么),别的展开输出尾巴
   * (跑出来什么)。两个都画的话,一条 edit 会占掉大半个看板。
   */
  const extra = diff ? diff.slice(0, MAX_INLINE_DIFF) : lastTail(input.rows).map((line) => "│ " + line)
  // 先给工具行留位置(最多留三行,再多就该折叠了),剩下的才给附加行。
  // 反过来按「附加行最多占一半」来分是不对的:调用方已经**专门为它**
  // 多申请过高度,再按比例砍一刀,diff 就永远只露得出两行
  const keepRows = Math.min(input.rows.length, 3)
  const diffRoom = Math.max(0, Math.min(extra.length, input.height - keepRows))
  const roomForRows = input.height - diffRoom

  const painted: string[] = []
  if (input.rows.length <= roomForRows) {
    for (const row of input.rows) painted.push(renderRow(row, input))
  } else {
    // 折叠行自己也要一行,所以真正能显示的比 roomForRows 少一条
    const shown = Math.max(0, roomForRows - 1)
    painted.push(theme.dim(`   ${t.toolsEarlier(input.rows.length - shown)}`))
    for (const row of input.rows.slice(input.rows.length - shown)) painted.push(renderRow(row, input))
  }

  if (diffRoom > 0) {
    // 尾巴要**留住最后那几行**:结论在最后,砍掉尾巴等于砍掉结论
    const shown = diff ? extra.slice(0, diffRoom) : extra.slice(extra.length - diffRoom)
    painted.push(...shown.map((line) => theme.dim(truncateToWidth("   " + line, input.width))))
  }
  return painted.slice(0, input.height)
}

function renderRow(row: BoardRow, input: BoardInput): string {
  if (row.kind === "note") {
    const mark = row.tone === "bad" ? theme.red("✗") : row.tone === "warn" ? theme.yellow("⚠") : row.tone === "good" ? theme.green("✓") : theme.dim("·")
    return truncateToWidth(` ${mark} ${row.text}`, input.width)
  }

  const glyph =
    row.status === "running"
      ? theme.cyan(input.spinner)
      : row.status === "error"
        ? theme.red("✗")
        : theme.green("✓")

  // 没问就放行的那些,工具名上黄。宽度是按 NAME_WIDTH 算的,上色只加 SGR,
  // 所以这一格的排版不受影响
  const label = row.tool.length > NAME_WIDTH ? row.tool.slice(0, NAME_WIDTH) : row.tool.padEnd(NAME_WIDTH)
  const name = row.trusted ? theme.yellow(label) : theme.dim(label)
  const right = row.status === "running" ? runningNote(row, input.now) : row.outcome

  // 右边先占位,剩下的全给目标 —— 目标可以截,结果不能截:
  // 「exit 1」被截成「exit」和成功长得一模一样
  const fixed = 1 + 1 + 1 + 1 + NAME_WIDTH + 1
  const rightWidth = right.length > 0 ? displayWidth(right) + 2 : 0
  const targetWidth = Math.max(4, input.width - fixed - rightWidth)
  const target = truncateToWidth(row.target, targetWidth)
  const gap = Math.max(1, input.width - fixed - displayWidth(target) - (right.length > 0 ? displayWidth(right) : 0))

  const body = ` ${glyph} ${name} ${target}${" ".repeat(gap)}${right.length > 0 ? tint(row, right) : ""}`
  return truncateToWidth(body, input.width)
}

function tint(row: ToolRow, text: string): string {
  return row.status === "error" ? theme.red(text) : theme.dim(text)
}

function runningNote(row: ToolRow, now: number): string {
  const ms = now - row.startedAt
  // 一秒以内不显示耗时:数字每帧都在跳,而那一秒里没有任何信息
  return ms >= 1000 ? duration(ms) : ""
}

/** 最后一条带 diff 的改动。只展开最后一条 —— 展开全部等于把瀑布流搬回来了。 */
function lastDiff(rows: readonly BoardRow[]): string[] | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    if (row.kind === "tool" && row.diff && row.diff.length > 0) return row.diff.split("\n")
  }
  return undefined
}
