/**
 * 落文件的调试日志。
 *
 * 铁律:绝不 console.log 到 stdout —— stdout 是流式渲染的独占通道,
 * 混进一行日志就会把正在打字的文本撕开。
 */
import { appendFileSync } from "node:fs"
import { ensureDirSync } from "../fs/dir.ts"
import { dirname, join } from "node:path"
import { dataDir } from "./xdg.ts"
import { readEnv } from "../env/vars.ts"

const ENABLED = readEnv("DEBUG") === "1"

let logPath: string | undefined

function target(): string {
  if (!logPath) {
    logPath = join(dataDir(), "log", `${new Date().toISOString().slice(0, 10)}.log`)
    ensureDirSync(dirname(logPath))
  }
  return logPath
}

function write(level: string, scope: string, message: string, extra?: unknown) {
  if (!ENABLED) return
  const line =
    [new Date().toISOString(), level, scope, message].join(" ") +
    (extra === undefined ? "" : " " + safeJson(extra)) +
    "\n"
  try {
    appendFileSync(target(), line)
  } catch {
    // 日志写不进去不能影响主流程
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function logger(scope: string) {
  return {
    debug: (message: string, extra?: unknown) => write("DEBUG", scope, message, extra),
    info: (message: string, extra?: unknown) => write("INFO ", scope, message, extra),
    warn: (message: string, extra?: unknown) => write("WARN ", scope, message, extra),
    error: (message: string, extra?: unknown) => write("ERROR", scope, message, extra),
  }
}

export const logEnabled = ENABLED
