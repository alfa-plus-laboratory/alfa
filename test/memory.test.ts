/**
 * Project memory: the storage layer (`.alfa/memory/`), the tool (add / delete / list),
 * and how it gets into the context.
 *
 * The groups marked ★ are where it really bites:
 *   - Limits. If notes only ever grow, they eat a chunk of context in **every session**,
 *     and they do it quietly.
 *   - Name normalization. The model will pass `../../etc/passwd`, and this is the only
 *     boundary.
 *   - Attached once, on the first message only. Attaching twice = the same batch of notes
 *     appears twice in the same context.
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

// ─────────────────────────────────────────────── storage layer

describe("discoverMemories", () => {
  test("a missing directory isn't an error, it means 'nothing saved yet'", () => {
    expect(discoverMemories(dir)).toEqual({ memos: [], dropped: 0 })
  })

  test("sorted by file name, with relative paths", () => {
    memo("b-second.md", "second")
    memo("a-first.md", "first")
    const { memos } = discoverMemories(dir)
    expect(memos.map((m) => m.name)).toEqual([`${MEMORY_DIR}/a-first.md`, `${MEMORY_DIR}/b-second.md`])
    expect(memos[0]!.content).toBe("first")
  })

  test("only .md counts; empty files are treated as absent", () => {
    memo("real.md", "keep")
    memo("notes.txt", "ignored")
    memo("blank.md", "   \n\n ")
    const { memos, dropped } = discoverMemories(dir)
    expect(memos).toHaveLength(1)
    expect(memos[0]!.content).toBe("keep")
    // an empty file doesn't count as "dropped" — it had no content to give anyway
    expect(dropped).toBe(0)
  })

  test("★ a note over the size limit is truncated, and marked as such", () => {
    memo("huge.md", "x".repeat(MAX_MEMO_BYTES + 2_000))
    const { memos } = discoverMemories(dir)
    expect(memos[0]!.content).toContain("[... truncated ...]")
  })

  test("★ hitting the count limit: the extras are kept out, and how many is reported", () => {
    for (let i = 0; i < MAX_MEMOS + 5; i++) memo(`note-${String(i).padStart(3, "0")}.md`, `note ${i}`)
    const { memos, dropped } = discoverMemories(dir)
    expect(memos).toHaveLength(MAX_MEMOS)
    expect(dropped).toBe(5)
  })

  test("★ hitting the byte limit keeps notes out too, so memory can't eat the context", () => {
    for (let i = 0; i < 6; i++) memo(`big-${i}.md`, "y".repeat(MAX_MEMO_BYTES))
    const { memos, dropped } = discoverMemories(dir)
    expect(memos.length).toBeLessThan(6)
    expect(dropped).toBeGreaterThan(0)
    const total = memos.reduce((sum, m) => sum + Buffer.byteLength(m.content, "utf8"), 0)
    expect(total).toBeLessThanOrEqual(16 * 1024)
  })
})

describe("★ loaded into context counts as read", () => {
  test("the model can edit its own notes directly without reading them first", () => {
    const path = memo("prefers-bun.md", "the user runs bun, not npm")
    discoverMemories(dir, "ses_1")
    expect(() => assertFresh("ses_1", path, "prefers-bun.md", "edit")).not.toThrow()
    // ★ the ledger is per session: loaded into **this session** doesn't mean anyone else
    // has read it (a subagent has its own session)
    expect(() => assertFresh("ses_other", path, "prefers-bun.md", "edit")).toThrow()
  })

  test("a truncated note doesn't count as read — it lacks the tail, so writing it back would delete the tail", () => {
    const path = memo("huge.md", "x".repeat(MAX_MEMO_BYTES + 2_000))
    discoverMemories(dir, "ses_1")
    expect(() => assertFresh("ses_1", path, "huge.md", "overwrite")).toThrow()
  })
})

describe("renderMemories", () => {
  test("writes nothing when there are no notes", () => {
    expect(renderMemories({ memos: [], dropped: 0 })).toBe("")
  })

  test("includes the path, says the model wrote it, and points at the tool", () => {
    const text = renderMemories({ memos: [{ name: `${MEMORY_DIR}/a.md`, content: "body" }], dropped: 0 })
    expect(text).toContain(`${MEMORY_DIR}/a.md`)
    expect(text).toContain("body")
    expect(text).toContain("memory tool")
  })

  test("★ dropped notes must be mentioned — memory silently missing a few is harder to debug than none", () => {
    expect(renderMemories({ memos: [{ name: "x", content: "y" }], dropped: 3 })).toContain("3 more notes not loaded")
  })
})

// ─────────────────────────────────────────────── the tool

describe("memory tool", () => {
  const run = (args: Parameters<typeof MemoryTool.execute>[0]) => MemoryTool.execute(args, ctx())

  test("save writes a file that the next discover picks up", async () => {
    const result = await run({ action: "save", name: "no-auto-commit", content: "never commit unasked" })
    expect(result.output).toContain("Saved")
    expect(readFileSync(join(dir, MEMORY_DIR, "no-auto-commit.md"), "utf8")).toContain("never commit unasked")
    expect(discoverMemories(dir).memos).toHaveLength(1)
  })

  test("saving under the same name replaces instead of adding another", async () => {
    await run({ action: "save", name: "pref", content: "first" })
    const result = await run({ action: "save", name: "pref", content: "second" })
    expect(result.output).toContain("Replaced")
    const { memos } = discoverMemories(dir)
    expect(memos).toHaveLength(1)
    expect(memos[0]!.content).toBe("second")
  })

  test("delete really deletes; deleting a missing note errors instead of pretending to succeed", async () => {
    await run({ action: "save", name: "gone", content: "x" })
    await run({ action: "delete", name: "gone" })
    expect(existsSync(join(dir, MEMORY_DIR, "gone.md"))).toBe(false)
    expect(run({ action: "delete", name: "gone" })).rejects.toThrow(/No note named/)
  })

  test("list reports the notes left out — exactly the part the model can't see in context", async () => {
    for (let i = 0; i < MAX_MEMOS + 2; i++) memo(`n-${String(i).padStart(3, "0")}.md`, `note ${i}`)
    const result = await run({ action: "list" })
    expect(result.output).toContain("2 more not loaded")
  })

  test("list gives a plain message for an empty directory", async () => {
    expect((await run({ action: "list" })).output).toContain("No notes saved")
  })

  test("★ names are normalized and can't escape the directory", () => {
    expect(slug("No-Auto-Commit")).toBe("no-auto-commit")
    expect(slug("tests_need_redis.md")).toBe("tests-need-redis")
    expect(slug("Note 1")).toBe("note-1")
    // this one is a security boundary: whatever the argument says, it lands inside
    // .alfa/memory/
    expect(slug("../../etc/passwd")).toBe("etc-passwd")
    expect(slug("/absolute/path")).toBe("absolute-path")
    expect(() => slug("///")).toThrow()
    expect(() => slug(undefined)).toThrow()
  })

  test("★ no traversal: given a path, the file still lands in the memory directory", async () => {
    await run({ action: "save", name: "../../escaped", content: "x" })
    expect(existsSync(join(dir, "escaped.md"))).toBe(false)
    expect(existsSync(join(dir, MEMORY_DIR, "escaped.md"))).toBe(true)
  })

  test("★ an oversized note is rejected at write time, not truncated later at read time", async () => {
    expect(run({ action: "save", name: "huge", content: "x".repeat(MAX_MEMO_BYTES + 1) })).rejects.toThrow(
      /limit is/,
    )
    expect(existsSync(join(dir, MEMORY_DIR, "huge.md"))).toBe(false)
  })

  test("★ at the count limit only new notes are blocked; existing ones stay editable", async () => {
    for (let i = 0; i < MAX_MEMOS; i++) memo(`n-${String(i).padStart(3, "0")}.md`, `note ${i}`)
    expect(run({ action: "save", name: "one-more", content: "x" })).rejects.toThrow(/is the limit/)
    // an existing note must stay editable — if the limit blocks corrections, memory only
    // gets more and more wrong
    await run({ action: "save", name: "n-000", content: "corrected" })
    expect(readFileSync(join(dir, MEMORY_DIR, "n-000.md"), "utf8")).toContain("corrected")
  })

  test("save without content errors", () => {
    expect(run({ action: "save", name: "x" })).rejects.toThrow(/content is required/)
  })

  test("goes through the permission gate under the memory permission", async () => {
    await run({ action: "save", name: "a", content: "b" })
    expect(asked).toEqual(["memory"])
  })

  test("a freshly saved note can be edited right away — the read-before-edit gate doesn't block it", async () => {
    await run({ action: "save", name: "fresh", content: "x" })
    expect(() => assertFresh("test", join(dir, MEMORY_DIR, "fresh.md"), "fresh.md", "edit")).not.toThrow()
  })
})

// ─────────────────────────────────────────────── the part that goes into the context

describe("★ how the memory part reaches the model and is counted", () => {
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

  test("goes in as user, ahead of the message — context before the question", () => {
    const messages = toLLMMessages(firstTurn())
    expect(messages).toHaveLength(1)
    const content = messages[0]!.content as Array<{ type: string; text: string }>
    expect(content.map((c) => c.type)).toEqual(["text", "text"])
    expect(content[0]!.text).toContain("MEMO-MARKER")
    expect(content[1]!.text).toBe("帮我改一下")
  })

  test("/context gives it its own row instead of lumping it into system", () => {
    const { slices } = sliceHistory(firstTurn())
    expect(slices.get("memory")!.tokens).toBeGreaterThan(0)
    // it must not count toward "你说的话" (ctxUser, "your messages") — the user didn't
    // say it
    expect(slices.get("user")!.tokens).toBeLessThan(slices.get("memory")!.tokens + 20)
  })

  test("a session with no notes has no memory row", () => {
    const plain: MessageWithParts[] = [
      { info: { id: "u1", sessionID: "s", role: "user", timeCreated: 1 }, parts: [part("u1", { type: "text", text: "hi" })] },
    ]
    expect(sliceHistory(plain).slices.get("memory")).toBeUndefined()
  })
})
