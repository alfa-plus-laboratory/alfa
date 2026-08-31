/**
 * 接着上次聊:哪些会话能接、接回来之后屏幕上是什么。
 *
 * 这里盯的是三类「不报错的错」:
 *   - 列出了开了没说话的空壳会话 → 挑选界面第一屏全是空行
 *   - 重放漏掉或多画了东西 → 用户以为历史丢了 / 以为工具还在跑
 *   - 挑选行的信息不足以区分两场会话 → 这个界面就白做了
 */
import { describe, expect, test } from "bun:test"
import { Store } from "../src/session/store.ts"
import type { AssistantMessage, ToolPart } from "../src/session/schema.ts"
import { digests, replay, restoreLastTurn } from "../src/cli/replay.ts"
import { createCatchUp, describeHistory, type TurnDigest } from "../src/agent/summarize.ts"
import { Renderer } from "../src/cli/render.ts"
import { Transcript } from "../src/tui/transcript.ts"
import { relativeTime, renderList, sessionLabel, pickKey } from "../src/cli/sessions.ts"
import { setColorEnabled } from "../src/cli/theme.ts"
import { setInterfaceLanguage } from "../src/i18n/index.ts"
import type { Key } from "../src/cli/keys.ts"
import type { UIEvent } from "../src/agent/events.ts"

setColorEnabled(false)
setInterfaceLanguage("en")

// ─────────────────────────────────────────────── 库

/** 造一场说过话的会话。时间给死值,排序断言才不会跟着钟走。 */
function seed(store: Store, id: string, directory: string, at: number, texts: string[]): void {
  store.createSession(id, directory)
  texts.forEach((text, index) => {
    const messageID = `${id}-m${index}`
    store.upsertMessage({ id: messageID, sessionID: id, role: "user", timeCreated: at + index })
    store.upsertPart({
      id: `${id}-p${index}`,
      sessionID: id,
      messageID,
      timeCreated: at + index,
      type: "text",
      text,
    })
  })
  setUpdatedAt(store, id, at)
}

/**
 * 把「最后动过」的时间拨到一个定值。
 *
 * Store 没有(也不该有)设置这个时钟的公开 API,而排序断言不能靠 sleep ——
 * 同一毫秒里建的两场会话谁前谁后是没有保证的。所以这里直接改库。
 */
function setUpdatedAt(store: Store, id: string, at: number): void {
  const db = (store as unknown as { db: { query(sql: string): { run(args: unknown): void } } }).db
  db.query(`UPDATE session SET time_updated = $at WHERE id = $id`).run({ id, at })
}

describe("能接的会话", () => {
  test("★ 开了没说话的空壳不出现 —— 每次启动都会建一行,列出来全是空行", () => {
    const store = new Store(":memory:")
    store.createSession("empty", "/repo")
    seed(store, "real", "/repo", 1000, ["帮我改一下 live.ts"])
    expect(store.listSessions({ directory: "/repo" }).map((s) => s.id)).toEqual(["real"])
    store.close()
  })

  test("按目录过滤 —— 别处的会话接过来,历史里的路径全是错的", () => {
    const store = new Store(":memory:")
    seed(store, "here", "/repo", 1000, ["a"])
    seed(store, "there", "/other", 2000, ["b"])
    expect(store.listSessions({ directory: "/repo" }).map((s) => s.id)).toEqual(["here"])
    store.close()
  })

  test("新的在前,--continue 拿的就是第一条", () => {
    const store = new Store(":memory:")
    seed(store, "old", "/repo", 1000, ["a"])
    seed(store, "new", "/repo", 5000, ["b"])
    expect(store.listSessions({ directory: "/repo" }).map((s) => s.id)).toEqual(["new", "old"])
    expect(store.latestSession("/repo")?.id).toBe("new")
    store.close()
  })

  test("★ 预览取**第一句**提问 —— 最后一句常常是「继续」这种没信息量的应答", () => {
    const store = new Store(":memory:")
    seed(store, "s", "/repo", 1000, ["帮我改一下 live.ts", "继续"])
    const info = store.listSessions({ directory: "/repo" })[0]!
    expect(info.preview).toBe("帮我改一下 live.ts")
    expect(info.messages).toBe(2)
    store.close()
  })

  test("这个目录下什么都没有时是空列表,不是抛错", () => {
    const store = new Store(":memory:")
    expect(store.listSessions({ directory: "/nowhere" })).toEqual([])
    expect(store.latestSession("/nowhere")).toBeUndefined()
    store.close()
  })
})

// ─────────────────────────────────────────────── 重放

function fakeSink() {
  const lines: string[] = []
  const events: UIEvent[] = []
  return {
    lines,
    events,
    sink: {
      line: (text: string) => lines.push(text),
      handle: (event: UIEvent) => events.push(event),
    },
  }
}

const assistant = (id: string): AssistantMessage => ({
  id,
  sessionID: "s",
  role: "assistant",
  parentID: "m0",
  providerID: "p",
  modelID: "m",
  cost: 0,
  timeCreated: 1,
})

const toolPart = (status: ToolPart["state"]["status"]): ToolPart => ({
  id: `t-${status}`,
  sessionID: "s",
  messageID: "a1",
  timeCreated: 2,
  type: "tool",
  callID: `c-${status}`,
  tool: "bash",
  state:
    status === "completed"
      ? { status, input: { command: "ls" }, output: "a\nb", metadata: {}, time: { start: 1, end: 2 } }
      : status === "error"
        ? { status, error: "boom", metadata: {}, time: { start: 1, end: 2 } }
        : status === "running"
          ? { status, input: {}, time: { start: 1 } }
          : { status },
})

describe("重放", () => {
  test("用户的话进滚动记录,模型的话走渲染器 —— 排版规矩只有一份", () => {
    const { lines, events, sink } = fakeSink()
    const count = replay(
      [
        { info: { id: "m0", sessionID: "s", role: "user", timeCreated: 1 }, parts: [
          { id: "p0", sessionID: "s", messageID: "m0", timeCreated: 1, type: "text", text: "帮我改一下" },
        ] },
        { info: assistant("a1"), parts: [
          { id: "p1", sessionID: "s", messageID: "a1", timeCreated: 2, type: "text", text: "好的" },
        ] },
      ],
      sink,
    )
    expect(lines.join("\n")).toContain("帮我改一下")
    expect(events.map((e) => e.type)).toEqual(["message.start", "part.delta", "part.end", "message.end"])
    expect(count).toBe(2)
  })

  test("★ 没跑完的工具不重放 —— 进程都换了,一个永远转着的圈比不画更糟", () => {
    const { events, sink } = fakeSink()
    replay([{ info: assistant("a1"), parts: [toolPart("running"), toolPart("pending"), toolPart("completed")] }], sink)
    const tools = events.filter((event) => event.type === "tool.state")
    expect(tools.length).toBe(1)
    expect((tools[0] as { part: ToolPart }).part.state.status).toBe("completed")
  })

  test("失败的工具要重放 —— 那一步为什么没成是历史的一部分", () => {
    const { events, sink } = fakeSink()
    replay([{ info: assistant("a1"), parts: [toolPart("error")] }], sink)
    expect(events.filter((event) => event.type === "tool.state").length).toBe(1)
  })

  test("★ 思考过程不重放:它当时也只在活动区闪了一下,没进过滚动记录", () => {
    const { events, sink } = fakeSink()
    replay(
      [
        { info: assistant("a1"), parts: [
          { id: "r1", sessionID: "s", messageID: "a1", timeCreated: 2, type: "reasoning", text: "嗯…" },
        ] },
      ],
      sink,
    )
    expect(events.some((event) => event.type === "part.delta")).toBe(false)
  })

  test("空的 assistant 消息不算一条 —— 只调了工具又被中断的那些不该撑大数字", () => {
    const { sink } = fakeSink()
    expect(replay([{ info: assistant("a1"), parts: [] }], sink)).toBe(0)
  })
})

// ─────────────────────────────────────────────── 挑选界面

const info = (over: Partial<ReturnType<typeof baseInfo>> = {}) => ({ ...baseInfo(), ...over })
function baseInfo() {
  return {
    id: "s1",
    title: "",
    directory: "/repo",
    timeCreated: 0,
    timeUpdated: 0,
    summary: "",
    messages: 4,
    preview: "",
  }
}

describe("挑选界面", () => {
  test("★ 认人的顺序:摘要 > 第一句提问 > 认了它没名字", () => {
    expect(sessionLabel(info({ summary: "在重做对话面板\n第二行", preview: "帮我改" }))).toBe("在重做对话面板")
    expect(sessionLabel(info({ preview: "帮我改一下 live.ts" }))).toBe("帮我改一下 live.ts")
    expect(sessionLabel(info())).toContain("no summary")
  })

  test("一周以内说「多久以前」,再往前说日期 —— 「23 天前」要在脑子里减一次", () => {
    const now = Date.UTC(2026, 6, 20, 12, 0, 0)
    expect(relativeTime(now - 30_000, now)).toBe("just now")
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago")
    expect(relativeTime(now - 3 * 3600_000, now)).toBe("3h ago")
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3d ago")
    expect(relativeTime(now - 30 * 86_400_000, now)).toMatch(/^\d\d-\d\d$/)
  })

  test("一行里同时有时间、条数和内容 —— 少一样就分不出两场会话", () => {
    const now = 10 * 3600_000
    const [, row] = renderList([info({ summary: "在重做对话面板", timeUpdated: now - 3600_000, messages: 12 })], {
      selected: 0,
      width: 60,
      height: 5,
      now,
    })
    expect(row).toContain("1h ago")
    expect(row).toContain("12 msgs")
    expect(row).toContain("在重做对话面板")
  })

  test("★ 装不下的那些要说出来 —— 「就这几场」和「上面还有」不能长得一样", () => {
    const many = Array.from({ length: 9 }, (_, i) => info({ id: `s${i}`, preview: `第 ${i} 场` }))
    const lines = renderList(many, { selected: 0, width: 40, height: 3, now: 0 })
    expect(lines.join("\n")).toContain("+6")
  })

  test("选中项滚进视野,不是被截在外面", () => {
    const many = Array.from({ length: 9 }, (_, i) => info({ id: `s${i}`, preview: `第 ${i} 场` }))
    const lines = renderList(many, { selected: 8, width: 40, height: 3, now: 0 }).join("\n")
    expect(lines).toContain("第 8 场")
    expect(lines).not.toContain("第 0 场")
  })

  test("空列表说清楚是空的,不画一个没有行的框", () => {
    expect(renderList([], { selected: 0, width: 60, height: 5, now: 0 }).join("\n")).toContain("nothing to resume")
  })
})

describe("★ 挑选界面的按键 —— 退出的路要比确认的路多", () => {
  const key = (name: string, over: Partial<Key> = {}): Key => ({ name, ctrl: false, meta: false, shift: false, ...over })

  test("只有回车是确认", () => {
    expect(pickKey(key("enter"))).toEqual({ kind: "accept" })
  })

  test("esc / q / ctrl-c / ctrl-d 都是走人", () => {
    for (const k of [key("escape"), key("q"), key("c", { ctrl: true }), key("d", { ctrl: true })]) {
      expect(pickKey(k)).toEqual({ kind: "cancel" })
    }
  })

  test("方向键翻,别的键一律不接 —— 误触不该换掉整场会话", () => {
    expect(pickKey(key("up"))).toEqual({ kind: "move", delta: -1 })
    expect(pickKey(key("pagedown"))).toEqual({ kind: "move", delta: 5 })
    for (const k of [key("z"), key("tab"), key("f5"), key("中")]) {
      expect(pickKey(k)).toEqual({ kind: "pass" })
    }
  })
})

describe("★ 重放接到真渲染器上 —— 顺序不能乱", () => {
  test("一轮的顺序是:你说的话 → 署名 → 它说的话 → 工具行", () => {
    const transcript = new Transcript()
    const renderer = new Renderer({ sink: transcript, root: "/repo", markdown: true, speakers: true })
    replay(
      [
        {
          info: { id: "m0", sessionID: "s", role: "user", timeCreated: 1 },
          parts: [{ id: "p0", sessionID: "s", messageID: "m0", timeCreated: 1, type: "text", text: "帮我改一下" }],
        },
        {
          info: assistant("a1"),
          parts: [
            { id: "p1", sessionID: "s", messageID: "a1", timeCreated: 2, type: "text", text: "好的,先看一眼。" },
            toolPart("completed"),
          ],
        },
      ],
      { line: (text) => transcript.push(text), handle: (event) => renderer.handle(event) },
    )
    // ★ 关键:模型那段话是流式渲染的,它手里可能还攒着半行。reset() 定稿 ——
    //   少了这一下,最后一句话会在下一次写入时才冒出来
    renderer.reset()

    const lines = transcript.view(200, 40).filter((line) => line.trim().length > 0)
    const at = (needle: string) => lines.findIndex((line) => line.includes(needle))
    expect(at("帮我改一下")).toBeGreaterThanOrEqual(0)
    expect(at("帮我改一下")).toBeLessThan(at("agent"))
    expect(at("agent")).toBeLessThan(at("好的,先看一眼。"))
    expect(at("好的,先看一眼。")).toBeLessThan(at("bash"))
    // 同一段话只出现一次 —— 流式渲染最容易在这里把定稿和预览都留下
    expect(lines.filter((line) => line.includes("好的,先看一眼。")).length).toBe(1)
  })
})

// ─────────────────────────────────────────────── 装回 session 视图

/** ChatModel 那三段里,这里只关心「提问」和「它说的话 + 工具行」。 */
function fakeTurnSink() {
  const events: UIEvent[] = []
  let prompt = ""
  return {
    events,
    get prompt() {
      return prompt
    },
    sink: {
      beginTurn: (text: string) => {
        prompt = text
      },
      handle: (event: UIEvent) => events.push(event),
    },
  }
}

describe("★ 接回来之后 session 视图不能是空的", () => {
  const turn = (userID: string, ask: string, botID: string, say: string, tools: ToolPart[] = []) => [
    {
      info: { id: userID, sessionID: "s", role: "user" as const, timeCreated: 1 },
      parts: [{ id: `${userID}p`, sessionID: "s", messageID: userID, timeCreated: 1, type: "text" as const, text: ask }],
    },
    {
      info: { ...assistant(botID), parentID: userID },
      parts: [
        { id: `${botID}p`, sessionID: "s", messageID: botID, timeCreated: 2, type: "text" as const, text: say },
        ...tools.map((tool) => ({ ...tool, messageID: botID })),
      ],
    },
  ]

  test("最后一轮的提问回到「你说」,回答回到「现在」", () => {
    const view = fakeTurnSink()
    expect(
      restoreLastTurn([...turn("u1", "第一问", "a1", "第一答"), ...turn("u2", "第二问", "a2", "第二答")], view.sink),
    ).toBe(true)
    expect(view.prompt).toBe("第二问")
    const said = view.events
      .filter((event) => event.type === "part.delta")
      .map((event) => (event as { delta: string }).delta)
    expect(said).toEqual(["第二答"])
  })

  test("★ 只装**最后**一轮 —— 活动区回答的是「现在怎么样了」,不是「说过些什么」", () => {
    const { sink, events } = fakeTurnSink()
    restoreLastTurn([...turn("u1", "第一问", "a1", "第一答"), ...turn("u2", "第二问", "a2", "第二答")], sink)
    expect(events.some((event) => event.type === "part.delta" && (event as { delta: string }).delta === "第一答")).toBe(
      false,
    )
  })

  test("那一轮的工具行也回来", () => {
    const { sink, events } = fakeTurnSink()
    restoreLastTurn(turn("u1", "问", "a1", "答", [toolPart("completed")]), sink)
    expect(events.filter((event) => event.type === "tool.state").length).toBe(1)
  })

  test("没有用户消息就什么都不动 —— 别把一个空提问钉在面板上", () => {
    const { sink } = fakeTurnSink()
    expect(restoreLastTurn([{ info: assistant("a1"), parts: [] }], sink)).toBe(false)
    expect(restoreLastTurn([], sink)).toBe(false)
  })
})

// ─────────────────────────────────────────────── 补摘要

describe("★ 库里没有摘要时照着历史补一份", () => {
  const turns = (count: number): TurnDigest[] =>
    Array.from({ length: count }, (_, i) => ({ prompt: `问题 ${i}`, reply: `回答 ${i}`, tools: [] }))

  test("历史摊成一轮一条,喂的是摘要 agent 一直在读的那种材料", () => {
    const text = describeHistory([
      { prompt: "帮我改一下 live.ts", reply: "改好了", tools: [{ tool: "edit", target: "live.ts", outcome: "+4 -1" }] },
    ])
    expect(text).toContain("帮我改一下 live.ts")
    expect(text).toContain("改好了")
    expect(text).toContain("edit live.ts")
    expect(text).toContain("<untrusted-data>")
  })

  test("★ 太长就只给最后几轮,而且**说清楚前面还有多少轮没给它看**", () => {
    const text = describeHistory(turns(30))
    expect(text).not.toContain("问题 0")
    expect(text).toContain("问题 29")
    expect(text).toContain("18 earlier turns are not available")
  })

  test("失败和中断要说出来 —— 那也是「走到哪了」的一部分", () => {
    const text = describeHistory([
      { prompt: "跑一下测试", reply: "", tools: [{ tool: "bash", target: "bun test", outcome: "exit 1", failed: true }], interrupted: true },
    ])
    expect(text).toContain("FAILED bash")
    expect(text).toContain("interrupted")
  })

  test("一轮都没有时不发请求 —— 空会话没什么可总结的", async () => {
    let called = false
    const catchUp = createCatchUp({
      stream: () => {
        called = true
        throw new Error("不该走到这里")
      },
      model: () => ({ providerID: "p", modelID: "m" }),
      language: () => "en",
    })
    expect((await catchUp([])).failed).toBeTruthy()
    expect(called).toBe(false)
  })

  test("整段历史 → 一轮一条的浓缩", () => {
    const list = digests(
      [
        {
          info: { id: "u1", sessionID: "s", role: "user", timeCreated: 1 },
          parts: [{ id: "p1", sessionID: "s", messageID: "u1", timeCreated: 1, type: "text", text: "问" }],
        },
        {
          info: assistant("a1"),
          parts: [
            { id: "p2", sessionID: "s", messageID: "a1", timeCreated: 2, type: "text", text: "答" },
            toolPart("completed"),
          ],
        },
      ],
      "/repo",
    )
    expect(list.length).toBe(1)
    expect(list[0]!.prompt).toBe("问")
    expect(list[0]!.reply).toBe("答")
    expect(list[0]!.tools.map((tool) => tool.tool)).toEqual(["bash"])
  })
})

// ─────────────────────────────────────────────── 合成注入的那一段

/**
 * 自动检查塞回去的提醒是**合成**的 user 消息(见 agent/loop.ts 的 verify)。
 * 它必须对模型可见、对用户不可见 —— 三处判据共用 replay.ts 里那个 textOf,
 * 所以三处一起测:漏一处,用户就会在记录里看到一段自己从没说过的
 * `<system-reminder>`。
 */
const synthetic = (id: string, text: string) => ({
  info: { id, sessionID: "s", role: "user" as const, timeCreated: 3 },
  parts: [
    {
      id: `${id}p`,
      sessionID: "s",
      messageID: id,
      timeCreated: 3,
      type: "text" as const,
      text,
      synthetic: true,
    },
  ],
})

const said = (id: string, text: string) => ({
  info: { id, sessionID: "s", role: "user" as const, timeCreated: 1 },
  parts: [{ id: `${id}p`, sessionID: "s", messageID: id, timeCreated: 1, type: "text" as const, text }],
})

const spoke = (id: string, parentID: string, text: string) => ({
  info: { ...assistant(id), parentID },
  parts: [{ id: `${id}p`, sessionID: "s", messageID: id, timeCreated: 2, type: "text" as const, text }],
})

describe("★ 合成注入的提醒不能冒充用户说的话", () => {
  const history = [
    said("u1", "改一下 a.ts"),
    spoke("a1", "u1", "改好了"),
    synthetic("u2", "<system-reminder>CHECK FAILED</system-reminder>"),
    spoke("a2", "u2", "这回真好了"),
  ]

  test("重放:滚动记录里不出现,也不算一条消息", () => {
    const { lines, sink } = fakeSink()
    const count = replay(history, sink)
    expect(lines.join("\n")).not.toContain("CHECK FAILED")
    expect(lines.join("\n")).toContain("改一下 a.ts")
    // 用户说了一句,模型答了两次 —— 那条合成的不算
    expect(count).toBe(3)
  })

  test("接回来:`你说的话`那一栏是用户的原话,不是提醒", () => {
    // 不解构:prompt 是个 getter,摊开来就等于在跑之前先把它读空了
    const turn = fakeTurnSink()
    expect(restoreLastTurn(history, turn.sink)).toBe(true)
    expect(turn.prompt).toBe("改一下 a.ts")
    // 提醒之后模型说的那句照旧要装回来
    const texts = turn.events
      .filter((event) => event.type === "part.delta")
      .map((event) => (event.type === "part.delta" ? event.delta : ""))
    expect(texts).toContain("这回真好了")
  })

  test("补摘要:不会被当成用户新提了一个问题", () => {
    const turns = digests(history, "/repo")
    expect(turns).toHaveLength(1)
    expect(turns[0]!.prompt).toBe("改一下 a.ts")
    expect(turns[0]!.reply).toContain("这回真好了")
  })
})
