/**
 * The gate for "has it been read, and has it changed since".
 *
 * This group tests **the kind of failure that raises no error**: edit's fuzzy cascade is
 * very good at making do, so both "editing without reading" and "editing after someone
 * else changed it post-read" quietly corrupt the file. So every assertion watches the
 * same thing — whether it throws when it should, and **doesn't throw when it shouldn't**
 * (false positives would get this gate cursed at and switched off).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { forgetReads } from "../src/fs/freshness.ts"
import { createToolContext } from "../src/tool/context.ts"
import { EditTool } from "../src/tool/edit.ts"
import { ReadTool } from "../src/tool/read.ts"
import { WriteTool } from "../src/tool/write.ts"

let dir: string
let counter = 0

function ctx(sessionID = "test") {
  return createToolContext(
    {
      cwd: dir,
      root: dir,
      sessionID,
      async ask() {},
      onProgress() {},
      onMetadata() {},
    },
    { messageID: "m", callID: `fresh${counter++}`, abortSignal: new AbortController().signal },
  )
}

const file = (name: string) => join(dir, name)
const put = (name: string, text: string) => {
  writeFileSync(file(name), text)
  return file(name)
}
const read = (name: string, sessionID?: string) =>
  ReadTool.execute({ filePath: file(name) }, ctx(sessionID))
const edit = (name: string, oldString: string, newString: string, sessionID?: string) =>
  EditTool.execute({ filePath: file(name), oldString, newString }, ctx(sessionID))
const write = (name: string, content: string) => WriteTool.execute({ filePath: file(name), content }, ctx())
const text = (name: string) => readFileSync(file(name), "utf8")

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "apc-fresh-"))
  forgetReads()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  forgetReads()
})

describe("edit's freshness gate", () => {
  test("editing an unread file is blocked, with a clear next step", async () => {
    put("a.ts", "const a = 1\n")
    const failed = await edit("a.ts", "const a = 1", "const a = 2").catch((error: Error) => error)

    expect(failed).toBeInstanceOf(Error)
    expect((failed as Error).message).toContain("have not read it yet")
    expect((failed as Error).message).toContain("read")
    // ★ the most important one: the file was not touched
    expect(text("a.ts")).toBe("const a = 1\n")
  })

  test("editing after reading is allowed", async () => {
    put("a.ts", "const a = 1\n")
    await read("a.ts")
    await edit("a.ts", "const a = 1", "const a = 2")
    expect(text("a.ts")).toBe("const a = 2\n")
  })

  test("changed by someone else after reading (another window / a sed -i) — blocked", async () => {
    put("a.ts", "const a = 1\n")
    await read("a.ts")
    // from this moment on, the copy the model holds is stale
    put("a.ts", "const a = 1\nconst b = 2\n")

    const failed = await edit("a.ts", "const a = 1", "const a = 2").catch((error: Error) => error)
    expect((failed as Error).message).toContain("changed on disk")
    expect(text("a.ts")).toBe("const a = 1\nconst b = 2\n")
  })

  test("same byte size but a changed mtime still counts as stale", async () => {
    put("a.ts", "const a = 1\n")
    await read("a.ts")
    // different content of the same length — an implementation that only looks at size
    // would allow it here
    put("a.ts", "const a = 9\n")
    const now = statSync(file("a.ts"))
    utimesSync(file("a.ts"), now.atime, new Date(now.mtimeMs + 5_000))

    const failed = await edit("a.ts", "const a = 1", "const a = 2").catch((error: Error) => error)
    expect((failed as Error).message).toContain("changed on disk")
  })

  test("consecutive edits to one file: the second isn't judged stale because of its own first", async () => {
    put("a.ts", "one\ntwo\n")
    await read("a.ts")
    await edit("a.ts", "one", "1")
    await edit("a.ts", "two", "2")
    expect(text("a.ts")).toBe("1\n2\n")
  })

  test("creating a file needs no read, and it can be edited right after", async () => {
    await edit("new.ts", "", "hello\n")
    expect(text("new.ts")).toBe("hello\n")
    await edit("new.ts", "hello", "world")
    expect(text("new.ts")).toBe("world\n")
  })

  test("a partial read (offset/limit) counts as read — otherwise big files could never be edited", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
    put("big.ts", lines)
    await ReadTool.execute({ filePath: file("big.ts"), offset: 1, limit: 5 }, ctx())
    await edit("big.ts", "line 199", "line one-nine-nine")
    expect(text("big.ts")).toContain("line one-nine-nine")
  })

  test("a failed read (offset out of range) isn't recorded — it saw nothing", async () => {
    put("a.ts", "const a = 1\n")
    await ReadTool.execute({ filePath: file("a.ts"), offset: 999 }, ctx()).catch(() => {})
    const failed = await edit("a.ts", "const a = 1", "const a = 2").catch((error: Error) => error)
    expect((failed as Error).message).toContain("have not read it yet")
  })
})

describe("write's freshness gate", () => {
  test("overwriting an unread file is blocked — a whole-file overwrite needs it more than a partial replace", async () => {
    put("a.ts", "important\n")
    const failed = await write("a.ts", "replaced\n").catch((error: Error) => error)

    expect((failed as Error).message).toContain("Refusing to overwrite")
    expect(text("a.ts")).toBe("important\n")
  })

  test("overwriting after reading is allowed", async () => {
    put("a.ts", "important\n")
    await read("a.ts")
    await write("a.ts", "replaced\n")
    expect(text("a.ts")).toBe("replaced\n")
  })

  test("writing a new file needs no read, and edit works right after", async () => {
    await write("new.ts", "alpha\n")
    await edit("new.ts", "alpha", "beta")
    expect(text("new.ts")).toBe("beta\n")
  })

  test("changed by someone else after writing — the next overwrite needs a reread", async () => {
    await write("new.ts", "alpha\n")
    put("new.ts", "someone else was here\n")
    const failed = await write("new.ts", "beta\n").catch((error: Error) => error)
    expect((failed as Error).message).toContain("changed on disk")
  })
})

describe("forgetReads: after switching sessions / compaction", () => {
  test("after the ledger is cleared a reread is required — by then the content really is gone from its context", async () => {
    put("a.ts", "const a = 1\n")
    await read("a.ts")

    forgetReads() // = /clear, /resume, /compact

    const failed = await edit("a.ts", "const a = 1", "const a = 2").catch((error: Error) => error)
    expect((failed as Error).message).toContain("have not read it yet")

    // reading it again restores normal behavior; nothing else is needed
    await read("a.ts")
    await edit("a.ts", "const a = 1", "const a = 2")
    expect(text("a.ts")).toBe("const a = 2\n")
  })
})

describe("★ the ledger is per session — a subagent's read isn't the main agent's read", () => {
  test("a file read in another session still has to be read in this one", async () => {
    put("a.ts", "one")
    // the subagent's session read it
    await read("a.ts", "ses_subagent")
    // the main agent hasn't read it — the gate must block. With one big shared ledger
    // this would be **allowed**, and that's exactly when edit's fuzzy cascade is most
    // likely to change the wrong spot
    await expect(edit("a.ts", "one", "two", "ses_main")).rejects.toThrow(/have not read it yet/)
    // once it has read it itself, allow
    await read("a.ts", "ses_main")
    await edit("a.ts", "one", "two", "ses_main")
    expect(text("a.ts")).toBe("two")
  })

  test("forgetReads with no argument clears everything — after /clear the subagents' ledgers are void too", async () => {
    put("b.ts", "one")
    await read("b.ts", "ses_a")
    await read("b.ts", "ses_b")
    forgetReads()
    await expect(edit("b.ts", "one", "two", "ses_a")).rejects.toThrow(/have not read it yet/)
    await expect(edit("b.ts", "one", "two", "ses_b")).rejects.toThrow(/have not read it yet/)
  })
})
