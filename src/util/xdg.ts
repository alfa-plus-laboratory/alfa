/**
 * Data directory resolution + GC for the on-disk tool output area.
 */
import { readdirSync, statSync, unlinkSync } from "node:fs"
import { ensureDirSync } from "../fs/dir.ts"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Directory name. Matches the command name and the project-level `.alfa/`.
 *
 * It used to be `apcode`, and the rename **is not backward compatible**: the old
 * directory simply isn't found, and it's treated as a first install. This is also why
 * there's no automatic migration — auth.json lives in there, and if a presumptuous
 * rename went wrong midway (permissions, cross-device, a same-name directory already
 * exists), the user would lose their API key just for starting the program. Whoever
 * wants to move it can mv it themselves; that's a command they can see.
 */
const APP = "alfa"

/** ~/.local/share/alfa (or $XDG_DATA_HOME/alfa) */
export function dataDir(): string {
  const base = process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share")
  return join(base, APP)
}

/** ~/.config/alfa (or $XDG_CONFIG_HOME/alfa) */
export function configDir(): string {
  const base = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config")
  return join(base, APP)
}

/** Where oversized tool output is spilled to disk. Given the path, the model can keep
 *  reading with read/grep. */
export function toolOutputDir(): string {
  const dir = join(dataDir(), "tool-output")
  ensureDirSync(dir)
  return dir
}

const GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const GC_INTERVAL_MS = 60 * 60 * 1000
const GC_DELAY_MS = 60 * 1000

/**
 * Start a low-frequency background GC that deletes tool output files older than 7 days.
 *
 * Starts after a 1-minute delay to avoid IO contention at process startup; unref'd so it
 * doesn't keep the process from exiting.
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
        // Concurrent deletion / permission problems are all ignored
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
