/**
 * memory tool: add, delete and view project memory.
 *
 * ── Why a tool, rather than "let it write to that directory itself" ──
 * write could do it too, and would get the forced diff over there for free. The
 * difference is **whether this act gets a record of its own**: through write, remembering
 * a sentence and changing a line of code look exactly alike in the history, and later,
 * finding out "what did it actually remember" means paging through diffs one by one.
 * Through a tool, every memory change is a named call — one line in the UI,
 * `● memory saved no-auto-commit`, and it adds up cleanly in `/context` too.
 *
 * It also solves two things write can't: names can be normalized (the model will come up
 * with things like `Note 1.md`), and limits can be enforced at the moment of writing
 * (write has no idea what 4KB means).
 *
 * ── Why there is no read action ──
 * Notes are loaded into the context in full at the start of a new session (see
 * MemoryPart in session/schema.ts), so it already has the full text. A "read it again"
 * action would only add one more fork in the road for the model to take. list stays
 * because **the ones blocked by the limit** are invisible to it — that's when it needs to
 * know what is there.
 *
 * ── Book-keeping right after it's written ──
 * Notes are files too, and the read-before-edit gate works on files (see
 * fs/freshness.ts). So after writing, a record is made here in passing, so that when its
 * next step is to fine-tune the note it just wrote with edit, it doesn't get blocked by
 * its own gate.
 */
import { readdirSync, rmSync, writeFileSync } from "node:fs"
import { ensureDirSync } from "../fs/dir.ts"
import { dirname, join } from "node:path"
import { z } from "zod"
import { noteRead, stampOf } from "../fs/freshness.ts"
import { discoverMemories, MAX_MEMOS, MAX_MEMO_BYTES, MEMORY_DIR } from "../prompt/memory.ts"
import type { ToolDef } from "./types.ts"

const Parameters = z.object({
  action: z.enum(["save", "delete", "list"]).describe("What to do"),
  name: z
    .string()
    .optional()
    .describe(
      'Short kebab-case slug naming what the note says, e.g. "no-auto-commit" or "tests-need-redis". Required for "save" and "delete". Saving over an existing name replaces that note.',
    ),
  content: z
    .string()
    .optional()
    .describe('The note itself, markdown, a few lines. Required for "save".'),
})

type Args = z.infer<typeof Parameters>

const DESCRIPTION = `Keeps notes about this project that survive between sessions. Everything stored here is loaded automatically at the start of every later session in this project, so a note is something your future self reads as fact.

Save one when you learn something that will still matter next week and that you would otherwise have to work out again:

- A preference the user has stated or corrected you on more than once — how they want things named, formatted, explained, committed.
- A standing requirement they keep repeating: "never touch the generated files", "always run the migration before the tests", "ask before you push".
- Something about this project or machine that cost you time to find out and is written down nowhere: a service that has to be running first, a command that only works from one directory, a test that is flaky for a known reason.
- **A decision that shapes the work, and where that work stands.** Which approach was taken and what it beat; something deliberately NOT done and why; a piece of work that is half finished and what the next step was. The code says what it does — not why this and not the obvious alternative, and not what was already ruled out. Next session that is exactly what you will be missing.
- Anything the user tells you to remember.

Do not save: the step you are on right now, a running commentary of what you changed today (git already keeps that), something already in AGENTS.md or the README, anything you are guessing at, or a secret. **When in doubt, do not save it** — an uncertain note comes back to you as fact in every future session and nobody re-checks it.

Usage rules:
- One idea per note, named after what it says rather than when you learned it. Saving over an existing name REPLACES that note — do that rather than adding a second one on the same subject.
- **A note about a piece of work is ONE note, saved over the same name as the work moves on.** Not one per session. Two notes on the same thread is a changelog, and a changelog that loads itself into every future session is exactly what this must not become.
- Delete a note the moment it turns out to be wrong or obsolete, in the same turn you find out. A stale note does damage every session until someone notices.
- Do not announce that you are saving one and do not ask permission first; the call itself is visible to the user. Just do it and carry on with the actual task.
- Notes are what you worked out. AGENTS.md is the user's own file — suggest changes to it, do not fold it in here.`

export const MemoryTool: ToolDef<Args> = {
  id: "memory",
  description: DESCRIPTION,
  parameters: Parameters,

  async execute(args, ctx) {
    // It only touches that one directory in the workspace, and names go through
    // normalization — path separators in the argument can't get out. So what is asked
    // here is whether "memory" as such is allowed, not whether some path is allowed
    await ctx.ask({ permission: "memory", patterns: ["*"] })

    const dir = join(ctx.root, MEMORY_DIR)

    if (args.action === "list") {
      const { memos, dropped } = discoverMemories(ctx.root)
      const lines = memos.map((memo) => `- ${slugOf(memo.name)} (${memo.content.length} chars)`)
      if (dropped > 0) lines.push(`- [${dropped} more not loaded into this session — over the size limit]`)
      return {
        output: memos.length === 0 ? "No notes saved for this project yet." : lines.join("\n"),
        title: `${memos.length} note${memos.length === 1 ? "" : "s"}`,
        metadata: { truncated: false, notes: memos.length, dropped },
      }
    }

    const name = slug(args.name)
    const path = join(dir, `${name}.md`)

    if (args.action === "delete") {
      if (!stampOf(path)) {
        throw new Error(`No note named "${name}". Use action "list" to see what is saved.`)
      }
      rmSync(path)
      ctx.metadata({ note: name, deleted: true })
      return {
        output: `Deleted note "${name}".`,
        title: `deleted ${name}`,
        metadata: { truncated: false, note: name, deleted: true },
      }
    }

    const content = (args.content ?? "").trim()
    if (content.length === 0) {
      throw new Error(`content is required for action "save".`)
    }
    const bytes = Buffer.byteLength(content, "utf8")
    if (bytes > MAX_MEMO_BYTES) {
      throw new Error(
        `That note is ${bytes} bytes; the limit is ${MAX_MEMO_BYTES}. A note this long is not a note — put the durable sentence here and the rest in AGENTS.md or the code.`,
      )
    }

    const replacing = stampOf(path) !== undefined
    if (!replacing) {
      // The count limit only blocks **new** notes. Changing one that already exists should
      // never be stopped by the limit
      const existing = countNotes(ctx.root)
      if (existing >= MAX_MEMOS) {
        throw new Error(
          `This project already has ${existing} notes, which is the limit. Delete one that has stopped being useful first — a memory that only ever grows stops being memory.`,
        )
      }
    }

    ensureDirSync(dirname(path))
    writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`)
    // Record it right after writing, so that when its next step is a small edit, the
    // read-before-edit gate doesn't block it
    noteRead(ctx.sessionID, path)
    ctx.metadata({ note: name, replaced: replacing, content })
    return {
      output: `${replacing ? "Replaced" : "Saved"} note "${name}". It will be loaded at the start of every later session in this project.`,
      title: `${replacing ? "replaced" : "saved"} ${name}`,
      metadata: { truncated: false, note: name, replaced: replacing, content },
    }
  },
}

/**
 * Total number of notes. Counted here, not via discoverMemories — that one under-reports
 * because of the 16KB byte limit, while the count limit is about **how many are on disk**.
 * Checking the limit against an under-reported number means the limit loosens by itself.
 */
function countNotes(root: string): number {
  try {
    return readdirSync(join(root, MEMORY_DIR)).filter((name) => name.endsWith(".md")).length
  } catch {
    return 0 // directory doesn't exist yet = no notes at all
  }
}

/**
 * Name normalization.
 *
 * The model comes up with all sorts of names: `Note 1`, `user_prefs.md`,
 * `../../etc/passwd`. Three things are done in one go — unify to kebab-case, drop the
 * extension, **swallow path separators entirely**. The last one is a security boundary:
 * whatever the argument says, it can't get out of this directory.
 */
export function slug(raw: string | undefined): string {
  const base = (raw ?? "")
    .trim()
    .replace(/\.md$/i, "")
    .toLowerCase()
    // Separators and dots become hyphens first rather than being deleted — deleted, `a/b`
    // and `ab` would collide into the same note
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  if (base.length === 0) {
    throw new Error(`name must contain at least one letter or digit — got ${JSON.stringify(raw ?? "")}.`)
  }
  return base
}

/**
 * `.alfa/memory/foo.md` → `foo`. The list returned to the model uses short names, and it
 * passes short names too
 */
function slugOf(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1).replace(/\.md$/i, "")
}
