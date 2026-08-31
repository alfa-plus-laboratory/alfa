/**
 * 数据目录解析 + 工具输出落盘区的 GC。
 */
import { readdirSync, statSync, unlinkSync } from "node:fs"
import { ensureDirSync } from "../fs/dir.ts"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * 目录名。和命令名、项目里的 `.alfa/` 对齐。
 *
 * 之前叫 `apcode`,改名**不做兼容**:找不到旧目录就当第一次装。
 * 不自动搬家的理由也在这儿 —— 里面躺着 auth.json,而一次自作主张的 rename
 * 万一中途出错(权限、跨设备、同名目录已存在),用户丢的是 API key,
 * 而他只是启动了一下程序。要搬的人自己 mv 一下,那是一条看得见的命令。
 */
const APP = "alfa"

/** ~/.local/share/alfa(或 $XDG_DATA_HOME/alfa) */
export function dataDir(): string {
  const base = process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share")
  return join(base, APP)
}

/** ~/.config/alfa(或 $XDG_CONFIG_HOME/alfa) */
export function configDir(): string {
  const base = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config")
  return join(base, APP)
}

/** 超限工具输出的落盘区。模型拿到路径后可以用 read/grep 续读。 */
export function toolOutputDir(): string {
  const dir = join(dataDir(), "tool-output")
  ensureDirSync(dir)
  return dir
}

const GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const GC_INTERVAL_MS = 60 * 60 * 1000
const GC_DELAY_MS = 60 * 1000

/**
 * 起一个低频后台 GC,删 7 天前的工具输出文件。
 *
 * 延迟 1 分钟起跑,避开进程启动时的 IO 竞争;unref 掉,不阻止进程退出。
 */
export function startToolOutputGC(): void {
  const sweep = () => {
    let dir: string
    try {
      dir = toolOutputDir()
    } catch {
      return
    }
    const deadline = Date.now() - GC_MAX_AGE_MS
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (!name.startsWith("tool_")) continue
      const path = join(dir, name)
      try {
        if (statSync(path).mtimeMs < deadline) unlinkSync(path)
      } catch {
        // 并发删除/权限问题一律忽略
      }
    }
  }

  const kickoff = setTimeout(() => {
    sweep()
    const timer = setInterval(sweep, GC_INTERVAL_MS)
    timer.unref?.()
  }, GC_DELAY_MS)
  kickoff.unref?.()
}
