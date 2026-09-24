/**
 * todo tool: the plan for the current stretch of work.
 *
 * ── It is first and foremost for **the user** to see ──
 * An agent that has been running for two minutes and called a dozen-odd tools leaves
 * nothing on screen but a string of `✓ read`, `✓ edit`. The user can see which hand it
 * moved, not how many hands it **intends** to move — so there is no telling "is it nearly
 * done, or has it just gone off course and is digging itself in deeper and deeper". On the
 * tool lines those two look exactly alike, and they are the difference between "wait a
 * bit longer" and "hit esc, now".
 *
 * Only incidentally is it for the model: a written-down list makes it drop fewer steps in
 * long tasks. But that is a side effect, not the reason — if it were only for the model's
 * own note-keeping, it already has the whole history in its context.
 *
 * ── Why "overwrite the whole list" rather than "change the status of item 3" ──
 * An incremental interface needs both sides to agree on the indices into the same list,
 * and the model's indices are often wrong: it will change an item it **believes** is
 * third. Sending the whole list back costs a few dozen tokens, and what it buys is a list
 * that always equals the one in the model's head — never item 2 ticked in the UI while
 * the model is still working on it.
 *
 * ── Dropping the plan is its own call: `clear: true` ──
 * An empty list is still an error, deliberately: a model that forgets `items` must not
 * silently wipe the plan, so "no plan was written" and "the plan is gone" stay distinct.
 * But that left no legal way to drop a plan. Told "forget all that, keep it simple", a
 * live run hit the error and then wrote a one-step placeholder plan — which the pinned
 * row then showed for the rest of the session. So dropping is explicit: `clear: true`
 * and no items. The UI and latestPlan read the `cleared` metadata as "no plan now", so an
 * older list can't resurface from history either.
 *
 * ── No todoread ──
 * Upstream (Claude Code / opencode) has a pair of read/write tools. The read one is
 * redundant here: the list is what the model itself wrote last turn, right there in its
 * context. One more tool is one more fork in the road for the model to take. The one place
 * that stops holding is compaction: once the last todo call is folded away, the list
 * survives only as a clipped tool line the compaction model saw (compact.ts), plus
 * whatever its summary kept. If plans turn out to get lost there, that's when a read
 * action earns its place.
 */
import { z } from "zod"
import type { ToolDef } from "./types.ts"

export const TODO_STATUSES = ["pending", "active", "done"] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]

/**
 * Other tools' vocabulary → ours.
 *
 * ── Why accept them, rather than error out and make it redo ──
 * `pending / in_progress / completed` is how other vendors' equivalent tools spell it,
 * and the model was trained on **all** of these tools together: it mixes the two APIs up
 * and sends `in_progress` out of muscle memory. The cost of an error is a whole wasted
 * turn (tool result → re-send the whole history → it sends the same list again with one
 * word changed), and all it buys is "maybe it'll remember next time" — and next time is a
 * new session.
 *
 * ★ They **go into the schema** (see StatusSchema), not accepted quietly on the side: what
 *   the JSON schema says is accepted and what is actually accepted must be one and the
 *   same thing. The three canonical ones come first, so writing from the first group is
 *   all the model needs to do. Only canonical values ever appear in storage and in the UI.
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

/** Max items in one list. Any more and it isn't a plan, it's everything that came to mind */
const MAX_ITEMS = 20
/**
 * Max length of one item. An item must be scannable at a glance — detail that doesn't fit
 * belongs in the answer, not the plan
 */
const MAX_TEXT = 120

const Parameters = z.object({
  clear: z
    .boolean()
    .optional()
    .describe("true drops the whole plan — the user abandoned it, or the work changed so much that the steps no longer apply. Send no items with it."),
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
    .optional()
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
- To drop the plan entirely, call with clear: true and no items. Do not replace it with a placeholder step.
- Up to ${MAX_ITEMS} steps; each is truncated at ${MAX_TEXT} characters.`

export const TodoTool: ToolDef<Args> = {
  id: "todo",
  description: DESCRIPTION,
  parameters: Parameters,

  async execute(args, ctx) {
    const items = normalize(args.items ?? [])
    if (args.clear === true) {
      if (items.length > 0) throw new Error("Send either clear: true (drop the plan) or items (replace it), not both.")
      await ctx.ask({ permission: "todo", patterns: ["*"] })
      ctx.metadata({ todos: [], cleared: true })
      return {
        output: "plan cleared",
        title: "cleared",
        metadata: { truncated: false, todos: [], cleared: true, done: 0, total: 0 },
      }
    }
    if (items.length === 0) throw new Error("items is required: send the whole plan, at least one step. To drop the plan, send clear: true instead.")
    // It goes through the permission gate so that "it can be denied" holds true — the tool
    // itself has no side effects, but a tool list you can't change is as awkward as a rule
    // saying "you can turn off everything except this"
    await ctx.ask({ permission: "todo", patterns: ["*"] })

    const done = items.filter((item) => item.status === "done").length
    const active = items.find((item) => item.status === "active")
    ctx.metadata({ todos: items })

    // The first line is for the **board** (see outcomeLine in render.ts: without a
    // dedicated metadata field it falls back to the output's first line); the lines after
    // it are for the model to check itself against
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
 * Tidy up the list the model gave.
 *
 * ── Why a second active is downgraded rather than rejected ──
 * The model occasionally marks two items as in progress. The cost of an error is one
 * wasted tool call this turn, and the gain is merely getting it to resend something
 * almost identical. Downgrading to pending has clear semantics: **the first one is what
 * it is doing now** — the order of the list is its own to begin with.
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
 * Read the list back out of the stored metadata.
 *
 * Resuming a session takes the same path: replay turns tool parts back into events, and
 * this turns them back into a list. So "pick up where we left off" brings back not just
 * the conversation but also that unfinished plan — which is exactly the first thing to
 * look at after picking back up.
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
