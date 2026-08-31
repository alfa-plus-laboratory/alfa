/**
 * 「确保这个目录在」。
 *
 * 起因是 Windows 上一句谁也看不懂的报错:write 工具在 `C:\Users\<me>\Downloads`
 * 里建不出文件,`EEXIST: file already exists, mkdir 'C:\Users\me\Downloads'` ——
 * 而那个目录明明就在,同一段代码写到别的路径一切正常。见 src/fs/dir.ts 文件头。
 *
 * 真机是 Windows,这儿没有。但那件事的**形状**在 POSIX 上复现得出来:一个指向
 * 目录的符号链接,和一个已经存在的普通目录,两种都不该让 mkdir 抛出来。
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
  test("不存在就建出来,连着几层一起", async () => {
    const dir = join(fresh(), "a", "b", "c")
    await ensureDir(dir)
    expect(existsSync(dir)).toBe(true)
  })

  test("已经在了就什么都不做,也不抛", async () => {
    const dir = join(fresh(), "there")
    mkdirSync(dir)
    await ensureDir(dir)
    expect(existsSync(dir)).toBe(true)
  })

  test("★ 指向目录的链接不能被当成「这儿有个非目录的东西」 —— Windows 上那个 Downloads 就是这么炸的", async () => {
    const base = fresh()
    const real = join(base, "real")
    const link = join(base, "link")
    mkdirSync(real)
    symlinkSync(real, link, "dir")
    await ensureDir(link)
    expect(existsSync(link)).toBe(true)
    // 建到链接**里面**也要成:write 工具要的是 dirname(目标文件)
    await ensureDir(join(link, "inner"))
    expect(existsSync(join(real, "inner"))).toBe(true)
  })

  test("同一个目录并发建,不该有人输", async () => {
    const dir = join(fresh(), "race", "deep")
    await Promise.all(Array.from({ length: 8 }, () => ensureDir(dir)))
    expect(existsSync(dir)).toBe(true)
  })

  test("★ 那儿摆着一个文件的话必须照实抛 —— 那是真的建不了", async () => {
    const base = fresh()
    const file = join(base, "occupied")
    writeFileSync(file, "x")
    expect(ensureDir(join(file, "under"))).rejects.toThrow()
  })

  test("同步版本同一套规矩", () => {
    const base = fresh()
    const dir = join(base, "sync", "deep")
    ensureDirSync(dir, { mode: 0o700 })
    expect(existsSync(dir)).toBe(true)
    // 第二次是个空操作,不抛
    ensureDirSync(dir)
    expect(existsSync(dir)).toBe(true)
  })
})
