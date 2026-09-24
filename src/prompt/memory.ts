/**
 * The **storage layer** for project memory: one note per file under `.alfa/memory/`.
 *
 * ── Division of labor with AGENTS.md ──
 * AGENTS.md is **written by people**: how this project builds, how it tests, which
 * conventions must not be broken. It is stable, authoritative, and changing it is a
 * deliberate act.
 *
 * Notes are **written by the model**: the user saying "don't auto-commit" for the third
 * time, the service on that machine having to be started before the tests can pass,
 * this repo's lint only finding its way when run from the root. Nobody would go out of
 * their way to write these into AGENTS.md, but stepping on each of them again every
 * session has a very real cost.
 *
 * ── There's a third kind: **what this project has decided, and how far it has got** ──
 * The "when to remember" list once held only the first two kinds (the user's rules +
 * environment pitfalls), so at the start of every new session the model knew nothing
 * about this project — it knew what you dislike, but not what had already been settled
 * here. And code can only say "this is how it is now"; it can't say "why it isn't the
 * other way", "what has already been tried and didn't work", "which part is half-done
 * and what the next step was going to be". The cost of re-deriving those is reading the
 * whole repo again, or making the same mistake again.
 *
 * ⚠ The discipline for this kind differs from the first two: **one line of work gets
 *   exactly one note, overwritten under the same name as things progress**. One per
 *   session and it becomes a changelog — git already keeps one, and stuffing another
 *   into the start of every session only eats up the window. See the notes in
 *   tool/memory.ts.
 *
 * ── It doesn't go into the system prompt ──
 * It was once appended to the tail of the system prompt. That was wrong in three ways:
 * in `/context` it was mixed into the "system 12k" lump and couldn't be accounted for
 * separately; system is re-sent every turn, while memory only needs loading once; and
 * most importantly, **adding and removing notes could only happen by the model writing
 * files itself**, so "what it has remembered" had no record of its own.
 *
 * Now: the content is carried in by a memory part attached to the first message of a
 * new session (see session/schema.ts), and adding/removing goes through an explicit tool
 * (see tool/memory.ts). This file only handles the filesystem half.
 *
 * ── The caps are necessary ──
 * If notes only ever grow, they'll keep growing until they eat the context, and they'll
 * eat it in **every single session**. So there are three gates: 4KB per note, 16KB
 * total, 24 notes at most. Hitting one has to be said out loud — a memory quietly
 * missing a few notes is harder to debug than no memory at all.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { noteRead } from "../fs/freshness.ts"
import { ALFA_DIR } from "./init.ts"

/** Relative to the project root. For who creates `.alfa/`, see init.ts */
export const MEMORY_DIR = `${ALFA_DIR}/memory`

/**
 * Per-note cap. A note longer than this has most likely stopped being a note and become
 * something that belongs in AGENTS.md
 */
export const MAX_MEMO_BYTES = 4 * 1024
/** Combined cap across all notes */
export const MAX_MEMORY_BYTES = 16 * 1024
/** At most how many notes to load */
export const MAX_MEMOS = 24

export interface Memo {
  /**
   * Relative to the project root, e.g. `.alfa/memory/no-auto-commit.md`. The model uses it
   * to know what to edit
   */
  name: string
  content: string
}

export interface MemorySet {
  memos: Memo[]
  /** How many notes were kept out by the caps. Anything other than 0 has to be said */
  dropped: number
}

/**
 * Read `<root>/.alfa/memory/*.md`.
 *
 * Sorted by file name, not by time: the same set of files produces the same text every
 * time — a history that jitters with disk read order could come out different even
 * after a `/resume`.
 */
/**
 * @param sessionID **Which session's** context this is loaded into. Only when given is
 *   the "has been read" entry recorded — and that ledger is kept per session (see the ★
 *   in fs/freshness.ts: "has it been read" asks **who** read it). Leave it out when you
 *   only want to count the notes (startup banner, `memory list`).
 */
export function discoverMemories(root: string, sessionID?: string): MemorySet {
  const dir = join(root, MEMORY_DIR)
  let names: string[]
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .sort()
  } catch {
    return { memos: [], dropped: 0 } // no directory = nothing remembered yet, not an error
  }

  const memos: Memo[] = []
  let dropped = 0
  let budget = MAX_MEMORY_BYTES
  for (const name of names) {
    if (memos.length >= MAX_MEMOS || budget <= 0) {
      dropped++
      continue
    }
    const path = join(dir, name)
    const file = readCapped(path, Math.min(MAX_MEMO_BYTES, budget))
    if (file === undefined) {
      // An empty file doesn't count, and doesn't count as kept out either — it has no
      // content to give in the first place
      continue
    }
    // ★ Loaded into the context means **has been read**: the full content is right in
    //   front of the model at this moment, which is exactly what the read-before-edit
    //   gate wants (see fs/freshness.ts). Without recording it, the model editing its own
    //   note with edit would be blocked by its own gate, even though it plainly holds the
    //   current content.
    //   Truncated ones aren't recorded: it's missing the tail, and writing back from what
    //   it has would delete that tail.
    if (!file.truncated && sessionID !== undefined) noteRead(sessionID, path, file.stamp)
    budget -= Buffer.byteLength(file.content, "utf8")
    memos.push({ name: `${MEMORY_DIR}/${name}`, content: file.content })
  }
  return { memos, dropped }
}

interface CappedFile {
  content: string
  truncated: boolean
  /**
   * Taken **before** the read. The other way round, a change made between the read and
   * the stat would be recorded as fresh
   */
  stamp: { mtimeMs: number; size: number }
}

function readCapped(path: string, cap: number): CappedFile | undefined {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return undefined
    const stamp = { mtimeMs: stat.mtimeMs, size: stat.size }
    const raw = readFileSync(path, "utf8").trim()
    if (raw.length === 0) return undefined
    // Cut the tail: a note's key points are at the start, and an overlong one should be
    // split up anyway
    if (Buffer.byteLength(raw, "utf8") <= cap) return { content: raw, truncated: false, stamp }
    return { content: raw.slice(0, cap) + "\n[... truncated ...]", truncated: true, stamp }
  } catch {
    return undefined
  }
}

/**
 * Assemble the section attached to the first message of a new session. No notes → empty
 * string — a passage saying "(none)" spends money every session describing something
 * that doesn't exist.
 *
 * Each note carries its path: when the model wants to change one, it has to know which.
 * The opening sentence must make clear **it wrote these itself** — it has to feel free
 * to edit its own notes, while not daring to touch the user's AGENTS.md.
 */
export function renderMemories(set: MemorySet): string {
  if (set.memos.length === 0) return ""
  const blocks = set.memos.map((memo) => `--- ${memo.name}\n${memo.content}`)
  const head = [
    "<project-memory>",
    "Notes you wrote about this project in earlier sessions, loaded automatically at the start of this one.",
    "They are yours: correct one the moment it turns out to be wrong, and delete one that has stopped being true.",
    "Use the memory tool to add, change or remove them.",
  ].join("\n")
  // What was kept out must be said. A memory quietly missing a few notes is harder to
  // debug than no memory — the symptom is "it still remembered last week"
  const tail =
    set.dropped > 0
      ? `\n\n[${set.dropped} more note${set.dropped === 1 ? "" : "s"} not loaded — the folder is over its size limit. Merge or delete some with the memory tool.]`
      : ""
  return `${head}\n\n${blocks.join("\n\n")}${tail}\n</project-memory>`
}
