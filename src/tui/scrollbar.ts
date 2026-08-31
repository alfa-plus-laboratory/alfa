/**
 * 竖直滚动条:一列字符,贴在面板最右边。
 *
 * ── 它回答的是两个问题,不是一个 ──
 * 「上面/下面还有没有东西」和「我现在在整段里的哪儿」。前者靠有没有滑块,
 * 后者靠滑块的位置和长度。少了它,一栏画满字的面板和一栏正好画完的面板
 * 长得一模一样 —— 用户只能靠按一下方向键去试。
 *
 * ── 那一列**永远保留**,但装得下时不画 ──
 * 这是刻意的:滑块一出现就把内容挤窄一列的话,每次内容长过一屏,整栏文字
 * 会重排一次(代码、diff、表格全跟着抖)。所以列先留着,空着不画 ——
 * 空着的槽也不会说谎,它就是「没有东西被藏起来」。
 *
 * ── 为什么滑块最少一行 ──
 * 一万行的文件按比例算出来的滑块是 0 行,那就等于没有滚动条。宁可位置略不准,
 * 也不能让它消失 —— 它首先要**在**,其次才准。
 */
import { theme } from "../cli/theme.ts"
import { padToWidth, truncateToWidth } from "../cli/width.ts"

/** 滑块。用实心块而不是重线条:重线条在不少等宽字体里和 `│` 画得一模一样 */
const THUMB = "█"
/**
 * 槽。
 *
 * ★ **不能用 `│`。** 它就画在面板最右列,而那一列右边紧挨着的就是框线 ——
 *   两根一模一样的竖线并排,看着就是「边框往左错了一格」。虚线一眼分得开:
 *   它是槽,不是边。滑块那边早就为同一个理由躲开了重线条(见 THUMB)。
 */
const TRACK = "┊"

export interface ScrollbarInput {
  /** 内容一共多少行(按当前宽度折过之后) */
  total: number
  /** 面板有多少行 */
  height: number
  /** 最上面显示的是第几行 */
  offset: number
}

/**
 * 算出那一列。返回正好 height 个单列字符;完全装得下时全是空格。
 */
export function scrollbarColumn(input: ScrollbarInput): string[] {
  const height = Math.max(0, input.height)
  if (height === 0) return []
  const blank = Array.from({ length: height }, () => " ")
  if (input.total <= height || input.total <= 0) return blank

  const size = Math.max(1, Math.min(height, Math.round((height * height) / input.total)))
  const maxOffset = input.total - height
  const at = Math.max(0, Math.min(maxOffset, input.offset))
  // 滑到底就必须**贴底**:差一行的话,用户会以为下面还剩一点没看
  const top = maxOffset === 0 ? 0 : Math.round((at / maxOffset) * (height - size))

  return blank.map((_, row) => (row >= top && row < top + size ? theme.cyan(THUMB) : theme.dim(TRACK)))
}

/**
 * 在滚动条上点(或拖)到第 row 行时,顶上那一行应该是第几行。
 *
 * ── 绝对定位,不是「按住哪就相对拖」 ──
 * 点哪儿滑块就居中到哪儿。相对拖要记住"按下去时抓的是滑块的第几行",而终端
 * 一行就是一格,那点精度换不来手感,却多一份会漂的状态。
 */
export function offsetForRow(row: number, input: { total: number; height: number }): number {
  const height = Math.max(1, input.height)
  const maxOffset = Math.max(0, input.total - height)
  if (maxOffset === 0) return 0
  const size = Math.max(1, Math.min(height, Math.round((height * height) / input.total)))
  const track = height - size
  if (track <= 0) return maxOffset
  // 滑块居中到点击处:track 上的位置 = 点击行 - 滑块的一半
  const at = Math.max(0, Math.min(track, row - Math.floor(size / 2)))
  return Math.round((at / track) * maxOffset)
}

/**
 * 把那一列贴到每行右边。
 *
 * `lines` 本该**已经画在 width - 1 的宽度里**。多出来的照样截掉:这一列一旦
 * 被挤出面板,合成器要么把它丢了(等于没有滚动条),要么盖到隔壁面板上 ——
 * 而"每行不超宽"是这个界面所有不错位的前提,不该靠调用方记得。
 */
export function attachScrollbar(lines: string[], column: string[], width: number): string[] {
  if (width < 2) return lines
  return lines.map((line, row) => padToWidth(truncateToWidth(line, width - 1), width - 1) + (column[row] ?? " "))
}
