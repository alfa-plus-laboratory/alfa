/**
 * 颜色。**唯一**允许 import picocolors 的文件。
 *
 * 收在一个地方不是洁癖:颜色要能被 --no-color / NO_COLOR / 非 TTY 三种方式
 * 关掉,散在各处就总有一处漏网,把转义序列吐进管道和日志里。
 *
 * picocolors 自己会看 NO_COLOR 和 isTTY,但**不认我们的 --no-color 参数**,
 * 所以这里包一层可运行时切换的开关。
 */
import pc from "picocolors"

/**
 * 永远带色的那一套 formatter。
 *
 * picocolors 的默认导出在非 TTY 下**整套退化成恒等函数**,于是 setColorEnabled(true)
 * 根本打不开色。那不只是测试里断言不了配色的问题:`… | less -R` 是真实用法,
 * 用户说"我就是要颜色"的时候得给得出来。开关只由下面的 enabled 一个人管。
 */
const paints = pc.createColors(true)

let enabled = pc.isColorSupported

export function setColorEnabled(value: boolean): void {
  enabled = value
}

export function colorEnabled(): boolean {
  return enabled
}

type Paint = (text: string) => string

const paint = (fn: Paint): Paint => (text) => (enabled ? fn(text) : text)

export const theme = {
  dim: paint(paints.dim),
  bold: paint(paints.bold),
  italic: paint(paints.italic),
  underline: paint(paints.underline),
  strike: paint(paints.strikethrough),
  /**
   * 行内代码。
   *
   * 用前景色而不是背景色:背景色在浅色主题的终端上要么看不见、要么糊成一块,
   * 而这个项目的用户用什么主题我们不知道。黄色和警告行同色,但警告永远是
   * 「行首一个符号 + 整行黄」,行内代码是句子中间的几个字,不会认错。
   */
  code: paint(paints.yellow),
  red: paint(paints.red),
  green: paint(paints.green),
  yellow: paint(paints.yellow),
  blue: paint(paints.blue),
  cyan: paint(paints.cyan),
  magenta: paint(paints.magenta),
  gray: paint(paints.gray),
  /** diff 用的反色底,比单纯改前景色更容易在浅色终端上看清 */
  addBg: paint((text) => paints.green(text)),
  delBg: paint((text) => paints.red(text)),
  inverse: paint(paints.inverse),
}

/**
 * 256 色前景。
 *
 * ── 为什么要越过 picocolors 自己写序列 ──
 * 它只给基本 16 色,而「从绿走到红」的渐变至少要十几档 —— 16 色里没有那些中间
 * 色,拿黄色顶替出来的是三段跳,不是渐变。256 色是 1999 年就有的 xterm 扩展,
 * 现在连 Windows Terminal 和 tmux 都认;真不认的终端会把它当未知 SGR 忽略,
 * 退化成默认前景色,而不是把序列吐成乱码。
 *
 * ★ 它照旧受 setColorEnabled 管 —— 这是这个文件存在的全部意义:关色要一处关得干净。
 * ★ 全屏界面下这条序列会被合成器解析成单元格样式(见 tui/screen.ts 的 applySGR
 *   认得 38;5;n),所以差分不会因此失准。
 */
export function color256(code: number): Paint {
  // ⚠ ESC 写成 \u001b,不许是裸控制字符 —— 裸的在 diff / grep / 编辑器里是隐形的
  const prefix = `\u001b[38;5;${code}m`
  return (text) => (enabled ? prefix + text + "\u001b[39m" : text)
}

/**
 * 计算可见宽度时要先去掉转义序列,否则对齐会错位。
 *
 * ESC 必须写成 \u001b 转义,不能是裸控制字符 —— 裸的在 diff、grep、
 * 编辑器里都是隐形的,哪天被改坏了根本看不出来(这个仓库已经栽过一次)。
 */
const ANSI = /\u001b\[[0-9;]*m/g
export function visibleLength(text: string): number {
  return text.replace(ANSI, "").length
}
