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
 * 风险(手快多敲一下回车就放行了),所以走人的那三个键一个都没动。
 *
 * 选项行上因此把**回车和 esc 写在字母前面**(`[⏎ y]` / `[esc n]`)。它一度靠
 * 大写(`[Y]`)去暗示"回车会选这个",而那是一条**只对已经知道它的人生效**的
 * 约定 —— 最需要知道回车能过的恰恰是 `y` 按不出来的人。见 promptKey 上那段 ⚠。
 */
import { looksLikeIme, optionsLine, requestLines } from "../../cli/confirm.ts"
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
  /**
   * 上一下按键没被认出来时要说的那句话。见 promptKey 的 `hint`。
   *
   * ★ 它顶掉的是翻页提示那一行,不是另开一行。框的高度是算好的,多一行会把
   *   内容挤掉一行;而这两件事的轻重差得很远 —— 一个正卡在"我按了没反应"上的
   *   人,不需要同时知道下面还有三行没看完
   */
  hint?: string,
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
    hint !== undefined
      ? theme.yellow(hint)
      : hidden > 0 || from > 0
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
  /** 认不出来:照旧不做决定,但要在框里说一句怎么按。ime = 那一下是输入法上屏的 */
  | { kind: "hint"; ime: boolean }
  | { kind: "ignore" }

/**
 * 按键映射。和 --plain 那套完全一致。
 *
 * 除了明确的 y / a,**其它一切都是拒绝或无视** —— 不要让误触决定文件系统的命运。
 *
 * ── ⚠ 中日韩输入法开着的时候,`y` 根本到不了这儿 ──
 * 输入法坐在键盘和终端中间:中文/日文输入态下按 `y`,它被当成拼音/ローマ字的
 * 第一个字母吃掉,屏幕上弹出来的是候选词窗口。用户看到的是「我按了 y,冒出个
 * 输入法」—— 而这个程序一个字节都没收到,所以它也无从"处理"这件事。
 *
 * 能做的只有两件,两件都做了:
 *   ① **预防**:选项行上第一个写的就是 `[⏎ y]`,回车排在字母前面。输入法碰不到
 *      回车和 esc(没在拼字的时候),所以那一行给的是一条一定走得通的路。
 *      见 confirm.ts 的 optionsLine。
 *   ② **补救**:候选词上屏之后,那几个汉字/假名会**作为普通字符送到这儿**。
 *      认不出来的键原来是静悄悄地无视 —— 而"按了没反应"正是这件事最难自己
 *      想明白的地方。现在它换成一句话:你的输入法开着,回车能过。
 *
 * ★ 说清这条补救**盖不住哪一半**:用户按 esc 取消候选词窗口时,那一下 esc 被
 *   输入法吃掉,我们同样什么都收不到;他再按一次 esc,到这儿就是一次正常的拒绝。
 *   这一侧不该为此把 esc 弄软 —— 拒绝是安全的那一边,而一个"有时候不拒绝"的
 *   esc 比这个不便严重得多。
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
  // 带修饰符的组合是真的无视(ctrl-x 之类),而**粘贴和多字符的那一路要说话** ——
  // 输入法上屏有时候整段一次性送来
  if (key.ctrl || key.meta) return { kind: "ignore" }
  if (key.name === "paste") return { kind: "hint", ime: looksLikeIme(key) }
  if ([...key.name].length !== 1) return { kind: "ignore" }

  switch (key.name.toLowerCase()) {
    case "y":
      return { kind: "decide", decision: "once" }
    case "a":
      // 拆句器不确定的时候,连"以后不再问"这个念头都不该给用户 —— 选项行上
      // 那一条这时候根本不画。
      //
      // ★ 它和按了个 `z` 走**同一条**回答("这个键在这儿不做事")。这正是这条
      //   规矩要的:两者必须分不出来。给 `a` 一句专门的解释,等于告诉用户
      //   "这个键在别的场合是有用的" —— 那就是那个不该给的念头
      return forbidAlways ? { kind: "hint", ime: false } : { kind: "decide", decision: "always" }
    case "n":
      return { kind: "decide", decision: "reject" }
    default:
      return { kind: "hint", ime: looksLikeIme(key) }
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
