/**
 * ↑ 键翻得到的历史,跨会话保留。
 *
 * 和 shell history 一个性质:里面是用户自己敲过的话,不含密钥,但也不是给
 * 别人看的。所以放在 home 下、权限 0600,不进项目目录。
 *
 * 多行输入用 \n 存不了(一条会被读成好几条),这里编码成 \\n —— 反斜杠本身
 * 先转义成 \\\\,顺序反了会把用户原文里的 `\n` 两个字符也变成换行。
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { ensureDirSync } from "../fs/dir.ts"
import { dirname, join } from "node:path"
import { dataDir } from "../util/xdg.ts"

const MAX_ENTRIES = 500

export function historyPath(): string {
  return join(dataDir(), "history")
}

function encode(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")
}

function decode(line: string): string {
  return line.replace(/\\(.)/g, (_, char: string) => (char === "n" ? "\n" : char))
}

export function loadHistory(path = historyPath()): string[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map(decode)
      .slice(-MAX_ENTRIES)
  } catch {
    return [] // 没有历史不是错误
  }
}

export function appendHistory(text: string, path = historyPath()): void {
  if (text.trim().length === 0) return
  try {
    ensureDirSync(dirname(path), { mode: 0o700 })
    appendFileSync(path, encode(text) + "\n", { mode: 0o600 })
  } catch {
    // 历史写不进去不该影响干活
  }
}

/** 超长了裁一次。启动时调一次就够,不必每次追加都算。 */
export function trimHistory(path = historyPath()): void {
  try {
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
    if (lines.length <= MAX_ENTRIES) return
    writeFileSync(path, lines.slice(-MAX_ENTRIES).join("\n") + "\n", { mode: 0o600 })
  } catch {
    // 同上
  }
}
