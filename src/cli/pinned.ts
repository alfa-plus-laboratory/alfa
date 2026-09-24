/**
 * The rows pinned above the running line: how far the plan has got, which subagents are
 * still open (running, queued or suspended — not yet killed), which background processes are running. At most a few rows; the
 * detail stays in the transcript, `/agents` and `/jobs`.
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
 * plus detail rows (running ones, then the suspended names) only when height allows. Agentflow allows a
 * hundred alive at once; a design that needs a row per agent fails exactly when it's
 * used hardest.
 *
 * ── Which subagents count: running, queued, suspended ──
 * A subagent that has finished is **suspended**, not gone: its whole session stays in the
 * store, it costs nothing while it waits, it doesn't count against the alive cap, and the
 * main agent can wake it with `task { resume }` holding everything it read last time —
 * there is no expiry (see tool/task.ts). So "not fully closed" is every subagent of this
 * session except the ones killed (`job kill`, `/agents kill`); the row stays while any exists.
 * Showing only the running ones would hide exactly the capital worth reusing, and the
 * user deciding whether to say "ask the auditor again" needs to see the auditor exists.
 * A failed one is suspended too (it can be woken to retry) and is drawn as ✗.
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

/**
 * Row 0 is the summary; then the running ones' latest activity, newest first; then, if
 * any are suspended, one row naming them so "which one could be asked again" has an answer.
 */
export function agentRows(jobs: readonly JobSnapshot[], width: number): string[] {
  const agents = jobs.filter(job => job.kind === "agent")
  if (agents.length === 0) return []
  const running = agents.filter(job => job.status === "running")
  const queued = agents.filter(job => job.status === "queued").length
  const suspended = agents.filter(job => job.status === "exited")
  // A stopped one (signal set) was the user's own doing, not a failure — same rule as the exit receipt
  const failed = suspended.filter(failedJob).length
  const cells = strip([
    ["suspended", suspended.length - failed], ["failed", failed], ["running", running.length], ["queued", queued],
  ])
  const counts = [
    running.length > 0 ? uiText(`${running.length} running`, `${running.length} 运行中`, `${running.length} 実行中`) : "",
    queued > 0 ? uiText(`${queued} queued`, `${queued} 排队`, `${queued} 待機`) : "",
    suspended.length > 0 ? uiText(`${suspended.length} suspended`, `${suspended.length} 挂起`, `${suspended.length} 一時停止`) : "",
    failed > 0 ? theme.red(uiText(`${failed} failed`, `${failed} 失败`, `${failed} 失敗`)) : "",
  ].filter(Boolean).join(theme.dim(" · "))
  const summary = truncateToWidth(`  ${theme.bold(uiText("agents", "子代理", "エージェント"))} ${cells} ${counts}`, width)
  const detail = [...running].sort((a, b) => b.startedAt - a.startedAt).map(job =>
    truncateToWidth(`    ${theme.cyan("●")} ${job.id}${theme.dim(` · ${oneLine(job.activity || job.command)}`)}`, width))
  if (suspended.length > 0) {
    const names = [...suspended].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).map(job => failedJob(job) ? theme.red(job.id) : job.id)
    detail.push(truncateToWidth(theme.dim(`    ◌ ${uiText("suspended", "挂起", "一時停止")}: `) + names.join(theme.dim(", ")), width))
  }
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

type Cell = "suspended" | "failed" | "running" | "queued"
const GLYPH: Record<Cell, (text: string) => string> = {
  suspended: text => theme.dim(text), failed: text => theme.red(text), running: text => theme.cyan(text), queued: text => theme.dim(text),
}
const CHAR: Record<Cell, string> = { suspended: "◌", failed: "✗", running: "●", queued: "○" }

/**
 * Left to right: suspended, failed, running, queued — as a wave finishes, cells move
 * from the right end to the left. Past STRIP_CELLS each kind gets cells by share, and any kind present keeps
 * at least one: a single failure among eighty must not round away to nothing.
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


function failedJob(job: JobSnapshot): boolean {
  return job.signal === undefined && job.exit !== 0
}
