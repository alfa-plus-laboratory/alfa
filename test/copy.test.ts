/**
 * ctrl-y:复制什么、复制出去的是什么、以及怎么发出去。
 *
 * 这里盯的是三类错:
 *   - 复制到**屏幕上的样子**而不是内容(带边框、折过行)
 *   - 复制到**用户从没见过的文字**(合成消息)
 *   - 在 tmux 里"按了没反应"(透传没包对)
 */
import { describe, expect, test } from "bun:test"
import { codeBlocks, copyRow, copyTargets, humanBytes } from "../src/tui/panes/copy.ts"
import { MAX_CLIPBOARD_BYTES, writeClipboard } from "../src/cli/clipboard.ts"
import type { MessageWithParts } from "../src/session/schema.ts"
import { setColorEnabled } from "../src/cli/theme.ts"
import { displayWidth, stripAnsi } from "../src/cli/width.ts"

setColorEnabled(false)

let seq = 0
function message(role: "user" | "assistant", text: string, synthetic = false): MessageWithParts {
  const id = `m${seq++}`
  return {
    info: { id, sessionID: "s", role, timeCreated: seq } as MessageWithParts["info"],
    parts: [
      {
        id: `p${seq++}`,
        sessionID: "s",
        messageID: id,
        timeCreated: seq,
        type: "text",
        text,
        ...(synthetic ? { synthetic: true } : {}),
      } as MessageWithParts["parts"][number],
    ],
  }
}

function sink() {
  const chunks: string[] = []
  return { stream: { write: (text: string) => chunks.push(text) } as unknown as NodeJS.WriteStream, all: () => chunks.join("") }
}

describe("围栏代码块", () => {
  test("语言和内容都取出来", () => {
    expect(codeBlocks("hi\n```ts\nconst a = 1\n```\nbye")).toEqual([{ language: "ts", code: "const a = 1" }])
  })

  test("没写语言也认", () => {
    expect(codeBlocks("```\necho hi\n```")).toEqual([{ language: "", code: "echo hi" }])
  })

  // ``` 里面嵌 ~~~ 是真实写法(在 markdown 里展示 markdown)。
  // 按任意围栏收口的话,那种块会被从中间截断
  test("★ 收口只认同一种围栏字符", () => {
    const blocks = codeBlocks("~~~md\n```ts\nx\n```\n~~~")
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.code).toBe("```ts\nx\n```")
  })

  test("没收口的那一段整个不算 —— 半截代码贴出去比没有更糟", () => {
    expect(codeBlocks("```ts\nconst a = 1")).toEqual([])
  })

  // 缩进四格的代码块和一段缩进的列表项在字符上没有区别
  test("缩进式的不认", () => {
    expect(codeBlocks("    const a = 1")).toEqual([])
  })

  test("空块丢掉", () => {
    expect(codeBlocks("```ts\n\n```")).toEqual([])
  })
})

describe("单子上列什么", () => {
  test("代码块排在整段回答前面 —— 要的十有八九是代码", () => {
    const targets = copyTargets([message("user", "do it"), message("assistant", "sure\n```sh\nls\n```")])
    expect(targets.map((one) => one.kind)).toEqual(["code", "reply", "prompt", "session"])
    expect(targets[0]?.text).toBe("ls")
  })

  test("没有代码块时第一行就是整段回答", () => {
    const targets = copyTargets([message("user", "hi"), message("assistant", "hello")])
    expect(targets.map((one) => one.kind)).toEqual(["reply", "prompt", "session"])
  })

  // 一轮里模型常常先说一句"我看一下"、调几个工具、再给结论。中间那些只调工具
  // 不说话的消息在库里也是 assistant —— 取到它就是复制了一段空的
  test("★ 取最后一条**有正文的** assistant,不是最后一条 assistant", () => {
    const targets = copyTargets([
      message("user", "go"),
      message("assistant", "the answer"),
      message("assistant", ""),
    ])
    expect(targets.find((one) => one.kind === "reply")?.text).toBe("the answer")
  })

  // 用户从没在屏幕上见过合成消息。复制出去等于交给他一段他不认识的文字,
  // 而他会以为那是模型说的
  test("★ 合成消息一个字都不进去", () => {
    const targets = copyTargets([
      message("user", "real question"),
      message("user", "<system-reminder>injected</system-reminder>", true),
      message("assistant", "answer"),
    ])
    expect(targets.find((one) => one.kind === "prompt")?.text).toBe("real question")
    expect(targets.find((one) => one.kind === "session")?.text).not.toContain("system-reminder")
  })

  test("整场对话用 > 标出人说的那半", () => {
    const whole = copyTargets([message("user", "a\nb"), message("assistant", "c")]).find(
      (one) => one.kind === "session",
    )
    expect(whole?.text).toBe("> a\n> b\n\nc")
  })

  test("什么都没有就是空单子", () => {
    expect(copyTargets([])).toEqual([])
  })
})

describe("一行的样子", () => {
  test("字节数靠右定宽,各行对得齐", () => {
    const rows = [
      copyRow({ kind: "code", label: "ts", hint: "const a = 1", text: "x".repeat(400) }, { width: 60, selected: false }),
      copyRow({ kind: "reply", label: "reply", hint: "hello", text: "y" }, { width: 60, selected: false }),
    ].map(stripAnsi)
    expect(rows.every((row) => displayWidth(row) <= 60)).toBe(true)
    expect(rows[0]!.endsWith("400 B  ")).toBe(true)
  })

  test("选中行整行等宽 —— 右边缺一截看着像画坏了", () => {
    const row = copyRow({ kind: "reply", label: "reply", hint: "hi", text: "y" }, { width: 40, selected: true })
    expect(displayWidth(stripAnsi(row))).toBe(40)
  })

  test("humanBytes 按 UTF-8 算,不按字符数", () => {
    expect(humanBytes("abc")).toBe("3 B")
    expect(humanBytes("中")).toBe("3 B")
    expect(humanBytes("x".repeat(2048))).toBe("2.0 kB")
  })
})

describe("OSC 52", () => {
  test("base64 之后用 BEL 收口", () => {
    const out = sink()
    writeClipboard("hi", out.stream, {})
    expect(out.all()).toBe("\u001b]52;c;aGk=\u0007")
  })

  // 不翻倍的话 tmux 会在第一个 ESC 上把透传截断,剩下的 base64 原样打在屏幕上
  test("★ tmux 里内层的 ESC 要翻倍", () => {
    const out = sink()
    writeClipboard("hi", out.stream, { TMUX: "/tmp/tmux-1000/default,1,0" })
    expect(out.all()).toBe("\u001bPtmux;\u001b\u001b]52;c;aGk=\u0007\u001b\\")
  })

  test("screen 里切成多条 DCS", () => {
    const out = sink()
    writeClipboard("x".repeat(2000), out.stream, { STY: "1.pts-0" })
    const written = out.all()
    expect(written.startsWith("\u001bP\u001b]52;c;")).toBe(true)
    expect(written.split("\u001bP").length).toBeGreaterThan(2)
  })

  // 超长的下场不是截断,是整条被终端丢掉 —— 也就是"按了没反应"
  test("★ 夹断而且如实报出来", () => {
    const out = sink()
    const result = writeClipboard("x".repeat(MAX_CLIPBOARD_BYTES + 10), out.stream, {})
    expect(result.clipped).toBe(true)
    expect(result.bytes).toBe(MAX_CLIPBOARD_BYTES)
  })

  test("刚好装得下的不算夹断", () => {
    const result = writeClipboard("x".repeat(MAX_CLIPBOARD_BYTES), sink().stream, {})
    expect(result.clipped).toBe(false)
  })

  test("多字节内容按字节算,不按字符算", () => {
    const result = writeClipboard("中".repeat(10), sink().stream, {})
    expect(result.bytes).toBe(30)
  })
})
