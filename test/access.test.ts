/** Guards real cross-directory behavior, not just the string of some rule. */
import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AccessManager } from "../src/security/access.ts"
import { canonicalPath } from "../src/fs/guard.ts"
import { ReadTool } from "../src/tool/read.ts"
import { EditTool } from "../src/tool/edit.ts"
import { createToolContext } from "../src/tool/context.ts"
import type { AskDecision } from "../src/tool/types.ts"

function fixture(decision: AskDecision = "session") {
  const dir = mkdtempSync(join(tmpdir(), "alfa-access-"))
  const root = join(dir, "a"), other = join(dir, "b")
  mkdirSync(root); mkdirSync(other)
  writeFileSync(join(other, "file.ts"), "export const value = 1\n")
  const requests: string[][] = []
  const access = new AccessManager(root, async request => { requests.push(request.patterns); return decision }, join(dir, "grants.json"))
  const ctx = createToolContext({ cwd: root, root, access, sessionID: dir, ask: async () => {}, onProgress() {}, onMetadata() {} }, { messageID: "m", callID: "c", abortSignal: new AbortController().signal })
  return { dir, root, other, access, ctx, requests, close: () => rmSync(dir, { recursive: true, force: true }) }
}
test("a sibling-repo read grant covers only the exact file; later reads don't ask again", async () => {
  const f = fixture()
  try {
    await ReadTool.execute({ filePath: "../b/file.ts" }, f.ctx)
    await ReadTool.execute({ filePath: "../b/file.ts" }, f.ctx)
    expect(f.requests).toEqual([[canonicalPath(join(f.other, "file.ts"))]])
    expect(f.access.list()[0]?.directory).toBe(false)
  } finally { f.close() }
})
test("external read and edit need separate grants; a granted second root edits without re-asking", async () => {
  const f = fixture()
  try {
    await ReadTool.execute({ filePath: "../b/file.ts" }, f.ctx)
    await EditTool.execute({ filePath: "../b/file.ts", oldString: "value = 1", newString: "value = 2" }, f.ctx)
    expect(f.requests).toHaveLength(2)
    f.access.add(f.other, "write")
    await ReadTool.execute({ filePath: "../b/file.ts" }, f.ctx)
    await EditTool.execute({ filePath: "../b/file.ts", oldString: "value = 2", newString: "value = 3" }, f.ctx)
    expect(f.requests).toHaveLength(2)
  } finally { f.close() }
})
test("symlinks and ancestors of nonexistent paths are authorized by their real path", async () => {
  const f = fixture()
  try {
    symlinkSync(f.other, join(f.root, "link"))
    await ReadTool.execute({ filePath: "link/file.ts" }, f.ctx)
    expect(f.requests[0]).toEqual([canonicalPath(join(f.other, "file.ts"))])
    expect(canonicalPath(join(f.root, "link/new/file.ts"))).toBe(join(canonicalPath(f.other), "new/file.ts"))
  } finally { f.close() }
})
test("revoking asks again; persisted grants survive across instances and can be removed", async () => {
  const f = fixture()
  try {
    f.access.add(f.other, "read", true)
    const loaded = new AccessManager(f.root, async () => "reject", join(f.dir, "grants.json"))
    await loaded.authorize(join(f.other, "file.ts"), f.root, "read")
    loaded.revoke(f.other)
    await expect(loaded.authorize(join(f.other, "file.ts"), f.root, "read")).rejects.toThrow("Permission denied")
    expect(new AccessManager(f.root, async () => "reject", join(f.dir, "grants.json")).list()).toEqual([])
  } finally { f.close() }
})
test("a directory grant has no hidden filename deny list", async () => {
  const f = fixture()
  try {
    mkdirSync(join(f.other, ".ssh")); writeFileSync(join(f.other, ".ssh/id_rsa"), "secret")
    f.access.add(f.other, "write")
    const result = await ReadTool.execute({ filePath: "../b/.ssh/id_rsa" }, f.ctx)
    expect(result.output).toContain("secret")
    expect(f.requests).toHaveLength(0)
  } finally { f.close() }
})
test("a one-time grant isn't kept; revoking invalidates a pending authorization", async () => {
  const f = fixture("once")
  try {
    await f.access.authorize(join(f.other, "file.ts"), f.root, "read")
    expect(f.access.list()).toEqual([])
    let answer!: (decision: AskDecision) => void
    const access = new AccessManager(f.root, () => new Promise(resolve => { answer = resolve }))
    const request = access.authorize(join(f.other, "file.ts"), f.root, "write")
    access.revoke(); answer("always")
    await expect(request).rejects.toThrow("Permission denied")
    expect(access.list()).toEqual([])
  } finally { f.close() }
})

test("system paths stay write-protected after alias resolution", async () => {
  const f = fixture()
  try {
    await expect(f.access.authorize("/etc/alfa-test-file", f.root, "write")).rejects.toThrow("System path is protected")
    expect(f.requests).toHaveLength(0)
  } finally { f.close() }
})
