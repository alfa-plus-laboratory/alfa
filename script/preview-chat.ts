/**
 * 把 session 视图画出来看一眼。开发用,不进构建。
 *
 *   bun run script/preview-chat.ts [zh|en|ja] [宽] [高]
 *
 * 存在的理由:行数对不对可以单测,**好不好看不行**。这一栏的失败方式多半是
 * 「每一条断言都过了,但人看着累」——那种问题只能靠眼睛。
 */
import { ChatModel } from "../src/tui/chat/model.ts"
import { ChatPane } from "../src/tui/panes/chat.ts"
import { Transcript } from "../src/tui/transcript.ts"
import { setInterfaceLanguage, type Language } from "../src/i18n/index.ts"
import { displayWidth, stripAnsi } from "../src/cli/width.ts"
import type { ToolPart } from "../src/session/schema.ts"

const [langArg, widthArg, heightArg] = process.argv.slice(2)
setInterfaceLanguage((langArg as Language) ?? "zh")
const width = Number(widthArg ?? 48)
const height = Number(heightArg ?? 26)

const model = new ChatModel({ root: process.cwd() })
const transcript = new Transcript()
const chat = new ChatPane({ model, transcript, view: "session", line: (text) => transcript.push(text) })

const text = { id: "t1", sessionID: "s", messageID: "m", timeCreated: 0, type: "text", text: "" } as const
const tool = (id: string, name: string, state: ToolPart["state"]): ToolPart => ({
  id, sessionID: "s", messageID: "m", timeCreated: 0, type: "tool", callID: id, tool: name, state,
})

model.setSummary(
  "这一段在重做全屏的对话面板。你否掉了瀑布流和按轮索引,定成三段式,历程那段由每轮结束后的 agent 滚动重写。目前面板和摘要 agent 都已落盘,测试全绿,还没在真机上跑过。",
)
chat.said("再帮我把工具看板的对齐调一下,右边的结果列要对齐")
// 真实流程里 beginTurn 由 runTurn 调(三种运行形态共用的那一处)
model.beginTurn("再帮我把工具看板的对齐调一下,右边的结果列要对齐")

model.handle({
  type: "tool.state",
  part: tool("p0", "todo", {
    status: "completed",
    input: {},
    output: "plan",
    metadata: {
      todos: [
        { text: "读一遍 renderBoard 现在怎么排", status: "done" },
        { text: "把结果列改成右对齐", status: "active" },
        { text: "补一条不超宽的断言", status: "pending" },
        { text: "跑一遍 chat.test.ts", status: "pending" },
      ],
    },
    time: { start: 0, end: 3 },
  }),
})

model.handle({ type: "part.start", part: text })
model.handle({
  type: "part.delta",
  part: text,
  delta: "我先看一下 `renderBoard` 现在怎么排的。右边那列现在是**按剩余宽度顶过去**的,\n所以目标一长就把结果挤走了。\n",
})
model.handle({
  type: "tool.state",
  part: tool("p1", "read", { status: "completed", input: { filePath: "src/tui/chat/board.ts" }, output: "", metadata: { lines: 142 }, time: { start: 0, end: 40 } }),
})
model.handle({
  type: "tool.state",
  part: tool("p2", "edit", { status: "completed", input: { filePath: "src/tui/chat/board.ts" }, output: "", metadata: { additions: 6, deletions: 2, diff: "Index: src/tui/chat/board.ts\n@@ -88,3 +88,4 @@\n-  const gap = 1\n+  const gap = Math.max(1, width - fixed)\n" }, time: { start: 41, end: 90 } }),
})
model.handle({
  type: "tool.state",
  part: tool("p3", "bash", { status: "running", input: { command: "bun test test/chat.test.ts" }, time: { start: Date.now() - 2_400 } }),
})

const paint = (label: string, lines: string[]) => {
  const bar = "─".repeat(width)
  process.stdout.write(`\n${label}\n╭${bar}╮\n`)
  for (const line of lines) process.stdout.write(`│${line}${" ".repeat(Math.max(0, width - displayWidth(stripAnsi(line))))}│\n`)
  process.stdout.write(`╰${bar}╯\n`)
}

paint("── session ──", chat.render({ width, height, busy: true, spinner: "⠹", detailVisible: true }))
paint("── session · 右栏收起(diff 就地展开)──", chat.render({ width, height, busy: true, spinner: "⠹", detailVisible: false }))
paint("── session · 窄且矮 ──", chat.render({ width, height: 10, busy: true, spinner: "⠹", detailVisible: true }))
// 还没开口的那一段:大空地里应该有一个带秒数的转圈
const waiting = new ChatModel({ root: process.cwd() })
const waitingChat = new ChatPane({ model: waiting, transcript: new Transcript(), view: "session", line: () => {} })
waiting.setSummary("你在重做对话面板,三段式已经定下来了。")
waiting.beginTurn("再帮我把工具看板的对齐调一下")
waiting.handle({ type: "part.start", part: { id: "r1", sessionID: "s", messageID: "m", timeCreated: 0, type: "reasoning", text: "" } })
waiting.handle({
  type: "part.delta",
  part: { id: "r1", sessionID: "s", messageID: "m", timeCreated: 0, type: "reasoning", text: "" },
  delta: "先确认 renderRow 里右边那列是怎么算宽度的,再决定要不要把它改成右对齐",
})
paint("── session · 还在思考(没开口)──", waitingChat.render({ width, height: 14, busy: true, spinner: "⠹", detailVisible: true }))

chat.setView("stream")
paint("── stream ──", chat.render({ width, height, busy: false, spinner: "", detailVisible: true }))
