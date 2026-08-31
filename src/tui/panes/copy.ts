/**
 * 「复制什么」那张单子。
 *
 * ── 为什么不是一个直接复制的快捷键 ──
 * 「复制」在这个界面里从来不是一件事。写代码的人最常复制的是**回答里那段
 * 代码**,其次才是整段回答;偶尔还要把自己刚才那句话再拿出来。一个键只能
 * 绑定其中一件,而剩下两件就回到了"用鼠标在三栏边框中间小心地拖"。
 *
 * ── 为什么不是终端原生拖选 ──
 * 全屏界面抓着鼠标,拖选被顶掉了(Shift 能绕过去,但那是一条得先知道才用得上
 * 的路)。就算拖到了,拖出来的也是**屏幕上的样子**:每行左右带着竖线、折过行、
 * 中间夹着旁边那一栏的字。而人要的是那段话本身。
 *
 * 所以这里给的是**逻辑内容**:从会话库里取原文,不带边框、不带折行、不带颜色。
 *
 * ── 顺序就是常用度 ──
 * 代码块排在整段回答**前面**。回答里有代码块的时候,要的十有八九是代码;
 * 没有代码块时这一段自然就不出现,第一行还是整段回答。
 */
import type { Key } from "../../cli/keys.ts"
import { t } from "../../i18n/index.ts"
import { theme } from "../../cli/theme.ts"
import { displayWidth, padToWidth, truncateToWidth } from "../../cli/width.ts"
import type { MessageWithParts } from "../../session/schema.ts"

export type CopyKind = "code" | "reply" | "prompt" | "session"

export interface CopyTarget {
  kind: CopyKind
  /** 左边那一列:这是什么 */
  label: string
  /** 中间那一列:哪一段。代码块给语言 + 首行,回答给首行 */
  hint: string
  /** 真正要发出去的字 */
  text: string
}

/** 最多列几个代码块。再多就不是"挑一个"而是"再翻一遍",那件事 `/view stream` 更合适 */
const MAX_CODE_BLOCKS = 6

/**
 * 从会话历史里算出可复制的那几样。
 *
 * ★ 取的是**最后一条有正文的 assistant 消息**,不是最后一条 assistant 消息。
 *   一轮里模型常常先说一句"我看一下"、调几个工具、再给结论,而中间那些
 *   只调工具不说话的消息在库里也是 assistant —— 取到它就是复制了一段空的。
 */
export function copyTargets(history: MessageWithParts[]): CopyTarget[] {
  const reply = lastText(history, "assistant")
  const prompt = lastText(history, "user")
  const out: CopyTarget[] = []

  for (const block of codeBlocks(reply).slice(0, MAX_CODE_BLOCKS)) {
    out.push({ kind: "code", label: block.language || t.copyCode, hint: firstLine(block.code), text: block.code })
  }
  if (reply.length > 0) out.push({ kind: "reply", label: t.copyReply, hint: firstLine(reply), text: reply })
  if (prompt.length > 0) out.push({ kind: "prompt", label: t.copyPrompt, hint: firstLine(prompt), text: prompt })

  const whole = transcriptText(history)
  if (whole.length > 0) out.push({ kind: "session", label: t.copySession, hint: t.copySessionHint, text: whole })
  return out
}

/**
 * 一整场对话,拍成纯文本。
 *
 * 只要人说的和模型说的两种。工具调用不进去:一份贴给同事看的记录里,
 * 三十行 `● read src/foo.ts` 会把真正的对话淹掉,而那些细节在库里一直都在。
 */
function transcriptText(history: MessageWithParts[]): string {
  const out: string[] = []
  for (const entry of history) {
    const role = entry.info.role
    if (role !== "user" && role !== "assistant") continue
    const text = textOf(entry)
    if (text.length === 0) continue
    out.push(`${role === "user" ? "> " : ""}${text.split("\n").join(role === "user" ? "\n> " : "\n")}`)
  }
  return out.join("\n\n")
}

function lastText(history: MessageWithParts[], role: "user" | "assistant"): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!
    if (entry.info.role !== role) continue
    const text = textOf(entry)
    if (text.length > 0) return text
  }
  return ""
}

/**
 * 一条消息的正文。
 *
 * ⚠ `synthetic` 的**必须跳过**。那些是程序自己塞进历史的东西(环境块、收口前
 *   的提醒、子 agent 的报告),用户从来没在屏幕上见过它们 —— 把它们复制出去
 *   等于交给他一段他不认识的文字,而他会以为那是模型说的。
 */
function textOf(entry: MessageWithParts): string {
  return entry.parts
    .filter((part) => part.type === "text" && part.synthetic !== true)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim()
}

export interface CodeBlock {
  language: string
  code: string
}

/**
 * 揪出 ``` 围起来的段落。
 *
 * 只认围栏式,不认缩进式:缩进四格的代码块和一段缩进的列表项在字符上没有
 * 区别,而认错的代价是单子里出现一条"代码"、点开是半句话。
 */
export function codeBlocks(markdown: string): CodeBlock[] {
  const out: CodeBlock[] = []
  const lines = markdown.split("\n")
  let fence: { marker: string; language: string; body: string[] } | undefined

  for (const line of lines) {
    const open = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/.exec(line)
    if (!fence) {
      // 语言那一格可以是空的 —— 多数人写 ``` 就完了
      if (open) fence = { marker: open[1]!.slice(0, 3), language: open[2] ?? "", body: [] }
      continue
    }
    // 收口只认**同一种**围栏字符。``` 里面嵌 ~~~ 是真实写法(在 markdown 里
    // 展示 markdown),按任意围栏收口的话那种块会被从中间截断
    if (open && open[1]!.startsWith(fence.marker)) {
      const code = fence.body.join("\n").trim()
      if (code.length > 0) out.push({ language: fence.language, code })
      fence = undefined
      continue
    }
    fence.body.push(line)
  }
  return out
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? ""
}

/** 人看得懂的字节数。`1.2 kB` 比 `1234 B` 好扫 */
export function humanBytes(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8")
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} kB`
}

const MARKS: Record<CopyKind, string> = { code: "⧉", reply: "◆", prompt: "▌", session: "≡" }

/** 一行:`⧉ ts        export function foo(…        420 B` */
export function copyRow(target: CopyTarget, options: { width: number; selected: boolean }): string {
  const size = humanBytes(target.text)
  const head = ` ${MARKS[target.kind]} ${padToWidth(truncateToWidth(target.label, 10), 10)} `
  // 大小定宽靠右:各行的数字要对得齐,不然眼睛得逐行去找它
  const tail = ` ${padToWidth(size, 7)}`
  const room = Math.max(4, options.width - displayWidth(head) - displayWidth(tail))
  const line = head + padToWidth(truncateToWidth(target.hint, room), room) + theme.dim(tail)
  return options.selected ? theme.inverse(padToWidth(stripForInverse(line), options.width)) : line
}

/**
 * 反白整行之前先把里面的颜色去掉。
 *
 * 不去的话,行尾那个 dim 的关闭码会把反白一起关掉 —— 现象是选中行的右边
 * 一截没有底色,看起来像画到一半断了。
 */
function stripForInverse(line: string): string {
  return line.replaceAll(/\u001b\[[0-9;]*m/g, "")
}

export type CopyKeyResult =
  | { kind: "move"; delta: number }
  | { kind: "accept" }
  | { kind: "cancel" }
  | { kind: "pass" }

export function copyKey(key: Key): CopyKeyResult {
  if (key.ctrl && (key.name === "c" || key.name === "d")) return { kind: "cancel" }
  // ctrl-y 再按一次就关掉。开它的键和关它的键是同一个,这是这一类浮层的常规
  if (key.ctrl && key.name === "y") return { kind: "cancel" }
  switch (key.name) {
    case "up":
      return { kind: "move", delta: -1 }
    case "down":
      return { kind: "move", delta: 1 }
    case "enter":
      return { kind: "accept" }
    case "escape":
    case "q":
      return { kind: "cancel" }
    default:
      return { kind: "pass" }
  }
}
