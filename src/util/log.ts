/**
 * Debug log written to a file.
 *
 * Iron rule: never console.log to stdout — stdout is the streaming renderer's exclusive
 * channel, and one stray log line tears apart the text being typed out.
 */
import { redact } from "./redact.ts"
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
    appendFileSync(target(), redact(line))
  } catch {
    // Failing to write the log must not affect the main flow
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
