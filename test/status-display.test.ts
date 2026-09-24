/**
 * The status the live area shows while and between turns: the running line (alfa mark,
 * phase, clock, thinking tail), the footer (context bar, actual cache hit rate, speed),
 * the pinned rows (plan, subagents incl. suspended ones, background jobs) and the tips
 * in the empty input box.
 *
 * Most of these fail silently when broken — a timer that outlives the turn burns CPU
 * with nothing on screen, an unknown cache counter shown as 0% reads as "broken", a
 * strip that rounds a lone failure away hides it — so the guards are here rather than in
 * anyone's eyes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { Activity, clock, FRAME_MS, mark, turnReceipt, type Phase } from "../src/cli/activity.ts"
import { footerLines } from "../src/cli/footer.ts"
import { agentRows, jobRow, pinnedRows, planRow } from "../src/cli/pinned.ts"
import { planChanges } from "../src/cli/plan.ts"
import { allTips, Tips, TIP_CONTEXT_AT } from "../src/cli/tips.ts"
import { Renderer } from "../src/cli/render.ts"
import { Editor } from "../src/cli/editor.ts"
import { Keyboard } from "../src/cli/keyboard.ts"
import { LiveRegion } from "../src/cli/live.ts"
import { Shell } from "../src/cli/shell.ts"
import { setColorEnabled } from "../src/cli/theme.ts"
import { displayWidth, stripAnsi } from "../src/cli/width.ts"
import { setInterfaceLanguage, LANGUAGES } from "../src/i18n/index.ts"
import type { UIEvent } from "../src/agent/events.ts"
import type { JobSnapshot } from "../src/tool/background.ts"
import type { Part, ReasoningPart, StepFinishPart, ToolPart } from "../src/session/schema.ts"
import type { TodoItem } from "../src/tool/todo.ts"

beforeAll(() => { setInterfaceLanguage("en"); setColorEnabled(false) })
afterAll(() => setColorEnabled(true))

const base = { sessionID: "s", messageID: "m", timeCreated: 0 }
const reasoning = (id: string, text = "", time?: { start: number; end?: number }): ReasoningPart =>
  ({ ...base, id, type: "reasoning", text, ...(time ? { time } : {}) })
const textPart = (id: string): Part => ({ ...base, id, type: "text", text: "" }) as Part
const stepStart = (): Part => ({ ...base, id: "st", type: "step-start" }) as Part
const stepFinish = (output: number, reasoningTokens = 0): StepFinishPart =>
  ({ ...base, id: "sf", type: "step-finish", finishReason: "stop", tokens: { input: 0, output, reasoning: reasoningTokens, cache: { read: 0, write: 0 } } }) as StepFinishPart
const tool = (callID: string, name: string, status: "running" | "completed"): ToolPart => ({
  ...base, id: callID, type: "tool", callID, tool: name,
  state: status === "running" ? { status, input: {}, time: { start: 0 } } : { status, input: {}, output: "", metadata: {}, time: { start: 0, end: 1 } },
}) as ToolPart

describe("activity: the phase follows what streamed", () => {
  test("reasoning → thinking, text → writing, a running tool → its name, then back to working", () => {
    const a = new Activity()
    a.begin(0)
    expect(a.current().kind).toBe("working")
    a.handle({ type: "part.start", part: reasoning("r1") }, 10)
    expect(a.current().kind).toBe("thinking")
    a.handle({ type: "part.delta", part: reasoning("r1"), delta: "check the\n\nregistry order" }, 20)
    expect(a.thinking()).toBe("check the registry order")
    a.handle({ type: "part.end", part: reasoning("r1") }, 30)
    expect(a.thinking()).toBe("")
    a.handle({ type: "part.delta", part: textPart("t1"), delta: "Done." }, 40)
    expect(a.current().kind).toBe("writing")
    a.handle({ type: "tool.state", part: tool("c1", "bash", "running") }, 50)
    expect(a.current()).toEqual({ kind: "tool", name: "bash" })
    a.handle({ type: "tool.state", part: tool("c1", "bash", "completed") }, 60)
    expect(a.current().kind).toBe("working")
  })

  test("★ silence before any output stays 'working' — a hidden-reasoning provider must not be labelled thinking", () => {
    const a = new Activity()
    a.begin(0)
    a.handle({ type: "part.start", part: stepStart() }, 0)
    expect(a.current().kind).toBe("working")
  })

  test("with parallel tools the line names one that is still running", () => {
    const a = new Activity()
    a.begin(0)
    a.handle({ type: "tool.state", part: tool("a", "read", "running") })
    a.handle({ type: "tool.state", part: tool("b", "grep", "running") })
    a.handle({ type: "tool.state", part: tool("b", "grep", "completed") })
    expect(a.current()).toEqual({ kind: "tool", name: "read" })
  })

  test("a retry counts down and then falls back to working on its own", () => {
    const a = new Activity()
    a.begin(0)
    a.handle({ type: "retry", attempt: 1, maxAttempts: 3, delayMs: 3000, message: "429" }, 1000)
    expect(a.current(2000)).toEqual({ kind: "retrying", until: 4000 })
    expect(a.current(4000).kind).toBe("working")
  })

  test("the summary counts steps and the whole turn's time", () => {
    const a = new Activity()
    a.begin(1000)
    a.handle({ type: "step.finish", part: stepFinish(10) }, 2000)
    a.handle({ type: "step.finish", part: stepFinish(10) }, 3000)
    expect(a.end(84_000)).toEqual({ elapsedMs: 83_000, steps: 2 })
    expect(a.end()).toBeUndefined()
  })
})

describe("activity: token speed", () => {
  test("measured from the first output to the step's end, not from the request", () => {
    const a = new Activity()
    a.begin(0)
    a.handle({ type: "part.start", part: stepStart() }, 0)
    a.handle({ type: "part.delta", part: textPart("t"), delta: "x" }, 5000)
    a.handle({ type: "step.finish", part: stepFinish(200) }, 7000)
    expect(a.speed(7000)).toEqual({ rate: 100, estimated: false })
  })

  test("★ hidden reasoning is taken out — it was generated before the first visible token", () => {
    const a = new Activity()
    a.begin(0)
    a.handle({ type: "part.start", part: stepStart() }, 0)
    a.handle({ type: "part.delta", part: textPart("t"), delta: "x" }, 5000)
    a.handle({ type: "step.finish", part: stepFinish(1200, 1000) }, 7000)
    expect(a.speed(7000)?.rate).toBe(100)
  })

  test("streamed reasoning stays in: it was generated inside the measured window", () => {
    const a = new Activity()
    a.begin(0)
    a.handle({ type: "part.start", part: stepStart() }, 0)
    a.handle({ type: "part.start", part: reasoning("r") }, 1000)
    a.handle({ type: "step.finish", part: stepFinish(400, 300) }, 3000)
    expect(a.speed(3000)?.rate).toBe(200)
  })

  test("a tiny step doesn't overwrite the last real measurement", () => {
    const a = new Activity()
    a.begin(0)
    a.handle({ type: "part.start", part: stepStart() }, 0)
    a.handle({ type: "part.delta", part: textPart("t"), delta: "x" }, 0)
    a.handle({ type: "step.finish", part: stepFinish(100) }, 1000)
    a.handle({ type: "part.start", part: stepStart() }, 1000)
    a.handle({ type: "part.delta", part: textPart("t"), delta: "x" }, 1000)
    a.handle({ type: "step.finish", part: stepFinish(3) }, 1010)
    expect(a.speed(1010)?.rate).toBe(100)
  })

  test("while streaming it is a marked estimate", () => {
    const a = new Activity()
    a.begin(0)
    a.handle({ type: "part.start", part: stepStart() }, 0)
    a.handle({ type: "part.delta", part: textPart("t"), delta: "word ".repeat(200) }, 0)
    expect(a.speed(2000)?.estimated).toBe(true)
  })
})

describe("the alfa mark", () => {
  const phases: Phase[] = [{ kind: "working" }, { kind: "thinking" }, { kind: "writing" }, { kind: "tool", name: "bash" }, { kind: "retrying", until: 0 }]
  const plain = (phase: Phase, frame: number) => stripAnsi(mark(phase, frame))

  test("★ every frame of every phase is exactly three columns — the label after it must not jitter", () => {
    for (const phase of phases) for (let frame = 0; frame < 24; frame++) expect(displayWidth(plain(phase, frame))).toBe(3)
  })

  test("frame 0 is the banner's α for every phase — that is what animation off shows", () => {
    for (const phase of phases) expect(plain(phase, 0)).toBe("⢎⡱⣇")
  })

  test("the motion is the state: writing draws the α stroke by stroke, a tool runs a gap round the loop", () => {
    const writing = Array.from({ length: 10 }, (_, f) => plain({ kind: "writing" }, f + 1))
    expect(writing[0]).not.toBe("⢎⡱⣇")
    expect(writing).toContain("⢎⡱⣇")
    const tool = new Set(Array.from({ length: 8 }, (_, f) => plain({ kind: "tool", name: "bash" }, f + 1)))
    expect(tool.size).toBe(8)
    for (const frame of tool) expect(frame.endsWith("⣇")).toBe(true)
  })

  test("thinking sweeps brightness, not shape; a retry doesn't move", () => {
    setColorEnabled(true)
    try {
      expect(mark({ kind: "thinking" }, 1)).not.toBe(mark({ kind: "thinking" }, 2))
      expect(stripAnsi(mark({ kind: "thinking" }, 1))).toBe("⢎⡱⣇")
      expect(mark({ kind: "retrying", until: 0 }, 3)).toBe(mark({ kind: "retrying", until: 0 }, 0))
    } finally { setColorEnabled(false) }
  })

  test("the clock ticks in whole seconds", () => {
    expect(clock(12_900)).toBe("12s")
    expect(clock(65_000)).toBe("1m05s")
    expect(clock(3_725_000)).toBe("1h02m")
  })

  test("the turn receipt says the time, and steps only when there were any", () => {
    expect(turnReceipt({ elapsedMs: 83_000, steps: 7 })).toBe("worked 1m23s · 7 steps")
    expect(turnReceipt({ elapsedMs: 400, steps: 0 })).toBe("worked 400ms")
    expect(turnReceipt({ elapsedMs: 2000, steps: 1 })).toBe("worked 2.0s · 1 step")
  })
})

function fakeKeyboard() {
  const input = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, setRawMode() {}, setEncoding() {}, resume() {}, pause() {} }) as unknown as NodeJS.ReadStream
  const out = Object.assign(new EventEmitter(), { isTTY: true, columns: 80, rows: 24, write: () => true }) as unknown as NodeJS.WriteStream
  return new Keyboard(input, out)
}

function terminal(rows = 30) {
  const frames: string[] = []
  const output = Object.assign(new EventEmitter(), { columns: 80, rows, isTTY: true, write: (s: string) => { frames.push(s); return true } }) as unknown as NodeJS.WriteStream
  return { region: new LiveRegion({ output, enabled: true }), frames, all: () => stripAnsi(frames.join("")) }
}

describe("running line", () => {
  test("shows the mark, the phase, the clock and the thinking tail while busy", () => {
    const keyboard = fakeKeyboard(), term = terminal(), activity = new Activity()
    const shell = new Shell({ keyboard, region: term.region, editor: new Editor([]), activity, onSubmit() {}, onCancel() {}, onExit() {} })
    shell.start()
    try {
      shell.setBusy(true)
      activity.handle({ type: "part.start", part: reasoning("r") })
      activity.handle({ type: "part.delta", part: reasoning("r"), delta: "the cache prefix breaks when the tool order changes" })
      // With the timer running, the next tick draws the change; draw it now
      shell.paint()
      const frame = term.all()
      expect(frame).toMatch(/ {2}[⠀-⣿]{3} thinking · 0s · esc to interrupt/)
      expect(frame).toContain("┆ the cache prefix breaks")
    } finally { shell.stop(); term.region.close(); keyboard.close() }
  })

  test("★ the animation timer exists only while busy — idle draws zero frames", async () => {
    const keyboard = fakeKeyboard(), term = terminal(), activity = new Activity()
    const shell = new Shell({ keyboard, region: term.region, editor: new Editor([]), activity, onSubmit() {}, onCancel() {}, onExit() {} })
    shell.start()
    try {
      shell.setBusy(true)
      // A tool phase changes the mark's shape; with colour off the thinking sweep is
      // brightness only, and identical frames rightly send nothing
      activity.handle({ type: "tool.state", part: tool("c", "bash", "running") })
      const before = term.frames.length
      await Bun.sleep(FRAME_MS * 3)
      expect(term.frames.length).toBeGreaterThan(before)
      shell.setBusy(false)
      const idle = term.frames.length
      await Bun.sleep(FRAME_MS * 3)
      expect(term.frames.length).toBe(idle)
    } finally { shell.stop(); term.region.close(); keyboard.close() }
  })

  test("animation off: a still mark and no clock that would stop moving", () => {
    const keyboard = fakeKeyboard(), term = terminal(), activity = new Activity()
    const shell = new Shell({ keyboard, region: term.region, editor: new Editor([]), activity, animate: () => false, onSubmit() {}, onCancel() {}, onExit() {} })
    shell.start()
    try {
      shell.setBusy(true)
      const frame = term.all()
      expect(frame).toContain("  ⢎⡱⣇ working · esc to interrupt")
      expect(frame).not.toContain("0s")
    } finally { shell.stop(); term.region.close(); keyboard.close() }
  })
})

describe("thinking tail", () => {
  test("★ it starts at a word boundary with … — a tail cut mid-word reads as corrupted output", async () => {
    const { wrapWords } = await import("../src/cli/width.ts")
    const rows = wrapWords("I should not read AGENTS.md again just to activate them, continue with the plan", 20)
    for (const row of rows) expect(row.startsWith(" ") || row.endsWith(" ")).toBe(false)
    expect(rows).toEqual(["I should not read", "AGENTS.md again just", "to activate them,", "continue with the", "plan"])
    // CJK has no spaces and still wraps within the width
    for (const row of wrapWords("先看注册表的排序再决定要不要改缓存前缀的位置", 10)) expect(displayWidth(row)).toBeLessThanOrEqual(10)
  })
})

describe("footer", () => {
  const input = { path: "~/code/alfa", spec: "anthropic/claude-opus-5", ratio: 0.41, estimated: false, thinking: false }

  test("the context bar, the percentage, the actual cache rate and the speed share the model line", () => {
    const [, line] = footerLines({ ...input, cache: 0.96, speed: { rate: 48.2, estimated: false } }, 120).map(stripAnsi)
    expect(line).toBe("anthropic/claude-opus-5 · ▓▓▓░░░░░ 41% ctx · cache 96% · 48 tok/s")
  })

  test("★ an unknown cache rate is a dash, never 0% — and no request yet shows nothing at all", () => {
    expect(stripAnsi(footerLines({ ...input, cache: null }, 120)[1]!)).toContain("cache —")
    expect(stripAnsi(footerLines({ ...input }, 120)[1]!)).not.toContain("cache")
  })

  test("a live estimate is marked", () => {
    expect(stripAnsi(footerLines({ ...input, speed: { rate: 7.25, estimated: true } }, 120)[1]!)).toContain("~7.3 tok/s")
  })

  test("★ on a narrow screen speed, cache and the bar give way; the percentage stays", () => {
    const line = stripAnsi(footerLines({ ...input, cache: 0.9, speed: { rate: 40, estimated: false } }, 30)[1]!)
    expect(line).toContain("41% ctx")
    expect(line).not.toContain("tok/s")
    expect(line).not.toContain("▓")
    expect(displayWidth(line)).toBeLessThanOrEqual(30)
  })
})

const job = (over: Partial<JobSnapshot>): JobSnapshot =>
  ({ id: "a", kind: "agent", command: "brief", workdir: "/", status: "running", startedAt: 0, pending: 0, ...over })

describe("pinned rows", () => {
  const items = (statuses: TodoItem["status"][]): TodoItem[] => statuses.map((status, i) => ({ text: `step ${i}`, status }))

  test("the plan is one row: progress and the item in progress", () => {
    expect(stripAnsi(planRow(items(["done", "done", "active", "pending", "pending"]), 80)!)).toBe("  ▰▰▰▰▱▱▱▱▱▱ 2/5 ▸ step 2")
  })

  test("a finished or empty plan leaves no row", () => {
    expect(planRow(items(["done", "done"]), 80)).toBeUndefined()
    expect(planRow([], 80)).toBeUndefined()
  })

  test("★ suspended subagents stay listed — they can still be woken, so they aren't closed", () => {
    const rows = agentRows([job({ id: "audit", status: "exited", exit: 0, endedAt: 5 }), job({ id: "parser", activity: "read src/x.ts" })], 80).map(stripAnsi)
    expect(rows[0]).toBe("  agents ◌● 1 running · 1 suspended")
    expect(rows[1]).toBe("    ● parser · read src/x.ts")
    expect(rows[2]).toBe("    ◌ suspended: audit")
  })

  test("a user-stopped one isn't a failure; a crashed one is", () => {
    const rows = agentRows([job({ id: "a", status: "exited", exit: 1, signal: "SIGTERM" }), job({ id: "b", status: "exited", exit: 1 })], 80).map(stripAnsi)
    expect(rows[0]).toBe("  agents ◌✗ 2 suspended · 1 failed")
  })

  test("★ a hundred agents still fit one row, and a lone failure keeps its cell", () => {
    const many = [
      ...Array.from({ length: 80 }, (_, i) => job({ id: `s${i}`, status: "exited", exit: 0 })),
      job({ id: "bad", status: "exited", exit: 1 }),
      ...Array.from({ length: 19 }, (_, i) => job({ id: `r${i}` })),
    ]
    const summary = stripAnsi(agentRows(many, 200)[0]!)
    const strip = summary.split(" ")[3]!
    expect([...strip].length).toBe(24)
    expect(strip).toContain("✗")
    expect(summary).toContain("19 running · 81 suspended · 1 failed")
  })

  test("no subagents, no row", () => {
    expect(agentRows([], 80)).toEqual([])
  })

  test("background processes get one row with their commands", () => {
    expect(stripAnsi(jobRow([job({ kind: "process", command: "bun run dev" }), job({ kind: "process", command: "old", status: "exited" })], 80)!)).toBe("  jobs 1 running · bun run dev")
  })

  test("the row budget is respected and detail gives way first", () => {
    const input = { plan: items(["active", "pending"]), agents: [job({ id: "x" }), job({ id: "y" })], jobs: [job({ kind: "process", command: "dev" })] }
    const three = pinnedRows(input, 80, 3).map(stripAnsi)
    expect(three.length).toBe(3)
    expect(three[1]).toContain("agents")
    expect(three[2]).toContain("jobs")
    const five = pinnedRows(input, 80, 5).map(stripAnsi)
    expect(five.length).toBe(5)
    expect(five[2]).toContain("● ")
    expect(pinnedRows(input, 80, 0)).toEqual([])
  })
})

describe("todo in the transcript", () => {
  test("★ a status-only update prints only what moved; a reshaped list prints in full", () => {
    const before: TodoItem[] = [{ text: "a", status: "done" }, { text: "b", status: "active" }, { text: "c", status: "pending" }]
    const ticked: TodoItem[] = [{ text: "a", status: "done" }, { text: "b", status: "done" }, { text: "c", status: "active" }]
    expect(planChanges(before, ticked).map(item => item.text)).toEqual(["b", "c"])
    const grown = [...ticked, { text: "d", status: "pending" as const }]
    expect(planChanges(ticked, grown)).toEqual(grown)
    expect(planChanges([], before)).toEqual(before)
  })

  test("★ a dropped plan leaves no pinned row, and no older list resurfaces from history", async () => {
    const { latestPlan } = await import("../src/cli/plan.ts")
    const todoPart = (id: string, metadata: Record<string, unknown>) =>
      ({ ...base, id, type: "tool", callID: id, tool: "todo", state: { status: "completed", input: {}, output: "", metadata, time: { start: 0, end: 1 } } }) as ToolPart
    const history = [{ info: { id: "m", role: "assistant" } as never, parts: [
      todoPart("a", { todos: [{ text: "old step", status: "active" }] }),
      todoPart("b", { todos: [], cleared: true }),
    ] as Part[] }]
    expect(latestPlan(history)).toEqual([])
  })

  test("the renderer prints the first list whole and the next update as a delta", () => {
    const lines: string[] = []
    const renderer = new Renderer({ sink: { write: (text) => lines.push(text), get atLineStart() { return true } } })
    const done = (todos: TodoItem[], id: string): UIEvent => ({ type: "tool.state", part: { ...base, id, type: "tool", callID: id, tool: "todo", state: { status: "completed", input: {}, output: "", metadata: { todos }, time: { start: 0, end: 1 } } } as ToolPart })
    renderer.handle(done([{ text: "read it", status: "active" }, { text: "fix it", status: "pending" }], "p1"))
    expect(stripAnsi(lines.join(""))).toContain("fix it")
    lines.length = 0
    renderer.handle(done([{ text: "read it", status: "done" }, { text: "fix it", status: "pending" }], "p2"))
    const delta = stripAnsi(lines.join(""))
    expect(delta).toContain("read it")
    expect(delta).not.toContain("fix it")
  })
})

describe("thinking receipt", () => {
  const render = (reasoning: "off" | "preview" | "full") => {
    const lines: string[] = []
    const renderer = new Renderer({ reasoning, speakers: true, sink: { write: (text) => lines.push(text), get atLineStart() { return true } } })
    return { renderer, text: () => stripAnsi(lines.join("")) }
  }
  const block = reasoning("r", "hmm", { start: 0, end: 8200 })

  test("★ preview leaves one line glued to the call it led to — no signature per tool step, none of the thinking itself", () => {
    const { renderer, text } = render("preview")
    renderer.handle({ type: "message.start", message: {} as never })
    renderer.handle({ type: "part.delta", part: block, delta: "hmm" })
    renderer.handle({ type: "part.end", part: block })
    renderer.handle({ type: "tool.state", part: tool("c", "bash", "running") })
    expect(text()).toBe("\n  ∴ thought 8.2s\n  ● bash \n")
  })

  test("off prints nothing; a sub-second block leaves nothing even in preview", () => {
    const off = render("off")
    off.renderer.handle({ type: "part.end", part: block })
    expect(off.text()).toBe("")
    const quick = render("preview")
    quick.renderer.handle({ type: "part.end", part: reasoning("e", "a quick look", { start: 0, end: 300 }) })
    expect(quick.text()).toBe("")
  })
})

describe("tips", () => {
  test("★ every tip fits the box in every language — it truncates without an ellipsis", () => {
    for (const language of LANGUAGES) {
      setInterfaceLanguage(language)
      for (const tip of allTips()) expect(displayWidth(tip)).toBeLessThanOrEqual(48)
    }
    setInterfaceLanguage("en")
  })

  test("★ the tip is gone for good once the first message is sent — mid-conversation it read as the user's own input", () => {
    const tips = new Tips(() => 0)
    const signals = { ratio: 0.1, staleSessions: 0 }
    expect(tips.current(signals)).toContain("/ for commands")
    tips.dismiss()
    expect(tips.current(signals)).toBeUndefined()
    expect(tips.current({ ...signals, ratio: 0.95, update: "9.9.9" })).toBeUndefined()
  })

  test("chosen once at the first paint — it doesn't change under the reader", () => {
    let roll = 0.9
    const tips = new Tips(() => roll)
    const first = tips.current({ ratio: 0, staleSessions: 0 })
    roll = 0
    expect(tips.current({ ratio: 0, staleSessions: 0 })).toBe(first)
  })

  test("a nearly full context outranks everything", () => {
    expect(new Tips().current({ ratio: TIP_CONTEXT_AT, staleSessions: 0 })).toContain("/compact")
  })

  test("a situational fact wins at launch; an update found later replaces the tip", () => {
    const tips = new Tips(() => 0)
    expect(tips.current({ ratio: 0, mode: "confirm", staleSessions: 0 })).toContain("Shift-Tab")
    expect(tips.current({ ratio: 0, mode: "confirm", update: "1.2.3", staleSessions: 0 })).toContain("/upgrade")
  })

  test("the box draws the tip after a coloured label, and nothing once dismissed", () => {
    setColorEnabled(true)
    try {
      const keyboard = fakeKeyboard(), term = terminal(), tips = new Tips(() => 0)
      const shell = new Shell({ keyboard, region: term.region, editor: new Editor([]), placeholder: () => tips.current({ ratio: 0, staleSessions: 0 }), onSubmit() {}, onCancel() {}, onExit() {} })
      shell.start()
      try {
        expect(term.all()).toContain("tips Type / for commands")
        // the label is coloured and the tip italic, so neither can pass for typed text
        expect(term.frames.join("")).toContain("\u001b[3m")
        tips.dismiss()
        shell.paint()
        expect(stripAnsi(term.frames.at(-1) ?? "")).not.toContain("Type / for commands")
      } finally { shell.stop(); term.region.close(); keyboard.close() }
    } finally { setColorEnabled(false) }
  })
})
