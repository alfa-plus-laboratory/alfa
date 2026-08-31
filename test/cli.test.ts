/**
 * 渲染与权限确认。
 *
 * 重点不是"好不好看",是两条会造成实际后果的行为:
 *   - edit 的 diff **必须**被打印(这是 edit 默认 allow 的前提条件)
 *   - 确认框在任何模糊情况下**必须**默认拒绝
 */
import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { Renderer, compact, duration, firstLine, outcomeLine, relativize, shortenPaths, summarize } from "../src/cli/render.ts"
import { askingJob, confirm, looksLikeIme, optionsLine, renderRequest, trustNote } from "../src/cli/confirm.ts"
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
import { flowNote, isLiveCommand } from "../src/cli/main.ts"

setColorEnabled(false) // 断言里比对纯文本

/** 渲染器要的那个「去处」:收字符串,并且知道自己在不在行首。 */
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

/** 一个能按键的假终端 + 接在上面的 Keyboard。 */
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

/** 假的 WriteStream,收集写入的内容。 */
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
 * 会「重画半行」的 sink。语义和 Transcript / LiveRegion 一致:
 * write 追加,replaceTail 提交整行 + 整个换掉未完成的部分。
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

// ─────────────────────────────────────────────── 纯函数

describe("渲染辅助函数", () => {
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

  test("firstLine 跳过空行并截断", () => {
    expect(firstLine("\n\n  hello  \nworld")).toBe("hello")
    expect(firstLine("x".repeat(200), 10)).toHaveLength(10)
  })

  test("relativize:区内相对,区外保持绝对", () => {
    expect(relativize("/repo/src/a.ts", "/repo")).toBe("src/a.ts")
    expect(relativize("/repo", "/repo")).toBe(".")
    // 越界的路径必须原样显示 —— 这件事不能被"看起来很短"掩盖
    expect(relativize("/etc/passwd", "/repo")).toBe("/etc/passwd")
    expect(relativize("/repo/a.ts", "")).toBe("/repo/a.ts")
  })

  test("summarize:命令原样,路径相对化", () => {
    expect(summarize(toolPart({ status: "running", input: { command: "ls -la" }, time: { start: 1 } }), "/repo")).toBe("ls -la")
    expect(summarize(toolPart({ status: "running", input: { filePath: "/repo/src/a.ts" }, time: { start: 1 } }), "/repo")).toBe("src/a.ts")
    expect(summarize(toolPart({ status: "pending" }))).toBe("")
  })

  test("outcomeLine 优先用 metadata,而不是给模型看的输出首行", () => {
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

    // 没有可用 metadata 时才退回输出首行
    const bare = toolPart({
      status: "completed", input: {}, output: "just text\nmore", metadata: {}, time: { start: 1, end: 2 },
    })
    expect(outcomeLine(bare)).toBe("just text")

    // 退回首行时路径要缩短,否则一行绝对路径把有用信息全挤掉
    const pathy = toolPart({
      status: "completed", input: {}, output: "/repo/src/a.ts\n/repo/src/b.ts", metadata: {},
      time: { start: 1, end: 2 },
    })
    expect(outcomeLine(pathy, "/repo")).toBe("src/a.ts")
  })

  test("shortenPaths 换掉一行里所有工作区路径", () => {
    expect(shortenPaths("<path>/repo/a.ts</path>", "/repo")).toBe("<path>a.ts</path>")
    expect(shortenPaths("/other/a.ts", "/repo")).toBe("/other/a.ts")
    expect(shortenPaths("anything", "")).toBe("anything")
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

  test("文本增量直出", () => {
    const part = { id: "p", sessionID: "s", messageID: "m", timeCreated: 1, type: "text", text: "" } as const
    const text = render([
      { type: "part.delta", part, delta: "Hel" },
      { type: "part.delta", part, delta: "lo" },
    ])
    expect(text).toBe("Hello")
  })

  test("默认不显示 reasoning,开了才显示", () => {
    const part = { id: "p", sessionID: "s", messageID: "m", timeCreated: 1, type: "reasoning", text: "" } as const
    expect(render([{ type: "part.delta", part, delta: "secret thought" }])).toBe("")

    const out = textSink()
    new Renderer({ sink: out, showReasoning: true }).handle({
      type: "part.delta", part, delta: "secret thought",
    })
    expect(out.text()).toBe("secret thought")
  })

  test("★ edit 的 diff 一定会被打印", () => {
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
    // ---/+++ 和等号分隔线是给 patch(1) 看的,不打
    expect(text).not.toContain("--- /repo/a.ts")
    expect(text).not.toContain("=====")
    // 但文件名必须留下,而且是相对路径 —— 并行编辑时靠它分辨这块 diff 是谁的
    expect(text).toContain("a.ts")
    expect(text).not.toContain("Index: ")
  })

  test("没有 diff 就不画 diff 区块", () => {
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

  test("工具卡片在文本没换行时先补一个换行,避免错位", () => {
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

  test("★ 并行调用时,结果行标出是谁的 —— 否则挂在别的工具下面", () => {
    const readPart = toolPart({ status: "running", input: { filePath: "/repo/a.ts" }, time: { start: 1 } }, "read")
    const globPart = { ...toolPart({ status: "running", input: { pattern: "src/**" }, time: { start: 1 } }, "glob"), id: "prt_2" }
    const readDone = { ...readPart, state: { status: "completed", input: {}, output: "x", metadata: { lines: 2 }, time: { start: 1, end: 3 } } } as ToolPart
    const globDone = { ...globPart, state: { status: "completed", input: {}, output: "y", metadata: { lines: 5 }, time: { start: 1, end: 4 } } } as ToolPart

    // 两个 ● 先后打出,read 的结果后到 —— 它必须自报家门
    const text = render([
      { type: "tool.state", part: readPart },
      { type: "tool.state", part: globPart },
      { type: "tool.state", part: readDone },
      { type: "tool.state", part: globDone },
    ])
    expect(text).toContain("read: 2 lines")
    // glob 的结果紧跟在自己的头之后(lastAnnounced 已被 read 的结果之前的 glob 头占住),
    // 所以不需要前缀 —— 但 read 的必须有
    expect(text.indexOf("read: 2 lines")).toBeGreaterThan(text.indexOf("● glob"))
  })

  test("串行调用时不加多余前缀", () => {
    const part = toolPart({ status: "running", input: { command: "ls" }, time: { start: 1 } }, "bash")
    const done = { ...part, state: { status: "completed", input: {}, output: "ok", metadata: { exit: 0 }, time: { start: 1, end: 2 } } } as ToolPart
    const text = render([
      { type: "tool.state", part },
      { type: "tool.state", part: done },
    ])
    expect(text).toContain("↳ exit 0")
    expect(text).not.toContain("bash: exit 0")
  })

  test("同一状态不重复画", () => {
    const part = toolPart({ status: "running", input: { command: "ls" }, time: { start: 1 } }, "bash")
    const text = render([
      { type: "tool.state", part },
      { type: "tool.state", part },
    ])
    expect(text.split("● bash").length - 1).toBe(1)
  })

  test("pending 不画 —— 参数还没齐,画出来只会闪一下", () => {
    expect(render([{ type: "tool.state", part: toolPart({ status: "pending" }) }])).toBe("")
  })

  test("重试提示带上次数和等待时长", () => {
    const text = render([
      { type: "retry", attempt: 2, maxAttempts: 8, delayMs: 4000, message: "rate limited" },
    ])
    expect(text).toContain("rate limited")
    expect(text).toContain("4.0s")
    expect(text).toContain("2/8")
  })

  test("step 行带 token 与缓存命中", () => {
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

// ─────────────────────────────────────────────── 确认框

describe("权限确认", () => {
  const request = (patch: Partial<PromptRequest> = {}): PromptRequest => ({
    permission: "bash",
    patterns: ["rm -rf build"],
    alwaysPatterns: ["rm *"],
    forbidAlways: false,
    ...patch,
  })

  test("★ 谁在要授权:主 agent 自己要的没有出处,子 agent 要的有", () => {
    expect(askingJob(request())).toBeUndefined()
    expect(askingJob(request({ metadata: { job: "调查agent" } }))).toBe("调查agent")
    // 空串不算 —— 一个「asked by subagent 」的框比不写还费解
    expect(askingJob(request({ metadata: { job: "" } }))).toBeUndefined()
    expect(askingJob(request({ metadata: { job: 7 } }))).toBeUndefined()
  })

  test("★ 子 agent 要的框必须写清是谁要的 —— 用户当时正在跟主 agent 说话", () => {
    expect(renderRequest(request({ metadata: { job: "调查agent" } }))).toContain("asked by subagent 调查agent")
  })

  test("★ trust 自动放行:主 agent 的写进对话,子 agent 的一个字都不写", () => {
    const mine = trustNote(request())
    expect(mine?.line).toContain("bash")
    expect(mine?.summary).toContain("without asking")
    // 后台那一场的记录留在它自己的输出里(job output),不该冒到用户这一场来
    expect(trustNote(request({ metadata: { job: "调查agent" } }))).toBeUndefined()
  })

  test("风险标记跟在后面,没有就不留一个空的 ·", () => {
    expect(trustNote(request({ reasons: ["writes outside the workspace"] }))?.line).toContain(
      "writes outside the workspace",
    )
    expect(trustNote(request())?.line).not.toContain("·")
  })

  test("bash 的子命令逐条列出,不挤成一行", () => {
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

  test("拆句失败要显式警告", () => {
    const text = renderRequest(request({ metadata: { command: "weird ' quote", parseOk: false } }))
    expect(text).toContain("could not parse")
  })

  test("风险原因列出来", () => {
    const text = renderRequest(request({ reasons: ["network access", "elevated privileges"] }))
    expect(text).toContain("network access")
    expect(text).toContain("elevated privileges")
  })

  test("★ forbidAlways 时根本不显示 always 选项", () => {
    expect(renderRequest(request({ forbidAlways: false }))).toContain("[a] always")
    expect(renderRequest(request({ forbidAlways: true }))).not.toContain("[a] always")
  })

  test("always 选项显示收窄后的作用域", () => {
    expect(renderRequest(request({ alwaysPatterns: ["src/*"] }))).toContain("(src/*)")
  })

  test("★ 非 TTY 一律拒绝 —— 没人看着不等于随便来", async () => {
    const out = sink()
    const { keyboard } = fakeKeyboard({ isTTY: false })
    expect(await confirm(request(), { keyboard, output: out.stream })).toBe("reject")
    expect(out.text()).toContain("automatically rejected")
  })

  test("★ 完全没给 keyboard 也拒绝(-p 模式)", async () => {
    const out = sink()
    expect(await confirm(request(), { output: out.stream })).toBe("reject")
  })

  test("★ 中断时立刻返回 reject", async () => {
    const out = sink()
    const controller = new AbortController()
    controller.abort()
    const { keyboard } = fakeKeyboard()
    expect(await confirm(request(), { keyboard, output: out.stream, signal: controller.signal })).toBe("reject")
  })

  test("按键映射:y / 回车 = once,a = always,n / esc / ctrl-c / ctrl-d = reject", async () => {
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
    // ★ 回车 = 放行一次(用户明确要的)。走人的路一个没少:esc / ctrl-c / ctrl-d
    expect(await press("\r")).toBe("once")
    expect(await press("\u001b")).toBe("reject")
    expect(await press("\u0003")).toBe("reject") // Ctrl-C
    expect(await press("\u0004")).toBe("reject") // Ctrl-D
  })

  test("★ 方向键和粘贴不算答案 —— 误触不该决定文件系统的命运", async () => {
    const out = sink()
    const kb = fakeKeyboard()
    const answer = confirm(request(), { keyboard: kb.keyboard, output: out.stream })
    await Bun.sleep(5)
    kb.press("\u001b[A") // ↑
    kb.press("\u001b[200~y\u001b[201~") // 粘贴进来一个 y
    await Bun.sleep(5)
    kb.press("y")
    expect(await answer).toBe("once")
  })

  test("★ forbidAlways 时按 a 无效,不会误批", async () => {
    const out = sink()
    const kb = fakeKeyboard()
    const answer = confirm(request({ forbidAlways: true }), { keyboard: kb.keyboard, output: out.stream })
    await Bun.sleep(5)
    kb.press("a") // 应该被忽略
    await Bun.sleep(5)
    kb.press("y") // 这个才算数
    expect(await answer).toBe("once")
  })

  test("拿不到 raw 模式就拒绝,不退化成逐行读", async () => {
    const out = sink()
    const { keyboard } = fakeKeyboard({ rawFails: true })
    expect(await confirm(request(), { keyboard, output: out.stream })).toBe("reject")
    expect(out.text()).toContain("cannot read a key")
  })

  test("★ 问话期间把活动区让开,问完还回去", async () => {
    const out = sink()
    const calls: string[] = []
    const region = { suspend: () => calls.push("suspend"), resume: () => calls.push("resume") }
    await confirm(request(), { output: out.stream, region })
    expect(calls).toEqual(["suspend", "resume"])
  })
})


// ─────────────────────────────────────────────── Renderer + markdown

describe("★ Renderer 的 markdown 通道", () => {
  const textPart = { id: "p", sessionID: "s", messageID: "m", timeCreated: 1, type: "text", text: "" } as const

  const feed = (deltas: string[]) => {
    const out = mdSink()
    const renderer = new Renderer({ sink: out, root: "/repo", markdown: true })
    for (const delta of deltas) renderer.handle({ type: "part.delta", part: textPart, delta })
    return { out, renderer }
  }

  test("正文按 markdown 渲染,标记不再出现在定稿行里", () => {
    const { out, renderer } = feed(["# 标题\n\n一段 **粗体**。\n"])
    renderer.handle({ type: "part.end", part: textPart })
    expect(out.committed()).toEqual(["标题", "", "一段 粗体。"])
  })

  test("★ 没完成的半行放在 tail 里,而且每次都是整条换掉", () => {
    const { out } = feed(["一段 **粗"])
    expect(out.committed()).toEqual([])
    expect(out.tail()).toBe("一段 **粗")

    // 继续喂到闭合:tail 变成渲染后的样子,而不是在后面又接一段
    const { out: out2 } = feed(["一段 **粗", "体** 了"])
    expect(out2.tail()).toBe("一段 粗体 了")
  })

  test("★ 工具卡片插进来之前缓冲要先收口 —— 否则会插进没闭合的代码块中间", () => {
    const { out, renderer } = feed(["```py\nx = 1\n"])
    renderer.handle({
      type: "tool.state",
      part: toolPart({ status: "running", input: { command: "ls" }, time: { start: 1 } }, "bash"),
    })
    const lines = out.committed()
    expect(lines[0]).toBe("  py")
    expect(lines[1]).toBe("  │ x = 1")
    expect(lines[2]).toContain("bash")
    // 收口过的内容不能在后面又吐一遍
    renderer.handle({ type: "part.end", part: textPart })
    expect(out.committed().filter((line) => line.includes("x = 1")).length).toBe(1)
  })

  test("★ 收尾时没换行的最后一行也要吐出来", () => {
    const { out, renderer } = feed(["最后一句没有换行"])
    renderer.handle({ type: "part.end", part: textPart })
    expect(out.committed()).toEqual(["最后一句没有换行"])
    expect(out.tail()).toBe("")
  })

  test("★ sink 不支持重画半行就静默退回原样 —— 渲染一半卡住比不渲染更糟", () => {
    const out = textSink()
    const renderer = new Renderer({ sink: out, root: "/repo", markdown: true })
    renderer.handle({ type: "part.delta", part: textPart, delta: "**粗体**" })
    expect(out.text()).toBe("**粗体**")
  })

  test("默认关着,-p 和管道的输出保持原样", () => {
    const out = mdSink()
    const renderer = new Renderer({ sink: out, root: "/repo" })
    renderer.handle({ type: "part.delta", part: textPart, delta: "# 标题\n" })
    expect(out.committed()).toEqual(["# 标题"])
  })

  test("思考过程不走 markdown,也不会被接到正文那条半行后面", () => {
    const reasoning = { id: "r", sessionID: "s", messageID: "m", timeCreated: 1, type: "reasoning", text: "" } as const
    const out = mdSink()
    const renderer = new Renderer({ sink: out, root: "/repo", markdown: true, showReasoning: true })
    renderer.handle({ type: "part.delta", part: textPart, delta: "正文 **粗体**" })
    renderer.handle({ type: "part.delta", part: reasoning, delta: "# 这不是标题" })
    expect(out.committed()).toEqual(["正文 粗体"])
    expect(out.tail()).toBe("# 这不是标题")
  })
})

// ───────────────────────────────────────────── --plain 的状态行

describe("★ --plain 的状态行也要写着「这是哪」", () => {
  function makeShell(columns: number, workspace?: string) {
    const chunks: string[] = []
    const stream = Object.assign(new EventEmitter(), {
      isTTY: true,
      columns,
      rows: 24,
      write(text: string) {
        chunks.push(text)
        return true
      },
    }) as unknown as NodeJS.WriteStream
    const shell = new Shell({
      region: new LiveRegion({ output: stream, enabled: true }),
      // 键盘只在 start()/stop() 里用得上,这里直接调 paint()
      keyboard: undefined as unknown as Keyboard,
      editor: new Editor(),
      label: () => "test/model",
      ...(workspace ? { workspace } : {}),
      onSubmit() {},
      onCancel() {},
      onExit() {},
    })
    shell.paint()
    return chunks.join("")
  }

  test("路径排在模型名前面 —— 横幅会被输出顶走,状态行不会", () => {
    const out = makeShell(100, "~/code/alfa-workspace")
    expect(out).toContain("~/code/alfa-workspace")
    expect(out.indexOf("~/code")).toBeLessThan(out.indexOf("test/model"))
  })

  test("窄屏上从左边收,留住尾巴", () => {
    expect(makeShell(60, "~/code/alfa-labs/subtools/alfa-workspace")).toContain("…/alfa-workspace")
  })

  test("没给工作区时照旧,不留一个空格子", () => {
    const out = makeShell(100)
    expect(out).toContain("test/model")
    expect(out).not.toContain("·  ·")
  })
})

/**
 * ★ 「开关按了,它还照老样子干」。
 *
 * system prompt 是每一步重建的,所以 `/agentflow` 翻过来之后下一次请求带的
 * 已经是新的那一段 —— 按说立刻生效。真机上不是:一场聊久了的会话里,**历史
 * 比 system 响得多**,模型面前摆着二十轮"我一直是自己动手的"的证据。所以
 * 切换那一刻还要往历史里落一条消息,把它说成一个有位置、有时间的事件。
 */
/**
 * ★ 中日韩输入法开着的时候,`y` 根本到不了这儿 —— 输入法把字母键吃了。
 *
 * 程序无从"处理"那一下(它一个字节都没收到),能做的只有两件:选项行上先写
 * 一条输入法碰不到的路(`[⏎ y]`),以及候选词上屏之后**说一句话**,而不是
 * 静悄悄地无视 —— "按了没反应"正是这件事最难自己想明白的地方。
 */
describe("输入法把 y 吃掉的时候", () => {
  const request = {
    permission: "bash",
    patterns: ["bash:rm"],
    alwaysPatterns: ["bash:rm -rf *"],
    forbidAlways: false,
    reasons: [],
    metadata: { command: "rm -rf build" },
  } as unknown as PromptRequest

  test("★ 选项行上回车和 esc 写在字母前面,而且是写出来的", () => {
    const line = stripAnsi(optionsLine(request))
    expect(line).toContain("[⏎ y]")
    expect(line).toContain("[esc n]")
    // 靠大写去暗示"回车会选这个"只对已经知道那条约定的人生效
    expect(line).not.toContain("[Y]")
  })

  test("★ 作用域截断 —— 挤掉的不能是右边那半句「怎么拒绝」", () => {
    const long = { ...request, alwaysPatterns: ["bash:" + "x".repeat(200)] } as unknown as PromptRequest
    expect(stripAnsi(optionsLine(long))).toContain("[esc n]")
  })

  test("★ 判据是非 ASCII:汉字/假名只可能是上屏来的,打错的 z 只是打错了", () => {
    const key = (name: string, text?: string) =>
      ({ name, ctrl: false, meta: false, shift: false, ...(text ? { text } : {}) }) as Key
    expect(looksLikeIme(key("中"))).toBe(true)
    expect(looksLikeIme(key("あ"))).toBe(true)
    expect(looksLikeIme(key("z"))).toBe(false)
    // 上屏有时候走括号粘贴 —— 那一路认的是 text,不是 name
    expect(looksLikeIme(key("paste", "你好"))).toBe(true)
    expect(looksLikeIme(key("paste", "hello"))).toBe(false)
  })
})

describe("agentflow 开关立刻生效", () => {
  test("★ 塞给模型那句话:不是用户说的、现在是什么状态、不用回头重做", () => {
    const on = flowNote(6)
    expect(on).toStartWith("Automated message, not from the user.")
    // 两个数都要写。只写窗口的话,模型会照着 6 去拆活儿 —— 那正是这个模式
    // 要打破的那个规模
    expect(on).toContain("6 of them running at once")
    expect(on).toMatch(/\d+ subagents in flight/)
    expect(on).toContain("nothing already finished needs redoing")

    const off = flowNote(false)
    expect(off).toContain("switched agentflow off")
    expect(off).toContain("nothing needs redoing")
  })

  /**
   * ★ 跑到一半敲的斜杠命令默认是排队的(`/clear` 换会话、`/compact` 折历史 ——
   *   跑到一半动它们就是把脚下的地抽掉)。而只改一个 let 的那几条是例外:
   *   `/agentflow` 恰恰是用户在**看着它埋头自己干**的时候才想按的那一个。
   */
  test("★ 只改设置的当场就办,碰历史 / 碰模型的照旧排队", () => {
    for (const live of ["/agentflow", "/agentflow on", "/think", "/permission trust", "/view stream", "/setting", "  /language reply ja  "]) {
      expect(isLiveCommand(live)).toBe(true)
    }
    for (const queued of ["/clear", "/compact", "/resume", "/model anthropic/x", "/reset", "/init", "/check", "hello"]) {
      expect(isLiveCommand(queued)).toBe(false)
    }
  })
})
