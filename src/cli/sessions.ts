/**
 * The session list only handles content and key mapping, so that --resume and /resume
 * get the same selection. Column widths are passed in by the host; CJK titles or a
 * narrow window must not change session numbering.
 */
import type { Key } from "./keys.ts"
import type { SessionInfo } from "../session/store.ts"
import { t } from "../i18n/index.ts"
import { theme } from "./theme.ts"
import { displayWidth, padToWidth, truncateToWidth } from "./width.ts"

export interface RowOptions {
  width: number
  selected: boolean
  /** It's the current session. Already inside it, so selecting it does nothing */
  current?: boolean
  /**
   * Base for relative times. Passed in rather than read on the spot, so all rows on one
   * screen share the same "now"
   */
  now: number
}

/**
 * One row per session: `● 2h ago   12 msgs   reworking the chat panel…`
 *
 * One row rather than two, because this screen is for **scanning**: picking out the one
 * session among ten relies on the time and the first sentence, not on reading through.
 */
export function sessionRow(info: SessionInfo, options: RowOptions): string {
  const { width } = options
  const mark = options.current ? theme.green("●") : " "
  // Both columns are fixed-width: time and count must line up across rows, or the eye
  // has to hunt for those two numbers row by row. Widths are sized for the longest value
  // (en's "just now" is 8 columns, "999 msgs" 8 columns); all spare space goes to the
  // body text
  const when = padToWidth(relativeTime(info.timeUpdated, options.now), 9)
  const count = padToWidth(t.sessionMessages(info.messages), 8)
  const head = ` ${mark} ${theme.dim(when)} ${theme.dim(count)} `
  const room = Math.max(4, width - displayWidth(head))
  const line = head + truncateToWidth(sessionLabel(info), room)
  // Invert the whole selected row: on a narrow screen, inverting only the text leaves
  // two blocks of background color in one row, which looks like a rendering bug
  return options.selected ? theme.selection(padToWidth(line, width)) : line
}

/** What to call this session. Fixed initial-request title, then first question, then an unnamed fallback. */
export function sessionLabel(info: SessionInfo): string {
  const title = firstLine(info.title)
  if (title.length > 0) return title
  const preview = firstLine(info.preview)
  if (preview.length > 0) return preview
  return theme.dim(t.sessionUntitled)
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? ""
}

/**
 * "How long ago".
 *
 * Within a week, relative time (people have a feel for "two hours ago", not for
 * timestamps); beyond that, a date — "23 days ago" needs a subtraction in your head,
 * while `07-14` simply is that day. Dates aren't translated: digits are digits in any
 * language, and translated month names just take up space.
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
  /** Max rows for the list (title and key-hint lines excluded). Scrolls past that */
  height: number
  now: number
  /** The session we're already in; drawn with a ● */
  currentID?: string
}

/**
 * The whole list: title + session rows + key hints.
 *
 * Both the title and the key hints stay, not dropped just because it's narrow: this
 * screen gets opened only a few times a year, so there's no "once you're used to it you
 * stop reading the hints", and one wrong keypress costs you attaching to a different
 * session.
 */
export function renderList(sessions: SessionInfo[], options: ListOptions): string[] {
  const { width, height } = options
  const lines = [theme.bold(` ${t.resumeTitle}`)]
  if (sessions.length === 0) {
    lines.push(theme.dim(`  ${t.resumeEmpty}`))
    return lines.map((line) => truncateToWidth(line, width))
  }

  // The selected item is always in view. When the list is short, scroll is always 0
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
  // Say what was cut off, or "these are all of them" and "there are more above" look
  // the same on screen
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
 * Keys for the picker.
 *
 * **The default is cancel**: Ctrl-C, Ctrl-D, esc and q all leave. Resuming a session
 * isn't dangerous in itself, but "I just want to see what's there" is the most common
 * reason to open it — there must be more ways out than ways to confirm.
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
