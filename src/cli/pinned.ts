/**
 * The rows pinned under the input box: how far the plan has got, which subagents are
 * working (running or queued), which background processes are running. At most a few
 * rows; the detail stays in the transcript, `/agents` and `/jobs`.
 *
 * ── Why under the input box, as a labelled column ──
 * They used to sit above the running line, between the conversation and "what it is
 * doing now", so the running line was pushed away from the box it is about and the eye
 * had to skip a block of state to get from the last reply to the prompt. Under the box
 * they join the footer as one status panel, and conversation → running line → input
 * reads top to bottom without a break. Each row starts with a short label (plan / agents
 * / jobs) padded to one column, and agent names are padded too, so what they are doing
 * lines up — a stack of rows that each start somewhere else reads as noise.
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
 * is "how far along", not "what are all the steps". Up to LIST_AGENTS working
 * subagents get a row each and no summary: a count above three names is a row spent
 * saying what the names already say, and folding three agents into "+2 more" hid two of
 * the three. Past that, one summary row holds any number — up to 24 one cell each, beyond
 * that a proportional strip — plus detail rows (the running ones) only when height
 * allows. Agentflow allows a hundred alive at once; a design that needs a row per agent
 * fails exactly when it's used hardest.
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
import { displayWidth, padToWidth, truncateToWidth } from "./width.ts"

const PLAN_BAR = 10
/** At most this many working subagents are listed one per row; more get a summary */
const LIST_AGENTS = 3
/** Agent names are padded to align their activity, up to this many columns */
const NAME_COLUMNS = 20
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
  const jobs = jobRow(input.jobs, width)
  // Agents get what plan and jobs leave, and always at least their first row: when height
  // runs out, jobs give way before agents (the slice below cuts from the end)
  const fixed = [plan, jobs].filter((row) => row !== undefined).length
  const agents = agentRows(input.agents, width, Math.max(1, max - fixed))
  return [plan, ...agents, jobs].filter((row): row is string => row !== undefined).slice(0, max)
}

/**
 * `plan   ▰▰▰▰▱▱▱▱▱▱ 3/6 ▸ add 3-language copy`. Absent when there's no plan or it's all
 * done.
 *
 * ★ The number is the position of the step named after it, not how many are done. It
 *   used to be the done count, and next to "▸ the step in progress" it read as the step
 *   number: working on step 1 showed `0/6`, and a model that updates its plan rarely
 *   left it at 0 for most of the work. Taken from the named step's own index, so a plan
 *   worked out of order still points at the right step.
 * The bar counts done steps plus half of the active one: it moves when a step starts,
 * and stays short of full until the last step is really done.
 */
export function planRow(items: readonly TodoItem[], width: number): string | undefined {
  if (items.length === 0) return undefined
  const progress = planProgress(items)
  if (progress.done === progress.total) return undefined
  const active = items.findIndex(item => item.status === "active")
  const at = active >= 0 ? active : items.findIndex(item => item.status === "pending")
  const filled = Math.min(PLAN_BAR - 1, Math.round(((progress.done + (active >= 0 ? 0.5 : 0)) / progress.total) * PLAN_BAR))
  const bar = theme.cyan("▰".repeat(filled)) + theme.dim("▱".repeat(PLAN_BAR - filled))
  const next = at >= 0 ? items[at]!.text : ""
  const mark = active >= 0 ? theme.cyan(" ▸ ") : theme.dim(" ○ ")
  const step = at >= 0 ? at + 1 : progress.done
  return labelled(labels().plan, `${bar} ${step}/${progress.total}${next ? mark + oneLine(next) : ""}`, width)
}

/**
 * The working subagents within `budget` rows. Up to LIST_AGENTS (and the budget allows):
 * one row each, running ones newest first, then queued. Past that: a summary row, then
 * the running ones' latest activity as height allows, then `+N more`.
 */
export function agentRows(jobs: readonly JobSnapshot[], width: number, budget = Infinity): string[] {
  const agents = jobs.filter(job => job.kind === "agent")
  const running = agents.filter(job => job.status === "running").sort((a, b) => b.startedAt - a.startedAt)
  const queued = agents.filter(job => job.status === "queued")
  const working = [...running, ...queued]
  if (working.length === 0 || budget <= 0) return []
  const label = labels().agents

  if (working.length <= LIST_AGENTS && working.length <= budget) {
    const names = Math.min(NAME_COLUMNS, Math.max(...working.map(job => displayWidth(job.id))))
    return working.map((job, i) => {
      const body = agentLine(job, names)
      return i === 0 ? labelled(label, body, width) : continued(body, width)
    })
  }

  const cells = strip([["running", running.length], ["queued", queued.length]])
  const counts = [
    running.length > 0 ? uiText(`${running.length} running`, `${running.length} 运行中`, `${running.length} 実行中`) : "",
    queued.length > 0 ? uiText(`${queued.length} queued`, `${queued.length} 排队`, `${queued.length} 待機`) : "",
  ].filter(Boolean).join(theme.dim(" · "))
  const rows = [labelled(label, `${cells} ${counts}`, width)]
  const room = budget - 1
  if (room <= 0 || running.length === 0) return rows
  // Room for one row only: the newest one, since the summary already gives the count
  const shown = running.length <= room ? running : room === 1 ? running.slice(0, 1) : running.slice(0, room - 1)
  // Padded to the names actually drawn, not to one that's folded into "+N more"
  const names = Math.min(NAME_COLUMNS, Math.max(...shown.map(job => displayWidth(job.id))))
  const detail = shown.map(job => continued(agentLine(job, names), width))
  const hidden = running.length - shown.length
  return [...rows, ...detail, ...(hidden > 0 && room > 1 ? [moreRow(hidden, width)] : [])]
}

/** `jobs   2 running · bun run dev · pytest -x`. Background processes started by anyone. */
export function jobRow(jobs: readonly JobSnapshot[], width: number): string | undefined {
  const running = jobs.filter(job => job.kind === "process" && job.status === "running")
  if (running.length === 0) return undefined
  const names = running.map(job => oneLine(job.command)).join(theme.dim(" · "))
  return labelled(labels().jobs, `${uiText(`${running.length} running`, `${running.length} 运行中`, `${running.length} 実行中`)}${theme.dim(" · ")}${theme.dim(names)}`, width)
}

/** `● scout    · read src/x.ts` — the name padded so activities line up */
function agentLine(job: JobSnapshot, names: number): string {
  const name = padToWidth(truncateToWidth(job.id, names), names)
  if (job.status === "queued") {
    const waiting = job.after && job.after.length > 0
      ? uiText(`waiting for ${job.after.join(", ")}`, `等待 ${job.after.join("、")}`, `${job.after.join("、")} を待機`)
      : uiText("queued", "排队中", "待機中")
    return `${theme.dim("○")} ${name}${theme.dim(` · ${waiting}`)}`
  }
  return `${theme.cyan("●")} ${name}${theme.dim(` · ${oneLine(job.activity || job.command)}`)}`
}

function moreRow(count: number, width: number): string {
  return continued(theme.dim(`+${count} ${uiText("more", "个", "件")} · /agents`), width)
}

function labels(): { plan: string; agents: string; jobs: string } {
  return {
    plan: uiText("plan", "计划", "計画"),
    agents: uiText("agents", "子代理", "エージェント"),
    jobs: uiText("jobs", "后台", "ジョブ"),
  }
}

/** One column for every label in the current language, so the rows' contents line up */
function labelColumn(): number {
  return Math.max(...Object.values(labels()).map(displayWidth))
}

function labelled(label: string, body: string, width: number): string {
  return truncateToWidth(`  ${theme.muted(padToWidth(label, labelColumn()))}  ${body}`, width)
}

/** A row under a labelled one: blank where the label was */
function continued(body: string, width: number): string {
  return truncateToWidth(`  ${" ".repeat(labelColumn())}  ${body}`, width)
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

