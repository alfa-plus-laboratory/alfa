/**
 * "Make sure this directory exists".
 *
 * It started with an error nobody could make sense of on Windows: the write tool could
 * not create a file in `C:\Users\<me>\Downloads`,
 * `EEXIST: file already exists, mkdir 'C:\Users\me\Downloads'` — yet that directory
 * was plainly there, and the same code writing to any other path worked fine. See the
 * header of src/fs/dir.ts.
 *
 * The real machine was Windows, which we don't have here. But the **shape** of that bug
 * reproduces on POSIX: a symlink pointing at a directory, and an ordinary directory that
 * already exists — neither should make mkdir throw.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureDir, ensureDirSync } from "../src/fs/dir.ts"

let root = ""
const fresh = () => {
  root = mkdtempSync(join(tmpdir(), "apc-dir-"))
  return root
}
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ""
})

describe("ensureDir", () => {
  test("creates a missing directory, several levels at once", async () => {
    const dir = join(fresh(), "a", "b", "c")
    await ensureDir(dir)
    expect(existsSync(dir)).toBe(true)
  })

  test("an existing directory is a no-op and doesn't throw", async () => {
    const dir = join(fresh(), "there")
    mkdirSync(dir)
    await ensureDir(dir)
    expect(existsSync(dir)).toBe(true)
  })

  test("★ a link to a directory isn't mistaken for 'a non-directory is here' — that's how Downloads broke on Windows", async () => {
    const base = fresh()
    const real = join(base, "real")
    const link = join(base, "link")
    mkdirSync(real)
    symlinkSync(real, link, "dir")
    await ensureDir(link)
    expect(existsSync(link)).toBe(true)
    // creating **inside** the link must work too: the write tool needs dirname(target file)
    await ensureDir(join(link, "inner"))
    expect(existsSync(join(real, "inner"))).toBe(true)
  })

  test("concurrent creation of the same directory: nobody loses", async () => {
    const dir = join(fresh(), "race", "deep")
    await Promise.all(Array.from({ length: 8 }, () => ensureDir(dir)))
    expect(existsSync(dir)).toBe(true)
  })

  test("★ a file in the way must throw — that really can't be created", async () => {
    const base = fresh()
    const file = join(base, "occupied")
    writeFileSync(file, "x")
    expect(ensureDir(join(file, "under"))).rejects.toThrow()
  })

  test("the sync version follows the same rules", () => {
    const base = fresh()
    const dir = join(base, "sync", "deep")
    ensureDirSync(dir, { mode: 0o700 })
    expect(existsSync(dir)).toBe(true)
    // the second call is a no-op and does not throw
    ensureDirSync(dir)
    expect(existsSync(dir)).toBe(true)
  })
})
