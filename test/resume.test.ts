/**
 * Picking up where we left off: which sessions can be resumed, and what's on screen once
 * one is.
 *
 * Three kinds of silent failure are watched here:
 *   - listing empty-shell sessions that were opened but never used → the picker's first
 *     screen is all blank lines
 *   - replay missing or over-drawing something → the user thinks history was lost /
 *     thinks a tool is still running
 *   - a picker row without enough information to tell two sessions apart → the whole
 *     screen is pointless
 */
import { describe, expect, test } from "bun:test"
import { Store } from "../src/session/store.ts"
import type { AssistantMessage, ToolPart } from "../src/session/schema.ts"
import { pipedResumeTarget } from "../src/cli/main.ts"
import { replay } from "../src/cli/replay.ts"
import { Renderer } from "../src/cli/render.ts"
import { relativeTime, renderList, sessionLabel, pickKey } from "../src/cli/sessions.ts"
import { setColorEnabled } from "../src/cli/theme.ts"
import { setInterfaceLanguage } from "../src/i18n/index.ts"
import type { Key } from "../src/cli/keys.ts"
import type { UIEvent } from "../src/agent/events.ts"

setColorEnabled(false)
setInterfaceLanguage("en")

// ─────────────────────────────────────────────── the store

/**
 * Creates a session that has messages. Times are fixed values so the ordering assertions
 * don't follow the clock.
 */
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
 * Sets the "last touched" time to a fixed value.
 *
 * Store has no (and shouldn't have a) public API for setting this clock, and ordering
 * assertions can't rely on sleep — which of two sessions created in the same millisecond
 * comes first is not guaranteed. So this edits the DB directly.
 */
function setUpdatedAt(store: Store, id: string, at: number): void {
  const db = (store as unknown as { db: { query(sql: string): { run(args: unknown): void } } }).db
  db.query(`UPDATE session SET time_updated = $at WHERE id = $id`).run({ id, at })
}

describe("resumable sessions", () => {
  test("★ empty sessions opened but never used are hidden — every launch creates one, so the list would be all blanks", () => {
    const store = new Store(":memory:")
    store.createSession("empty", "/repo")
    seed(store, "real", "/repo", 1000, ["帮我改一下 live.ts"])
    expect(store.listSessions({ directory: "/repo" }).map((s) => s.id)).toEqual(["real"])
    store.close()
  })

  test("legacy summary columns cannot replace the first real user message as the session label", () => {
    const store = new Store(":memory:")
    try {
      const db = (store as unknown as { db: { exec(sql: string): void } }).db
      db.exec("ALTER TABLE session ADD COLUMN summary TEXT NOT NULL DEFAULT 'obsolete label'")
      seed(store, "legacy", "/repo", 1000, ["Actual request"])
      store.upsertMessage({ id: "injection", sessionID: "legacy", role: "user", timeCreated: 1 })
      store.upsertPart({ id: "injected-text", sessionID: "legacy", messageID: "injection", timeCreated: 1, type: "text", text: "Internal note", synthetic: true })
      expect(sessionLabel(store.getSession("legacy")!)).toBe("Actual request")
      expect(sessionLabel(store.listSessions({ directory: "/repo" })[0]!)).toBe("Actual request")
    } finally { store.close() }
  })

  test("filtered by directory — a session from elsewhere would have all the wrong paths in its history", () => {
    const store = new Store(":memory:")
    seed(store, "here", "/repo", 1000, ["a"])
    seed(store, "there", "/other", 2000, ["b"])
    expect(store.listSessions({ directory: "/repo" }).map((s) => s.id)).toEqual(["here"])
    store.close()
  })

  test("newest first, and --continue takes the first", () => {
    const store = new Store(":memory:")
    seed(store, "old", "/repo", 1000, ["a"])
    seed(store, "new", "/repo", 5000, ["b"])
    expect(store.listSessions({ directory: "/repo" }).map((s) => s.id)).toEqual(["new", "old"])
    expect(store.latestSession("/repo")?.id).toBe("new")
    store.close()
  })

  test("★ the preview is the **first** prompt — the last is often a no-information reply like 'continue'", () => {
    const store = new Store(":memory:")
    seed(store, "s", "/repo", 1000, ["帮我改一下 live.ts", "继续"])
    const info = store.listSessions({ directory: "/repo" })[0]!
    expect(info.preview).toBe("帮我改一下 live.ts")
    expect(info.messages).toBe(2)
    store.close()
  })

  test("a directory with no sessions gives an empty list, not an error", () => {
    const store = new Store(":memory:")
    expect(store.listSessions({ directory: "/nowhere" })).toEqual([])
    expect(store.latestSession("/nowhere")).toBeUndefined()
    store.close()
  })

  test("a pipe resumes the newest other session instead of trying to open a picker", () => {
    const current = info({ id: "current", timeUpdated: 3000 })
    const previous = info({ id: "previous", timeUpdated: 2000 })
    expect(pipedResumeTarget([current, previous], current.id)).toBe(previous)
    expect(pipedResumeTarget([current], current.id)).toBeUndefined()
  })
})

// ─────────────────────────────────────────────── replay

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

describe("replay", () => {
  test("user text goes to the scrollback, model text through the renderer — one set of layout rules", () => {
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

  test("★ unfinished tools are not replayed — the process is gone, and a spinner that spins forever is worse than none", () => {
    const { events, sink } = fakeSink()
    replay([{ info: assistant("a1"), parts: [toolPart("running"), toolPart("pending"), toolPart("completed")] }], sink)
    const tools = events.filter((event) => event.type === "tool.state")
    expect(tools.length).toBe(1)
    expect((tools[0] as { part: ToolPart }).part.state.status).toBe("completed")
  })

  test("failed tools are replayed — why a step failed is part of the history", () => {
    const { events, sink } = fakeSink()
    replay([{ info: assistant("a1"), parts: [toolPart("error")] }], sink)
    expect(events.filter((event) => event.type === "tool.state").length).toBe(1)
  })

  test("★ reasoning is not replayed: at the time it only flashed in the live area and never entered the scrollback", () => {
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

  test("an empty assistant message doesn't count — interrupted tool-only turns shouldn't inflate the number", () => {
    const { sink } = fakeSink()
    expect(replay([{ info: assistant("a1"), parts: [] }], sink)).toBe(0)
  })
})

// ─────────────────────────────────────────────── the picker

const info = (over: Partial<ReturnType<typeof baseInfo>> = {}) => ({ ...baseInfo(), ...over })
function baseInfo() {
  return {
    id: "s1",
    title: "",
    directory: "/repo",
    timeCreated: 0,
    timeUpdated: 0,
    messages: 4,
    preview: "",
  }
}

describe("the picker", () => {
  test("★ label precedence: first prompt identifies the session without a generated label", () => {
    expect(sessionLabel(info({ preview: "帮我改一下 live.ts" }))).toBe("帮我改一下 live.ts")
    expect(sessionLabel(info())).toContain("untitled")
  })

  test("within a week show 'how long ago', beyond that a date — '23 days ago' makes you do subtraction", () => {
    const now = Date.UTC(2026, 6, 20, 12, 0, 0)
    expect(relativeTime(now - 30_000, now)).toBe("just now")
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago")
    expect(relativeTime(now - 3 * 3600_000, now)).toBe("3h ago")
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3d ago")
    expect(relativeTime(now - 30 * 86_400_000, now)).toMatch(/^\d\d-\d\d$/)
  })

  test("a row shows time, message count and content — drop one and two sessions look alike", () => {
    const now = 10 * 3600_000
    const [, row] = renderList([info({ preview: "在重做对话面板", timeUpdated: now - 3600_000, messages: 12 })], {
      selected: 0,
      width: 60,
      height: 5,
      now,
    })
    expect(row).toContain("1h ago")
    expect(row).toContain("12 msgs")
    expect(row).toContain("在重做对话面板")
  })

  test("★ sessions that don't fit are counted — 'that's all' and 'there's more' must not look the same", () => {
    const many = Array.from({ length: 9 }, (_, i) => info({ id: `s${i}`, preview: `第 ${i} 场` }))
    const lines = renderList(many, { selected: 0, width: 40, height: 3, now: 0 })
    expect(lines.join("\n")).toContain("+6")
  })

  test("the selected row scrolls into view instead of being cut off", () => {
    const many = Array.from({ length: 9 }, (_, i) => info({ id: `s${i}`, preview: `第 ${i} 场` }))
    const lines = renderList(many, { selected: 8, width: 40, height: 3, now: 0 }).join("\n")
    expect(lines).toContain("第 8 场")
    expect(lines).not.toContain("第 0 场")
  })

  test("an empty list says it's empty instead of drawing a box with no rows", () => {
    expect(renderList([], { selected: 0, width: 60, height: 5, now: 0 }).join("\n")).toContain("nothing to resume")
  })
})

describe("★ picker keys — more ways out than ways to confirm", () => {
  const key = (name: string, over: Partial<Key> = {}): Key => ({ name, ctrl: false, meta: false, shift: false, ...over })

  test("only enter confirms", () => {
    expect(pickKey(key("enter"))).toEqual({ kind: "accept" })
  })

  test("esc / q / ctrl-c / ctrl-d all leave", () => {
    for (const k of [key("escape"), key("q"), key("c", { ctrl: true }), key("d", { ctrl: true })]) {
      expect(pickKey(k)).toEqual({ kind: "cancel" })
    }
  })

  test("arrow keys move, every other key is ignored — a stray key shouldn't swap the whole session", () => {
    expect(pickKey(key("up"))).toEqual({ kind: "move", delta: -1 })
    expect(pickKey(key("pagedown"))).toEqual({ kind: "move", delta: 5 })
    for (const k of [key("z"), key("tab"), key("f5"), key("中")]) {
      expect(pickKey(k)).toEqual({ kind: "pass" })
    }
  })
})

describe("★ replay into the real renderer — order must hold", () => {
  test("a turn's order is: your words → speaker name → its words → tool lines", () => {
    let committed = "", tail = ""
    const transcript = {
      get atLineStart() { return !(committed + tail) || (committed + tail).endsWith("\n") },
      write(text: string) { committed += text },
      push(text: string) { committed += text + "\n" },
      replaceTail(lines: string[], next: string) { committed += lines.map(line => line + "\n").join(""); tail = next },
    }
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
    // ★ The key point: the model's text is rendered as a stream and may still be holding
    //   half a line. reset() finalizes it — without this, the last sentence only shows up
    //   on the next write
    renderer.reset()

    const lines = (committed + tail).split("\n").filter((line) => line.trim().length > 0)
    const at = (needle: string) => lines.findIndex((line) => line.includes(needle))
    expect(at("帮我改一下")).toBeGreaterThanOrEqual(0)
    expect(at("帮我改一下")).toBeLessThan(at("alfa"))
    expect(at("alfa")).toBeLessThan(at("好的,先看一眼。"))
    expect(at("好的,先看一眼。")).toBeLessThan(at("bash"))
    // the same text appears only once — this is where streaming rendering most easily
    // leaves both the final version and the preview behind
    expect(lines.filter((line) => line.includes("好的,先看一眼。")).length).toBe(1)
  })
})

// ─────────────────────────────────────────────── the synthetic injected message

/**
 * The reminder the automatic check injects back is a **synthetic** user message (see
 * verify in agent/loop.ts). It must be visible to the model and invisible to the user —
 * Replay must filter this text or the user sees, in their transcript, a
 * `<system-reminder>` they never said.
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

describe("★ a synthetic injected reminder never passes as the user's words", () => {
  const history = [
    said("u1", "改一下 a.ts"),
    spoke("a1", "u1", "改好了"),
    synthetic("u2", "<system-reminder>CHECK FAILED</system-reminder>"),
    spoke("a2", "u2", "这回真好了"),
  ]

  test("replay: absent from the scrollback and not counted as a message", () => {
    const { lines, sink } = fakeSink()
    const count = replay(history, sink)
    expect(lines.join("\n")).not.toContain("CHECK FAILED")
    expect(lines.join("\n")).toContain("改一下 a.ts")
    // the user said one thing and the model answered twice — the synthetic one doesn't
    // count
    expect(count).toBe(3)
  })

})
