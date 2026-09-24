/**
 * The shared vocabulary for "what is still running in the background on my behalf".
 *
 * ── Why processes and subagents are the same thing ──
 * An `npm run dev` and a subagent combing through the repo are, to the user, the same
 * thing: **I don't have to stand here waiting, but I need to know whether it is still
 * there, what it said, and how to stop it**. Both outlive a single tool call, both have
 * to stay alive across turns, both have to be cleaned up on exit. Since the questions to
 * answer are the same, there should not be two sets of names, two panels, two "take a
 * look" tools — then the model would first have to work out "which kind is this id" every
 * time, a question of no value to it whatsoever.
 *
 * So the `job` tool manages both, with `bash background:true` and `task` each starting
 * one kind. This file is the little bit both sides share: the snapshot's shape, name
 * allocation, and the interface for the agent side.
 *
 * ── Why AgentJobs is only an interface ──
 * A subagent spins up a whole Loop, and `src/tool` does not know about the loop. The implementation lives in
 * `src/agent/subagent.ts` and is injected by the CLI when it builds the ToolContext.
 * Here we only declare "what it must be able to do".
 */

import type { ReasoningEffort } from "../llm/types.ts"

export type JobKind = "process" | "agent"
export type JobReader = "model" | "user"

export interface JobSnapshot {
  id: string
  /**
   * Process or subagent. The UI and `job list` both tell them apart; everywhere else
   * treats them alike
   */
  kind: JobKind
  /** For a process, the command text; for a subagent, the first line of its brief */
  command: string
  /**
   * **Who started** this background process (the subagent's name); ones started by the
   * main agent itself don't have this.
   *
   * ★ It decides whether this process starting and ending gets written into the main
   *   conversation: an `npm run dev` a subagent started in passing, reported into the
   *   conversation the user is reading, is **cross-contamination** — the user didn't ask
   *   anyone to start it, and that conversation is about something else. It is still
   *   listed by `/jobs` (that is state, not content).
   */
  owner?: string
  workdir: string
  /**
   * `queued` **only ever applies to subagents**: the window is full, or it is waiting for
   * other jobs to finish (see pump in agent/subagent.ts). Processes have no queue;
   * `bash background:true` starts when it starts.
   *
   * ★ Queued **does not count as running**. This field once had only two values, so a
   *   queued one could only be reported as "running" — and that statement was false: it
   *   hadn't sent a single request yet. "Stopped" has to be a true statement, and so does
   *   this one (see the star on JobReadResult.detail).
   */
  status: "queued" | "running" | "exited"
  /** The jobs it is queued behind (subagents only). See StartAgentInput.after */
  after?: string[]
  /**
   * Who is waiting for **this one's** report (subagents only).
   *
   * ★ It decides whether the report is sent into the main conversation: if someone is
   *   waiting, the report gets spliced into that one's brief (see briefFor in
   *   subagent.ts), and stuffing another copy into the main conversation hands back the
   *   very context that dispatching subagents was meant to save — twelve scouts each
   *   turning in a report, and the main conversation is full at once. If the agent that
   *   dispatched it wants to look, `job output` still reads it.
   */
  feeds?: string[]
  startedAt: number
  endedAt?: number
  /**
   * Exit code. null when killed by a signal; subagents use 0 = finished speaking,
   * 1 = error/stopped
   */
  exit?: number | null
  signal?: string
  /** How many characters of output haven't been read yet */
  pending: number
  /**
   * What it is doing right now (subagents only: a one-liner about its latest tool call).
   *
   * Processes don't have this — one line of `npm run dev` already says what it is, while a
   * subagent's `command` is the job handed down ten seconds ago; "what step is it on now"
   * has to be said separately.
   */
  activity?: string
  /**
   * What the subagent was set up with, when the `task` call chose it (subagents only).
   * Absent = inherited from the main conversation. Shown in `job list` so the model can
   * tell its read-only scout from its editor without remembering its own calls.
   */
  setup?: AgentSetup
  /** How many rounds of requests it has sent (subagents only) */
  steps?: number
  /**
   * How many tokens it has burned (subagents only, billing basis, **growing as it runs**).
   *
   * ★ Must be reported, and **split into in and out**. A subagent is the one thing in this
   *   program that "spends money invisibly": it runs in the background, with no card and
   *   no streaming text, and one run of it may cost more than a whole turn of the main
   *   conversation. The spend on the status line only counts the main session (that
   *   number is also the source of truth for context usage; mixing this in would make it
   *   all wrong), so this bill can only be settled on its own line.
   *
   *   In and out are split because their unit prices differ by an order of magnitude —
   *   merged into one number, a very cheap subagent and a very expensive one look exactly
   *   alike (same reason as that cell on the status line; see cli/context.ts).
   */
  tokensIn?: number
  tokensOut?: number
}

export interface JobReadResult {
  job: JobSnapshot
  /** New output since last time. Empty string if there is nothing new */
  output: string
  /** Timed out waiting (for that to happen, waitMs has to be greater than 0) */
  timedOut: boolean
  /**
   * Stopping a job couldn't confirm it is really gone — a sentence one can follow up on.
   *
   * ★ This field exists because "stopped" used to be reported **unconditionally**: the
   *   caller saw "Stopped dev", when all that sentence actually meant was "our bookkeeping
   *   has marked it done". What turned up in real runs was `job kill` saying stopped while
   *   the port was still taken (see KillOutcome in tool/bash/kill.ts).
   */
  detail?: string
}

export interface StartAgentInput {
  /**
   * What kind of agent this is — named by its **nature**, not by this particular job:
   * 调查agent (investigation agent), 分析agent (analysis agent), audit. It becomes the
   * job's name; on a clash `-2` is appended.
   *
   * Any language works (see slugName). The name in this field is what a person sees
   * first, whereas numbers like `job-2` / `job-5` have to be memorized to know who they
   * refer to — exactly what this naming scheme is meant to avoid.
   */
  name: string
  /**
   * The full brief handed to the subagent. It can't see the main conversation, so this
   * has to be self-contained
   */
  prompt: string
  /**
   * Start only after these finish, and splice the reports they hand back into its brief.
   *
   * ── This field is the whole of "orchestration" ──
   * With it, "twelve investigate separately → three cross-check → one summarizes" is **one
   * graph laid out in a single turn**, which the program runs through in topological
   * order. Without it, the main agent would have to wake up between every stage to act as
   * scheduler, and each time it wakes it resends the whole conversation history — the
   * cost of orchestration would double with the number of stages, until the
   * orchestration itself cost more than the work it orchestrates.
   *
   * Names must be jobs **already dispatched in this session** (see resolveAfter). So a new
   * job can only point to earlier jobs, and the graph is acyclic by construction.
   */
  after?: string[]
  /**
   * Which model it runs on, as `provider/model` — or a bare model name, meaning the
   * current provider. Absent = the main conversation's model, read when it starts.
   */
  model?: string
  /** Absent = the main conversation's effort, read when it starts */
  effort?: ReasoningEffort
  /**
   * The only tools it gets, by name — a subset of the main agent's minus `task` / `ask`.
   * Absent = all of those. Order doesn't matter: the list it gets keeps the registry's
   * sorted order either way (the tool list is the earliest cache prefix).
   */
  tools?: string[]
}

/** See JobSnapshot.setup. Each field present only if the task call set it */
export interface AgentSetup {
  model?: string
  effort?: ReasoningEffort
  tools?: string[]
}

/**
 * Subagents running in the background. Implementation in agent/subagent.ts.
 *
 * The method names match the bash/jobs.ts side **on purpose**: once the `job` tool has an
 * id it asks the process table first, then here; both return the same shape, so it
 * doesn't need two sets of branches for two kinds of job.
 */
export interface AgentJobs {
  start(input: StartAgentInput): Promise<JobSnapshot>
  /**
   * Wake up a subagent that has **already finished** and hand it one more instruction.
   *
   * ── Why it shouldn't have an expiry ──
   * That session sits complete in the database (see parent_id in agent/subagent.ts);
   * waking it costs only one more run of the loop — and it still holds everything it read
   * last round. Giving it a "gone cold after ten minutes" rule would be pure
   * implementation laziness: the user occasionally really does need to follow up with that
   * one, and then the only alternative is dispatching a blank one and explaining the
   * background all over again.
   *
   * ★ But **no expiry does not mean it crosses sessions**: only ones **dispatched by this
   *   session itself** can be woken. After `/clear` it is a brand-new conversation, and
   *   the previous one's subagents simply don't exist for it (see owns).
   *
   * One that is still running can't be woken (it is busy, and its answer will come back
   * on its own anyway), nor can an unknown name.
   */
  resume(id: string, prompt: string): Promise<JobSnapshot>
  list(): JobSnapshot[]
  has(id: string): boolean
  read(id: string, waitMs: number, reader?: JobReader): Promise<JobReadResult>
  /**
   * Stop it but keep it: a suspended subagent keeps its whole session and `resume` wakes
   * it. One that finishes on its own ends up in the same state.
   */
  suspend(id: string, reader?: JobReader): Promise<JobReadResult>
  /**
   * Done with it for good: stop it if it's still working, then remove it — gone from
   * list, output unreadable, never wakeable. `removed` is false when it was still winding
   * down after the wait; it is removed the moment it exits.
   */
  kill(id: string, reader?: JobReader): Promise<JobReadResult & { removed: boolean }>
  /**
   * The final text it handed in, **without the lines from its working process**.
   * undefined if it hasn't finished yet.
   *
   * Separate from read() because the two uses want different things: whoever wants the
   * conclusion wants only the conclusion (the whole point of dispatching it is that the
   * process stays out of the main conversation), while for ones running in the
   * background what's wanted is "what step is it on".
   */
  report(id: string): string | undefined
  /**
   * Take the report and **record that it has been delivered**.
   *
   * ★ A report may reach the main agent by two paths at once: the `task` call itself
   *   finding on the spot that it already finished (anything that ends within 400 ms
   *   does), and the push when it ends (see deliverReport in cli/main.ts). If both
   *   deliver, the model reads the same conclusion twice — and will most likely try to
   *   reconcile them as results from two subagents. This function makes it "whoever gets
   *   there first is responsible"; the other gets undefined and does nothing.
   */
  claimReport(id: string): string | undefined
}

// ─────────────────────────────────────────────── names

/**
 * Names in use, **not given back even after the job finishes**.
 *
 * ── Why both kinds of job share one ledger ──
 * With a subagent called `audit` and a script called `audit` running at the same time,
 * `job output audit` becomes a matter of luck. The name is the one thing in this field
 * that gets referenced over and over; it has to be unique across the whole program, not
 * "unique within its own table".
 *
 * ── Why names are not recycled ──
 * The model may still be holding the previous one's name. With a reused name it would
 * read the new job's output with the old conclusion in hand — and that kind of mistake
 * raises no error, it just yields an answer that looks reasonable.
 */
const used = new Set<string>()

/**
 * Trade an already-normalized word for a globally unique name:
 * `dev` → `dev` / `dev-2` / `dev-3`
 */
export function reserveName(base: string): string {
  const name = base.length > 0 ? base : "job"
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  for (let n = 2; ; n++) {
    const candidate = `${name}-${n}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
}

/** Tests only. */
export function __resetNamesForTest(): void {
  used.clear()
}

/**
 * A phrase → a word usable as a name. Shared by both sides, so that `dev` and `Dev` are
 * not treated as two names.
 *
 * ── Why not keep only ASCII ──
 * This once deleted everything matching `[^a-z0-9]+`, so **any Chinese name became an
 * empty string** and fell back to `job` / `job-2` / `job-5`. That is exactly what this
 * naming scheme is meant to avoid (see StartAgentInput.name above and nameFor in
 * bash/jobs.ts: numbers have to be memorized to know who they refer to). So what gets
 * removed now is **separators**, not "non-English": whitespace, punctuation and control
 * characters go; letters, digits and Han / kana / Hangul all stay.
 *
 * ── Why clip by display width ──
 * The name is shown inline wherever the job comes up — `/jobs` and `/agents` rows, the
 * approval card's header — and a CJK character takes **two columns**. Clip by character
 * count and an eight-character Chinese name gets drawn sixteen columns wide, twice the
 * budget.
 */
export function slugName(text: string): string {
  const out = text
    .toLowerCase()
    // Separators → hyphen. \p{L} is a letter in any language, \p{N} a digit
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
  return clampToColumns(out, NAME_COLUMNS) || "agent"
}

/**
 * Max columns for a name. Any wider and it crowds out the rest of the line it sits in (a
 * `/jobs` row, the approval card's header)
 */
const NAME_COLUMNS = 16

/**
 * Clip by **display width**.
 *
 * Deliberately not importing cli/width.ts: that is the rendering layer, and this is the
 * tool layer. What needs judging here is
 * much simpler too — just the one rule "CJK counts as two columns", with no need for the
 * full combining-character / variation-selector handling over there.
 */
function clampToColumns(text: string, columns: number): string {
  let width = 0
  let out = ""
  for (const char of text) {
    const size = wide(char) ? 2 : 1
    if (width + size > columns) break
    width += size
    out += char
  }
  return out.replace(/-+$/g, "")
}

/**
 * A coarser copy of the same wide-character table — here we only need "wide or not", not
 * width.ts's precision. The ranges likewise come from Markus Kuhn's wcwidth.c (public
 * domain); see NOTICE.
 */
function wide(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f)
  )
}
