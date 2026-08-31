/**
 * 上下文占用怎么画:输入框上沿那条量表、`/context` 的分项、`--plain` 状态行
 * 上那一小格。
 *
 * ── 三处画的是同一个数,但**只有一处**画在全屏界面上 ──
 * 全屏下量表挂在输入框上沿(见 tui/app.ts 的 draw),状态行上不再重复;
 * `--plain` 没有那条线,所以那一格留给它。同一个数在同一屏出现两次,用户
 * 第一反应永远是「这两个是不是不一样」。
 *
 * ── 为什么分项要画成条 ──
 * 一列数字回答不了「谁把窗口吃满了」——那是要**比**出来的,而人比长度比数字
 * 快得多。真实的会话里这份分项几乎总是同一个结论:tool results 占了八成。
 * 那个结论要一眼看见,才会让人想起还有 `/compact` 这回事。
 *
 * ── 颜色分两套,别混 ──
 * **水位**(整体占了多少)走渐变色阶 RAMP:绿 → 黄 → 红 → 红黑,每一格按自己
 * 的位置上色,于是条本身就是那把尺。**占比**(某一项占了多少、超没超线)走
 * 三档 paintFor:一项占 60% 不该因为大就变红,它只是大。
 */
import type { ContextReport, ContextSnapshot, SliceKey } from "../agent/context.ts"
import { t } from "../i18n/index.ts"
import { compact } from "./render.ts"
import { color256, theme } from "./theme.ts"
import { displayWidth, padToWidth } from "./width.ts"

/** 黄线 / 红线。到了黄线就该知道有 `/compact` 这回事,到了红线是它该发生了 */
export const WARN_AT = 0.8
export const DANGER_AT = 0.95

/**
 * 绿 → 绿黄 → 黄 → 黄红 → 红 → 红黑。xterm-256 的色号,从 0% 排到 100%。
 *
 * ── 为什么是渐变,不是三档红绿灯 ──
 * 三档只在跨线的那一瞬间给一次信号,而那一瞬间用户多半没在看。渐变让**每一眼**
 * 都带着位置信息:偏黄了就是过半,发橙就该想起 `/compact` 了 —— 不用去读数字,
 * 也不用记住 80% 是哪条线。
 *
 * 最后那两档(160/124/88)是「红黑」:它只在真正贴到顶时出现,而那时候暗下去
 * 恰恰是对的 —— 满了的进度条不该还在发亮抢眼睛,它该看着像烧焦了。
 */
const RAMP = [46, 82, 118, 154, 190, 226, 220, 214, 208, 202, 196, 160, 124, 88] as const

/**
 * 某个位置对应的颜色。
 *
 * `readable` 为真时**避开最暗的那两档** —— 字要读得出来。进度条可以烧到发黑,
 * 因为它的信息在长度里;而一个用 88 号色写的百分比,在深色终端上基本是隐形的。
 */
export function rampPaint(ratio: number, readable = true): (text: string) => string {
  const last = RAMP.length - 1 - (readable ? 2 : 0)
  const at = Math.max(0, Math.min(last, Math.round(clamp01(ratio) * (RAMP.length - 1))))
  return color256(RAMP[at]!)
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

/**
 * 报告里那几行分项条、以及超线提醒用的颜色。
 *
 * 分项条讲的是**占比**不是**水位**,渐变在那儿没有意义(「这一项 60%」不该
 * 因为它大就变红 —— 它只是大);超线提醒是一句话,黄和红在这个界面里从头到尾
 * 就那一个含义。所以这两处照旧走三档。
 */
export function paintFor(ratio: number): (text: string) => string {
  if (ratio >= DANGER_AT) return theme.red
  if (ratio >= WARN_AT) return theme.yellow
  return theme.dim
}

/**
 * 量表:`▓▓▓▓▓░░░░░░░░`。
 *
 * 用实心/空心两种块而不是渐变块:渐变块(▁▂▃)在等宽字体里高度不一,一排下来
 * 像坏了。这两个在所有终端里都是稳定的单宽字符。
 */
export function gauge(ratio: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)))
  // 有一点就画一格:0% 和 0.4% 在决策上没区别,但「一格都没有」会让人以为它坏了
  const at = ratio > 0 && filled === 0 ? 1 : filled
  return "▓".repeat(at) + "░".repeat(Math.max(0, width - at))
}

/**
 * 上色的量表:**每一格按它自己在窗口里的位置上色**,不是整条一个颜色。
 *
 * 于是条本身就是那条色阶:走到哪一格,那一格就是那个位置该有的颜色。整条一个
 * 颜色的话,34% 和 79% 长得一模一样(都是灰的),而颜色本来是这里最省眼睛的
 * 那个维度。空的那几格保持 dim —— 它们是「还没到」,不该有颜色。
 */
export function gradientGauge(ratio: number, width: number): string {
  const bar = gauge(ratio, width)
  let out = ""
  for (let at = 0; at < width; at++) {
    const char = bar[at] ?? "░"
    // 位置按 at/(width-1) 算,不是 (at+1)/width:第一格要落在色阶的**头**上,
    // 最后一格落在**尾**上。用后者的话满条也走不到纯绿和最暗那两档,
    // 条越短丢得越多 —— 八格的条会从第二档起步,看着像它自己偏黄
    const position = width > 1 ? at / (width - 1) : 1
    out += char === "▓" ? rampPaint(position, false)(char) : theme.dim(char)
  }
  return out
}

/**
 * `--plain` 状态行上那一格:`ctx 34%`。估出来的数带个 `~`。
 *
 * 和上面那条量表同一条规矩:不写窗口占用的绝对值。那一行本来就挤(路径、模型、
 * 权限模式全在),而 `306k / 900k` 这对数回答不了任何一个用户会问的问题。
 */
export function contextChip(snapshot: ContextSnapshot): string {
  const percent = Math.round(snapshot.ratio * 100)
  return `${t.ctxShort} ${snapshot.estimated ? "~" : ""}${percent}%`
}

/**
 * 状态行上的花费:`4.3M in · 86k out`。
 *
 * ── 它和量表是两个数,不是一个数的两种写法 ──
 * 量表答「还能聊多久」,这个答「这一趟烧了多少」。后者只增不减,而且会远大于
 * 窗口 —— 每一轮都要把整段历史重发一遍,聊二十轮就是十几倍的量。**正因为它
 * 大得反直觉,才更该写出来**:不写的话,这件事只会在月底的账单上出现一次。
 *
 * ── 进出为什么分开写 ──
 * 单价差一个数量级:in 是重发历史堆出来的(缓存命中更便宜),out 是模型真写
 * 出来的字。合成一个数的话,一场很便宜的会话和一场很贵的会话长得一模一样。
 *
 * ── 为什么不用 ↑↓ 箭头 ──
 * 那两个符号是**歧义宽度**的:同一个字符在 CJK 字体里占两列。而这一行现在
 * 画在框里,超一列就把右边那条竖线顶出去了(和轨上不画图标同一条理由)。
 *
 * 一个 token 都还没花的时候不画 —— 一格 `0 in · 0 out` 只是噪音。
 */
export function spentChip(snapshot: ContextSnapshot): string {
  const { total, input, output } = snapshot.spent
  return total > 0 ? t.ctxSpentShort(compact(input), compact(output)) : ""
}

/**
 * 输入框上沿那条线**右端**的量表:`──────── ▓▓▓▓▓░░░░░░░ 34% · 306k / 900k ─┤`。
 *
 * ── 为什么它在这儿,而不是(只)在状态行上 ──
 * 「还能聊多久」是**打字之前**要知道的事:句子还没出口时决定要不要先压缩,
 * 代价是一条命令;打完一大段再发现满了,代价是那一轮白跑。这条线就在输入框
 * 上沿,是那个念头出现的地方。同一个数不在状态行上再写一遍 —— 一个东西出现
 * 两处,用户第一反应永远是「这两个是不是不一样」。
 *
 * ── 窄了就一层层往回缩 ──
 * 三栏都开着的时候中间栏可能只有四十列。宁可只剩一个百分比,也不要让这条线
 * 超宽 —— 超一列,整个界面的边框就会错位。
 */
export function contextRule(snapshot: ContextSnapshot, room: number): string {
  const percent = `${snapshot.estimated ? "~" : ""}${Math.round(snapshot.ratio * 100)}%`
  // ★ 这里**不写 token 的绝对值**。
  //
  //   `306k / 900k` 是一对没人拿去做决定的数:决定只有一个 —— 现在压不压 ——
  //   而百分比和颜色已经把它答完了。那两个数唯一的作用是让这条常驻的线变长、
  //   变吵,还得让人每次都去心算一次比值。要具体数字的时候有 `/context`,
  //   那是一份**主动去看**的报告,数字在那儿才有人真的读。
  const forms: Array<[number, string]> = [
    [12, " " + percent],
    [8, " " + percent],
    [0, percent],
  ]
  for (const [bar, text] of forms) {
    if (bar + text.length > room) continue
    // 条上色在**每一格**上,百分比上色在整体上 —— 它只有一个位置,就是现在这个
    return (bar > 0 ? gradientGauge(snapshot.ratio, bar) : "") + rampPaint(snapshot.ratio)(text)
  }
  return ""
}

const LABEL_WIDTH = 20
const BAR_WIDTH = 14

/**
 * `/context` 的正文。
 *
 * 宽度不由调用方给:斜杠命令的回答是一段文本,它同时要落进瀑布流、活动区和
 * `--plain` 的滚动区,三处宽度都不一样。所以按一个窄栏也放得下的固定排版画,
 * 让它在哪儿都不折行 —— 一份被折行折烂的表格,比一列数字还难读。
 */
export function renderContextReport(report: ContextReport, model: string): string {
  const paint = paintFor(report.ratio)
  const percent = Math.round(report.ratio * 100)
  const lines: string[] = []

  lines.push(
    "  " +
      theme.bold(t.ctxTitle) +
      "  " +
      gradientGauge(report.ratio, 24) +
      "  " +
      // 百分比和条的**末端同色**:两样说的是同一件事,颜色不一致读起来像在
      // 说两件事
      theme.bold(rampPaint(report.ratio)(`${report.estimated ? "~" : ""}${percent}%`)) +
      theme.dim(`   ${compact(report.used)} / ${compact(report.budget)}`),
  )
  lines.push("")

  for (const slice of report.slices) {
    // 一个字都不占的分项不列。空行比多一个 0 更能让真正占地方的那几项跳出来
    if (slice.tokens <= 0) continue
    lines.push(row(sliceLabel(slice.key), slice.tokens, slice.tokens / report.budget, theme.cyan))
  }
  lines.push(row(t.ctxFree, report.free, report.free / report.budget, theme.dim))

  lines.push("")
  // 模型名和窗口写在一起:窗口多大是**这个模型**的属性,分开写的话,换过模型
  // 的人会拿着上一个模型的印象读这份报告
  lines.push(theme.dim(`  ${model} · ${t.ctxWindow(compact(report.limit), compact(report.budget))}`))
  if (report.limitSource === "default") lines.push(theme.dim(`  ${t.ctxWindowGuessed}`))
  lines.push(theme.dim(`  ${t.ctxMessages(report.messages)}${report.folded > 0 ? ` · ${t.ctxFolded(report.folded)}` : ""}`))
  // 花费:和上面那些数**不是一回事**,所以单独一行,并且当场解释它为什么这么大。
  // 不解释的话,一个比窗口大十倍的数看着就像个 bug
  if (report.spent.total > 0) {
    const spent =
      "  " +
      t.ctxSpent(compact(report.spent.total), compact(report.spent.input), compact(report.spent.output)) +
      (report.spent.cached > 0 ? ` · ${t.ctxSpentCached(compact(report.spent.cached))}` : "")
    lines.push(theme.dim(spent))
    lines.push(theme.dim(`  ${t.ctxSpentWhy}`))
  }
  // 这两句是这份报告的诚信声明:总数是真的,切分是估的。不说的话,用户会
  // 拿着 251.0k 这个数当精确值去做决定
  lines.push(theme.dim(`  ${report.estimated ? t.ctxAllEstimated : t.ctxSplitEstimated}`))
  if (report.ratio >= WARN_AT) lines.push(paint(`  ${t.ctxCompactHint}`))
  else lines.push(theme.dim(`  ${t.ctxCompactHint}`))

  return lines.join("\n")
}

function row(label: string, tokens: number, share: number, paint: (text: string) => string): string {
  const percent = Math.round(share * 100)
  // 占了地方却显示 0% 会读成「这一项不花钱」。它花了,只是不到一个百分点
  const shown = percent === 0 && tokens > 0 ? "<1%" : `${percent}%`
  return (
    "  " +
    theme.dim(padToWidth(label, LABEL_WIDTH)) +
    padRight(compact(tokens), 8) +
    theme.dim(padRight(shown, 6)) +
    "  " +
    paint(gauge(share, BAR_WIDTH))
  )
}

/** 数字右对齐。padToWidth 是左对齐的,而一列数字左对齐等于没对齐 */
function padRight(text: string, width: number): string {
  const pad = Math.max(0, width - displayWidth(text))
  return " ".repeat(pad) + text
}

export function sliceLabel(key: SliceKey): string {
  switch (key) {
    case "system":
      return t.ctxSystem
    case "tools":
      return t.ctxTools
    case "mcp":
      return t.ctxMcpTools
    case "skills":
      return t.ctxSkills
    case "summary":
      return t.ctxSummary
    case "memory":
      return t.ctxMemory
    case "env":
      return t.ctxEnv
    case "user":
      return t.ctxUser
    case "handoff":
      return t.ctxHandoff
    case "reply":
      return t.ctxReply
    case "thinking":
      return t.ctxThinking
    case "call":
      return t.ctxCall
    case "result":
      return t.ctxResult
  }
}
