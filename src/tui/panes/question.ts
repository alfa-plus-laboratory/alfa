/**
 * 「它问你一句」的模态框。
 *
 * ── 为什么和权限框长得像但不是同一个 ──
 * 两者都是"停下来等人",所以共用同一个模态队列、同一套画法(见 app.ts)。
 * 但框的颜色和口气刻意不同:权限框是黄的、写着 ⚠,它在拦一件**你没答应过**
 * 的事;这个是青的、写着 ?,它在问一件**只有你知道答案**的事。用同一种颜色的话,
 * 用户会用对待权限框的那种警觉(和肌肉记忆里的回车)来对付一个普通问题 ——
 * 而那个回车在这里会选中第一个选项。
 *
 * ── 内容和 --plain 共用一份 ──
 * 见 cli/ask.ts 的 QuestionState:选项怎么标号、按键什么意思、提示行写什么,
 * 全在那边。这里只负责把它出的行摆进一个框里,并由 app.ts 用 blit 盖上去 ——
 * 全屏下直接往 stdout 写会盖穿合成器画好的画面,而且差分的基准会永久失准。
 */
import type { QuestionState } from "../../cli/ask.ts"
import { theme } from "../../cli/theme.ts"
import { displayWidth, truncateToWidth } from "../../cli/width.ts"
import { t } from "../../i18n/index.ts"
import type { Answer, Question } from "../../tool/types.ts"
import type { NoteTone } from "../chat/board.ts"

const MAX_WIDTH = 92
const MIN_WIDTH = 30

export interface QuestionView {
  lines: string[]
  width: number
  height: number
  /** 还有多少行在框外(选项多、说明长的时候框塞不下) */
  hidden: number
}

export function renderQuestion(
  state: QuestionState,
  scroll: number,
  maxWidth: number,
  maxHeight: number,
): QuestionView {
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, maxWidth - 4))
  const inner = width - 4

  const content = state.lines(inner)
  // 边框 2 行 + 翻页提示 1 行
  const room = Math.max(1, maxHeight - 3)
  const from = Math.max(0, Math.min(scroll, Math.max(0, content.length - room)))
  const visible = content.slice(from, from + room)
  const hidden = content.length - visible.length - from

  const bar = theme.cyan("│")
  const body = visible.map((line) => bar + " " + pad(line, inner) + " " + bar)
  const tail =
    hidden > 0 || from > 0
      ? theme.dim(`${from > 0 ? "↑ " : ""}${hidden > 0 ? `↓ ${hidden} more` : ""}  (pgup/pgdn)`)
      : ""

  const lines = [
    theme.cyan("╭" + "─".repeat(width - 2) + "╮"),
    ...body,
    bar + " " + pad(tail, inner) + " " + bar,
    theme.cyan("╰" + "─".repeat(width - 2) + "╯"),
  ]
  return { lines, width, height: lines.length, hidden: Math.max(0, hidden) }
}

function pad(text: string, width: number): string {
  const shown = displayWidth(text) > width ? truncateToWidth(text, width) : text
  return shown + " ".repeat(Math.max(0, width - displayWidth(shown)))
}

/**
 * 正在等用户回答的那一行。先占位,答完原地换成下面那条。
 *
 * 和权限那边同一条理由:排在队里的提问也要**立刻**在看板上占一行,否则用户
 * 看到的是一个莫名其妙不动了的 agent。
 */
export function askingSummary(question: Question): string {
  return theme.cyan("? ") + truncateToWidth(question.question, 44) + theme.yellow(` — ${t.waitingForYou}`)
}

/** 答完在对话里留的那一行。框会消失,而"我当时选了什么"必须留得住 */
export function answerLine(question: Question, answer: Answer): string {
  return (
    theme.cyan(`  ? `) +
    theme.dim(`${truncateToWidth(question.question, 60)} → `) +
    answerWord(answer)
  )
}

/** 看板上的同一件事。行首的记号归看板管,所以这里只出文字和语气 */
export function answerSummary(question: Question, answer: Answer): { text: string; tone: NoteTone } {
  const text = theme.dim(truncateToWidth(question.question, 44) + " → ") + answerWord(answer)
  return { text, tone: answer.kind === "picked" || answer.kind === "typed" ? "good" : "info" }
}

function answerWord(answer: Answer): string {
  switch (answer.kind) {
    case "picked":
      return theme.green(truncateToWidth(answer.choices.join(", "), 40))
    case "typed":
      return theme.cyan(truncateToWidth(answer.text, 40))
    case "cancelled":
      return theme.dim(t.askDismissed)
    case "unavailable":
      return theme.dim(t.askNobody)
    // 回上一题不是一个答案,走不到这条收据上(见 tui/app.ts 的 answered) ——
    // 写一句是为了这个 switch 保持穷尽:哪天 Answer 多一档,这里会编译不过
    case "back":
      return theme.dim(t.askHintBack)
  }
}
