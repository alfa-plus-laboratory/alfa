/**
 * todo 工具:这一段活儿的计划。
 *
 * ── 它首先是给**用户**看的 ──
 * 一个跑了两分钟、调了十几次工具的 agent,在屏幕上只剩一串 `✓ read`、`✓ edit`。
 * 用户看得见它动了哪只手,看不见它**打算**动几只手 —— 于是没法判断「它是快
 * 干完了,还是刚跑偏了正在越挖越深」。这两件事在工具行上长得一模一样,而它们
 * 是「再等等」和「赶紧按 esc」的区别。
 *
 * 顺带才是给模型看的:一份写下来的清单会让它在长任务里少丢步骤。但那是副作用,
 * 不是理由 —— 如果只为模型自己记事,它在上下文里已经有整段历史了。
 *
 * ── 为什么是「整份覆盖」而不是「改第 3 条的状态」 ──
 * 增量接口要求两边对同一份列表的下标有共识,而模型的下标经常是错的:它会去改
 * 一条**它以为**排在第三的项目。整份传回来的代价是几十个 token,换来的是这份
 * 清单永远等于模型脑子里那份 —— 不会出现界面上第 2 条已经打勾、模型却还在做它。
 *
 * ── 没有 todoread ──
 * 上游(Claude Code / opencode)有一对读写工具。读那个在这里是多余的:清单是
 * 模型自己上一轮写的,就在它的上下文里。多一个工具就多一条模型会走的岔路。
 * 等接了上下文压缩、清单真的可能被压没了,再考虑补它。
 */
import { z } from "zod"
import type { ToolDef } from "./types.ts"

export const TODO_STATUSES = ["pending", "active", "done"] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]

/**
 * 别的工具里那套说法 → 我们这套。
 *
 * ── 为什么要认它们,而不是报错让它重来 ──
 * `pending / in_progress / completed` 是别家同类工具的写法,而模型是在**所有**
 * 这些工具上一起训出来的:它会把两套 API 记混,然后照着肌肉记忆发 `in_progress`。
 * 报错的代价是一整轮白跑(工具结果 → 重发整段历史 → 它把同一份清单改一个词
 * 再发一遍),换来的只是"它下次可能记住了"—— 而下次是新的一场会话。
 *
 * ★ 它们**进 schema**(见 StatusSchema),不是私下悄悄认:JSON schema 里写着
 *   接受什么,和实际接受什么,必须是同一件事。规范的三个排在前面,模型照着
 *   第一组写就对了。落库和界面上只会出现规范值。
 */
const TODO_ALIASES: Readonly<Record<string, TodoStatus>> = {
  in_progress: "active",
  completed: "done",
}

const StatusSchema = z
  .enum([...TODO_STATUSES, ...Object.keys(TODO_ALIASES)] as [string, ...string[]])
  .transform((value) => (TODO_ALIASES[value] ?? value) as TodoStatus)

export interface TodoItem {
  text: string
  status: TodoStatus
}

/** 一份清单最多几条。再多就不是计划,是把想到的全倒出来了 */
const MAX_ITEMS = 20
/** 单条多长。清单项要能一眼扫完 —— 写不下的细节属于回答,不属于计划 */
const MAX_TEXT = 120

const Parameters = z.object({
  items: z
    .array(
      z.object({
        text: z.string().describe("What this step does, in a few words. Imperative: \"add the scrollbar column\"."),
        status: StatusSchema.describe(
          '"pending", "active" (exactly one, the step you are on), or "done". ' +
            '"in_progress" and "completed" are accepted as synonyms of "active" and "done".',
        ),
      }),
    )
    .describe("The complete plan, in order. Always send every step, including the ones already done."),
})

type Args = z.infer<typeof Parameters>

const DESCRIPTION = `Records the plan for the current piece of work, and shows it to the user as you go.

Use it when the task has several steps that the user cannot see coming — a multi-file change, anything you will verify afterwards, anything where you might be a while. Skip it for single-step work; a one-item plan is noise.

Usage rules:
- Send the WHOLE list every time. This call replaces the previous plan; steps you leave out disappear.
- Exactly one step may be "active". Mark a step "done" the moment it is finished, in the same turn — a plan that updates only at the end tells the user nothing while it matters.
- Keep steps at the size of a real unit of work, not one per tool call. 3-7 steps is the usual shape.
- Do not add a step for "tell the user what I did". Answering is not part of the plan.
- Up to ${MAX_ITEMS} steps; each is truncated at ${MAX_TEXT} characters.`

export const TodoTool: ToolDef<Args> = {
  id: "todo",
  description: DESCRIPTION,
  parameters: Parameters,

  async execute(args, ctx) {
    const items = normalize(args.items ?? [])
    if (items.length === 0) throw new Error("items is required: send the whole plan, at least one step.")
    // 走一遍门卫是为了「它能被 deny」这件事成立 —— 这个工具本身没有副作用,
    // 但一个改不了的工具列表,和一条「除了这个别的都能关」的规则一样别扭
    await ctx.ask({ permission: "todo", patterns: ["*"] })

    const done = items.filter((item) => item.status === "done").length
    const active = items.find((item) => item.status === "active")
    ctx.metadata({ todos: items })

    // 第一行是给**看板**看的(见 render.ts 的 outcomeLine:没有专门的
    // metadata 字段时它退回输出首行),后面那几行是给模型对账用的
    const head = `plan: ${done}/${items.length} done${active ? ` · now: ${active.text}` : ""}`
    const body = items.map((item) => `${mark(item.status)} ${item.text}`)
    return {
      output: [head, ...body].join("\n"),
      title: `${done}/${items.length}`,
      metadata: { truncated: false, todos: items, done, total: items.length },
    }
  },
}

/**
 * 收拾模型给的那份清单。
 *
 * ── 为什么第二个 active 降级而不是报错 ──
 * 模型偶尔会把两条都标成进行中。报错的代价是这一轮白跑一次工具调用,而收益
 * 只是让它重发一份几乎一样的东西。降级成 pending 的语义是明确的:**第一条
 * 就是它现在在做的**,清单顺序本来就是它自己排的。
 */
function normalize(items: readonly { text: string; status: TodoStatus }[]): TodoItem[] {
  const out: TodoItem[] = []
  let seenActive = false
  for (const item of items.slice(0, MAX_ITEMS)) {
    const text = item.text.replaceAll(/\s+/g, " ").trim()
    if (text.length === 0) continue
    let status: TodoStatus = item.status
    if (status === "active") {
      if (seenActive) status = "pending"
      seenActive = true
    }
    out.push({ text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + "…" : text, status })
  }
  return out
}

function mark(status: TodoStatus): string {
  return status === "done" ? "[x]" : status === "active" ? "[>]" : "[ ]"
}

/**
 * 从落库的 metadata 里把清单读回来。
 *
 * 恢复会话走的是同一条路:replay 把工具 part 翻回事件,这里再翻回清单。所以
 * 「接着上次聊」接回来的不只是话,还有那份没做完的计划 —— 而它恰恰是接回来
 * 之后第一个要看的东西。
 */
export function parseTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return []
  const out: TodoItem[] = []
  for (const raw of value.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== "object") continue
    const record = raw as Record<string, unknown>
    const text = record["text"]
    const status = record["status"]
    if (typeof text !== "string" || text.length === 0) continue
    if (typeof status !== "string" || !(TODO_STATUSES as readonly string[]).includes(status)) continue
    out.push({ text, status: status as TodoStatus })
  }
  return out
}
