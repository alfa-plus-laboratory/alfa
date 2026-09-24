/**
 * The history reachable with the ↑ key, kept across sessions.
 *
 * Same nature as shell history: it holds what the user typed themselves — no keys, but
 * not meant for anyone else's eyes either. So it lives under home, mode 0600, never in the
 * project directory.
 *
 * Multi-line input can't be stored with \n (one entry would be read back as several), so
 * it's encoded as \\n — with the backslash itself escaped to \\\\ first; do it in the
 * other order and the two characters `\n` in the user's original text turn into a newline
 * too.
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
    return [] // no history isn't an error
  }
}

export function appendHistory(text: string, path = historyPath()): void {
  if (text.trim().length === 0) return
  try {
    ensureDirSync(dirname(path), { mode: 0o700 })
    appendFileSync(path, encode(text) + "\n", { mode: 0o600 })
  } catch {
    // Failing to write history shouldn't get in the way of work
  }
}

/** Trim once when it's too long. Once at startup is enough; no need to do it on every append. */
export function trimHistory(path = historyPath()): void {
  try {
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
    if (lines.length <= MAX_ENTRIES) return
    writeFileSync(path, lines.slice(-MAX_ENTRIES).join("\n") + "\n", { mode: 0o600 })
  } catch {
    // Same as above
  }
}
