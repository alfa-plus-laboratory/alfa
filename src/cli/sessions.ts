/**
 * 会话挑选界面的**内容**:一行长什么样、按键是什么意思。
 *
 * 两个宿主共用这一份 —— 启动时的 `--resume`(画在底部活动区里)和跑起来之后的
 * `/resume`(画在全屏的浮层里)。宿主只管把行放到屏幕上、把按键喂进来;
 * "哪一行是哪一场会话"这件事只有一个答案,不能两边各写一遍。
 *
 * 这里不认识终端,也不认识 App:给一批会话和一个宽度,返回若干行字符串。
 */
import type { Key } from "./keys.ts"
import type { SessionInfo } from "../session/store.ts"
import { t } from "../i18n/index.ts"
import { theme } from "./theme.ts"
import { displayWidth, padToWidth, truncateToWidth } from "./width.ts"

export interface RowOptions {
  width: number
  selected: boolean
  /** 就是现在这一场。已经在里面了,选它不做事 */
  current?: boolean
  /** 相对时间的基准。传进来而不是现取,一屏之内所有行才是同一个"现在" */
  now: number
}

/**
 * 一场会话一行:`● 2h ago   12 msgs   在重做对话面板…`
 *
 * 一行而不是两行,是因为这个界面是用来**扫**的:十场会话里认出那一场靠的是
 * 时间和第一句话,而不是通读。摘要读全文有 `/summary`。
 */
export function sessionRow(info: SessionInfo, options: RowOptions): string {
  const { width } = options
  const mark = options.current ? theme.green("●") : " "
  // 两列都定宽:时间和条数在各行之间要对得齐,不然眼睛得逐行找那两个数字。
  // 宽度按最长的取值配(en 的 "just now" 8 列、"999 msgs" 8 列),多的空格
  // 全留给正文
  const when = padToWidth(relativeTime(info.timeUpdated, options.now), 9)
  const count = padToWidth(t.sessionMessages(info.messages), 8)
  const head = ` ${mark} ${theme.dim(when)} ${theme.dim(count)} `
  const room = Math.max(4, width - displayWidth(head))
  const line = head + truncateToWidth(sessionLabel(info), room)
  // 选中整行反白:窄屏上只把文字反白的话,一行里会有两块背景色,看着像画坏了
  return options.selected ? theme.inverse(padToWidth(line, width)) : line
}

/** 这场会话该怎么称呼。摘要 > 第一句提问 > 认了它没名字。 */
export function sessionLabel(info: SessionInfo): string {
  const summary = firstLine(info.summary)
  if (summary.length > 0) return summary
  const preview = firstLine(info.preview)
  if (preview.length > 0) return preview
  return theme.dim(t.sessionUntitled)
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? ""
}

/**
 * 「多久以前」。
 *
 * 一周以内用相对时间(人对"两小时前"有感觉,对时间戳没有),再往前用日期 ——
 * "23 天前"要在脑子里减一次,而 `07-14` 直接就是那天。日期不翻译:数字在
 * 哪种语言里都是数字,翻出来的月份名反而占地方。
 */
export function relativeTime(then: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1000))
  if (seconds < 60) return t.agoNow
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t.agoMinutes(minutes)
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t.agoHours(hours)
  const days = Math.floor(hours / 24)
  if (days < 7) return t.agoDays(days)
  const date = new Date(then)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

export interface ListOptions {
  selected: number
  width: number
  /** 列表最多占几行(不含标题和键位那两行)。超了就滚 */
  height: number
  now: number
  /** 已经在里面的那一场,画一个 ● */
  currentID?: string
  /** 自带标题行。全屏那边标题写在浮层边框上,就不要这一行了 */
  title?: boolean
}

/**
 * 整个列表:标题 + 若干行会话 + 键位提示。
 *
 * 标题和键位提示都留着,不因为窄就省:这个界面一年也打不开几次,
 * 没有"用熟了就不看提示"这回事,而按错一次的代价是接到别的会话上。
 */
export function renderList(sessions: SessionInfo[], options: ListOptions): string[] {
  const { width, height } = options
  const lines = options.title === false ? [] : [theme.bold(` ${t.resumeTitle}`)]
  if (sessions.length === 0) {
    lines.push(theme.dim(`  ${t.resumeEmpty}`))
    return lines.map((line) => truncateToWidth(line, width))
  }

  // 选中项永远在视野里。列表短的时候 scroll 恒为 0
  const room = Math.max(1, height)
  const scroll = Math.max(0, Math.min(options.selected - room + 1, sessions.length - room))
  for (const [index, info] of sessions.slice(Math.max(0, scroll), Math.max(0, scroll) + room).entries()) {
    const at = Math.max(0, scroll) + index
    lines.push(
      sessionRow(info, {
        width,
        selected: at === options.selected,
        now: options.now,
        ...(info.id === options.currentID ? { current: true } : {}),
      }),
    )
  }
  // 截掉的那些要说出来,否则「就这几场」和「上面还有」在屏幕上长得一样
  const hidden = sessions.length - room
  if (hidden > 0) lines.push(theme.dim(`  +${hidden}`))
  lines.push(theme.dim(`  ${t.resumeKeys}`))
  return lines.map((line) => truncateToWidth(line, width))
}

export type PickResult =
  | { kind: "move"; delta: number }
  | { kind: "accept" }
  | { kind: "cancel" }
  | { kind: "pass" }

/**
 * 挑选界面的按键。
 *
 * **默认是取消**:Ctrl-C、Ctrl-D、esc、q 都是走人。恢复会话本身不危险,但
 * "我只是想看看有哪些"才是打开它最常见的理由 —— 退出的路必须比确认的路多。
 */
export function pickKey(key: Key): PickResult {
  if (key.ctrl && (key.name === "c" || key.name === "d")) return { kind: "cancel" }
  switch (key.name) {
    case "up":
      return { kind: "move", delta: -1 }
    case "down":
      return { kind: "move", delta: 1 }
    case "pageup":
      return { kind: "move", delta: -5 }
    case "pagedown":
      return { kind: "move", delta: 5 }
    case "enter":
      return { kind: "accept" }
    case "escape":
    case "q":
      return { kind: "cancel" }
    default:
      return { kind: "pass" }
  }
}
