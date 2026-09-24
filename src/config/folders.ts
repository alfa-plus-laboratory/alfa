/**
 * "How this folder uses alfa" — reading, writing, and the trust slot.
 *
 * ── Why a separate file ──
 * config.ts only cares about **what this JSON looks like** (parsing, errors in plain
 * words). This file cares about **what it means for a run**: is this the first visit,
 * should this directory's instruction files be allowed to talk to the model. Mix the
 * two and config.ts slowly becomes something that knows everything
 * — while right now it is the gatekeeper of the only file in the program the user edits
 * by hand.
 *
 * ── ★ The key is the workspace root, not cwd ──
 * Starting in `repo/src/api` and starting in `repo/` is **the same repo**; its trust
 * should be the same entry. Keyed by cwd, one repo could pile up a dozen mutually
 * contradictory records, and all the user would notice is "sometimes it trusts this
 * repo and sometimes it asks all over again".
 *
 * ── Trust fails closed here ──
 * `checking` (not done reading yet) counts as **untrusted**. The other way round, the
 * project's AGENTS.md would already be in the system prompt during those few seconds —
 * and that is exactly the thing we're taking a look at.
 */
import { readdirSync } from "node:fs"
import { resolve } from "node:path"
import {
  loadConfig,
  saveConfig,
  configPath,
  type Config,
  type FolderConfig,
  type TrustState,
} from "./config.ts"

/** Today. `YYYY-MM-DD` — stored for humans, plays no part in any decision */
export function today(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/**
 * This folder's key in the config.
 *
 * resolve only, **no realpath**: to the user, a workspace entered through a symlink is
 * the path they typed; swap it for the resolved real path and they can never find
 * their own entry in the config file again. And this table is for humans to read and
 * edit by hand.
 */
export function folderKey(root: string): string {
  return resolve(root)
}

export function folderConfig(root: string, config: Config): FolderConfig | undefined {
  return config.folders?.[folderKey(root)]
}

/** Has the opening card asked yet. See cli/folder-setup.ts */
export function isFirstVisit(root: string, config: Config): boolean {
  return folderConfig(root, config)?.seenAt === undefined
}

/**
 * Whether to offer the trust choice again at startup.
 *
 * `seenAt` only answers "have we been here", it can't stand in for a decision now.
 * `/trust off` quarantines the current directory immediately, but the user shouldn't
 * lock themselves into untrusted forever because of it: the next visit still needs a
 * visible way back. `checking` is not asked again, because that review continues after
 * startup.
 */
export function needsTrustChoice(root: string, config: Config): boolean {
  return isFirstVisit(root, config) || trustFor(root, config) === "untrusted"
}

/** Trust state. No record = never asked, so project instructions must be blocked first. */
export function trustFor(root: string, config: Config): TrustState {
  return folderConfig(root, config)?.trust ?? "untrusted"
}

/**
 * Whether the project's instruction files (AGENTS.md / CLAUDE.md …) may go into the
 * system prompt this run.
 *
 * ⚠ `checking` counts as **no**. Those few seconds are exactly when we've sent someone
 *   to read those files; if we were already following them while reading, the check
 *   would be worthless.
 */
export function trustsProjectInstructions(root: string, config: Config): boolean {
  return trustFor(root, config) === "trusted"
}

/**
 * Write to disk. **Failures don't throw** — same reason as the remember* series in
 * config.ts: what the user pressed was "trust this folder", not "write the config file".
 */
function update(root: string, mutate: (folder: FolderConfig) => void, path = configPath()): void {
  try {
    const config = loadConfig(path)
    const key = folderKey(root)
    const folder = { ...config.folders?.[key] }
    mutate(folder)
    config.folders = { ...config.folders, [key]: folder }
    saveConfig(config, path)
  } catch {
    // Not remembering beats interrupting the current operation
  }
}

export interface FolderChoice {
  trust: TrustState
}

/**
 * The answer from the opening card. `seenAt` only records "been here"; untrusted will
 * be asked again next time.
 */
export function rememberFolder(root: string, choice: FolderChoice, path = configPath()): void {
  update(
    root,
    (folder) => {
      folder.trust = choice.trust
      folder.seenAt = today()
      if (choice.trust === "trusted") folder.trustedAt = today()
      else delete folder.trustedAt
      if (choice.trust !== "concerns") delete folder.concern
    },
    path,
  )
}

/**
 * Set (or remove) the trust mark.
 *
 * The date is written along with it. The date plays no part in any decision; it exists
 * only to answer one question: **when did I allow this?** A permission with no date —
 * a year later nobody can say whether it was granted after careful thought or pressed
 * by a slip of the hand one day.
 */
export function markTrust(root: string, trust: TrustState, path = configPath()): void {
  update(
    root,
    (folder) => {
      folder.trust = trust
      if (trust === "trusted") folder.trustedAt = today()
      else delete folder.trustedAt
      if (trust !== "concerns") delete folder.concern
    },
    path,
  )
}

/**
 * The review explicitly found something: the state and the summary must be written in
 * one go — never a half record where the red light is there but the reason is lost.
 */
export function markTrustConcern(root: string, concern: string, path = configPath()): void {
  update(
    root,
    (folder) => {
      folder.trust = "concerns"
      folder.concern = concern
      delete folder.trustedAt
    },
    path,
  )
}



/**
 * Whether this directory is "empty". If it is, don't ask about trust — there's nothing
 * in it that could talk to the model.
 *
 * ★ The test is **directory entries**, not "is there an AGENTS.md". The latter looks
 *   more precise but is actually worse: an unfamiliar repo full of source that just
 *   happens to have no AGENTS.md would count as empty, while the injections in its
 *   `.alfa/mcp.json`, build scripts and README are still right there.
 *
 * `.git` doesn't count — a fresh directory after `git init` is empty in the user's eyes,
 * and it really is. When it can't be read (permissions, directory doesn't exist) return
 * false: **when unsure, treat it as not empty** — on that side it's one extra question,
 * on the other it's a silent allow.
 */
export function isEmptyFolder(root: string, readdir: (dir: string) => string[] = readdirSync): boolean {
  try {
    return readdir(root).filter((name) => name !== ".git").length === 0
  } catch {
    return false
  }
}
