/**
 * 「读过没有、读完之后变了没有」的闸门。
 *
 * 这一组测的是**不报错的那类失败**:edit 的模糊级联很能凑合,所以「没读过就改」
 * 和「读完被人改了再改」都会安静地把文件弄坏。断言因此全都盯着同一件事 ——
 * 该抛的时候抛了没有,以及**不该抛的时候别抛**(误伤会让这道闸门被人骂着关掉)。
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

describe("edit 的时新性闸门", () => {
  test("没读过就改 —— 挡下来,而且说清楚该干什么", async () => {
    put("a.ts", "const a = 1\n")
    const failed = await edit("a.ts", "const a = 1", "const a = 2").catch((error: Error) => error)

    expect(failed).toBeInstanceOf(Error)
    expect((failed as Error).message).toContain("have not read it yet")
    expect((failed as Error).message).toContain("read")
    // ★ 最重要的一条:文件没被动过
    expect(text("a.ts")).toBe("const a = 1\n")
  })

  test("读过再改 —— 放行", async () => {
    put("a.ts", "const a = 1\n")
    await read("a.ts")
    await edit("a.ts", "const a = 1", "const a = 2")
    expect(text("a.ts")).toBe("const a = 2\n")
  })

  test("读完之后被别人改了(另一个窗口 / 一条 sed -i)—— 挡下来", async () => {
    put("a.ts", "const a = 1\n")
    await read("a.ts")
    // 模型手里那份从这一刻起就是陈旧的
    put("a.ts", "const a = 1\nconst b = 2\n")

    const failed = await edit("a.ts", "const a = 1", "const a = 2").catch((error: Error) => error)
    expect((failed as Error).message).toContain("changed on disk")
    expect(text("a.ts")).toBe("const a = 1\nconst b = 2\n")
  })

  test("字节数一样但 mtime 变了,照样算过期", async () => {
    put("a.ts", "const a = 1\n")
    await read("a.ts")
    // 同样长度的另一份内容 —— 只看 size 的实现会在这里放行
    put("a.ts", "const a = 9\n")
    const now = statSync(file("a.ts"))
    utimesSync(file("a.ts"), now.atime, new Date(now.mtimeMs + 5_000))

    const failed = await edit("a.ts", "const a = 1", "const a = 2").catch((error: Error) => error)
    expect((failed as Error).message).toContain("changed on disk")
  })

  test("连着改同一个文件:第二刀不会被自己的第一刀判成过期", async () => {
    put("a.ts", "one\ntwo\n")
    await read("a.ts")
    await edit("a.ts", "one", "1")
    await edit("a.ts", "two", "2")
    expect(text("a.ts")).toBe("1\n2\n")
  })

  test("新建不用先读,建完就能接着改", async () => {
    await edit("new.ts", "", "hello\n")
    expect(text("new.ts")).toBe("hello\n")
    await edit("new.ts", "hello", "world")
    expect(text("new.ts")).toBe("world\n")
  })

  test("只读了一段(offset/limit)也算读过 —— 否则大文件永远改不了", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
    put("big.ts", lines)
    await ReadTool.execute({ filePath: file("big.ts"), offset: 1, limit: 5 }, ctx())
    await edit("big.ts", "line 199", "line one-nine-nine")
    expect(text("big.ts")).toContain("line one-nine-nine")
  })

  test("读失败(offset 越界)不记账 —— 它什么也没看到", async () => {
    put("a.ts", "const a = 1\n")
    await ReadTool.execute({ filePath: file("a.ts"), offset: 999 }, ctx()).catch(() => {})
    const failed = await edit("a.ts", "const a = 1", "const a = 2").catch((error: Error) => error)
    expect((failed as Error).message).toContain("have not read it yet")
  })
})

describe("write 的时新性闸门", () => {
  test("覆盖没读过的文件 —— 挡下来。整文件覆盖比局部替换更该拦", async () => {
    put("a.ts", "important\n")
    const failed = await write("a.ts", "replaced\n").catch((error: Error) => error)

    expect((failed as Error).message).toContain("Refusing to overwrite")
    expect(text("a.ts")).toBe("important\n")
  })

  test("读过再覆盖 —— 放行", async () => {
    put("a.ts", "important\n")
    await read("a.ts")
    await write("a.ts", "replaced\n")
    expect(text("a.ts")).toBe("replaced\n")
  })

  test("写新文件不用先读,写完能接着 edit", async () => {
    await write("new.ts", "alpha\n")
    await edit("new.ts", "alpha", "beta")
    expect(text("new.ts")).toBe("beta\n")
  })

  test("写完之后又被别人改了 —— 下一次覆盖要重读", async () => {
    await write("new.ts", "alpha\n")
    put("new.ts", "someone else was here\n")
    const failed = await write("new.ts", "beta\n").catch((error: Error) => error)
    expect((failed as Error).message).toContain("changed on disk")
  })
})

describe("forgetReads:换会话 / 压缩之后", () => {
  test("清账本之后要重读 —— 那时候文件内容确实已经不在它的上下文里了", async () => {
    put("a.ts", "const a = 1\n")
    await read("a.ts")

    forgetReads() // = /clear、/resume、/compact

    const failed = await edit("a.ts", "const a = 1", "const a = 2").catch((error: Error) => error)
    expect((failed as Error).message).toContain("have not read it yet")

    // 重读一遍就恢复正常,不需要别的动作
    await read("a.ts")
    await edit("a.ts", "const a = 1", "const a = 2")
    expect(text("a.ts")).toBe("const a = 2\n")
  })
})

describe("★ 账本按会话分 —— 子 agent 读过不等于主 agent 读过", () => {
  test("另一场读过的文件,这一场照旧要先读", async () => {
    put("a.ts", "one")
    // 子 agent 那一场读了它
    await read("a.ts", "ses_subagent")
    // 主 agent 没读过 —— 闸门必须拦住。一本大账的话这里会**放行**,
    // 而这正是 edit 的模糊级联最容易改错地方的时候
    await expect(edit("a.ts", "one", "two", "ses_main")).rejects.toThrow(/have not read it yet/)
    // 自己读过就放行
    await read("a.ts", "ses_main")
    await edit("a.ts", "one", "two", "ses_main")
    expect(text("a.ts")).toBe("two")
  })

  test("forgetReads 不带参数是全清 —— /clear 之后连子 agent 那几本一起作废", async () => {
    put("b.ts", "one")
    await read("b.ts", "ses_a")
    await read("b.ts", "ses_b")
    forgetReads()
    await expect(edit("b.ts", "one", "two", "ses_a")).rejects.toThrow(/have not read it yet/)
    await expect(edit("b.ts", "one", "two", "ses_b")).rejects.toThrow(/have not read it yet/)
  })
})
