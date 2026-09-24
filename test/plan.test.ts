/**
 * The plan: the tool, tidying up the list, windowing, and how it looks in the two views.
 */
import { describe, expect, test } from "bun:test"
import { planProgress, planRows, planWindow } from "../src/cli/plan.ts"
import { Renderer } from "../src/cli/render.ts"
import { setColorEnabled } from "../src/cli/theme.ts"
import { stripAnsi } from "../src/cli/width.ts"
import type { ToolPart } from "../src/session/schema.ts"
import { parseTodos, TodoTool, type TodoItem } from "../src/tool/todo.ts"
import type { ToolContext } from "../src/tool/types.ts"

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

describe("todo tool", () => {
  test("the output's first line is the progress for the board", async () => {
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

  test("★ a second active is demoted to pending — an error would only waste a call", async () => {
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

  test("★ in_progress / completed are accepted — models mix them up with other tools, an error only wastes a round", () => {
    const parsed = TodoTool.parameters.safeParse({
      items: [
        { text: "一", status: "in_progress" },
        { text: "二", status: "completed" },
        { text: "三", status: "pending" },
      ],
    })
    expect(parsed.success).toBe(true)
    // only the canonical values ever reach storage and the UI
    expect(parsed.data?.items?.map((one: { status: string }) => one.status)).toEqual(["active", "done", "pending"])
  })

  test("unrecognized statuses still error — accepting aliases isn't accepting anything", () => {
    expect(TodoTool.parameters.safeParse({ items: [{ text: "一", status: "blocked" }] }).success).toBe(false)
  })

  test("an empty list is an error — 'the plan is gone' and 'no plan was written' must stay distinct", async () => {
    await expect(TodoTool.execute({ items: [] }, ctx())).rejects.toThrow(/items is required/)
    await expect(TodoTool.execute({}, ctx())).rejects.toThrow(/clear: true/)
  })

  /**
   * ★ The live run: told "drop all that", the model hit the empty-list error and wrote a
   *   one-step placeholder, which stayed pinned. Dropping is its own explicit call.
   */
  test("★ clear: true drops the plan; with items too it's ambiguous and refused", async () => {
    const result = await TodoTool.execute({ clear: true }, ctx())
    expect(result.metadata["cleared"]).toBe(true)
    expect(result.metadata["todos"]).toEqual([])
    await expect(TodoTool.execute({ clear: true, items: [{ text: "x", status: "pending" }] }, ctx())).rejects.toThrow(/not both/)
  })

  test("blank items are skipped, overlong ones truncated", async () => {
    const result = await TodoTool.execute(
      { items: [{ text: "   ", status: "pending" }, { text: "x".repeat(200), status: "pending" }] },
      ctx(),
    )
    const todos = result.metadata["todos"] as TodoItem[]
    expect(todos).toHaveLength(1)
    expect(todos[0]!.text).toHaveLength(120)
  })

  test("parseTodos rejects unknown statuses", () => {
    expect(parseTodos([{ text: "a", status: "done" }, { text: "b", status: "??" }, { text: "", status: "done" }])).toEqual([
      { text: "a", status: "done" },
    ])
    expect(parseTodos(undefined)).toEqual([])
    expect(parseTodos("nope")).toEqual([])
  })
})

describe("list rows", () => {
  test("three statuses, three shapes — distinguishable even on a monochrome terminal", () => {
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

  test("progress counts statuses instead of guessing from order", () => {
    expect(
      planProgress([
        { text: "a", status: "done" },
        { text: "b", status: "pending" },
        { text: "c", status: "active" },
      ]),
    ).toEqual({ done: 1, total: 3, active: "c" })
  })

  test("★ when it doesn't fit, the window centers on the active item", () => {
    const list: TodoItem[] = [
      ...items("一", "二", "三"),
      { text: "四", status: "active" },
      ...items("五", "六"),
    ]
    const { shown, hidden } = planWindow(list, 3)
    // keep one item above as an anchor, give the rest to what hasn't happened yet
    expect(shown.map((one) => one.text)).toEqual(["三", "四", "五"])
    expect(hidden).toBe(3)
  })

  test("shows everything when it fits", () => {
    expect(planWindow(items("一", "二"), 5).shown).toHaveLength(2)
    expect(planWindow(items("一", "二"), 5).hidden).toBe(0)
  })

  test("with no active item, starts from the top", () => {
    expect(planWindow(items("一", "二", "三"), 2).shown.map((one) => one.text)).toEqual(["一", "二"])
  })
})

// ─────────────────────────────────────────────────────── the two views

function tool(state: ToolPart["state"], name = "todo"): ToolPart {
  return { id: "p1", sessionID: "s", messageID: "m", timeCreated: 0, type: "tool", callID: "p1", tool: name, state }
}

function done(todos: TodoItem[]): ToolPart {
  return tool({ status: "completed", input: {}, output: "plan", metadata: { todos }, time: { start: 0, end: 1 } })
}

describe("waterfall view", () => {
  test("★ the plan is printed in full — printing just 1/3 would hide what the tool did", () => {
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
