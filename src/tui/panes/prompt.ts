/**
 * 权限确认的模态框。
 *
 * ── 为什么必须由合成器来画 ──
 * 全屏模式下往 stdout 直接 write 是致命的:文字会盖穿已经画好的面板,而合成器
 * 的前台缓冲还以为屏幕没变 —— 之后每一帧的差分都对着错的基准算,画面再也回不来。
 * 所以这里只**产出行**,由 app.ts 用 blit 盖上去,和别的面板走同一条路。
 *
 * ── 内容和 --plain 模式共用一份 ──
 * 见 confirm.ts 的 requestLines。两边各写一遍的话,总有一天会出现"两种界面
 * 问的不是同一件事"——那在一个会自己执行 shell 命令的程序里是不能接受的。
 *
 * ── 回车 = 放行一次,Esc / Ctrl-C / Ctrl-D 仍然是拒绝 ──
 * 这条是用户明确要的:批准是常态,每次都去够 `y` 是纯摩擦。代价说清楚 ——
 * 「没明确表态就当同意」这道口子在一个会自己执行 shell 命令的程序里是真实
 * 风险(手快多敲一下回车就放行了),所以走人的那三个键一个都没动,
 * 选项行上的大写也跟着换成 `[Y]`:那个大写就是在告诉用户回车会干什么。
 */
import { optionsLine, requestLines } from "../../cli/confirm.ts"
import type { PromptRequest } from "../../permission/gate.ts"
import { theme } from "../../cli/theme.ts"
import { t } from "../../i18n/index.ts"
import type { Key } from "../../cli/keys.ts"
import type { AskDecision } from "../../tool/types.ts"
import type { NoteTone } from "../chat/board.ts"
import { displayWidth, truncateToWidth, wrapToWidth } from "../../cli/width.ts"

const MAX_WIDTH = 92
const MIN_WIDTH = 30

export interface PromptView {
  lines: string[]
  width: number
  height: number
  /** 还有多少行在框外(用来提示可以往下翻) */
  hidden: number
}

/**
 * 画出模态框。
 *
 * @param scroll 内容滚了多少行 —— write 的预览可能几十行,框塞不下
 */
export function renderPrompt(
  request: PromptRequest,
  scroll: number,
  maxWidth: number,
  maxHeight: number,
): PromptView {
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, maxWidth - 4))
  const inner = width - 4

  const content = requestLines(request).flatMap((line) =>
    displayWidth(line) <= inner ? [line] : wrapToWidth(line, inner),
  )
  const options = optionsLine(request)

  // 边框 2 + 选项行 1 + 选项上面的空行 1
  const room = Math.max(1, maxHeight - 4)
  const from = Math.max(0, Math.min(scroll, Math.max(0, content.length - room)))
  const visible = content.slice(from, from + room)
  const hidden = content.length - visible.length - from

  const bar = theme.yellow("│")
  const body = visible.map((line) => bar + " " + pad(line, inner) + " " + bar)
  const tail =
    hidden > 0 || from > 0
      ? theme.dim(`${from > 0 ? "↑ " : ""}${hidden > 0 ? `↓ ${hidden} more` : ""}  (pgup/pgdn)`)
      : ""

  const lines = [
    theme.yellow("╭" + "─".repeat(width - 2) + "╮"),
    ...body,
    bar + " " + pad(tail, inner) + " " + bar,
    bar + " " + pad(options, inner) + " " + bar,
    theme.yellow("╰" + "─".repeat(width - 2) + "╯"),
  ]
  return { lines, width, height: lines.length, hidden: Math.max(0, hidden) }
}

function pad(text: string, width: number): string {
  const shown = displayWidth(text) > width ? truncateToWidth(text, width) : text
  return shown + " ".repeat(Math.max(0, width - displayWidth(shown)))
}

export type PromptKeyResult =
  | { kind: "decide"; decision: AskDecision }
  | { kind: "scroll"; delta: number }
  | { kind: "ignore" }

/**
 * 按键映射。和 --plain 那套完全一致。
 *
 * 除了明确的 y / a,**其它一切都是拒绝或无视** —— 不要让误触决定文件系统的命运。
 */
export function promptKey(key: Key, forbidAlways: boolean): PromptKeyResult {
  if (key.ctrl && (key.name === "c" || key.name === "d")) return { kind: "decide", decision: "reject" }
  // 回车 = 放行一次。Esc 是走人 —— 「确认」和「算了」必须是两个键
  if (key.name === "enter") return { kind: "decide", decision: "once" }
  if (key.name === "escape") return { kind: "decide", decision: "reject" }
  if (key.name === "pageup") return { kind: "scroll", delta: -5 }
  if (key.name === "pagedown") return { kind: "scroll", delta: 5 }
  if (key.name === "up") return { kind: "scroll", delta: -1 }
  if (key.name === "down") return { kind: "scroll", delta: 1 }
  if (key.ctrl || key.meta || [...key.name].length !== 1) return { kind: "ignore" }

  switch (key.name.toLowerCase()) {
    case "y":
      return { kind: "decide", decision: "once" }
    case "a":
      // 拆句器不确定的时候,连"以后不再问"这个念头都不该给用户
      return forbidAlways ? { kind: "ignore" } : { kind: "decide", decision: "always" }
    case "n":
      return { kind: "decide", decision: "reject" }
    default:
      return { kind: "ignore" }
  }
}

/** 请求的主语:命令原文优先,否则第一个目标。两个视图的收据都从这里取。 */
export function requestSubject(request: PromptRequest): string {
  const metadata = request.metadata ?? {}
  const subject =
    typeof metadata["command"] === "string" ? (metadata["command"] as string) : (request.patterns[0] ?? "")
  return subject.split("\n")[0] ?? ""
}

/** 决定之后往对话里留一行记录 —— 模态框会消失,但"我批准过什么"必须留痕。 */
export function decisionLine(request: PromptRequest, decision: AskDecision): string {
  return (
    theme.yellow(`  ⚠ ${request.permission}`) +
    theme.dim(` ${truncateToWidth(requestSubject(request), 60)} → `) +
    verdictWord(decision)
  )
}

/**
 * 看板上的同一件事。
 *
 * 和 decisionLine 分开只因为**行首的符号归看板管**(它按 tone 上色),
 * 措辞和取值一律共用上面那两个函数 —— 两个视图不能对同一次批准说不同的话。
 */
export function decisionSummary(request: PromptRequest, decision: AskDecision): { text: string; tone: NoteTone } {
  const text =
    theme.dim(`${request.permission} `) + truncateToWidth(requestSubject(request), 44) + theme.dim(" → ") + verdictWord(decision)
  return { text, tone: decision === "reject" ? "bad" : "good" }
}

/** 正在等用户按键的那一行。先占位,按完键原地换成上面那条。 */
export function askSummary(request: PromptRequest): string {
  return (
    theme.dim(`${request.permission} `) +
    truncateToWidth(requestSubject(request), 44) +
    theme.yellow(` — ${t.waitingForYou}`)
  )
}

function verdictWord(decision: AskDecision): string {
  return decision === "once"
    ? theme.green(t.allowedOnce)
    : decision === "always"
      ? theme.cyan(t.allowedAlways)
      : theme.red(t.rejected)
}
