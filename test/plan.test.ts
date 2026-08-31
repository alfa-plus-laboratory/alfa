/**
 * 计划:工具、清单的收拾、开窗,以及它在两个视图里的样子。
 */
import { describe, expect, test } from "bun:test"
import { planProgress, planRows, planWindow } from "../src/cli/plan.ts"
import { Renderer } from "../src/cli/render.ts"
import { setColorEnabled } from "../src/cli/theme.ts"
import { stripAnsi } from "../src/cli/width.ts"
import { restoreLastTurn } from "../src/cli/replay.ts"
import type { MessageWithParts, ToolPart } from "../src/session/schema.ts"
import { parseTodos, TodoTool, type TodoItem } from "../src/tool/todo.ts"
import type { ToolContext } from "../src/tool/types.ts"
import { ChatModel } from "../src/tui/chat/model.ts"
import { ChatPane } from "../src/tui/panes/chat.ts"
import { Transcript } from "../src/tui/transcript.ts"

setColorEnabled(false)

function ctx(): ToolContext {
  return {
    cwd: process.cwd(),
    root: process.cwd(),
    sessionID: "s",
    messageID: "m",
    callID: "c",
    abortSignal: new AbortController().signal,
    ask: async () => {},
    onProgress: () => {},
    metadata: () => {},
  }
}

const items = (...text: string[]): TodoItem[] => text.map((one) => ({ text: one, status: "pending" as const }))

describe("todo 工具", () => {
  test("输出第一行是给看板看的进度", async () => {
    const result = await TodoTool.execute(
      {
        items: [
          { text: "读一遍渲染器", status: "done" },
          { text: "把滚动条拆出去", status: "active" },
          { text: "补测试", status: "pending" },
        ],
      },
      ctx(),
    )
    expect(result.output.split("\n")[0]).toBe("plan: 1/3 done · now: 把滚动条拆出去")
    expect(result.title).toBe("1/3")
    expect(result.metadata["todos"]).toHaveLength(3)
  })

  test("★ 第二个 active 降级成 pending —— 报错只会白跑一次调用", async () => {
    const result = await TodoTool.execute(
      {
        items: [
          { text: "一", status: "active" },
          { text: "二", status: "active" },
        ],
      },
      ctx(),
    )
    const todos = result.metadata["todos"] as TodoItem[]
    expect(todos.map((one) => one.status)).toEqual(["active", "pending"])
  })

  test("★ in_progress / completed 照收 —— 模型会和别家工具记混,报错只是白跑一轮", () => {
    const parsed = TodoTool.parameters.safeParse({
      items: [
        { text: "一", status: "in_progress" },
        { text: "二", status: "completed" },
        { text: "三", status: "pending" },
      ],
    })
    expect(parsed.success).toBe(true)
    // 落库和界面上只会出现规范值
    expect(parsed.data?.items.map((one: { status: string }) => one.status)).toEqual(["active", "done", "pending"])
  })

  test("认不出来的还是要报错 —— 认别名不等于什么都收", () => {
    expect(TodoTool.parameters.safeParse({ items: [{ text: "一", status: "blocked" }] }).success).toBe(false)
  })

  test("空清单是错误 —— 「计划没了」和「没写过计划」得分得开", async () => {
    await expect(TodoTool.execute({ items: [] }, ctx())).rejects.toThrow(/items is required/)
  })

  test("空白项跳过,超长的截断", async () => {
    const result = await TodoTool.execute(
      { items: [{ text: "   ", status: "pending" }, { text: "x".repeat(200), status: "pending" }] },
      ctx(),
    )
    const todos = result.metadata["todos"] as TodoItem[]
    expect(todos).toHaveLength(1)
    expect(todos[0]!.text).toHaveLength(120)
  })

  test("parseTodos 挡掉不认识的状态", () => {
    expect(parseTodos([{ text: "a", status: "done" }, { text: "b", status: "??" }, { text: "", status: "done" }])).toEqual([
      { text: "a", status: "done" },
    ])
    expect(parseTodos(undefined)).toEqual([])
    expect(parseTodos("nope")).toEqual([])
  })
})

describe("清单的行", () => {
  test("三种状态三个形状 —— 单色终端上也分得出", () => {
    const rows = planRows(
      [
        { text: "做完了", status: "done" },
        { text: "在做", status: "active" },
        { text: "没做", status: "pending" },
      ],
      40,
    ).map(stripAnsi)
    expect(rows[0]).toContain("✓")
    expect(rows[1]).toContain("▸")
    expect(rows[2]).toContain("○")
  })

  test("进度按状态数,不按顺序猜", () => {
    expect(
      planProgress([
        { text: "a", status: "done" },
        { text: "b", status: "pending" },
        { text: "c", status: "active" },
      ]),
    ).toEqual({ done: 1, total: 3, active: "c" })
  })

  test("★ 装不下时以进行中那条为中心开窗", () => {
    const list: TodoItem[] = [
      ...items("一", "二", "三"),
      { text: "四", status: "active" },
      ...items("五", "六"),
    ]
    const { shown, hidden } = planWindow(list, 3)
    // 上面留一条当锚点,后面全给还没发生的事
    expect(shown.map((one) => one.text)).toEqual(["三", "四", "五"])
    expect(hidden).toBe(3)
  })

  test("放得下就全给", () => {
    expect(planWindow(items("一", "二"), 5).shown).toHaveLength(2)
    expect(planWindow(items("一", "二"), 5).hidden).toBe(0)
  })

  test("没有进行中的那条就从头看", () => {
    expect(planWindow(items("一", "二", "三"), 2).shown.map((one) => one.text)).toEqual(["一", "二"])
  })
})

// ─────────────────────────────────────────────────────── 两个视图

function tool(state: ToolPart["state"], name = "todo"): ToolPart {
  return { id: "p1", sessionID: "s", messageID: "m", timeCreated: 0, type: "tool", callID: "p1", tool: name, state }
}

function done(todos: TodoItem[]): ToolPart {
  return tool({ status: "completed", input: {}, output: "plan", metadata: { todos }, time: { start: 0, end: 1 } })
}

describe("session 视图", () => {
  function pane() {
    const model = new ChatModel({ root: process.cwd() })
    const transcript = new Transcript()
    const chat = new ChatPane({ model, transcript, view: "session", line: (text) => transcript.push(text) })
    return { model, chat }
  }

  test("★ 计划跨轮次活着 —— 它讲的是整段活儿,不是这一轮", () => {
    const { model } = pane()
    model.handle({ type: "tool.state", part: done([{ text: "改渲染器", status: "active" }]) })
    model.beginTurn("下一句")
    expect(model.plan).toHaveLength(1)
  })

  test("★ 整份覆盖,不合并 —— 删掉的那条必须消失", () => {
    const { model } = pane()
    model.handle({ type: "tool.state", part: done(items("一", "二", "三")) })
    model.handle({ type: "tool.state", part: done(items("一")) })
    expect(model.plan.map((one) => one.text)).toEqual(["一"])
  })

  test("★ /clear 和换会话都要清掉 —— 上一场的计划不能挂在这一场头上", () => {
    const { model } = pane()
    model.handle({ type: "tool.state", part: done(items("一")) })
    model.clear()
    expect(model.plan).toEqual([])
  })

  test("画出来能看到 plan 那条横线和进度", () => {
    const { model, chat } = pane()
    model.beginTurn("重构一下")
    model.handle({
      type: "tool.state",
      part: done([
        { text: "读一遍渲染器", status: "done" },
        { text: "把滚动条拆出去", status: "active" },
      ]),
    })
    const painted = chat
      .render({ width: 50, height: 24, busy: false, spinner: "⠹", detailVisible: true })
      .map(stripAnsi)
      .join("\n")
    expect(painted).toContain("plan")
    expect(painted).toContain("1/2")
    expect(painted).toContain("把滚动条拆出去")
  })

  test("没有计划时那一段整个不出现", () => {
    const { model, chat } = pane()
    model.beginTurn("随便问一句")
    const painted = chat
      .render({ width: 50, height: 24, busy: false, spinner: "⠹", detailVisible: true })
      .map(stripAnsi)
      .join("\n")
    expect(painted).not.toContain("plan")
  })

  test("★ 有计划时每一行仍然不超宽", () => {
    const { model, chat } = pane()
    model.beginTurn("重构")
    model.handle({
      type: "tool.state",
      part: done([{ text: "把中间那一栏拆成摘要、提问、计划、活动区四段".repeat(3), status: "active" }]),
    })
    for (const width of [24, 40, 60]) {
      for (const line of chat.render({ width, height: 20, busy: true, spinner: "⠹", detailVisible: false })) {
        expect(stripAnsi(line).length).toBeLessThanOrEqual(width * 2)
      }
    }
  })
})

describe("瀑布流视图", () => {
  test("★ 计划整份打印 —— 只打一行 1/3 等于把工具干的事藏起来", () => {
    const lines: string[] = []
    const renderer = new Renderer({
      sink: {
        write: (text) => lines.push(text),
        get atLineStart() {
          return true
        },
      },
    })
    renderer.handle({
      type: "tool.state",
      part: done([
        { text: "读一遍渲染器", status: "done" },
        { text: "把滚动条拆出去", status: "active" },
      ]),
    })
    const painted = stripAnsi(lines.join(""))
    expect(painted).toContain("读一遍渲染器")
    expect(painted).toContain("把滚动条拆出去")
  })
})

describe("恢复会话", () => {
  test("★ 接回来的不只是话,还有那份没做完的计划", () => {
    const model = new ChatModel({ root: process.cwd() })
    const history: MessageWithParts[] = [
      {
        info: { id: "m1", sessionID: "s", role: "user", timeCreated: 1 },
        parts: [{ id: "t1", sessionID: "s", messageID: "m1", timeCreated: 1, type: "text", text: "重构一下" }],
      },
      {
        info: {
          id: "m2",
          sessionID: "s",
          role: "assistant",
          parentID: "m1",
          providerID: "p",
          modelID: "m",
          cost: 0,
          timeCreated: 2,
        },
        parts: [{ ...done([{ text: "把滚动条拆出去", status: "active" }]), messageID: "m2" }],
      },
    ]
    expect(restoreLastTurn(history, model)).toBe(true)
    expect(model.plan.map((one) => one.text)).toEqual(["把滚动条拆出去"])
  })
})
