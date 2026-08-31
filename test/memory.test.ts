/**
 * 项目记忆:存取层(`.alfa/memory/`)、工具(增删看)、以及它怎么进上下文。
 *
 * 带 ★ 的几组是真正会咬人的地方:
 *   - 上限。便条只增不减的话,它会**每一场**都吃掉一截上下文,而且悄悄地吃。
 *   - 名字规范化。模型会传 `../../etc/passwd`,而这是唯一一道边界。
 *   - 只在第一句挂一次。挂两次 = 同一批便条在同一条上下文里出现两遍。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MAX_MEMOS,
  MAX_MEMO_BYTES,
  MEMORY_DIR,
  discoverMemories,
  renderMemories,
} from "../src/prompt/memory.ts"
import { MemoryTool, slug } from "../src/tool/memory.ts"
import { createToolContext } from "../src/tool/context.ts"
import { assertFresh, forgetReads } from "../src/fs/freshness.ts"
import { sliceHistory } from "../src/agent/context.ts"
import { toLLMMessages } from "../src/agent/to-model-messages.ts"
import type { MessageWithParts, Part } from "../src/session/schema.ts"

let dir: string
const memo = (name: string, content: string) => {
  const path = join(dir, MEMORY_DIR, name)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, content)
  return path
}

let asked: string[] = []
const ctx = () =>
  createToolContext(
    {
      cwd: dir,
      root: dir,
      sessionID: "test",
      async ask(input) {
        asked.push(input.permission)
      },
      onProgress() {},
      onMetadata() {},
    },
    { messageID: "m", callID: "c1", abortSignal: new AbortController().signal },
  )

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "apc-memory-"))
  asked = []
  forgetReads()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  forgetReads()
})

// ─────────────────────────────────────────────── 存取层

describe("discoverMemories", () => {
  test("没有那个目录不是错,是「还没记过东西」", () => {
    expect(discoverMemories(dir)).toEqual({ memos: [], dropped: 0 })
  })

  test("按文件名排序,带上相对路径", () => {
    memo("b-second.md", "second")
    memo("a-first.md", "first")
    const { memos } = discoverMemories(dir)
    expect(memos.map((m) => m.name)).toEqual([`${MEMORY_DIR}/a-first.md`, `${MEMORY_DIR}/b-second.md`])
    expect(memos[0]!.content).toBe("first")
  })

  test("只认 .md,空文件当没有", () => {
    memo("real.md", "keep")
    memo("notes.txt", "ignored")
    memo("blank.md", "   \n\n ")
    const { memos, dropped } = discoverMemories(dir)
    expect(memos).toHaveLength(1)
    expect(memos[0]!.content).toBe("keep")
    // 空文件不算"被挡掉"—— 它本来就没有内容可给
    expect(dropped).toBe(0)
  })

  test("★ 单条超上限就截断,并且标出来", () => {
    memo("huge.md", "x".repeat(MAX_MEMO_BYTES + 2_000))
    const { memos } = discoverMemories(dir)
    expect(memos[0]!.content).toContain("[... truncated ...]")
  })

  test("★ 条数撞上限:多出来的挡在外面,而且报出来几条", () => {
    for (let i = 0; i < MAX_MEMOS + 5; i++) memo(`note-${String(i).padStart(3, "0")}.md`, `note ${i}`)
    const { memos, dropped } = discoverMemories(dir)
    expect(memos).toHaveLength(MAX_MEMOS)
    expect(dropped).toBe(5)
  })

  test("★ 字节撞上限也一样挡,不会让记忆吃光上下文", () => {
    for (let i = 0; i < 6; i++) memo(`big-${i}.md`, "y".repeat(MAX_MEMO_BYTES))
    const { memos, dropped } = discoverMemories(dir)
    expect(memos.length).toBeLessThan(6)
    expect(dropped).toBeGreaterThan(0)
    const total = memos.reduce((sum, m) => sum + Buffer.byteLength(m.content, "utf8"), 0)
    expect(total).toBeLessThanOrEqual(16 * 1024)
  })
})

describe("★ 装进上下文就算读过", () => {
  test("模型能直接 edit 自己的便条,不用先 read 一遍", () => {
    const path = memo("prefers-bun.md", "the user runs bun, not npm")
    discoverMemories(dir, "ses_1")
    expect(() => assertFresh("ses_1", path, "prefers-bun.md", "edit")).not.toThrow()
    // ★ 账本按会话分:装进**这一场**不等于别人也读过(子 agent 有自己的一场)
    expect(() => assertFresh("ses_other", path, "prefers-bun.md", "edit")).toThrow()
  })

  test("截断过的那条不算读过 —— 它手里少了尾巴,写回去就是把尾巴删了", () => {
    const path = memo("huge.md", "x".repeat(MAX_MEMO_BYTES + 2_000))
    discoverMemories(dir, "ses_1")
    expect(() => assertFresh("ses_1", path, "huge.md", "overwrite")).toThrow()
  })
})

describe("renderMemories", () => {
  test("没有便条就一个字都不写", () => {
    expect(renderMemories({ memos: [], dropped: 0 })).toBe("")
  })

  test("带路径、说清是它自己写的、并指向那个工具", () => {
    const text = renderMemories({ memos: [{ name: `${MEMORY_DIR}/a.md`, content: "body" }], dropped: 0 })
    expect(text).toContain(`${MEMORY_DIR}/a.md`)
    expect(text).toContain("body")
    expect(text).toContain("memory tool")
  })

  test("★ 被挡掉的必须说出来 —— 悄悄少几条的记忆比没有记忆更难查", () => {
    expect(renderMemories({ memos: [{ name: "x", content: "y" }], dropped: 3 })).toContain("3 more notes not loaded")
  })
})

// ─────────────────────────────────────────────── 工具

describe("memory 工具", () => {
  const run = (args: Parameters<typeof MemoryTool.execute>[0]) => MemoryTool.execute(args, ctx())

  test("save 落成一个文件,下一次 discover 就读得到", async () => {
    const result = await run({ action: "save", name: "no-auto-commit", content: "never commit unasked" })
    expect(result.output).toContain("Saved")
    expect(readFileSync(join(dir, MEMORY_DIR, "no-auto-commit.md"), "utf8")).toContain("never commit unasked")
    expect(discoverMemories(dir).memos).toHaveLength(1)
  })

  test("同名再 save 是替换,不是多出一条", async () => {
    await run({ action: "save", name: "pref", content: "first" })
    const result = await run({ action: "save", name: "pref", content: "second" })
    expect(result.output).toContain("Replaced")
    const { memos } = discoverMemories(dir)
    expect(memos).toHaveLength(1)
    expect(memos[0]!.content).toBe("second")
  })

  test("delete 真的删掉;删不存在的那条要报错,而不是假装成功", async () => {
    await run({ action: "save", name: "gone", content: "x" })
    await run({ action: "delete", name: "gone" })
    expect(existsSync(join(dir, MEMORY_DIR, "gone.md"))).toBe(false)
    expect(run({ action: "delete", name: "gone" })).rejects.toThrow(/No note named/)
  })

  test("list 报出被挡在外面的那几条 —— 那正是模型在上下文里看不见的部分", async () => {
    for (let i = 0; i < MAX_MEMOS + 2; i++) memo(`n-${String(i).padStart(3, "0")}.md`, `note ${i}`)
    const result = await run({ action: "list" })
    expect(result.output).toContain("2 more not loaded")
  })

  test("空目录时 list 说人话", async () => {
    expect((await run({ action: "list" })).output).toContain("No notes saved")
  })

  test("★ 名字规范化,而且走不出那个目录", () => {
    expect(slug("No-Auto-Commit")).toBe("no-auto-commit")
    expect(slug("tests_need_redis.md")).toBe("tests-need-redis")
    expect(slug("Note 1")).toBe("note-1")
    // 这一条是安全边界:参数里不管写什么都落在 .alfa/memory/ 里面
    expect(slug("../../etc/passwd")).toBe("etc-passwd")
    expect(slug("/absolute/path")).toBe("absolute-path")
    expect(() => slug("///")).toThrow()
    expect(() => slug(undefined)).toThrow()
  })

  test("★ 遍历不出去:传路径进来,文件还是落在记忆目录里", async () => {
    await run({ action: "save", name: "../../escaped", content: "x" })
    expect(existsSync(join(dir, "escaped.md"))).toBe(false)
    expect(existsSync(join(dir, MEMORY_DIR, "escaped.md"))).toBe(true)
  })

  test("★ 单条超上限在写入那一刻就挡住,而不是留到读的时候截断", async () => {
    expect(run({ action: "save", name: "huge", content: "x".repeat(MAX_MEMO_BYTES + 1) })).rejects.toThrow(
      /limit is/,
    )
    expect(existsSync(join(dir, MEMORY_DIR, "huge.md"))).toBe(false)
  })

  test("★ 条数满了只拦新增,改已经在的那条照旧", async () => {
    for (let i = 0; i < MAX_MEMOS; i++) memo(`n-${String(i).padStart(3, "0")}.md`, `note ${i}`)
    expect(run({ action: "save", name: "one-more", content: "x" })).rejects.toThrow(/is the limit/)
    // 已经在的那条要能改 —— 上限拦住修正,记忆就只会越来越错
    await run({ action: "save", name: "n-000", content: "corrected" })
    expect(readFileSync(join(dir, MEMORY_DIR, "n-000.md"), "utf8")).toContain("corrected")
  })

  test("save 缺内容要报错", () => {
    expect(run({ action: "save", name: "x" })).rejects.toThrow(/content is required/)
  })

  test("走权限门卫,报的是 memory 这个名目", async () => {
    await run({ action: "save", name: "a", content: "b" })
    expect(asked).toEqual(["memory"])
  })

  test("刚写完的便条能立刻 edit —— 不被改前先读那道闸拦下来", async () => {
    await run({ action: "save", name: "fresh", content: "x" })
    expect(() => assertFresh("test", join(dir, MEMORY_DIR, "fresh.md"), "fresh.md", "edit")).not.toThrow()
  })
})

// ─────────────────────────────────────────────── 进上下文的那一段

describe("★ memory part 怎么进模型、怎么算账", () => {
  const part = (messageID: string, extra: Partial<Part> & Pick<Part, "type">): Part =>
    ({ id: `${messageID}-p`, sessionID: "s", messageID, timeCreated: 1, ...extra }) as Part

  const firstTurn = (): MessageWithParts[] => [
    {
      info: { id: "u1", sessionID: "s", role: "user", timeCreated: 1 },
      parts: [
        part("u1", { type: "memory", text: "<project-memory>MEMO-MARKER</project-memory>", notes: 1 }),
        part("u1", { type: "text", text: "帮我改一下" }),
      ],
    },
  ]

  test("以 user 的身份进去,而且排在这句话前面 —— 先给背景再给问题", () => {
    const messages = toLLMMessages(firstTurn())
    expect(messages).toHaveLength(1)
    const content = messages[0]!.content as Array<{ type: string; text: string }>
    expect(content.map((c) => c.type)).toEqual(["text", "text"])
    expect(content[0]!.text).toContain("MEMO-MARKER")
    expect(content[1]!.text).toBe("帮我改一下")
  })

  test("/context 里自成一栏,不再混进 system 那一坨", () => {
    const { slices } = sliceHistory(firstTurn())
    expect(slices.get("memory")!.tokens).toBeGreaterThan(0)
    // 它不该被算成「你说的话」—— 那不是用户说的
    expect(slices.get("user")!.tokens).toBeLessThan(slices.get("memory")!.tokens + 20)
  })

  test("一条便条都没有的会话,memory 那一栏就不存在", () => {
    const plain: MessageWithParts[] = [
      { info: { id: "u1", sessionID: "s", role: "user", timeCreated: 1 }, parts: [part("u1", { type: "text", text: "hi" })] },
    ]
    expect(sliceHistory(plain).slices.get("memory")).toBeUndefined()
  })
})
