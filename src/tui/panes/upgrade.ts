/**
 * 升级浮层的内容。
 *
 * ── 为什么升级要独占一个窗口 ──
 * 它和别的命令不是一类东西:九十多兆要下几分钟,中途还会**把用户手上这个程序
 * 换掉**。原来它只是往对话里写几行进度,而对话本来就一直在滚 —— 用户报的原话是
 * 「我不仔细看还不知道在 downloading」。一件要等几分钟、还会改磁盘的事,不该
 * 长得跟一条普通回执一样。
 *
 * 所以:一个盖在最上面的框,独占按键(esc 取消),下完之前别的什么都干不了。
 * 这不是为了拦着用户,是因为**这几分钟里他做的任何事都建立在"程序马上要被
 * 换掉"这个前提上**——发一句话给模型,答到一半二进制没了,那才是真的怪。
 *
 * ── 纯函数 ──
 * 这里不认识终端也不认识 App:给一份状态,返回要画的几行。进度条的算术和
 * 单位换算全在这儿,所以它们是能被测的。
 */
import { t } from "../../i18n/index.ts"
import { theme } from "../../cli/theme.ts"

export interface UpgradeState {
  /** 手上这个版本 */
  from: string
  /** 查到的新版本。还没查到就没有 */
  to?: string
  phase: "checking" | "downloading" | "verifying" | "installing" | "done" | "failed" | "cancelled" | "current"
  received?: number
  total?: number
  /** done 时是新版本号,failed 时是原因 */
  detail?: string
}

/** 进度条内部的宽度下限。再窄就别画了,画出来也读不出比例 */
const MIN_BAR = 10

export function renderUpgrade(state: UpgradeState, width: number): string[] {
  const lines: string[] = []
  const inner = Math.max(MIN_BAR, width)

  lines.push(theme.dim(`  ${t.upgradeFrom(state.from)}${state.to ? ` → ${theme.bold(state.to)}` : ""}`))
  lines.push("")
  lines.push(`  ${statusLine(state)}`)

  if (state.phase === "downloading") {
    lines.push("")
    lines.push(`  ${bar(state, inner - 4)}`)
  }

  lines.push("")
  lines.push(theme.dim(`  ${hint(state)}`))
  return lines
}

function statusLine(state: UpgradeState): string {
  switch (state.phase) {
    case "checking":
      return t.upgradeChecking
    case "downloading":
      return t.upgradeDownloadingNow
    case "verifying":
      return t.upgradeVerifying
    case "installing":
      return t.upgradeInstalling
    case "current":
      return theme.green(t.upgradeCurrent(state.from))
    case "done":
      return theme.green(t.upgradeDone(state.from, state.detail ?? "?"))
    case "cancelled":
      return theme.yellow(t.upgradeCancelled)
    case "failed":
      return theme.red(t.upgradeFailed(state.detail ?? "?"))
  }
}

/** 结束了的三档不再提 esc —— 那时候按什么都是"关掉它" */
function hint(state: UpgradeState): string {
  const over = state.phase === "done" || state.phase === "failed" || state.phase === "cancelled" || state.phase === "current"
  return over ? t.upgradeClose : t.upgradeCancelHint
}

/**
 * 进度条。
 *
 * 拿不到 Content-Length 时**不画一个假的条** —— 一个永远停在同一格的进度条比
 * 没有进度条更让人以为卡住了。那时候只报已经下了多少,那至少是个在动的数。
 */
function bar(state: UpgradeState, width: number): string {
  const received = state.received ?? 0
  if (!state.total || state.total <= 0) return theme.dim(megabytes(received))

  const ratio = Math.max(0, Math.min(1, received / state.total))
  const label = `${String(Math.round(ratio * 100)).padStart(3)}%  ${megabytes(received)} / ${megabytes(state.total)}`
  const barWidth = Math.max(MIN_BAR, width - label.length - 2)
  const filled = Math.round(ratio * barWidth)
  return `${theme.green("█".repeat(filled))}${theme.dim("░".repeat(Math.max(0, barWidth - filled)))}  ${theme.dim(label)}`
}

/** 兆字节,一位小数。字节数在这个尺度上没人读得出大小 */
function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)}MB`
}
