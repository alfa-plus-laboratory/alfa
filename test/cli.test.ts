/**
 * Rendering and permission confirmation.
 *
 * The point is not "does it look nice" but two behaviors with real consequences:
 *   - edit's diff **must** be printed (that is the precondition for edit being allow by
 *     default)
 *   - the confirmation prompt **must** default to reject in any ambiguous situation
 */
import { uiText } from "../src/i18n/index.ts"
import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { Renderer, commandLines, compact, duration, firstLine, outcomeLine, relativize, shortenPaths, summarize, toolDetails, toolFailed } from "../src/cli/render.ts"
import { askingJob, confirm, looksLikeIme, optionsLine, renderRequest } from "../src/cli/confirm.ts"
import { Editor } from "../src/cli/editor.ts"
import { Keyboard } from "../src/cli/keyboard.ts"
import { LiveRegion } from "../src/cli/live.ts"
import { Shell } from "../src/cli/shell.ts"
import { setColorEnabled } from "../src/cli/theme.ts"
import type { PromptRequest } from "../src/permission/gate.ts"
import type { Key } from "../src/cli/keys.ts"
import { stripAnsi } from "../src/cli/width.ts"
import type { ToolPart } from "../src/session/schema.ts"
import type { UIEvent } from "../src/agent/events.ts"
import { terminalText } from "../src/cli/terminal-text.ts"
import { flowNote, isLiveCommand } from "../src/cli/main.ts"

setColorEnabled(false) // assertions compare plain text

/** The "destination" the renderer needs: takes strings, and knows whether it's at the
 *  start of a line. */
function textSink() {
  const chunks: string[] = []
  return {
    write(text: string) {
      chunks.push(text)
    },
    get atLineStart() {
      const all = chunks.join("")
      return all.length === 0 || all.endsWith("\n")
    },
    text: () => chunks.join(""),
  }
}

/** A fake terminal that can press keys + a Keyboard attached to it. */
function fakeKeyboard(options: { isTTY?: boolean; rawFails?: boolean } = {}) {
  const emitter = new EventEmitter()
  const input = Object.assign(emitter, {
    isTTY: options.isTTY ?? true,
    isRaw: false,
    setRawMode() {
      if (options.rawFails) throw new Error("not a tty after all")
    },
    setEncoding() {},
    resume() {},
    pause() {},
  }) as unknown as NodeJS.ReadStream
  const out = sink()
  return {
    keyboard: new Keyboard(input, out.stream),
    press: (bytes: string) => emitter.emit("data", bytes),
  }
}

/** A fake WriteStream that collects what gets written. */
function sink() {
  const chunks: string[] = []
  const stream = {
    write(text: string) {
      chunks.push(text)
      return true
    },
  } as unknown as NodeJS.WriteStream
  return { stream, text: () => chunks.join("") }
}

/**
 * A sink that can "redraw half a line". Same semantics as Transcript / LiveRegion:
 * write appends, replaceTail commits whole lines + replaces the unfinished part
 * wholesale.
 */
function mdSink() {
  const lines: string[] = []
  let tail = ""
  return {
    write(text: string) {
      tail += text
      const parts = tail.split("\n")
      tail = parts.pop() ?? ""
      for (const line of parts) lines.push(line)
    },
    get atLineStart() {
      return tail.length === 0
    },
    replaceTail(committed: string[], next: string) {
      for (const line of committed) lines.push(line)
      tail = next
    },
    committed: () => [...lines],
    tail: () => tail,
  }
}

const toolPart = (state: ToolPart["state"], tool = "edit"): ToolPart => ({
  id: "prt_1",
  sessionID: "ses_1",
  messageID: "msg_1",
  timeCreated: 1,
  type: "tool",
  callID: "c1",
  tool,
  state,
})

// ─────────────────────────────────────────────── Pure functions

describe("render helpers", () => {
  test("compact", () => {
    expect(compact(0)).toBe("0")
    expect(compact(999)).toBe("999")
    expect(compact(1500)).toBe("1.5k")
    expect(compact(23_400)).toBe("23k")
    expect(compact(2_400_000)).toBe("2.4M")
  })

  test("duration", () => {
    expect(duration(120)).toBe("120ms")
    expect(duration(1500)).toBe("1.5s")
    expect(duration(95_000)).toBe("1m35s")
  })

  test("firstLine skips blank lines and truncates", () => {
    expect(firstLine("\n\n  hello  \nworld")).toBe("hello")
    expect(firstLine("x".repeat(200), 10)).toHaveLength(10)
  })

  test("relativize: relative inside the area, absolute outside", () => {
    expect(relativize("/repo/src/a.ts", "/repo")).toBe("src/a.ts")
    expect(relativize("/repo", "/repo")).toBe(".")
    // A path outside the area must be shown as is — this must not be masked by "it
    // looks short"
    expect(relativize("/etc/passwd", "/repo")).toBe("/etc/passwd")
    expect(relativize("/repo/a.ts", "")).toBe("/repo/a.ts")
  })

  test("summarize: commands verbatim, paths relativized", () => {
    expect(summarize(toolPart({ status: "running", input: { command: "ls -la" }, time: { start: 1 } }), "/repo")).toBe("ls -la")
    expect(summarize(toolPart({ status: "running", input: { filePath: "/repo/src/a.ts" }, time: { start: 1 } }), "/repo")).toBe("src/a.ts")
    expect(summarize(toolPart({ status: "pending" }))).toBe("")
  })

  test("★ summarize: ask shows its question — its input is a questions array, not a top-level field", () => {
    const one = { questions: [{ question: "Which database?", options: [] }] }
    expect(summarize(toolPart({ status: "running", input: one, time: { start: 1 } }))).toBe("Which database?")
    const two = { questions: [{ question: "Which database?", options: [] }, { question: "Which port?", options: [] }] }
    expect(summarize(toolPart({ status: "running", input: two, time: { start: 1 } }))).toBe("Which database? (+1)")
  })

  test("★ summarize: task names the agent and its brief — a blank `● task` hid the one call that spends in the background", () => {
    expect(summarize(toolPart({ status: "running", input: { name: "scout", prompt: "List src/cli\nthen report" }, time: { start: 1 } }, "task"))).toBe("scout · List src/cli")
    expect(summarize(toolPart({ status: "running", input: { resume: "scout", prompt: "also tests" }, time: { start: 1 } }, "task"))).toBe(`scout (${uiText("resume", "唤醒", "再開")}) · also tests`)
  })

  test("outcomeLine prefers metadata over the first line of the model-facing output", () => {
    const edit = toolPart({
      status: "completed",
      input: {},
      output: "<path>/repo/a.ts</path>\nEdit applied successfully.",
      metadata: { additions: 3, deletions: 1, truncated: false },
      time: { start: 1, end: 2 },
    })
    expect(outcomeLine(edit)).toBe("+3 -1")

    const bash = toolPart({
      status: "completed", input: {}, output: "whatever",
      metadata: { exit: 0, truncated: true }, time: { start: 1, end: 2 },
    })
    expect(outcomeLine(bash)).toBe("exit 0 · truncated")

    const killed = toolPart({
      status: "completed", input: {}, output: "x",
      metadata: { exit: null, truncated: false }, time: { start: 1, end: 2 },
    })
    expect(outcomeLine(killed)).toBe("killed")

    // Only fall back to the output's first line when there's no usable metadata
    const bare = toolPart({
      status: "completed", input: {}, output: "just text\nmore", metadata: {}, time: { start: 1, end: 2 },
    })
    expect(outcomeLine(bare)).toBe("just text")

    // When falling back to the first line, paths get shortened, otherwise a line of
    // absolute paths crowds out all the useful information
    const pathy = toolPart({
      status: "completed", input: {}, output: "/repo/src/a.ts\n/repo/src/b.ts", metadata: {},
      time: { start: 1, end: 2 },
    })
    expect(outcomeLine(pathy, "/repo")).toBe("src/a.ts")
  })

  test("shortenPaths replaces every workspace path in a line", () => {
    expect(shortenPaths("<path>/repo/a.ts</path>", "/repo")).toBe("<path>a.ts</path>")
    expect(shortenPaths("/other/a.ts", "/repo")).toBe("/other/a.ts")
    expect(shortenPaths("anything", "")).toBe("anything")
    expect(shortenPaths("/private/var/project/file.ts", "/var/project")).toBe("file.ts")
  })

  test("★ a command's output hangs under one elbow — bare lines read as the model's answer", () => {
    expect(commandLines("  thinking on\n  shown from the next turn", 80, true)).toEqual([
      "  ⎿ thinking on",
      "    shown from the next turn",
    ])
    // A second reply from the same command continues the block rather than opening another
    expect(commandLines("  one more", 80, false)).toEqual(["    one more"])
  })

  test("the common indent is dropped even when the spaces sit inside a color", () => {
    // What theme.dim("  ") + text produces with color on; a plain slice would cut the escape
    const dim = "\u001b[2m  \u001b[22mthinking on"
    const [line] = commandLines(dim + "\n    nested", 80, true)
    expect(stripAnsi(line!)).toBe("  ⎿ thinking on")
    expect(line).toContain("\u001b[2m")
    expect(commandLines(dim + "\n    nested", 80, true)[1]).toBe("      nested")
  })

  test("blank edges are trimmed so the elbow lands on text; inner blanks stay", () => {
    expect(commandLines("\n  a\n\n  b\n", 80, true)).toEqual(["  ⎿ a", "", "    b"])
    expect(commandLines("\n\n", 80, true)).toEqual([])
  })

  test("long lines wrap inside the indent instead of back to column 0", () => {
    const lines = commandLines("x".repeat(30), 20, true)
    expect(lines).toEqual(["  ⎿ " + "x".repeat(16), "    " + "x".repeat(14)])
  })
})

// ─────────────────────────────────────────────── Renderer

describe("Renderer", () => {
  const render = (events: UIEvent[], root = "/repo") => {
    const out = textSink()
    const renderer = new Renderer({ sink: out, root })
    for (const event of events) renderer.handle(event)
    return out.text()
  }

  test("text deltas are written straight through", () => {
    const part = { id: "p", sessionID: "s", messageID: "m", timeCreated: 1, type: "text", text: "" } as const
    const text = render([
      { type: "part.delta", part, delta: "Hel" },
      { type: "part.delta", part, delta: "lo" },
    ])
    expect(text).toBe("Hello")
  })

  test("reasoning is hidden by default, shown only when enabled", () => {
    const part = { id: "p", sessionID: "s", messageID: "m", timeCreated: 1, type: "reasoning", text: "" } as const
    expect(render([{ type: "part.delta", part, delta: "secret thought" }])).toBe("")

    const out = textSink()
    new Renderer({ sink: out, showReasoning: true }).handle({
      type: "part.delta", part, delta: "secret thought",
    })
    expect(out.text()).toBe("secret thought")
  })

  test("★ several answered questions each get a row — the card that asked them is gone once answered", () => {
    const asked = (entries: Array<{ question: string; kind: string; answer: string }>) => toolPart({
      status: "completed", input: {}, output: "The user answered", time: { start: 1, end: 2 },
      metadata: { answer: entries.map(each => each.answer).join(" · "), asked: entries },
    }, "ask")
    const two = render([{ type: "tool.state", part: asked([
      { question: "Which database?", kind: "picked", answer: "Postgres" },
      { question: "Which port?", kind: "cancelled", answer: "cancelled" },
    ]) }])
    expect(two).toContain("    · Which database? → Postgres")
    expect(two).toContain(`    · Which port? → ${uiText("dismissed", "未回答", "答えなし")}`)
    // One question is already whole in the header and ↳; a row would only repeat them
    const one = render([{ type: "tool.state", part: asked([{ question: "Which database?", kind: "picked", answer: "Postgres" }]) }])
    expect(one).not.toContain("·")
  })

  test("★ an edit's diff is always printed", () => {
    const diff = [
      "Index: /repo/a.ts",
      "===================================================================",
      "--- /repo/a.ts",
      "+++ /repo/a.ts",
      "@@ -1,2 +1,2 @@",
      '-const a = 1',
      '+const a = 2',
    ].join("\n")

    const text = render([
      {
        type: "tool.state",
        part: toolPart({
          status: "completed", input: { filePath: "/repo/a.ts" },
          output: "Edit applied successfully.",
          metadata: { additions: 1, deletions: 1, diff }, time: { start: 1, end: 8 },
        }),
      },
    ])
    expect(text).toContain("+const a = 2")
    expect(text).toContain("-const a = 1")
    expect(text).toContain("@@ -1,2 +1,2 @@")
    // ---/+++ and the row of equals signs are for patch(1); not printed
    expect(text).not.toContain("--- /repo/a.ts")
    expect(text).not.toContain("=====")
    // But the file name must stay, as a relative path — with parallel edits it's how you
    // tell whose diff this is
    expect(text).toContain("a.ts")
    expect(text).not.toContain("Index: ")
  })

  test("no diff, no diff block", () => {
    const text = render([
      {
        type: "tool.state",
        part: toolPart({
          status: "completed", input: {}, output: "ok", metadata: {}, time: { start: 1, end: 2 },
        }, "bash"),
      },
    ])
    expect(text).toContain("ok")
    expect(text).not.toContain("@@")
  })

  test("a tool card adds a newline first when the text hasn't ended its line, so nothing misaligns", () => {
    const textPart = { id: "p", sessionID: "s", messageID: "m", timeCreated: 1, type: "text", text: "" } as const
    const text = render([
      { type: "part.delta", part: textPart, delta: "thinking" },
      {
        type: "tool.state",
        part: toolPart({ status: "running", input: { command: "ls" }, time: { start: 1 } }, "bash"),
      },
    ])
    expect(text.startsWith("thinking\n")).toBe(true)
  })

  test("★ parallel calls: the result line names its tool — otherwise it hangs under another tool", () => {
    const readPart = toolPart({ status: "running", input: { filePath: "/repo/a.ts" }, time: { start: 1 } }, "read")
    const globPart = { ...toolPart({ status: "running", input: { pattern: "src/**" }, time: { start: 1 } }, "glob"), id: "prt_2" }
    const readDone = { ...readPart, state: { status: "completed", input: {}, output: "x", metadata: { lines: 2 }, time: { start: 1, end: 3 } } } as ToolPart
    const globDone = { ...globPart, state: { status: "completed", input: {}, output: "y", metadata: { lines: 5 }, time: { start: 1, end: 4 } } } as ToolPart

    // Both ● lines print one after the other, and read's result arrives later — it has to
    // say whose it is
    const text = render([
      { type: "tool.state", part: readPart },
      { type: "tool.state", part: globPart },
      { type: "tool.state", part: readDone },
      { type: "tool.state", part: globDone },
    ])
    expect(text).toContain("read: 2 lines")
    // glob's result comes right after its own header (lastAnnounced is already held by
    // the glob header that came before read's result), so it needs no prefix — but
    // read's must have one
    expect(text.indexOf("read: 2 lines")).toBeGreaterThan(text.indexOf("● glob"))
  })

  test("sequential calls get no extra prefix", () => {
    const part = toolPart({ status: "running", input: { command: "ls" }, time: { start: 1 } }, "bash")
    const done = { ...part, state: { status: "completed", input: {}, output: "ok", metadata: { exit: 0 }, time: { start: 1, end: 2 } } } as ToolPart
    const text = render([
      { type: "tool.state", part },
      { type: "tool.state", part: done },
    ])
    expect(text).toContain("↳ exit 0")
    expect(text).not.toContain("bash: exit 0")
  })

  test("the same state is not drawn twice", () => {
    const part = toolPart({ status: "running", input: { command: "ls" }, time: { start: 1 } }, "bash")
    const text = render([
      { type: "tool.state", part },
      { type: "tool.state", part },
    ])
    expect(text.split("● bash").length - 1).toBe(1)
  })

  test("pending is not drawn — the arguments aren't complete, drawing it would only flicker", () => {
    expect(render([{ type: "tool.state", part: toolPart({ status: "pending" }) }])).toBe("")
  })

  test("the retry notice shows the attempt count and wait time", () => {
    const text = render([
      { type: "retry", attempt: 2, maxAttempts: 8, delayMs: 4000, message: "rate limited" },
    ])
    expect(text).toContain("rate limited")
    expect(text).toContain("4.0s")
    expect(text).toContain("2/8")
  })

  test("the step line shows tokens and cache hits", () => {
    const text = render([
      {
        type: "step.finish",
        part: {
          id: "p", sessionID: "s", messageID: "m", timeCreated: 1, type: "step-finish",
          finishReason: "stop", cost: 0,
          tokens: { input: 3400, output: 71, reasoning: 0, cache: { read: 3300, write: 0 } },
        },
      },
    ])
    expect(text).toContain("3.4k in")
    expect(text).toContain("71 out")
    expect(text).toContain("3.3k cached")
  })
})

// ─────────────────────────────────────────────── Confirmation prompt

describe("permission confirmation", () => {
  const request = (patch: Partial<PromptRequest> = {}): PromptRequest => ({
    permission: "bash",
    patterns: ["rm -rf build"],
    alwaysPatterns: ["rm *"],
    forbidAlways: false,
    ...patch,
  })

  test("★ who is asking: the main agent's own requests carry no source, a subagent's do", () => {
    expect(askingJob(request())).toBeUndefined()
    expect(askingJob(request({ metadata: { job: "调查agent" } }))).toBe("调查agent")
    // An empty string doesn't count — a prompt saying "asked by subagent " is more
    // baffling than saying nothing
    expect(askingJob(request({ metadata: { job: "" } }))).toBeUndefined()
    expect(askingJob(request({ metadata: { job: 7 } }))).toBeUndefined()
  })

  test("★ a subagent's prompt must say who is asking — the user is talking to the main agent at the time", () => {
    expect(renderRequest(request({ metadata: { job: "调查agent" } }))).toContain("asked by subagent 调查agent")
  })

  test("bash subcommands are listed one by one, not crammed into one line", () => {
    const text = renderRequest(
      request({
        patterns: ["git status", "rm -rf build"],
        metadata: { command: "git status && rm -rf build", segments: ["git status", "rm -rf build"] },
      }),
    )
    expect(text).toContain("git status && rm -rf build")
    expect(text).toContain("runs 2 commands")
    expect(text).toContain("• git status")
    expect(text).toContain("• rm -rf build")
  })

  test("a failed command split gets an explicit warning", () => {
    const text = renderRequest(request({ metadata: { command: "weird ' quote", parseOk: false } }))
    expect(text).toContain("could not parse")
  })

  test("risk reasons are listed", () => {
    const text = renderRequest(request({ reasons: ["network access", "elevated privileges"] }))
    expect(text).toContain("network access")
    expect(text).toContain("elevated privileges")
  })

  test("★ with forbidAlways, the always option is not shown at all", () => {
    expect(renderRequest(request({ forbidAlways: false }))).toContain("[a] always")
    expect(renderRequest(request({ forbidAlways: true }))).not.toContain("[a] always")
  })

  test("the always option shows the narrowed scope", () => {
    expect(renderRequest(request({ alwaysPatterns: ["src/*"] }))).toContain("(src/*)")
  })

  test("★ non-TTY blocks execution without attributing a rejection to the user", async () => {
    const out = sink()
    const { keyboard } = fakeKeyboard({ isTTY: false })
    await expect(confirm(request(), { keyboard, output: out.stream })).rejects.toThrow("Approval unavailable")
    expect(out.text()).toContain("operation not executed")
  })

  test("★ no keyboard in -p mode reports unavailable approval", async () => {
    const out = sink()
    await expect(confirm(request(), { output: out.stream })).rejects.toThrow("no interactive input")
  })

  test("★ returns reject immediately when aborted", async () => {
    const out = sink()
    const controller = new AbortController()
    controller.abort()
    const { keyboard } = fakeKeyboard()
    expect(await confirm(request(), { keyboard, output: out.stream, signal: controller.signal })).toBe("reject")
  })

  test("key map: y / enter = once, a = always, n / esc / ctrl-c / ctrl-d = reject", async () => {
    const press = async (bytes: string, forbidAlways = false) => {
      const out = sink()
      const kb = fakeKeyboard()
      const answer = confirm(request({ forbidAlways }), { keyboard: kb.keyboard, output: out.stream })
      await Bun.sleep(5)
      kb.press(bytes)
      return answer
    }

    expect(await press("y")).toBe("once")
    expect(await press("Y")).toBe("once")
    expect(await press("a")).toBe("always")
    expect(await press("n")).toBe("reject")
    // ★ Enter = allow once (what the user explicitly asked for). None of the ways out is
    //   missing: esc / ctrl-c / ctrl-d
    expect(await press("\r")).toBe("once")
    expect(await press("\u001b")).toBe("reject")
    expect(await press("\u0003")).toBe("reject") // Ctrl-C
    expect(await press("\u0004")).toBe("reject") // Ctrl-D
  })

  test("★ arrow keys and pastes are not answers — a stray key must not decide the filesystem's fate", async () => {
    const out = sink()
    const kb = fakeKeyboard()
    const answer = confirm(request(), { keyboard: kb.keyboard, output: out.stream })
    await Bun.sleep(5)
    kb.press("\u001b[A") // ↑
    kb.press("\u001b[200~y\u001b[201~") // a pasted y
    await Bun.sleep(5)
    kb.press("y")
    expect(await answer).toBe("once")
  })

  test("★ with forbidAlways, pressing a does nothing and can't approve by mistake", async () => {
    const out = sink()
    const kb = fakeKeyboard()
    const answer = confirm(request({ forbidAlways: true }), { keyboard: kb.keyboard, output: out.stream })
    await Bun.sleep(5)
    kb.press("a") // should be ignored
    await Bun.sleep(5)
    kb.press("y") // this one counts
    expect(await answer).toBe("once")
  })

  test("reports unavailable when raw mode fails instead of degrading to line reads", async () => {
    const out = sink()
    const { keyboard } = fakeKeyboard({ rawFails: true })
    await expect(confirm(request(), { keyboard, output: out.stream })).rejects.toThrow("Approval unavailable")
    expect(out.text()).toContain("cannot read a key")
  })

  test("★ the live region steps aside while asking and comes back afterwards", async () => {
    const out = sink()
    const calls: string[] = []
    const region = { suspend: () => calls.push("suspend"), resume: () => calls.push("resume") }
    await expect(confirm(request(), { output: out.stream, region })).rejects.toThrow("Approval unavailable")
    expect(calls).toEqual(["suspend", "resume"])
  })
})


// ─────────────────────────────────────────────── Renderer + markdown

describe("★ Renderer markdown channel", () => {
  const textPart = { id: "p", sessionID: "s", messageID: "m", timeCreated: 1, type: "text", text: "" } as const

  const feed = (deltas: string[]) => {
    const out = mdSink()
    const renderer = new Renderer({ sink: out, root: "/repo", markdown: true })
    for (const delta of deltas) renderer.handle({ type: "part.delta", part: textPart, delta })
    return { out, renderer }
  }

  test("body text renders as markdown, markup no longer appears in committed lines", () => {
    const { out, renderer } = feed(["# 标题\n\n一段 **粗体**。\n"])
    renderer.handle({ type: "part.end", part: textPart })
    expect(out.committed()).toEqual(["标题", "", "一段 粗体。"])
  })

  test("★ an unfinished partial line lives in the tail and is replaced whole each time", () => {
    const { out } = feed(["一段 **粗"])
    expect(out.committed()).toEqual([])
    expect(out.tail()).toBe("一段 **粗")

    // Keep feeding until it closes: the tail turns into its rendered form, rather than
    // having another piece appended after it
    const { out: out2 } = feed(["一段 **粗", "体** 了"])
    expect(out2.tail()).toBe("一段 粗体 了")
  })

  test("★ the buffer is flushed before a tool card goes in — otherwise it lands inside an unclosed code block", () => {
    const { out, renderer } = feed(["```py\nx = 1\n"])
    renderer.handle({
      type: "tool.state",
      part: toolPart({ status: "running", input: { command: "ls" }, time: { start: 1 } }, "bash"),
    })
    const lines = out.committed()
    expect(lines[0]).toBe("  py")
    expect(lines[1]).toBe("  │ x = 1")
    expect(lines[2]).toBe("") // one line between tool and body text; commit order unchanged
    expect(lines[3]).toContain("bash")
    // Content already committed must not be emitted again later
    renderer.handle({ type: "part.end", part: textPart })
    expect(out.committed().filter((line) => line.includes("x = 1")).length).toBe(1)
  })

  test("★ on finish, a last line without a newline is still emitted", () => {
    const { out, renderer } = feed(["最后一句没有换行"])
    renderer.handle({ type: "part.end", part: textPart })
    expect(out.committed()).toEqual(["最后一句没有换行"])
    expect(out.tail()).toBe("")
  })

  test("★ a sink that can't redraw the partial line silently falls back to raw text — a half-rendered stall is worse than none", () => {
    const out = textSink()
    const renderer = new Renderer({ sink: out, root: "/repo", markdown: true })
    renderer.handle({ type: "part.delta", part: textPart, delta: "**粗体**" })
    expect(out.text()).toBe("**粗体**")
  })

  test("off by default: -p and piped output stay raw", () => {
    const out = mdSink()
    const renderer = new Renderer({ sink: out, root: "/repo" })
    renderer.handle({ type: "part.delta", part: textPart, delta: "# 标题\n" })
    expect(out.committed()).toEqual(["# 标题"])
  })

  test("reasoning skips markdown and is never appended to the body's partial line", () => {
    const reasoning = { id: "r", sessionID: "s", messageID: "m", timeCreated: 1, type: "reasoning", text: "" } as const
    const out = mdSink()
    const renderer = new Renderer({ sink: out, root: "/repo", markdown: true, showReasoning: true })
    renderer.handle({ type: "part.delta", part: textPart, delta: "正文 **粗体**" })
    renderer.handle({ type: "part.delta", part: reasoning, delta: "# 这不是标题" })
    expect(out.committed()).toEqual(["正文 粗体"])
    expect(out.tail()).toBe("# 这不是标题")
  })
})

// ─────────────────────────────────────────────── Shell: approvals, input, tool output

describe("when the IME swallows the y", () => {
  const request = {
    permission: "bash",
    patterns: ["bash:rm"],
    alwaysPatterns: ["bash:rm -rf *"],
    forbidAlways: false,
    reasons: [],
    metadata: { command: "rm -rf build" },
  } as unknown as PromptRequest

  test("★ the options line puts enter and esc before the letters, spelled out", () => {
    const line = stripAnsi(optionsLine(request))
    expect(line).toContain("[⏎ y]")
    expect(line).toContain("[esc n]")
    // Hinting "enter picks this one" with a capital letter only works for people who
    // already know that convention
    expect(line).not.toContain("[Y]")
  })

  test("★ scope truncation — what gets squeezed out must not be the 'how to reject' half on the right", () => {
    const long = { ...request, alwaysPatterns: ["bash:" + "x".repeat(200)] } as unknown as PromptRequest
    expect(stripAnsi(optionsLine(long))).toContain("[esc n]")
  })

  test("★ the criterion is non-ASCII: kanji/kana can only come from an IME commit, a stray z is just a typo", () => {
    const key = (name: string, text?: string) =>
      ({ name, ctrl: false, meta: false, shift: false, ...(text ? { text } : {}) }) as Key
    expect(looksLikeIme(key("中"))).toBe(true)
    expect(looksLikeIme(key("あ"))).toBe(true)
    expect(looksLikeIme(key("z"))).toBe(false)
    // IME commits sometimes arrive as bracketed paste — that path checks text, not name
    expect(looksLikeIme(key("paste", "你好"))).toBe(true)
    expect(looksLikeIme(key("paste", "hello"))).toBe(false)
  })
})

describe("the agentflow toggle takes effect immediately", () => {
  test("★ the note handed to the model: not from the user, what the state is now, nothing to redo", () => {
    const on = flowNote(6)
    expect(on).toStartWith("Automated message, not from the user.")
    // Both numbers have to be stated. With only the window, the model would split the
    // work to fit 6 — exactly the scale this mode is meant to break
    expect(on).toContain("6 of them running at once")
    expect(on).toMatch(/\d+ subagents in flight/)
    expect(on).toContain("nothing already finished needs redoing")

    const off = flowNote(false)
    expect(off).toContain("switched agentflow off")
    expect(off).toContain("nothing needs redoing")
  })

  /**
   * ★ Slash commands typed mid-run are queued by default (`/clear` switches sessions,
   *   `/compact` folds history — doing those mid-run pulls the ground out from under
   *   it). The ones that only change a single let are the exception: `/agentflow` is
   *   precisely the one the user wants to press **while watching it grind away on its
   *   own**.
   */
  test("★ settings-only commands run at once, ones touching history / the model still queue", () => {
    for (const live of ["/agentflow", "/agentflow on", "/think", "/permission auto", "/view stream", "  /language reply ja  "]) {
      expect(isLiveCommand(live)).toBe(true)
    }
    for (const queued of ["/setting", "/clear", "/compact", "/resume", "/model anthropic/x", "/reset", "/init", "/check", "hello"]) {
      expect(isLiveCommand(queued)).toBe(false)
    }
  })
})

test("approval keys and the Enter right after them don't leak into chat input", async () => {
  const kb = fakeKeyboard(), chat: string[] = [], out = sink()
  const release = kb.keyboard.push(key => { chat.push(key.name) })
  try {
    const answer = confirm({permission:"websearch",patterns:["news"],alwaysPatterns:["*"],forbidAlways:false}, { keyboard: kb.keyboard, output: out.stream })
    kb.press("a\r")
    expect(await answer).toBe("always")
    expect(chat).toEqual([])
  } finally { release(); kb.keyboard.close() }
})

test("slash candidates show in the single-column input area, Tab completes and Enter runs", () => {
  const kb = fakeKeyboard(), frames: string[][] = [], submitted: string[] = []
  const region = { active: true, width: 60, rows: 20, set: (lines: string[]) => frames.push(lines), clear() {} } as unknown as LiveRegion
  const shell = new Shell({ keyboard: kb.keyboard, region, editor: new Editor([]), onSubmit: text => submitted.push(text), onCancel() {}, onExit() {} })
  shell.start()
  try {
    kb.press("/sett")
    expect(frames.at(-1)?.join("\n")).toContain("/setting")
    kb.press("\t\r")
    expect(submitted).toEqual(["/setting"])
  } finally { shell.stop(); kb.keyboard.close() }
})

test("@ candidates show in the input area and Tab completes the workspace path", () => {
  const kb = fakeKeyboard(), frames: string[][] = [], submitted: string[] = []
  const region = { active: true, width: 60, rows: 20, set: (lines: string[]) => frames.push(lines), clear() {} } as unknown as LiveRegion
  const files = (query: string) => query === "src/ma" ? [{ value: "@src/main.ts", hint: "", more: true }] : []
  const shell = new Shell({ keyboard: kb.keyboard, region, editor: new Editor([]), files, onSubmit: text => submitted.push(text), onCancel() {}, onExit() {} })
  shell.start()
  try {
    kb.press("check @src/ma")
    expect(frames.at(-1)?.join("\n")).toContain("@src/main.ts")
    kb.press("\t\r")
    expect(submitted).toEqual(["check @src/main.ts "])
  } finally { shell.stop(); kb.keyboard.close() }
})

test("Ctrl-L clears and redraws the viewport while reasserting keyboard modes", () => {
  const kb = fakeKeyboard(), frames: string[][] = [], controls: string[] = []
  let reasserted = 0
  kb.keyboard.reassert = () => { reasserted += 1 }
  const region = {
    active: true,
    width: 60,
    rows: 20,
    set: (lines: string[]) => frames.push(lines),
    clear() {},
    passthrough: (sequence: string) => controls.push(sequence),
  } as unknown as LiveRegion
  const shell = new Shell({ keyboard: kb.keyboard, region, editor: new Editor([]), onSubmit() {}, onCancel() {}, onExit() {} })
  shell.start()
  try {
    const before = frames.length
    kb.press("\f")
    expect(controls).toHaveLength(1)
    expect(reasserted).toBe(1)
    expect(frames.length).toBeGreaterThan(before)
  } finally { shell.stop(); kb.keyboard.close() }
})

test("the status indicator below the input follows Shift-Tab", async () => {
  const kb = fakeKeyboard(), frames: string[][] = []
  let mode: "confirm" | "default" | "auto" = "auto"
  const region = { active: true, width: 80, rows: 20, set: (lines: string[]) => frames.push(lines), clear() {} } as unknown as LiveRegion
  const shell = new Shell({
    keyboard: kb.keyboard,
    region,
    editor: new Editor([]),
    mode: () => mode,
    setMode: next => { mode = next },
    onSubmit() {},
    onCancel() {},
    onExit() {},
  })
  shell.start()
  try {
    expect(frames.at(-1)?.at(-1)).toContain("auto")
    kb.press("\u001b[Z")
    await Promise.resolve()
    const changed = frames.at(-1)?.at(-1) ?? ""
    expect(changed).toContain("confirm")
    expect(changed).not.toContain("auto")
  } finally { shell.stop(); kb.keyboard.close() }
})

test("a background status repaint never covers a pending approval", async () => {
  const kb = fakeKeyboard(), frames: string[][] = []
  const region = { active: true, width: 60, rows: 20, set: (lines: string[]) => frames.push(lines), clear() {}, write() {}, suspend() {}, resume() {} } as unknown as LiveRegion
  const shell = new Shell({ keyboard: kb.keyboard, region, editor: new Editor([]), onSubmit() {}, onCancel() {}, onExit() {} })
  shell.start()
  try {
    const answer = confirm({permission:"websearch",patterns:["world news"],alwaysPatterns:["*"],forbidAlways:false}, { keyboard: kb.keyboard, region })
    const prompt = frames.at(-1)
    shell.setBusy(true)
    shell.paint()
    expect(frames.at(-1)).toBe(prompt)
    expect(prompt?.join("\n")).toContain("allow once")
    kb.press("s\r")
    expect(await answer).toBe("session")
  } finally { shell.stop(); kb.keyboard.close() }
})


test("a failing exit isn't masked by completed status, and the command's trailing error is directly readable", () => {
  const part = toolPart({ status: "completed", input: { command: "bun test" }, output: "first line\nactual failure\n", metadata: { exit: 1 }, time: { start: 1, end: 20 } }, "bash")
  expect(toolFailed(part)).toBe(true)
  const output = textSink()
  new Renderer({ sink: output }).handle({ type: "tool.state", part })
  const text = output.text()
  expect(text).toContain("✗")
  expect(text).toContain("actual failure")
  const details = toolDetails(part)
  expect(details).toContain("first line\nactual failure")
  expect(details).not.toContain('"output":')
  expect(details).toContain("bun test")
})

test("compact preview truncation is traceable, expanded output keeps the middle lines", () => {
  const part = toolPart({ status: "completed", input: {}, output: Array.from({ length: 12 }, (_, i) => `line-${i}`).join("\n"), metadata: { exit: 0 }, time: { start: 1, end: 20 } }, "bash")
  const out = textSink(), renderer = new Renderer({ sink: out, width: () => 40 })
  renderer.handle({ type: "tool.state", part })
  expect(out.text()).not.toContain("line-0")
  expect(out.text()).toContain(`/detail ${part.callID}`)
  expect(out.text()).toContain("line-11")
  const expanded = textSink(), full = new Renderer({ sink: expanded, width: () => 40, toolOutput: "expanded" })
  full.handle({ type: "tool.state", part })
  expect(expanded.text()).toContain("line-0")
  expect(expanded.text()).toContain("line-11")
})


test("raw tool output can't clear the screen or write the clipboard, control characters are expanded before wrapping", () => {
  const raw = "before\u001b[2J\u001b]52;c;Zm9v\u0007after\rnext\tcell"
  expect(terminalText(raw)).toBe("beforeafter\nnext  cell")
  const part = toolPart({ status: "completed", input: { command: "printf" }, output: raw, metadata: { exit: 0 }, time: { start: 1, end: 2 } }, "bash")
  expect(toolDetails(part)).not.toContain("\u001b")
})

test("tool preview and details use readable output, not the internal meta tag", () => {
  const part = toolPart({ status: "completed", input: { command: "echo ok" }, output: 'ok\n<meta exit="0" />', metadata: { exit: 0, displayOutput: "ok" }, time: { start: 1, end: 20 } }, "bash")
  const out = textSink()
  new Renderer({ sink: out }).handle({ type: "tool.state", part })
  expect(out.text()).toContain("ok")
  expect(out.text()).not.toContain("<meta")
  expect(toolDetails(part)).not.toContain("<meta")
})

test("SSH offers session approval but not persistent approval, and keys match the display", async () => {
  const out = sink(), kb = fakeKeyboard()
  const request: PromptRequest = { permission: "ssh.host", patterns: ["pc1"], alwaysPatterns: [], forbidAlways: true, allowSession: true }
  expect(optionsLine(request)).toContain("[s]")
  expect(optionsLine(request)).not.toContain("[a]")
  const answer = confirm(request, { keyboard: kb.keyboard, output: out.stream })
  await Bun.sleep(5)
  kb.press("a")
  await Bun.sleep(5)
  kb.press("s")
  expect(await answer).toBe("session")
  kb.keyboard.close()
})

/** An overlay on a real LiveRegion, guarding the approval lifecycle where background
 *  output, repaints and key presses all take part. */
function approvalTerminal() {
  const frames: string[] = []
  const output = Object.assign(new EventEmitter(), { columns: 64, rows: 20, isTTY: true, write: (s: string) => { frames.push(s); return true } }) as unknown as NodeJS.WriteStream
  const region = new LiveRegion({ output, enabled: true })
  return { region, output, frames, last: () => stripAnsi(frames.at(-1) ?? "") }
}

test("during approval the draft stays editable, a typed y can't approve, and approval needs an explicit Tab focus switch", async () => {
  const kb = fakeKeyboard(), term = approvalTerminal(), editor = new Editor([])
  const shell = new Shell({ keyboard: kb.keyboard, region: term.region, editor, onSubmit() { throw new Error("must not submit") }, onCancel() {}, onExit() {} })
  editor.setText("还没打完")
  shell.start()
  let ended = false
  const answer = confirm({ permission: "bash", patterns: ["fixture"], alwaysPatterns: [], forbidAlways: true, cause: "mode", metadata: { command: "fixture" } }, { keyboard: kb.keyboard, region: term.region, draft: { editor, restore: () => shell.paint() } }).then(value => { ended = true; return value })
  try {
    expect(term.last()).toContain("还没打完")
    kb.press("yes\r")
    await Bun.sleep(1)
    expect(ended).toBe(false); expect(editor.text).toBe("还没打完yes")
    term.region.write("unrelated tool output\n")
    const frame = term.last()
    expect(frame.indexOf("unrelated tool output")).toBeLessThan(frame.indexOf("Approve"))
    expect(frame).toContain("Tab to approve")
    kb.press("\ty\r")
    expect(await answer).toBe("once")
    expect(editor.text).toBe("还没打完yes")
    expect(term.last()).toContain("还没打完yes")
    expect(term.last()).not.toContain("Approve")
  } finally { shell.stop(); term.region.close(); kb.keyboard.close() }
})

test("★ on the card ⏎ alone still allows once — the cursor starts on the narrowest yes", async () => {
  const kb = fakeKeyboard(), term = approvalTerminal()
  const request: PromptRequest = { permission: "bash", patterns: ["ls"], alwaysPatterns: ["ls *"], forbidAlways: false, metadata: { command: "ls" } }
  try {
    const plain = confirm(request, { keyboard: kb.keyboard, region: term.region })
    expect(term.last()).toContain("❯ 1. allow once")
    kb.press("\r")
    expect(await plain).toBe("once")
    // Moving the cursor is the only way ⏎ means anything else
    const moved = confirm(request, { keyboard: kb.keyboard, region: term.region })
    kb.press("\u001b[B\u001b[B")
    expect(term.last()).toContain("❯ 3. always allow")
    kb.press("\r")
    expect(await moved).toBe("always")
  } finally { term.region.close(); kb.keyboard.close() }
})

test("★ with forbidAlways the always row is gone, and so are its digit and its letter", async () => {
  const kb = fakeKeyboard(), term = approvalTerminal()
  try {
    const answer = confirm({ permission: "bash", patterns: ["ls"], alwaysPatterns: ["ls *"], forbidAlways: true, metadata: { command: "ls" } }, { keyboard: kb.keyboard, region: term.region })
    expect(term.last()).not.toContain("always")
    let ended = false
    void answer.then(() => { ended = true })
    kb.press("a3")
    await Bun.sleep(1)
    expect(ended).toBe(false)
    // Two rows: allow once, reject — so 2 is reject
    kb.press("2")
    expect(await answer).toBe("reject")
  } finally { term.region.close(); kb.keyboard.close() }
})

test("a long approval can expand and scroll to its end, and resize or cancel restores the original input area", async () => {
  const kb = fakeKeyboard(), term = approvalTerminal(), editor = new Editor([])
  const shell = new Shell({ keyboard: kb.keyboard, region: term.region, editor, onSubmit() {}, onCancel() {}, onExit() {} })
  shell.start()
  const controller = new AbortController()
  const command = Array.from({ length: 30 }, (_, i) => `step-${i}`).join("\n")
  const answer = confirm({ permission: "bash", patterns: [command], alwaysPatterns: [], forbidAlways: true, metadata: { command }, signal: controller.signal }, { keyboard: kb.keyboard, region: term.region, draft: { editor, restore: () => shell.paint() } })
  try {
    expect(term.last()).toContain("details")
    kb.press("d")
    for (let i = 0; i < 35; i++) kb.press("\u001b[B")
    expect(term.last()).toContain("step-29")
    Object.assign(term.output, { columns: 28, rows: 12 })
    term.output.emit("resize")
    // The resize repaint runs in a microtask. Without waiting, this asserted the frame
    // from before the resize — which only held while every frame redrew the whole card
    await Promise.resolve()
    expect(term.last()).toContain("reject")
    controller.abort()
    expect(await answer).toBe("reject")
    expect(term.last()).not.toContain("Approve")
  } finally { shell.stop(); term.region.close(); kb.keyboard.close() }
})


test("native patch running summary identifies the operation and nested target path", () => {
  for (const [type, action] of [["create_file", uiText("create", "创建", "作成")], ["update_file", uiText("update", "修改", "更新")], ["delete_file", uiText("delete", "删除", "削除")]]) {
    const part = toolPart({ status: "running", input: { callId: "hidden-call-id", operation: { type, path: "/repo/src/file.ts", diff: "+private contents" } }, time: { start: 1 } }, "apply_patch")
    expect(summarize(part, "/repo")).toBe(`${action} src/file.ts`)
    expect(summarize(part, "/repo")).not.toContain("private contents")
  }
})
