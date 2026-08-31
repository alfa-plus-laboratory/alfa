/**
 * 「确保这个目录在」。
 *
 * ── 为什么不直接 mkdir(recursive: true) ──
 * 按 POSIX 的说法它对已存在的目录是幂等的,而**在 Windows 上不是**。用户实测:
 *
 *   EEXIST: file already exists, mkdir 'C:\Users\river\Downloads'
 *
 * 而那个目录明明就在。`Downloads`、`Documents`、`Desktop` 这几个在现在的 Windows
 * 上常常不是普通目录,而是**重解析点**(OneDrive 的已知文件夹转移、或者用户自己
 * 把它挪到了别的盘,原地留一个 junction)。递归 mkdir 撞到 EEXIST 之后要判断
 * 「已经在的这个是不是目录」,而那一步看的是链接本身而不是它指向的东西 ——
 * 于是结论是"这儿有个非目录的东西",抛 EEXIST。
 *
 * 表现出来是:write 工具在用户的下载目录里一个文件都建不出来,而同一段代码
 * 写到别处一切正常,`touch` 也正常 —— 最难查的那一类。
 *
 * ── 两条防线 ──
 * 1. 已经在了就**根本不 mkdir**(existsSync 跟着链接走,junction 上是 true)。
 * 2. 万一还是抛了 EEXIST,再确认一次它在,在就当成功 —— 并发建同一个目录时
 *    也是这条路。真的不在才把错误抛出去。
 */
import { existsSync, mkdirSync } from "node:fs"
import { mkdir } from "node:fs/promises"

export interface EnsureDirOptions {
  /** 新建时的权限位。已经存在的目录**不改** —— 那是用户的目录,不是我们的 */
  mode?: number
}

export async function ensureDir(dir: string, options: EnsureDirOptions = {}): Promise<void> {
  if (existsSync(dir)) return
  try {
    await mkdir(dir, { recursive: true, ...(options.mode === undefined ? {} : { mode: options.mode }) })
  } catch (error) {
    if (!settled(error, dir)) throw error
  }
}

export function ensureDirSync(dir: string, options: EnsureDirOptions = {}): void {
  if (existsSync(dir)) return
  try {
    mkdirSync(dir, { recursive: true, ...(options.mode === undefined ? {} : { mode: options.mode }) })
  } catch (error) {
    if (!settled(error, dir)) throw error
  }
}

/** 报错但目录确实在 = 这件事已经成了(别人先建的,或者上面那个 Windows 的坑) */
function settled(error: unknown, dir: string): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return (code === "EEXIST" || code === "EPERM") && existsSync(dir)
}
