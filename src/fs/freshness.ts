/**
 * A ledger of "has it been read, and has it changed since".
 *
 * ── What it blocks is a class of failure that **doesn't error** ──
 * edit's matching has a fuzzy cascade (see tool/edit/replace.ts): if the exact match
 * misses it falls back to indentation-stripped matching, anchor matching... The cascade
 * exists to tolerate the model getting a few spaces wrong, and the price is that it is
 * **very good at making do**. So two things turn into silent data corruption:
 *
 *   1. The model never read the file at all — after compaction all it has is a summary,
 *      or it goes purely from memory of the previous session, builds an oldString that
 *      "looks right", and the cascade matches it to a place that is similar but not the
 *      one.
 *   2. It was read, but someone changed the file afterwards — another window, a
 *      formatter, git checkout, a `sed -i` it just ran itself. The oldString built from
 *      the old content lands on the new content.
 *
 * What the two have in common is that **nothing errors**: the file is damaged, the diff
 * even looks reasonable, and it only blows up the next time the tests run, by which time
 * it's a dozen steps later. So this gate isn't "stricter is better", it trades a class of
 * silent errors for one that speaks up.
 *
 * ── Why stat and not a content hash ──
 * read reads **streaming, line by line**, and may stop early on the 50KB byte cap — there
 * are no "bytes of the whole file" to hash. stat is one syscall, and edit/write already
 * stat once anyway to check for directories.
 *
 * The cost is that a `touch` (content unchanged) also counts as stale. The false positive
 * errs on the safe side: just one more read of the file, and the message says clearly
 * what to do. The other way round, one miss means one damaged file.
 *
 * ── A partial read counts as read ──
 * A range read with offset/limit, or one truncated by the cap, is recorded all the same.
 * Otherwise files over 2000 lines could never be edited — and "large files can't be
 * edited" is both more common and harder to work around than "editing from half a
 * file". The real last line of defense is edit's unique-match requirement: oldString
 * must hit exactly one place in the whole file.
 *
 * ── State lives in the process; a new session must clear it explicitly ──
 * A module-level Map, like fs/mutex.ts. What it records is "what's in the model's head",
 * so `/clear`, `/resume` and `/compact` all need forgetReads() — after those three, the
 * file contents really are no longer in its context.
 *
 * ── ★ Ledgers are per **session**, not one big ledger keyed by path ──
 * "Has it been read" asks **who** read it. A subagent has its own session and its own
 * context (see agent/subagent.ts); it having read foo.ts has nothing to do with whether
 * the main agent holds foo.ts's content. The consequence of one big ledger: a file some
 * background scout read, the main agent could edit without reading — and what this gate
 * guards against is exactly the **silent** corruption where fuzzy matching lands in the
 * wrong place when editing unread. The reverse holds too: the main agent having read it
 * shouldn't let a subagent slip through.
 */
import { statSync } from "node:fs"

export interface FileStamp {
  mtimeMs: number
  size: number
}

/**
 * Not read / changed since it was read. A separate type, so upper layers can tell "the
 * model's mistake" from "the tool is broken".
 */
export class StaleFileError extends Error {
  readonly path: string
  constructor(path: string, message: string) {
    super(message)
    this.name = "StaleFileError"
    this.path = path
  }
}

/** sessionID → (path → stamp). Per the star in the header: "read" asks **who** read it */
const ledgers = new Map<string, Map<string, FileStamp>>()

function ledgerOf(sessionID: string): Map<string, FileStamp> {
  let ledger = ledgers.get(sessionID)
  if (!ledger) {
    ledger = new Map<string, FileStamp>()
    ledgers.set(sessionID, ledger)
  }
  return ledger
}

/** Take a stamp. undefined if the file is missing / unreadable; the caller decides. */
export function stampOf(path: string): FileStamp | undefined {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return undefined
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return undefined
  }
}

/**
 * Record "this file looks like this now, and the model has seen it".
 *
 * ⚠ read must pass the stamp taken **before reading**: if the file changes while being
 * streamed, recording the new stamp would claim "it saw the new content", when what it
 * actually saw was half old, half new. Record the old stamp and the next edit judges it
 * stale and makes it re-read — again erring on the safe side.
 */
export function noteRead(sessionID: string, path: string, stamp = stampOf(path)): void {
  if (!stamp) return
  ledgerOf(sessionID).set(path, stamp)
}

/**
 * The gate before editing. Throws if it was never read, or if what's on disk changed
 * since it was read.
 *
 * The caller must already have confirmed the file exists (edit/write both call this
 * after their own existence check) — if stat fails here we just let it through; in
 * that case the disk read right after reports a more accurate error itself.
 */
export function assertFresh(
  sessionID: string,
  path: string,
  label: string,
  verb: "edit" | "overwrite",
): void {
  const now = stampOf(path)
  if (!now) return

  const seen = ledgerOf(sessionID).get(path)
  if (!seen) {
    throw new StaleFileError(
      path,
      `Refusing to ${verb} ${label}: you have not read it yet. Call read on it first, then retry — ` +
        `a copy from an earlier session, a summary, or memory is not good enough, because the file may have changed since.`,
    )
  }
  if (seen.mtimeMs !== now.mtimeMs || seen.size !== now.size) {
    throw new StaleFileError(
      path,
      `Refusing to ${verb} ${label}: it changed on disk after you read it ` +
        `(another window, another tool, or a command you ran). ` +
        `Read it again, then redo this change against the current content.`,
    )
  }
}

/**
 * Forget everything. Called after switching sessions (`/clear`, `/resume`) and after
 * compaction (`/compact`).
 *
 * The compaction one is easy to mistake for overcaution, but it's the most necessary of
 * the three: after compaction the model holds only a handoff note, and the handoff note
 * often says "next step: change X to Y in foo.ts". Without clearing the ledger it would
 * edit straight off that sentence — exactly why this module exists. The cost is one
 * re-read, and the compaction prompt already says "files must be re-read".
 */
export function forgetReads(sessionID?: string): void {
  // No id = clear everything. `/clear` and `/resume` go this way: after switching
  // sessions, the subagents' ledgers are voided too (they've already been stopped
  // anyway, see stopAgents in cli/main.ts)
  if (sessionID === undefined) ledgers.clear()
  else ledgers.delete(sessionID)
}

/** For tests only. */
export function __ledgerSizeForTest(sessionID?: string): number {
  if (sessionID !== undefined) return ledgers.get(sessionID)?.size ?? 0
  let total = 0
  for (const ledger of ledgers.values()) total += ledger.size
  return total
}
