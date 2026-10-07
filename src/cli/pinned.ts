/**
 * The rows pinned above the running line: how far the plan has got, which subagents are
 * working (running or queued), which background processes are running. At most a few
 * rows; the detail stays in the transcript, `/agents` and `/jobs`.
 *
 * ── Why these came back after 0.10 ──
 * The retired full-screen UI had a plan pane and a subagent grid; 0.10 dropped both and
 * said background work gets no pinned area, leaving start/finish receipts in the
 * transcript. In use, those receipts scroll away within a turn, so "is anything still
 * running behind my back" was only answerable by typing `/agents` or `/jobs` — and the
 * question matters most right before typing the next message. Receipts record *events*;
 * these rows show *state*, and state belongs where it stays in view. What is kept from
 * 0.10: nothing here animates or counts time by itself, so an idle screen still draws
 * zero frames. A row changes only when the thing it shows changes.
 *
 * ── One row per concern, and a bound on each ──
 * The plan is one row (progress + the item in progress), not the checklist: the full
 * list costs up to a dozen rows on every screen, and the question it answers in passing
 * is "how far along", not "what are all the steps". Subagents get one summary row that
 * holds any number of them — up to 24 one cell each, beyond that a proportional strip —
 * plus detail rows (the running ones) only when height allows. Agentflow allows a
 * hundred alive at once; a design that needs a row per agent fails exactly when it's
 * used hardest.
 *
 * ── Which subagents count: the working ones ──
 * A finished subagent is not gone — its session stays, and a message wakes it with
 * everything it read — but it is not doing anything, so it has no row. This row used to
 * keep finished ones too ("suspended"), so the user could see what was worth asking again;
 * that made a `kill` that removed them necessary, only so the row could be cleared, and
 * with agentflow dozens piled up. Now the row answers only "is anything working behind my
 * back"; `/agents` lists the finished ones, and a failure is on its end receipt. A
 * subagent waiting on the main agent's answer is running, with that as its activity.
 */
import type { JobSnapshot } from "../tool/background.ts"
import type { TodoItem } from "../tool/todo.ts"
import { uiText } from "../i18n/index.ts"
import { planProgress } from "./plan.ts"
import { theme } from "./theme.ts"
import { displayWidth, truncateToWidth } from "./width.ts"

const PLAN_BAR = 10
/** One cell per agent up to this many; past it the strip turns proportional. */
const STRIP_CELLS = 24

export interface PinnedInput {
  plan: readonly TodoItem[]
  agents: readonly JobSnapshot[]
  jobs: readonly JobSnapshot[]
}

export function pinnedRows(input: PinnedInput, width: number, max: number): string[] {
  if (max <= 0) return []
  const plan = planRow(input.plan, width)
  const agents = agentRows(input.agents, width)
  const jobs = jobRow(input.jobs, width)
  // Summary rows first, in a fixed order; agent detail only with height to spare
  const rows = [plan, agents[0], jobs].filter((row): row is string => row !== undefined)
  const spare = max - rows.length
  if (spare > 0 && agents.length > 1) {
    const detail = agents.slice(1)
    const at = rows.indexOf(agents[0]!) + 1
    rows.splice(at, 0, ...(detail.length > spare ? [...detail.slice(0, spare - 1), moreRow(detail.length - spare + 1, width)] : detail))
  }
  return rows.slice(0, max)
}

/** `▰▰▰▱▱▱▱▱▱▱ 3/10 ▸ add 3-language copy`. Absent when there's no plan or it's all done. */
export function planRow(items: readonly TodoItem[], width: number): string | undefined {
  if (items.length === 0) return undefined
  const progress = planProgress(items)
  if (progress.done === progress.total) return undefined
  const filled = Math.round((progress.done / progress.total) * PLAN_BAR)
  const bar = theme.cyan("▰".repeat(filled)) + theme.dim("▱".repeat(PLAN_BAR - filled))
  const head = `  ${bar} ${progress.done}/${progress.total}`
  const next = progress.active || items.find(item => item.status === "pending")?.text || ""
  const mark = progress.active ? theme.cyan(" ▸ ") : theme.dim(" ○ ")
  const room = Math.max(4, width - displayWidth(head) - 3)
  return truncateToWidth(head + (next ? mark + truncateToWidth(next, room) : ""), width)
}

/** Row 0 is the summary; then the running ones' latest activity, newest first. */
export function agentRows(jobs: readonly JobSnapshot[], width: number): string[] {
  const agents = jobs.filter(job => job.kind === "agent")
  const running = agents.filter(job => job.status === "running")
  const queued = agents.filter(job => job.status === "queued").length
  if (running.length === 0 && queued === 0) return []
  const cells = strip([["running", running.length], ["queued", queued]])
  const counts = [
    running.length > 0 ? uiText(`${running.length} running`, `${running.length} 运行中`, `${running.length} 実行中`) : "",
    queued > 0 ? uiText(`${queued} queued`, `${queued} 排队`, `${queued} 待機`) : "",
  ].filter(Boolean).join(theme.dim(" · "))
  const summary = truncateToWidth(`  ${theme.bold(uiText("agents", "子代理", "エージェント"))} ${cells} ${counts}`, width)
  const detail = [...running].sort((a, b) => b.startedAt - a.startedAt).map(job =>
    truncateToWidth(`    ${theme.cyan("●")} ${job.id}${theme.dim(` · ${oneLine(job.activity || job.command)}`)}`, width))
  return [summary, ...detail]
}

/** `jobs 2 running · bun run dev · pytest -x`. Background processes started by anyone. */
export function jobRow(jobs: readonly JobSnapshot[], width: number): string | undefined {
  const running = jobs.filter(job => job.kind === "process" && job.status === "running")
  if (running.length === 0) return undefined
  const names = running.map(job => oneLine(job.command)).join(theme.dim(" · "))
  return truncateToWidth(`  ${theme.bold(uiText("jobs", "后台", "ジョブ"))} ${uiText(`${running.length} running`, `${running.length} 运行中`, `${running.length} 実行中`)}${theme.dim(" · ")}${theme.dim(names)}`, width)
}

function moreRow(count: number, width: number): string {
  return truncateToWidth(theme.dim(`    +${count} ${uiText("more", "个", "件")} · /agents`), width)
}

type Cell = "running" | "queued"
const GLYPH: Record<Cell, (text: string) => string> = { running: text => theme.cyan(text), queued: text => theme.dim(text) }
const CHAR: Record<Cell, string> = { running: "●", queued: "○" }

/**
 * Running, then queued. Past STRIP_CELLS each kind gets cells by share, and any kind
 * present keeps at least one: two queued among ninety running must not round away.
 */
function strip(counts: [Cell, number][]): string {
  const total = counts.reduce((sum, [, n]) => sum + n, 0)
  let cells = counts.map(([kind, n]) => [kind, n] as [Cell, number])
  if (total > STRIP_CELLS) {
    cells = counts.map(([kind, n]) => [kind, n === 0 ? 0 : Math.max(1, Math.round((n / total) * STRIP_CELLS))] as [Cell, number])
    // Rounding can overshoot; take the excess from the largest kind
    let over = cells.reduce((sum, [, n]) => sum + n, 0) - STRIP_CELLS
    while (over > 0) {
      const largest = cells.reduce((best, cell) => cell[1] > best[1] ? cell : best)
      largest[1]--; over--
    }
  }
  return cells.map(([kind, n]) => GLYPH[kind](CHAR[kind].repeat(n))).join("")
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

