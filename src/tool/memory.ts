/**
 * memory 工具:增、删、看项目记忆。
 *
 * ── 为什么是工具,而不是「让它自己去 write 那个目录」 ──
 * 用 write 也能写,而且能白嫖那边的强制 diff。但差别在**这件事有没有一条属于
 * 自己的记录**:走 write,记住一句话和改一行代码在历史里长得一模一样,回头想
 * 知道「它到底记了些什么」只能一条条翻 diff。走工具,每一次记忆变动都是一次
 * 具名调用,界面上一行 `● memory saved no-auto-commit`,`/context` 里也算得清。
 *
 * 顺带解决两件 write 解决不了的:名字能被规范化(模型会起 `Note 1.md` 这种),
 * 上限能在写入那一刻挡住(write 不知道 4KB 是什么意思)。
 *
 * ── 为什么没有 read 动作 ──
 * 便条在新会话开头就整份装进上下文了(见 session/schema.ts 的 MemoryPart),
 * 它手里已经有全文。给一个「再读一遍」的动作,只会多一条模型会走的岔路。
 * list 留着是因为**撞上限被挡掉的那几条**它看不见 —— 那时候需要知道有什么。
 *
 * ── 写进去之前先记账 ──
 * 便条也是文件,而改前先读那道闸认的是文件(见 fs/freshness.ts)。这里写完
 * 顺手记一笔,免得它下一步想用 edit 微调自己刚写的便条时被自己的闸拦下来。
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
    // 只碰工作区里那一个目录,名字过一遍规范化 —— 参数里带路径分隔符是走不出去的。
    // 所以这里问的是「记忆」这件事本身要不要放行,不是某个路径要不要放行
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
      // 条数上限只拦**新增**。改一条已经在的从来不该被上限挡住
      const existing = countNotes(ctx.root)
      if (existing >= MAX_MEMOS) {
        throw new Error(
          `This project already has ${existing} notes, which is the limit. Delete one that has stopped being useful first — a memory that only ever grows stops being memory.`,
        )
      }
    }

    ensureDirSync(dirname(path))
    writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`)
    // 刚写完就记账,免得它下一步想 edit 微调时被改前先读那道闸拦下来
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
 * 便条总数。自己数,不走 discoverMemories —— 那个会因为 16KB 的字节上限少报,
 * 而条数上限判的是**盘上有几条**。用少报的数去判上限,等于上限自己会松动。
 */
function countNotes(root: string): number {
  try {
    return readdirSync(join(root, MEMORY_DIR)).filter((name) => name.endsWith(".md")).length
  } catch {
    return 0 // 目录还不存在 = 一条都没有
  }
}

/**
 * 名字规范化。
 *
 * 模型起名字的花样很多:`Note 1`、`user_prefs.md`、`../../etc/passwd`。三件事
 * 一起做掉 —— 统一成 kebab-case、去掉扩展名、**把路径分隔符整个吃掉**。
 * 最后一条是安全边界:参数里不管写什么都走不出这个目录。
 */
export function slug(raw: string | undefined): string {
  const base = (raw ?? "")
    .trim()
    .replace(/\.md$/i, "")
    .toLowerCase()
    // 分隔符和点先变连字符,而不是删掉 —— 删掉的话 `a/b` 和 `ab` 会撞成同一条
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  if (base.length === 0) {
    throw new Error(`name must contain at least one letter or digit — got ${JSON.stringify(raw ?? "")}.`)
  }
  return base
}

/** `.alfa/memory/foo.md` → `foo`。回给模型的列表里用短名,它传的也是短名 */
function slugOf(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1).replace(/\.md$/i, "")
}
