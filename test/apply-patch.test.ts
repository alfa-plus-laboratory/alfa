/**
 * Native patch operations must be no weaker than edit/write. These tests use real files
 * and mutate them during approval: an internal mutex cannot protect against an external
 * editor, so successful parser tests alone cannot prove that user changes survive.
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ApplyPatchTool } from "../src/tool/apply-patch.ts"
import { applyV4A } from "../src/tool/patch/v4a.ts"
import { ReadTool } from "../src/tool/read.ts"
import { forgetReads } from "../src/fs/freshness.ts"
import type { AskInput, ToolContext } from "../src/tool/types.ts"

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "alfa-patch-test-")) })
afterEach(() => { forgetReads(); rmSync(root, { recursive: true, force: true }) })
function context(ask: (input: AskInput) => Promise<void> = async () => {}): ToolContext {
  return { cwd: root, root, sessionID: root, messageID: "m", callID: "call_patch", abortSignal: new AbortController().signal, ask, onProgress() {}, metadata() {} }
}
const call = (operation: Parameters<typeof ApplyPatchTool.execute>[0]["operation"], ctx = context()) => ApplyPatchTool.execute({ callId: "call_patch", operation }, ctx)
async function seen(name: string, text: string | Buffer, ctx = context()) {
  writeFileSync(join(root, name), text)
  await ReadTool.execute({ filePath: name }, ctx)
}

test("exact V4A supports ordered hunks, anchors, EOF insertion, and creation without fuzzy replacement", () => {
  expect(applyV4A("user work\nfirst\nx\nsecond\ny\n", "@@ first\n-x\n+X\n@@ second\n-y\n+Y")).toBe("user work\nfirst\nX\nsecond\nY\n")
  expect(applyV4A("a\n", "@@\n+b\n*** End of File")).toBe("a\nb\n")
  expect(applyV4A("", "+hello\n+world\n", true)).toBe("hello\nworld\n")
  expect(() => applyV4A("same\nsame\n", "@@\n-same\n+new")).toThrow("multiple matches")
  expect(() => applyV4A("  old\n", "@@\n-old\n+new")).toThrow("does not match")
  expect(() => applyV4A("a\n", "*** Move to: b\n")).toThrow("Invalid V4A")
})

test("create, update, and delete share diff approval and update their read freshness", async () => {
  const approvals: AskInput[] = []
  const ctx = context(async ask => { approvals.push(ask) })
  await call({ type: "create_file", path: "a.txt", diff: "+first\n+untouched\n" }, ctx)
  const result = await call({ type: "update_file", path: "a.txt", diff: "@@\n-first\n+changed\n untouched" }, ctx)
  expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("changed\nuntouched\n")
  expect(result.metadata.filePath).toContain("a.txt")
  expect(result.metadata.diff).toContain("+changed")
  await call({ type: "delete_file", path: "a.txt" }, ctx)
  expect(existsSync(join(root, "a.txt"))).toBe(false)
  expect(approvals.map(ask => ask.permission)).toEqual(["edit", "edit", "edit"])
  expect(approvals.every(ask => ask.metadata?.preview && ask.patterns[0] === "a.txt")).toBe(true)
})

test("unread and stale existing files cannot be updated or deleted", async () => {
  writeFileSync(join(root, "a"), "old\n")
  await expect(call({ type: "delete_file", path: "a" })).rejects.toThrow("have not read")
  await expect(call({ type: "update_file", path: "a", diff: "@@\n-old\n+new" })).rejects.toThrow("have not read")
  await ReadTool.execute({ filePath: "a" }, context())
  writeFileSync(join(root, "a"), "new user work\n")
  await expect(call({ type: "delete_file", path: "a" })).rejects.toThrow("changed on disk")
  expect(readFileSync(join(root, "a"), "utf8")).toBe("new user work\n")
})

test("all hunks preflight before writing and unrelated user edits survive exact replacement", async () => {
  await seen("a", "uncommitted user line\nold\nlast\n")
  await expect(call({ type: "update_file", path: "a", diff: "@@\n-old\n+new\n@@\n-missing\n+bad" })).rejects.toThrow("does not match")
  expect(readFileSync(join(root, "a"), "utf8")).toBe("uncommitted user line\nold\nlast\n")
  await call({ type: "update_file", path: "a", diff: "@@\n-old\n+new" })
  expect(readFileSync(join(root, "a"), "utf8")).toBe("uncommitted user line\nnew\nlast\n")
})

test("approval-time edits are preserved even if mtime and size are restored", async () => {
  await seen("a", "old\n")
  const path = join(root, "a")
  utimesSync(path, 12345, 12345)
  await ReadTool.execute({ filePath: "a" }, context())
  const original = statSync(path)
  const ctx = context(async () => { writeFileSync(path, "USR\n"); utimesSync(path, original.atime, original.mtime) })
  await expect(call({ type: "update_file", path: "a", diff: "@@\n-old\n+new" }, ctx)).rejects.toThrow("File changed during patch approval")
  expect(readFileSync(path, "utf8")).toBe("USR\n")
  expect(readdirSync(root)).toEqual(["a"])
})

test("denied and aborted patches have no file side effects", async () => {
  const ctx = context(async () => { throw new Error("denied") })
  await expect(call({ type: "create_file", path: "new/a", diff: "+x" }, ctx)).rejects.toThrow("denied")
  expect(readdirSync(root)).toEqual([])
  const controller = new AbortController()
  const abort = context(async () => { controller.abort() }); abort.abortSignal = controller.signal
  await expect(call({ type: "create_file", path: "new/a", diff: "+x" }, abort)).rejects.toThrow("aborted")
  expect(readdirSync(root)).toEqual([])
})

test("create never overwrites an existing file including one created during approval", async () => {
  await seen("a", "user\n")
  await expect(call({ type: "create_file", path: "a", diff: "+bad" })).rejects.toThrow("already exists")
  const ctx = context(async () => { writeFileSync(join(root, "b"), "user\n") })
  await expect(call({ type: "create_file", path: "b", diff: "+bad" }, ctx)).rejects.toThrow()
  expect(readFileSync(join(root, "b"), "utf8")).toBe("user\n")
  expect(readdirSync(root).sort()).toEqual(["a", "b"])
})

test("path traversal and escaping symlinks are rejected", async () => {
  await expect(call({ type: "create_file", path: "../escape", diff: "+bad" })).rejects.toThrow()
  symlinkSync(tmpdir(), join(root, "outside"))
  await expect(call({ type: "create_file", path: "outside/escape", diff: "+bad" })).rejects.toThrow()
})

test("changed symlink targets abort while authorized in-workspace symlinks edit their target", async () => {
  writeFileSync(join(root, "a"), "old\n"); writeFileSync(join(root, "b"), "user\n")
  symlinkSync(join(root, "a"), join(root, "link"))
  await ReadTool.execute({ filePath: "link" }, context())
  const ctx = context(async () => { unlinkSync(join(root, "link")); symlinkSync(join(root, "b"), join(root, "link")) })
  await expect(call({ type: "update_file", path: "link", diff: "@@\n-old\n+new" }, ctx)).rejects.toThrow("target changed")
  expect(readFileSync(join(root, "b"), "utf8")).toBe("user\n")
  await ReadTool.execute({ filePath: "link" }, context())
  await call({ type: "update_file", path: "link", diff: "@@\n-user\n+changed" })
  expect(readFileSync(join(root, "b"), "utf8")).toBe("changed\n")
})

test("BOM, CRLF, and executable mode survive updates; binary and hard-linked files fail closed", async () => {
  await seen("a", "\uFEFFold\r\nkeep\r\n")
  chmodSync(join(root, "a"), 0o755)
  await ReadTool.execute({ filePath: "a" }, context())
  const owner = statSync(join(root, "a"))
  await call({ type: "update_file", path: "a", diff: "@@\n-old\n+new" })
  const updated = statSync(join(root, "a"))
  expect([updated.uid, updated.gid]).toEqual([owner.uid, owner.gid])
  expect(readFileSync(join(root, "a"), "utf8")).toBe("\uFEFFnew\r\nkeep\r\n")
  expect(statSync(join(root, "a")).mode & 0o777).toBe(0o755)
  linkSync(join(root, "a"), join(root, "hard"))
  await expect(call({ type: "delete_file", path: "a" })).rejects.toThrow("hard links")
  writeFileSync(join(root, "binary"), Buffer.from([0xff, 0xfe]))
  // Stamp directly: read intentionally refuses some binaries before granting freshness.
  const { noteRead } = await import("../src/fs/freshness.ts")
  noteRead(root, join(root, "binary"))
  await expect(call({ type: "update_file", path: "binary", diff: "@@\n-a\n+b" })).rejects.toThrow("UTF-8")
})

test("same-file parallel patches serialize approval and keep both changes", async () => {
  await seen("a", "one\ntwo\n")
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const firstApproval = new Promise<void>(resolve => { entered = resolve })
  const first = call({ type: "update_file", path: "a", diff: "@@\n-one\n+ONE" }, context(async () => { entered(); await waiting }))
  await firstApproval
  const second = call({ type: "update_file", path: "a", diff: "@@\n-two\n+TWO" })
  release()
  await Promise.all([first, second])
  expect(readFileSync(join(root, "a"), "utf8")).toBe("ONE\nTWO\n")
})


test("a parent swapped for an escaping symlink during approval creates nothing outside", async () => {
  const outside = mkdtempSync(join(tmpdir(), "alfa-patch-outside-"))
  try {
    mkdirSync(join(root, "parent"))
    const ctx = context(async () => {
      rmSync(join(root, "parent"), { recursive: true })
      symlinkSync(outside, join(root, "parent"))
    })
    await expect(call({ type: "create_file", path: "parent/new/file", diff: "+bad" }, ctx)).rejects.toThrow()
    expect(readdirSync(outside)).toEqual([])
  } finally { rmSync(outside, { recursive: true, force: true }) }
})
