/**
 * Draws the plan checklist as rows, printed in the transcript right after the result line
 * of the todo call — the same spot as a diff (see render.ts).
 *
 * ── Why the marks are three characters of different shapes ──
 * State isn't told by color: in half of all terminal color schemes a dim green and a
 * dim gray look identical, and "is this item done or not" is the only question this
 * checklist has to answer. Shape survives even on a monochrome terminal.
 */
import { theme } from "./theme.ts"
import { truncateToWidth } from "./width.ts"
import { parseTodos, type TodoItem, type TodoStatus } from "../tool/todo.ts"
import { liveHistory } from "../agent/to-model-messages.ts"
import type { MessageWithParts } from "../session/schema.ts"

/** Done, in progress, not yet started */
const MARKS: Record<TodoStatus, string> = { done: "✓", active: "▸", pending: "○" }

export interface PlanProgress {
  done: number
  total: number
  /** The item in progress; empty string if none */
  active: string
}

export function planProgress(items: readonly TodoItem[]): PlanProgress {
  return {
    done: items.filter((item) => item.status === "done").length,
    total: items.length,
    active: items.find((item) => item.status === "active")?.text ?? "",
  }
}

/**
 * Draw every item. Two leading columns, to line up with body text elsewhere.
 *
 * Done items are dimmed whole: they no longer need reading, and stay only so one can
 * see "how far we've come". The item in progress gets a bright ▸ — a screen should have
 * only one place shouting "look here".
 */
export function planRows(items: readonly TodoItem[], width: number): string[] {
  return items.map((item) => {
    const text = truncateToWidth(item.text, Math.max(4, width - 4))
    if (item.status === "done") return theme.dim(` ${MARKS.done} ${text}`)
    if (item.status === "active") return theme.cyan(` ${MARKS.active} `) + text
    return theme.dim(` ${MARKS.pending} `) + theme.dim(text)
  })
}

/**
 * Which items to keep when they don't all fit.
 *
 * Open the window centered on **the item in progress**, not cut from the top: once the
 * list gets long its head is all checked-off history, while "which step are we on now,
 * and what's still ahead" is what needs to be seen. Keeping one done item above as an
 * anchor is enough.
 */
export function planWindow(items: readonly TodoItem[], room: number): { shown: readonly TodoItem[]; hidden: number } {
  if (room <= 0) return { shown: [], hidden: items.length }
  if (items.length <= room) return { shown: items, hidden: 0 }
  const at = items.findIndex((item) => item.status === "active")
  // No item in progress (all done / not started): common sense says start from the top
  const center = at === -1 ? 0 : at
  // Keep one done item above as an anchor and give the rest to what follows — that's
  // what hasn't happened yet
  const from = Math.max(0, Math.min(center - 1, items.length - room))
  return { shown: items.slice(from, from + room), hidden: items.length - room }
}

/**
 * The plan the model currently holds: the latest completed `todo` call **in the history
 * it is sent** (liveHistory), not in the whole store.
 *
 * ★ Same cut as what the model sees. After compaction folds the last todo call away, the
 *   model no longer has that list; pinning it anyway would show progress on a plan nobody
 *   is following. When the call sits in the verbatim tail compaction keeps, it survives.
 */
export function latestPlan(history: MessageWithParts[]): TodoItem[] {
  const { messages } = liveHistory(history)
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]!.parts
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]!
      if (part.type !== "tool" || part.tool !== "todo" || part.state.status !== "completed") continue
      // A dropped plan is "no plan now" — scanning on would resurface the list before it
      if (part.state.metadata["cleared"] === true) return []
      const items = parseTodos(part.state.metadata["todos"])
      if (items.length > 0) return items
    }
  }
  return []
}

/**
 * What a todo call changed, for the transcript: the whole list the first time or when the
 * items themselves changed (added, removed, reworded, reordered), otherwise only the items
 * whose status moved.
 *
 * ── Why not the whole list every time ──
 * A seven-item plan ticked off one step at a time printed seven rows per tick — fifty
 * rows of mostly identical checklist over a turn, burying the edits between them. What a
 * status-only call *did* is those one or two moved items, the same way an edit prints its
 * diff and not the file. The full list is still printed whenever its shape changes, and
 * the pinned row above the input box always shows where it stands.
 */
export function planChanges(before: readonly TodoItem[], after: readonly TodoItem[]): readonly TodoItem[] {
  const sameShape = before.length === after.length && before.every((item, i) => item.text === after[i]!.text)
  if (!sameShape) return after
  return after.filter((item, i) => item.status !== before[i]!.status)
}
