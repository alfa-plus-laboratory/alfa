/**
 * Subagents: send a copy of yourself out to do the work, without standing around waiting.
 *
 * ── Why it's built on background jobs rather than being a system of its own ──
 * A subagent combing through the repo and an `npm run dev` are the same thing to the user
 * and to the model: I don't have to wait on it, but I need to know whether it's still
 * alive, what it said, and how to stop it. Since the questions to answer are the same, it
 * should be the same kind of thing — the same table, the same receipts, the same `job`
 * tool (see the top of tool/background.ts). `task` only starts it; the other three needs
 * don't take a single new tool.
 *
 * ── It solves a **context** problem, not a concurrency problem ──
 * A job like "where in this repo is X implemented" means reading seven or eight files if
 * you do it yourself, and the contents of those files stay in the main conversation's
 * window forever — when the only useful part is the final conclusion. Sent out, all that
 * text burns in the subagent's own session, and only the conclusion comes back.
 * Parallelism is just a side benefit.
 *
 * ── Each subagent gets a session of its own ──
 * It has to be persisted: the main loop re-reads the full history from the store every
 * round (see the top of loop.ts), so without a session of its own it has no history to
 * read. But those sessions **must not show up in `/resume`** — the session the user wants
 * to continue is their own, not the little job sent out ten minutes ago to count three
 * files. So the session table has a parent_id column, and session listing filters on it
 * (see session/store.ts).
 *
 * ── Two things it can't do, both deliberate ──
 * 1. **It can't start subagents of its own.** `task` isn't in its tool list. Recursive
 *    expansion costs exponential tokens, and a runaway third level has nobody watching.
 * 2. **It can't ask the user.** `ask` isn't in its tool list. It runs in the background
 *    while the user is talking to the main agent; faced with a question popping up out of
 *    nowhere, with no context, the user has no way to judge how to answer it. If something
 *    needs asking, the main agent should ask it with the subagent's conclusions in hand —
 *    by then the context is complete.
 *
 * ⚠ But **permissions are unchanged**. It goes through the same gatekeeper as the main
 *   agent, the same rule table, the same "don't ask again", so it can edit files just the
 *   same, and it pops a dialog just the same when touching someone else's stuff (the
 *   dialog says which job is asking). Background isn't a way around the gatekeeper; it
 *   just doesn't stand there waiting — the same logic as `bash background:true`.
 *
 * ── Per job: which model, how hard it thinks, which tools ──
 * A task may set all three (see JobSetup). Before this, every subagent was a copy of
 * the main agent: same model, same tools — so a broad search paid top-model prices, and
 * a read-only investigation could not be sent out at all, only asked for politely in the
 * brief. What was tried first and dropped: expressing "read-only" as a flag. Which tools
 * count as read-only is not stable (bash reads and writes; an MCP tool says nothing),
 * so the call names the tools it grants and this file checks the names, nothing more.
 *
 * ★ All three are **fixed at start and kept on resume**. A woken subagent's history was
 *   produced under that setup — its cache prefix is that model with that tool list — and
 *   changing either halfway pays the whole history again at full price for a setting the
 *   main agent could have had by starting a fresh one. The task tool refuses the
 *   combination rather than guessing which of the two was meant.
 * ⚠ The tool list is **filtered, never reordered**: it is the earliest cache prefix, and
 *   the registry's sorted order is what makes it stable (see tool/registry.ts).
 */
import { forgetReads } from "../fs/freshness.ts"
import { killAll as killProcessJobs } from "../tool/bash/jobs.ts"
import { inspectLocalText, LOCAL_SOURCES } from "../tool/untrusted.ts"
import { newSessionID } from "../session/id.ts"
import type { Store } from "../session/store.ts"
import type { MessageWithParts, ToolPart } from "../session/schema.ts"
import type { LLMStreamFn, ModelInfo, ModelRef, ReasoningEffort, Tokens } from "../llm/types.ts"
import type { ToolContext, ToolDef } from "../tool/types.ts"
import {
  reserveName,
  slugName,
  type AgentJobs,
  type JobReadResult,
  type JobReader,
  type JobSnapshot,
  type StartAgentInput,
} from "../tool/background.ts"
import { Emitter, type UIEvent } from "./events.ts"
import { MAX_AGENT_JOBS, MAX_ALIVE_JOBS, MAX_FLOW_ALIVE_JOBS } from "./flow.ts"
import { contextTokens } from "./tokens.ts"
import { Loop } from "./loop.ts"

/**
 * The window and the total both live in agent/flow.ts — config validation and the
 * `/agentflow` command read them too, and neither of those modules should drag in the
 * whole scheduler for a few constants (see the top of that file).
 *
 * ★ MAX_AGENT_JOBS is the **window**, not the total: the fifth one doesn't error, it
 *   queues (see pump).
 */
export { MAX_AGENT_JOBS } from "./flow.ts"

/** Once a dependency finishes, max chars of its report spliced in for the next worker */
const HANDOFF_CHARS = 8_000

/**
 * How long to wait after starting before replying. See the end of launch(): these few
 * hundred ms buy "bad credentials show up on the spot"
 */
const SETTLE_MS = 400

/** Max characters of a subagent's output kept in memory */
const MAX_KEEP_CHARS = 200_000

/**
 * The line between the report and the process.
 *
 * Someone reading incrementally (`job output`) first sees a string of "where it went",
 * then this line, and only after it the conclusion. Without this line, the final paragraph
 * blurs together with the tool lines before it, though their value differs by an order of
 * magnitude.
 */
const REPORT_MARK = "--- report ---"


export interface SubagentDeps {
  store: Store
  stream: LLMStreamFn
  /** Read fresh: after a `/model` switch, the next subagent should use the new model */
  model(): ModelRef
  /**
   * That model's accounting. Needed to compute spend — whether cache hits count toward
   * input **depends on the provider** (see contextTokens in agent/tokens.ts). Sum it
   * yourself and the OpenAI-compatible side counts the cached part twice, overreporting a
   * run by as much as double
   */
  info(): ModelInfo
  /**
   * Book what the subagent spent into **this session's overall ledger**.
   *
   * Optional: subagents can also run where there's no main UI (tests, -p), and then there's
   * no gauge to update. If given, it must be the "book the spend, don't touch usage" path —
   * see ContextMeter.bill.
   */
  bill?(tokens: Tokens): void
  /**
   * The tools the subagent can use this round. A task's `tools` narrows this further,
   * here — see JobSetup.
   *
   * ★ **Removing `task` and `ask` is the caller's job**; it isn't done here on the caller's
   *   behalf — the reasons for those two boundaries are in the file header, and the
   *   removal happens at the CLI layer (only it knows what the tool list looks like).
   *
   * @param model The job's own model, when the task chose one. The list depends on it:
   *   the Responses codex profile swaps edit/write for apply_patch, and a subagent on that
   *   model with the main model's list would be handed tools its prompt never mentions
   */
  tools(model?: ModelInfo): ToolDef<any>[]
  /**
   * The subagent's system. Static — the job itself goes in the first user message; don't
   * splice it in here and wreck the cache
   *
   * @param model The job's own model, when the task chose one: the template follows the
   *   model (an OpenAI subagent must not get the Anthropic template), and so does the
   *   `model:` line the environment block reports
   */
  system(model?: { spec: string; info: ModelInfo }): string[]
  /**
   * Turn a task's `model` into something runnable, or throw a sentence the calling model
   * can act on (unknown provider, no key — and what is configured instead). Absent =
   * choosing a model isn't offered in this host, and a task asking for one is refused.
   */
  resolveModel?(spec: string): { spec: string; ref: ModelRef; info: ModelInfo }
  /**
   * The main conversation's effort, **read fresh** at each start — the default for a task
   * that doesn't set its own. Absent or undefined = the provider's default
   */
  effort?(): ReasoningEffort | undefined
  /**
   * @param job Which subagent this call belongs to. **Not just the sessionID** — the
   *   permission dialog has to say who's asking: when a dialog pops up while the user is
   *   talking to the main agent without saying which background job wants it, all they
   *   see is a request to authorize something they never asked anyone to do
   */
  makeToolContext(
    job: { id: string; sessionID: string },
    call: { messageID: string; callID: string; abortSignal: AbortSignal },
  ): ToolContext
  /**
   * What to attach to a new session's first message (the same as the main session's; see
   * memory / gitContext in loop.ts)
   */
  memory?(sessionID: string): { text: string; notes: number } | undefined
  gitContext?(): string | undefined
  /**
   * The directory this session is opened in. Sessions belong to a directory, and a child
   * session has to follow its parent's
   */
  directory: string
  /**
   * Which session is current. **Read fresh** — `/clear` can swap it mid-run, and a
   * subagent belongs to **the session that sent it out**, not whichever one happens to be
   * open when it comes back (see deliverReport)
   */
  session(): string
  /** Every event from a subagent's loop, tagged with the job; the host picks what to show */
  onToolEvent?(job: string, event: UIEvent): void
  /**
   * Leave a trace of starts and stops. A background you can't see is automation you can't
   * see — the same reasoning as on the process side
   */
  observer?(event: { kind: "started" | "exited"; job: JobSnapshot }): void
  /**
   * Some job's state changed (queued, started, a step, new output, ended). For a host
   * that shows live job state: nothing redraws on its own while idle, so without this
   * ping such a view stays stuck on the old state. The CLI doesn't wire it — the
   * transcript only gets the start/end receipts from observer and the diffs from
   * onToolEvent.
   */
  onChange?(): void
  /**
   * Is agentflow on, and if so, how big is the window. **Read fresh** — `/agentflow` should
   * take effect from the very next task, and what it changes is scheduling, not the ones
   * already running.
   *
   * Returns false / absent = off: window MAX_AGENT_JOBS, total MAX_ALIVE_JOBS.
   */
  flow?(): number | false
}

export class TooManyAgentsError extends Error {
  constructor(limit: number, flow: boolean) {
    super(
      `Too many subagents already queued or running (${limit}). ` +
        `Their answers arrive on their own — wait for some of them, or stop the ones you no longer need ` +
        `(job tool, action "kill").` +
        (flow ? "" : ` If this job really does split into more parts than that, ask the user to turn on agentflow.`),
    )
    this.name = "TooManyAgentsError"
  }
}

/**
 * What a task chose for its subagent. Each field present only if the task set it; an
 * absent one follows the main conversation. See the file header for why it's fixed at
 * start.
 */
interface JobSetup {
  model?: { spec: string; ref: ModelRef; info: ModelInfo }
  effort?: ReasoningEffort
  tools?: string[]
}

export class UnknownAgentError extends Error {
  constructor(id: string) {
    super(`No subagent named "${id}". Use the job tool with action "list" to see what is running.`)
    this.name = "UnknownAgentError"
  }
}

interface AgentJob {
  id: string
  /**
   * The first line of the brief. It's what the receipts and `job list` show — the name
   * can't say "what it's doing this time"
   */
  description: string
  sessionID: string
  /**
   * Which directory it runs in. Same as the parent session's — a job sent out is work in
   * this repo
   */
  workdir: string
  controller: AbortController
  status: "queued" | "running" | "exited"
  /**
   * Killed for good (`job kill`, `/agents <id> kill`). A stopped or finished subagent is
   * otherwise suspended indefinitely and can be woken; kill is the one way to say "this
   * one won't be needed again", so it stops being listed, read or woken — the same as a
   * subagent of another session (see owns). Its session stays in the store like any other.
   */
  removed?: boolean
  /** kill() was asked while it was still winding down: remove it the moment it exits */
  removeWhenDone?: boolean
  /**
   * The text it was given. **Held here while it's queued** — what actually goes out also
   * has what the jobs it waits on hand back spliced in front (see briefFor), and those
   * don't exist yet.
   */
  prompt: string
  /**
   * Start only once these have finished.
   *
   * ── Why no cycle check is needed ──
   * An edge can only point at a task **already registered** (see resolveAfter: unknown
   * names error on the spot), and a new task is always later than the ones it points to.
   * Later points to earlier, so this graph is a DAG by construction — a cycle can't be
   * built. That's exactly why resume doesn't accept after: the one being woken is an old
   * node, and letting it point at a new node would get around this invariant (see
   * AgentJobs.resume).
   */
  after: string[]
  /** See JobSetup. Kept across resume */
  setup: JobSetup
  /**
   * When it entered the queue. The stopwatch runs from startedAt, and time spent queued
   * doesn't count as its working time
   */
  queuedAt: number
  /**
   * Has it ever actually run.
   *
   * ★ Exists for one thing only: **no receipt for the ones that never ran**. A task
   *   cancelled while still queued never had a "▸ started" line; pair it with a "· it
   *   ended" and the user reads that something ended whose beginning they never saw — and
   *   one cascade can write ten such lines in one go. The model is still told (`job kill`
   *   replies on the spot "also took these down along the way", see kill)
   */
  ran?: boolean
  startedAt: number
  endedAt?: number
  exit?: number | null
  signal?: string
  steps: number
  /** Grows as it runs. See JobSnapshot.tokensIn — only this place can settle that account */
  tokensIn: number
  tokensOut: number
  activity?: string
  /**
   * The text it handed in at the end. See AgentJobs.report — if you want the conclusion,
   * this is all you need
   */
  report?: string
  /**
   * The report has reached the main agent. See AgentJobs.claimReport: two paths, but it may
   * be delivered only once
   */
  reported?: boolean
  /** Inside launch()'s settle window — whoever started it is about to claim the report. See settle */
  starting?: boolean
  /**
   * **Which session** sent it out. After a session switch, its conclusion has nowhere to
   * go; see deliverReport
   */
  parentSessionID: string
  /** All the output produced so far */
  seen: string
  /**
   * Length already handed to the model. Next time only the new part is given — the same
   * cursor semantics as on the process side
   */
  cursor: number
  /** The user's slash-command view advances independently from the model's context */
  userCursor: number
  waiters: Array<() => void>
  exitWaiters: Array<() => void>
}

export class SubagentJobs implements AgentJobs {
  private readonly jobs = new Map<string, AgentJob>()

  constructor(private readonly deps: SubagentDeps) {}

  async start(input: StartAgentInput): Promise<JobSnapshot> {
    const limit = this.maxAlive()
    if (this.alive().length >= limit) throw new TooManyAgentsError(limit, this.deps.flow?.() !== false)

    const name = input.name.trim()
    const prompt = input.prompt.trim()
    if (name.length === 0) throw new Error("name is required: a few words for what kind of agent this is.")
    if (prompt.length === 0) throw new Error("prompt is required: the whole brief for the subagent.")
    // ★ Dependencies must be validated **before claiming the name**. The other way round, a
    //   call with a mistyped dependency name burns a name for nothing (used names aren't
    //   recycled, see background.ts), and the next agent of the same kind becomes -2 for
    //   no reason
    const after = this.resolveAfter(input.after ?? [])
    // Same rule as after: a bad model or tool name must fail before a name is claimed
    const setup = this.resolveSetup(input)

    // Names go by **kind** (调查agent / 分析agent, i.e. "investigation agent" / "analysis
    // agent"), with -2 appended on a clash. Receipts and `job list` also show the first
    // line of the brief — the name answers "what kind of thing is this", that line
    // answers "what it's doing this time"
    const id = reserveName(slugName(name))
    const headline = firstLine(prompt).slice(0, 120)
    const sessionID = newSessionID()
    // ★ Once parentID is filled in, this session no longer appears in `/resume` or
    //   `--continue`. See the file header. What's filled in is **the session that sent it
    //   out**, not its own id — either would make the filter work, but only the former can
    //   still answer "who sent this" afterwards
    this.deps.store.createSession(sessionID, this.deps.directory, this.deps.session())

    const now = Date.now()
    const job: AgentJob = {
      id,
      description: headline,
      sessionID,
      parentSessionID: this.deps.session(),
      workdir: this.deps.directory,
      controller: new AbortController(),
      status: "queued",
      prompt,
      after,
      setup,
      queuedAt: now,
      startedAt: now,
      steps: 0,
      tokensIn: 0,
      tokensOut: 0,
      seen: "",
      cursor: 0,
      userCursor: 0,
      waiters: [],
      exitWaiters: [],
    }
    this.jobs.set(id, job)

    // If dependencies aren't all done, or the window is full, it queues — and **visibly, on
    // the spot**: the task call's reply says queued and what it waits for, and so does
    // `job list`. From outside, quietly queueing and quietly dropping look exactly the
    // same
    if (!this.admits(job)) {
      this.deps.onChange?.()
      return snapshot(job, this.feedsOf(id))
    }
    return this.launch(job, this.briefFor(job))
  }

  /**
   * Wake one that has finished and give it one more instruction. See AgentJobs.resume.
   *
   * ── Where it's cheap ──
   * That session lies untouched in the store, and the loop re-reads the full history from
   * the store every round — so "carrying on the conversation" needs nothing moved here:
   * append the new message, and when it wakes up it still holds everything it read in its
   * last run. Dispatching a blank one instead means re-explaining the whole background, and
   * what it reads is the same batch of files all over again.
   *
   * ── Where it's expensive (so the tool description has to say when not to use it) ──
   * Carrying on means its tens of thousands of tokens of history **are resent every
   * round**. And the entire point of dispatching a subagent is to burn those elsewhere — a
   * subagent that's woken again and again slowly turns into a second main conversation.
   * Use it to follow up on the same matter; for a different matter, dispatch a new one.
   */
  async resume(id: string, prompt: string): Promise<JobSnapshot> {
    const job = this.mine(id)
    if (!job) throw new UnknownAgentError(id)
    if (job.status !== "exited") {
      throw new Error(
        job.status === "queued"
          ? `Subagent "${id}" has not started yet — it is queued behind ${job.after.join(", ") || "the ones already running"}. ` +
            `It will do the job it was given, and its answer will be delivered to you on its own.`
          : `Subagent "${id}" is still working. Its answer will be delivered to you on its own — ` +
            `wait for it, then follow up if you still need to.`,
      )
    }
    const text = prompt.trim()
    if (text.length === 0) throw new Error("prompt is required: what you want it to do now.")
    const limit = this.maxAlive()
    if (this.alive().length >= limit) throw new TooManyAgentsError(limit, this.deps.flow?.() !== false)

    job.description = firstLine(text).slice(0, 120)
    job.controller = new AbortController()
    job.status = "queued"
    job.prompt = text
    job.queuedAt = Date.now()
    // ★ The dependencies from its previous run must be cleared. They finished long ago, and
    //   their content is already in its own session — kept, a stopped old dependency would
    //   get it cancelled by cascade this time around (see gateOf)
    job.after = []
    job.endedAt = undefined
    job.exit = undefined
    job.signal = undefined
    job.activity = undefined
    // The previous report was already delivered; this run builds up a fresh one
    job.report = undefined
    job.reported = false
    // The buffer keeps being appended to, not cleared — `job output` reads incrementally
    // (see tool/job.ts), and clearing it would leave the cursor pointing outside the buffer
    this.append(job, `\n--- woken up: ${job.description} ---`)
    if (!this.admits(job)) {
      this.deps.onChange?.()
      return snapshot(job, this.feedsOf(id))
    }
    return this.launch(job, text)
  }

  /**
   * The part that actually gets it running. **Shared by start and wake-up** — write it
   * twice and sooner or later you get "wound down on start, forgot to on wake-up", the kind
   * of bug that only shows itself on the second run.
   */
  private async launch(job: AgentJob, prompt: string): Promise<JobSnapshot> {
    const { id, sessionID } = job
    // ★ These two lines must come **before the first await**. pump() releases jobs one at
    //   a time and relies on the count from running() to know how many window slots are
    //   left — land the state one step late and a single pass releases the entire queue
    job.status = "running"
    job.ran = true
    // Only now does the stopwatch start: the minutes spent queued weren't it working. Spend
    // is **not reset** (for one that's been woken up): that account asks "how much has this
    // agent cost me in total", and it really is still the same agent
    job.startedAt = Date.now()
    // Total steps from its earlier runs. While running, observe() keeps adding as it goes
    // (a run that throws never reports a count, so then this is all there is), and when
    // this run ends normally the number the loop reports is authoritative — add the two
    // together and it doubles
    const stepsBefore = job.steps
    const emitter = new Emitter<UIEvent>()
    const unsubscribe = emitter.on((event) => { this.observe(job, event); this.deps.onToolEvent?.(job.id, event) })

    const { model, tools } = job.setup
    // Read at each start, like the model: a woken subagent that inherited its effort
    // follows an /effort changed since its last run
    const effort = job.setup.effort ?? this.deps.effort?.()
    const loop = new Loop({
      store: this.deps.store,
      emitter,
      stream: this.deps.stream,
      // Filtered, never reordered — see the ⚠ in the file header
      tools: tools
        ? () => this.deps.tools(model?.info).filter((tool) => tools.includes(tool.id))
        : () => this.deps.tools(model?.info),
      system: () => this.deps.system(model),
      makeToolContext: (call) => this.deps.makeToolContext({ id, sessionID }, call),
      ...(this.deps.memory ? { memory: this.deps.memory } : {}),
      ...(this.deps.gitContext ? { gitContext: this.deps.gitContext } : {}),
      // ★ Deliberately **not wiring** verify: that check (tsc / cargo check) is
      //   project-wide, and the main agent runs it at wrap-up anyway. A few more concurrent
      //   runs in the background would both fight each other for the machine and report a
      //   "half-edited" intermediate state as a failure — a failure nobody can see, which
      //   would only leave the subagent wrestling with itself in the background
    })

    const run = loop
      .run({
        execution: {
          requestKind: "subagent", runId: crypto.randomUUID(), sessionId: sessionID,
          rootSessionId: job.parentSessionID, agentInstanceId: sessionID,
          parentAgentInstanceId: job.parentSessionID, depth: 1,
        },
        sessionID,
        model: model?.ref ?? this.deps.model(),
        ...(effort ? { effort } : {}),
        // The tool receipt knows the reserved ID, but the worker cannot see that receipt.
        // Keep identity with the assignment so all workers retain the shared system prefix.
        text: `# Assigned subagent identity
Your assigned job ID is ${JSON.stringify(id)}. Use this exact ID when asked for your own name or identity; do not infer it from the project or another agent's report.

# Assignment
${prompt}`,
        abortSignal: job.controller.signal,
      })
      .then((result) => {
        // Add, don't overwrite: for one that's been woken, steps is its lifetime total
        job.steps = stepsBefore + result.steps
        // The report must be appended to the buffer **before wind-down**: append it after
        // status becomes exited, and a read() waking at exactly that moment sees "it ended"
        // with not a single word
        // Flagged here, where the report is born, because it leaves by three doors (the
        // task tool claiming it, delivery into the main session, a follow-up's brief) and
        // each would otherwise need its own check
        const answer = this.finalAnswer(job, result.error, result.interrupted, result.hitStepLimit)
        const warning = inspectLocalText(answer, LOCAL_SOURCES.subagent)
        job.report = warning.length === 0 ? answer : [...warning, answer].join("\n")
        this.append(job, `\n${REPORT_MARK}\n${job.report}`)
        this.settle(
          job,
          result.error ? 1 : result.interrupted ? null : 0,
          result.interrupted ? "stopped" : undefined,
        )
      })
      .catch((error: unknown) => {
        job.report = describe(error)
        this.append(job, `\n${REPORT_MARK}\n${job.report}`)
        this.settle(job, 1)
      })
      .finally(() => unsubscribe())

    // Wait a moment after starting before replying: errors like bad credentials or a
    // mistyped model name come back within a few hundred ms; report "dispatched" instead
    // and the model goes off to do other things without a care, only discovering minutes
    // later that it never started
    job.starting = true
    await Promise.race([exited(job), delay(SETTLE_MS)])
    job.starting = false
    void run

    if (job.status === "running") this.deps.observer?.({ kind: "started", job: this.snap(job) })
    return this.snap(job)
  }

  list(): JobSnapshot[] {
    return [...this.jobs.values()].filter((job) => this.owns(job)).map((job) => this.snap(job))
  }

  has(id: string): boolean {
    return this.mine(id) !== undefined
  }

  async read(id: string, waitMs = 0, reader: JobReader = "model"): Promise<JobReadResult> {
    const job = this.mine(id)
    if (!job) throw new UnknownAgentError(id)

    let timedOut = false
    // Queued ones can be waited on too — output comes as soon as it starts running. Waiting
    // on a task that hasn't started isn't a mistake; once this queue exists, it's a use
    // that's bound to happen
    if (waitMs > 0 && cursor(job, reader) >= job.seen.length && job.status !== "exited") {
      timedOut = !(await waitForChange(job, waitMs))
    }
    return { job: this.snap(job), output: drain(job, reader), timedOut }
  }

  async suspend(id: string, reader: JobReader = "model"): Promise<JobReadResult> {
    const job = this.mine(id)
    if (!job) throw new UnknownAgentError(id)
    // Stopping it = the ones waiting on it will never get what they're waiting for. **The
    // cascade must happen on the spot, and be said out loud** — skip it and they hang in
    // the queue forever (once gateOf says cancel, someone still has to carry it out); don't
    // say it and what the model sees is three tasks vanishing into thin air
    const cascade = job.status !== "exited" ? this.cancelDependents(id, `${id} was stopped`) : []
    if (job.status === "queued") {
      this.cancelQueued(job, "you stopped it before it started")
    } else if (job.status === "running") {
      job.controller.abort()
      // ★ Take down the background processes it started too. Otherwise a dev server
      //   started by a subagent keeps holding its port after the subagent itself is
      //   stopped — and its starts and stops are **not written into the conversation**
      //   (deliberately), so nothing anywhere on screen explains who holds that port
      void killProcessJobs(id)
      // An interrupt has to go through a whole chain (see agent/runner.ts): stream
      // disconnects → tools get the signal and wind themselves down → tool parts that never
      // landed are rewritten to error. Wait for it briefly, so what we get back is the
      // cleaned-up state
      await Promise.race([exited(job), delay(1_000)])
    }
    if (cascade.length > 0) {
      this.append(job, `— also cancelled, they were waiting on this one: ${cascade.join(", ")}`)
    }
    return { job: this.snap(job), output: drain(job, reader), timedOut: false }
  }

  /**
   * Done with this one for good: stop it if it's still working (the same path as
   * suspend, cascade included), then remove it.
   *
   * ── Why kill and suspend are two calls ──
   * Stopping used to be the only call, and a stopped subagent stays suspended — that is
   * what lets the main agent stop four scouts and then still ask one of them a question.
   * But "these won't be needed again" had no call: a live run killed three suspended
   * agents, got "Stopped" back each time, and they stayed in `job list` and the pinned
   * row. So the model's vocabulary is now the user's: suspend when it may be asked again,
   * kill when it won't. With agentflow a session can leave dozens behind; each is a line
   * in the pinned row, in `/agents` and in the model's `job list`.
   *
   * ★ One still winding down when suspend's wait runs out is marked and removed the moment
   *   it exits (settle). Its report then goes nowhere: the caller said it isn't wanted,
   *   and delivering the answer of an agent nobody can look up again would only confuse.
   */
  async kill(id: string, reader: JobReader = "model"): Promise<JobReadResult & { removed: boolean }> {
    const job = this.mine(id)
    if (!job) throw new UnknownAgentError(id)
    const result = job.status === "exited" ? { job: this.snap(job), output: drain(job, reader), timedOut: false } : await this.suspend(id, reader)
    if (job.status === "exited") job.removed = true
    else job.removeWhenDone = true
    this.deps.onChange?.()
    return { ...result, removed: job.removed === true }
  }

  /**
   * Stop them right away, **without waiting for them to wind down**. Returns how many were
   * stopped.
   *
   * `/clear` and `/resume` go through here: after switching conversations, the conclusions
   * those subagents hand back have nowhere left to go (the conversation that sent them out
   * is gone), and they're still burning money. No waiting for wind-down, because these two
   * commands **should react the moment you press them** — the rows in the UI turn into
   * "stopped" right away, while the wind-down in the store finishes on its own in the
   * background.
   */
  abort(): number {
    const alive = this.alive()
    for (const job of alive) {
      // The ones that haven't started are simply struck off: no stream to cut, no process
      // to collect — but they still hold a "to do", and if they aren't struck off, the queue
      // keeps running by itself after `/clear`
      if (job.status === "queued") {
        this.cancelQueued(job, "the conversation moved on")
        continue
      }
      // The ones struck off in earlier iterations take a batch down with them by cascade
      // (the pump in settle), so partway through this list some may already have wound
      // down — aborting a finished task again is harmless, but that's exactly the kind of
      // spot where "harmless, so leave it" slowly turns into a real bug
      if (job.status === "exited") continue
      job.controller.abort()
      // The processes it started go with it. See the ★ in kill()
      void killProcessJobs(job.id)
    }
    return alive.length
  }

  /**
   * Stop them all. Called before the process exits.
   *
   * Otherwise a subagent still running would keep writing to the store after the main
   * program has closed the database — not leaving stray processes behind, but writing to
   * an SQLite handle that's already closed.
   */
  async killAll(timeoutMs = 2_000): Promise<number> {
    const alive = this.alive()
    const running = this.running()
    this.abort()
    if (running.length > 0) {
      await Promise.race([Promise.all(running.map((job) => exited(job))), delay(timeoutMs)])
    }
    return alive.length
  }

  // ───────────────────────────────────────────── Scheduling

  private running(): AgentJob[] {
    return [...this.jobs.values()].filter((job) => job.status === "running")
  }

  /**
   * Queued + running. The total cap counts these — the queued ones will spend money sooner
   * or later too
   */
  private alive(): AgentJob[] {
    return [...this.jobs.values()].filter((job) => job.status !== "exited")
  }

  /** The current concurrency window. With flow mode on, it's the number flow gives */
  private window(): number {
    const flow = this.deps.flow?.()
    return typeof flow === "number" ? flow : MAX_AGENT_JOBS
  }

  private maxAlive(): number {
    return typeof this.deps.flow?.() === "number" ? MAX_FLOW_ALIVE_JOBS : MAX_ALIVE_JOBS
  }

  /** Can this queued one be released now: dependencies done, and room in the window */
  private admits(job: AgentJob): boolean {
    return this.gateOf(job) === "go" && this.running().length < this.window()
  }

  /**
   * What it's waiting on.
   *
   *   go     — everything it waits on has finished (**including the ones that crashed**)
   *   wait   — some haven't finished yet
   *   cancel — the one it waits on was stopped, so what it waits for will never come
   *
   * ── Why "crashed" still lets it through, while "stopped" cascades ──
   * A failed dependency still has something to say (why it failed, how far it got), and
   * the next worker can often still get on with that in hand — at the very least it can
   * truthfully report "the previous link didn't make it". **Being stopped**, though, is the
   * user's intent: when they pressed it, they meant to stop this whole line, not "this
   * one". Quietly carry on, and they'd see a string of work they just stopped pop right
   * back up.
   */
  private gateOf(job: AgentJob): "go" | "wait" | "cancel" {
    for (const id of job.after) {
      const dep = this.jobs.get(id)
      if (!dep) continue
      if (dep.status !== "exited") return "wait"
      if (dep.signal !== undefined) return "cancel"
    }
    return "go"
  }

  /**
   * Release into free slots, one at a time.
   *
   * Released in **registration order** (a Map iterates in insertion order), so the first
   * dispatched runs first — a queue where "who goes first is luck" shows up for the user as
   * the same job running in a different order every time.
   */
  private pump(): void {
    for (const job of [...this.jobs.values()]) {
      if (job.status !== "queued") continue
      const gate = this.gateOf(job)
      if (gate === "wait") continue
      if (gate === "cancel") {
        const blocker = job.after.find((id) => this.jobs.get(id)?.signal !== undefined)
        this.cancelQueued(job, `${blocker ?? "what it was waiting on"} was stopped`)
        continue
      }
      // Window full: stop right here. **Not continue** — the ones after this were queued
      // later, and there's no reason for them to jump ahead of this one
      if (this.running().length >= this.window()) return
      void this.launch(job, this.briefFor(job))
    }
  }

  /**
   * Check a task's model / effort / tools. Throws, like resolveAfter, rather than dropping
   * what it can't honor: a subagent quietly started with **all** tools after asking for
   * three is the exact read-only scout that must not happen.
   */
  private resolveSetup(input: StartAgentInput): JobSetup {
    const setup: JobSetup = {}
    // Model first: which tool names exist depends on it (see SubagentDeps.tools)
    const spec = input.model?.trim()
    if (spec) {
      if (!this.deps.resolveModel) {
        throw new Error("Choosing a model for a subagent is not available in this run. Leave model out.")
      }
      setup.model = this.deps.resolveModel(spec)
    }
    if (input.effort !== undefined) setup.effort = input.effort
    if (input.tools !== undefined) {
      const wanted = [...new Set(input.tools.map((name) => name.trim()).filter((name) => name.length > 0))]
      if (wanted.length === 0) {
        throw new Error("tools must name at least one tool. Leave it out to give the subagent all of yours.")
      }
      const barred = wanted.filter((name) => name === "task" || name === "ask")
      if (barred.length > 0) {
        throw new Error(
          `A subagent never gets ${barred.join(" or ")}: it cannot start subagents of its own or ask the user. ` +
            `Drop ${barred.length > 1 ? "them" : "it"} from tools.`,
        )
      }
      const available = this.deps.tools(setup.model?.info).map((tool) => tool.id)
      const unknown = wanted.filter((name) => !available.includes(name))
      if (unknown.length > 0) {
        throw new Error(
          `No tool named ${unknown.map((name) => JSON.stringify(name)).join(", ")} for a subagent. ` +
            `It can be given: ${available.join(", ")}.`,
        )
      }
      setup.tools = wanted
    }
    return setup
  }

  /**
   * Register dependencies. An unknown name **errors on the spot** instead of being treated
   * as already satisfied.
   *
   * When the model mistypes a dependency name, the task that should have waited starts
   * right away, gets an empty-handed brief, and hands in a respectable-looking wrong answer
   * — and that kind of mistake raises no error.
   */
  private resolveAfter(ids: readonly string[]): string[] {
    const out: string[] = []
    for (const raw of ids) {
      const id = raw.trim()
      if (id.length === 0) continue
      if (!this.mine(id)) throw new UnknownAgentError(id)
      if (!out.includes(id)) out.push(id)
    }
    return out
  }

  /**
   * Who's waiting on this one. See JobSnapshot.feeds — the report should go to them, not to
   * the main conversation
   */
  private feedsOf(id: string): string[] {
    return [...this.jobs.values()]
      .filter((job) => job.status === "queued" && job.after.includes(id))
      .map((job) => job.id)
  }

  /**
   * Strike off one that hasn't started. Ones already running or already wound down are left
   * alone — those two go through abort
   */
  private cancelQueued(job: AgentJob, why: string): void {
    if (job.status !== "queued") return
    job.report = `(cancelled: ${why})`
    this.append(job, `\n${REPORT_MARK}\n${job.report}`)
    this.settle(job, null, "stopped")
  }

  /**
   * Cancel everything waiting on this one and return who was cancelled — **the whole
   * line**, not just the direct next worker.
   *
   * ★ First **compute** the whole line, then take them down one by one. Compute while
   *   taking down, and the pump in settle cancels downstream tasks before the recursion
   *   reaches them (it can tell on its own that "what it waits on was stopped"), so those
   *   tasks **really are cancelled, yet missing from the return value** — and the return
   *   value is exactly the "I also took these down along the way" message for the caller.
   *   Something done but never said is harder to track down than something not done.
   */
  private cancelDependents(id: string, why: string): string[] {
    const doomed: AgentJob[] = []
    const front = [id]
    while (front.length > 0) {
      const from = front.shift()!
      for (const job of this.jobs.values()) {
        if (job.status !== "queued" || !job.after.includes(from) || doomed.includes(job)) continue
        doomed.push(job)
        front.push(job.id)
      }
    }
    for (const job of doomed) this.cancelQueued(job, why)
    return doomed.map((job) => job.id)
  }

  /**
   * The brief that actually goes out: what it waited for + its own job.
   *
   * ── Why dependency reports are **spliced into the brief**, not left to `job output` ──
   * A subagent has no `task`, and no reason to know what this orchestration looks like.
   * Give it a brief it can get to work from as soon as it's read, and it's just an ordinary
   * subagent — orchestration exists only inside the scheduler, instead of becoming a
   * protocol every subagent has to understand.
   */
  private briefFor(job: AgentJob): string {
    if (job.after.length === 0) return job.prompt
    const blocks: string[] = []
    for (const id of job.after) {
      const dep = this.jobs.get(id)
      if (!dep) continue
      const text = (dep.report ?? "(it finished without saying anything)").slice(0, HANDOFF_CHARS)
      const failed = dep.exit !== 0 ? " — THIS ONE FAILED, take it into account" : ""
      blocks.push(`## ${id}${failed}\nIt was asked to: ${dep.description}\n\n${text}`)
    }
    if (blocks.length === 0) return job.prompt
    return (
      `You were waiting on ${job.after.length === 1 ? "another subagent" : `${job.after.length} other subagents`}. ` +
      `${job.after.length === 1 ? "It has" : "They have"} finished, and this is what ` +
      `${job.after.length === 1 ? "it" : "they"} reported:\n\n` +
      `${blocks.join("\n\n")}\n\n---\n\nNow, your own job:\n\n${job.prompt}`
    )
  }

  private snap(job: AgentJob): JobSnapshot {
    return snapshot(job, this.feedsOf(job.id))
  }

  // ───────────────────────────────────────────── Internals

  /**
   * Was this subagent sent out by **this session**.
   *
   * ── Why the whole table is partitioned by session ──
   * A subagent goes with the session that sent it. After `/clear` it's a brand-new
   * conversation that knows nothing of what the previous one sent out — and without the
   * partition, the brand-new agent's first `job list` would show a pile of work it never
   * dispatched: it could read their output, stop them, even wake a ten-minute-old
   * investigation and carry on with it. This is the same rule as "processes started by a
   * subagent stay out of the main conversation", except that one partitions by **who
   * started it**, and this one by **who dispatched it**.
   *
   * ★ It also makes those come back on their own when `/resume` picks up an old session:
   *   ownership is recorded on the job, and "which session is current" is read fresh — the
   *   moment you resume, they belong to the current session again.
   */
  private owns(job: AgentJob): boolean {
    return job.parentSessionID === this.deps.session() && !job.removed
  }

  /**
   * The one belonging to this session. Anyone else's is treated as nonexistent — replying
   * "not allowed" would only send it looking for a way around
   */
  private mine(id: string): AgentJob | undefined {
    const job = this.jobs.get(id)
    return job && this.owns(job) ? job : undefined
  }

  /**
   * Subagent event → one line in the buffer.
   *
   * ── Why only tools are recorded, not what it says ──
   * What it says along the way ("let me look at X first") is reasoning for its own ears,
   * while this buffer is **for the main agent to read**: every line goes into the main
   * conversation's context. Keep just one line per tool call (where it went, what it
   * touched), plus the final report — that's the reason it was sent out.
   */
  private observe(job: AgentJob, event: UIEvent): void {
    switch (event.type) {
      case "message.start":
        job.steps++
        return
      // ★ Spend is **booked as it runs**, not totaled once it ends. A subagent that runs for
      //   five minutes is, until it ends, the only thing in this program that's "spending
      //   money with no number on screen"
      case "step.finish": {
        const tokens = event.part.tokens
        job.tokensIn += contextTokens(tokens, job.setup.model?.info ?? this.deps.info())
        job.tokensOut += tokens.output
        // ★ The same spend is booked in two places; the two answer different questions:
        //     on job — "how much did **this** subagent spend", for its end receipt
        //     bill() — "how much has **this session** spent in total", for the status
        //              line and /context
        //   Book only the former, and under agentflow, where the main agent is a foreman
        //   that barely does any work itself, the main ledger's number stays a tiny sliver
        //   forever, while the real money is all spent here.
        //
        //   ⚠ Go through bill(), not observe(): the latter would replace the main
        //     conversation's context usage with this subagent's (see the passage on
        //     ContextMeter.bill)
        this.deps.bill?.(tokens)
        this.deps.onChange?.()
        return
      }
      case "tool.state": {
        const part = event.part
        if (part.state.status === "running") {
          job.activity = callLabel(part)
          this.deps.onChange?.()
          return
        }
        if (part.state.status === "pending") return
        if (part.state.status === "completed") return this.append(job, `· ${callLabel(part)}`)
        return this.append(job, `✗ ${callLabel(part)} — ${firstLine(part.state.error)}`)
      }
      case "error":
        return this.append(job, `✗ ${firstLine(event.error.message)}`)
      default:
        return
    }
  }

  report(id: string): string | undefined {
    return this.mine(id)?.report
  }

  claimReport(id: string): string | undefined {
    const job = this.mine(id)
    if (!job || job.reported || job.report === undefined) return undefined
    job.reported = true
    return job.report
  }

  /** Which session dispatched this task. See AgentJob.parentSessionID */
  parentOf(id: string): string | undefined {
    return this.jobs.get(id)?.parentSessionID
  }

  /**
   * The final text it handed back. Taken from **the persisted copy**, not what the stream
   * accumulated — where an interrupt rewrote it, the store is authoritative
   */
  private finalAnswer(
    job: AgentJob,
    error: Error | undefined,
    interrupted: boolean,
    hitStepLimit = false,
  ): string {
    if (error) return `It stopped with an error: ${describe(error)}`
    const history = this.deps.store.listAll(job.sessionID)
    const text = lastAssistantText(history)
    // ★ An answer that hit the step cap must be **marked**. It still writes a wrap-up
    //   paragraph (MAX_STEPS_PROMPT forces it to), which reads exactly like a finished
    //   report — while it's actually cut off halfway. Unmarked, the main agent would treat
    //   an unfinished investigation as a conclusion, and this kind of mistake raises no
    //   error
    const clipped = hitStepLimit
      ? "\n\n(It ran out of steps before finishing — this answer may be incomplete.)"
      : ""
    if (text.length > 0) return text + (interrupted ? "\n\n(Stopped before finishing; this answer may be incomplete.)" : clipped)
    if (interrupted) return "(stopped before a final answer)"
    return "(it finished without a final answer)"
  }

  private append(job: AgentJob, text: string): void {
    if (text.length === 0) return
    job.seen += text.endsWith("\n") ? text : text + "\n"
    if (job.seen.length > MAX_KEEP_CHARS) {
      const over = job.seen.length - MAX_KEEP_CHARS
      job.seen = job.seen.slice(over)
      // The cursor has to move along with the cut — otherwise the part cut off would count
      // as "already read"
      job.cursor = Math.max(0, job.cursor - over)
      job.userCursor = Math.max(0, job.userCursor - over)
    }
    wake(job)
    this.deps.onChange?.()
  }

  private settle(job: AgentJob, exit: number | null, signal?: string): void {
    if (job.status === "exited") return
    job.status = "exited"
    job.endedAt = Date.now()
    job.exit = exit
    if (signal) job.signal = signal
    job.activity = undefined
    // Killed while it was still stopping: from here on it doesn't exist (see kill)
    if (job.removeWhenDone) job.removed = true
    // Its ledger of "what it has read" goes with it — this session is over, and that
    // ledger will never be consulted again (ledgers are per session, see fs/freshness.ts)
    forgetReads(job.sessionID)
    // ★ The snapshot must be taken **before** pump(). It carries feeds (who's waiting on
    //   this report), and whether the report goes into the main conversation is decided by
    //   exactly that (see deliverReport in cli/main.ts) — once pump runs, the one waiting
    //   goes from queued to running and feeds turns empty on the spot. The next worker
    //   still gets the report (briefFor reads it straight off this job), but the main
    //   conversation now thinks "nobody's waiting" and gets a second copy stuffed into it
    const snap = this.snap(job)
    wake(job)
    // No receipt for ones that never ran. See AgentJob.ran
    //
    // ★ One that ends inside its own settle window (a mistyped model, bad credentials) is
    //   announced a tick late. The task call that started it is still awaiting launch()
    //   and claims the report as soon as it resumes; announced synchronously, the host's
    //   delivery (deliverReport in cli/main.ts) claimed it first, and the task call — the
    //   one place the main agent reads "why didn't it start" — got "It said nothing."
    if (job.ran) {
      const notice = { kind: "exited" as const, job: snap }
      if (job.starting) setTimeout(() => this.deps.observer?.(notice), 0)
      else this.deps.observer?.(notice)
    }
    this.deps.onChange?.()
    // A slot just freed up, and the ones waiting on it may now have all they need
    this.pump()
  }
}

// ─────────────────────────────────────────────── Helpers

function snapshot(job: AgentJob, feeds: string[] = []): JobSnapshot {
  return {
    id: job.id,
    kind: "agent",
    command: job.description,
    workdir: job.workdir,
    status: job.status,
    startedAt: job.startedAt,
    ...(job.after.length > 0 ? { after: [...job.after] } : {}),
    ...(feeds.length > 0 ? { feeds } : {}),
    ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
    ...(job.exit !== undefined ? { exit: job.exit } : {}),
    ...(job.signal !== undefined ? { signal: job.signal } : {}),
    ...(job.activity !== undefined ? { activity: job.activity } : {}),
    ...(hasSetup(job.setup) ? { setup: {
      ...(job.setup.model ? { model: job.setup.model.spec } : {}),
      ...(job.setup.effort ? { effort: job.setup.effort } : {}),
      ...(job.setup.tools ? { tools: [...job.setup.tools] } : {}),
    } } : {}),
    pending: Math.max(0, job.seen.length - job.cursor),
    steps: job.steps,
    tokensIn: job.tokensIn,
    tokensOut: job.tokensOut,
  }
}

function hasSetup(setup: JobSetup): boolean {
  return setup.model !== undefined || setup.effort !== undefined || setup.tools !== undefined
}

function cursor(job: AgentJob, reader: JobReader): number {
  return reader === "user" ? job.userCursor : job.cursor
}

function drain(job: AgentJob, reader: JobReader = "model"): string {
  const out = job.seen.slice(cursor(job, reader))
  if (reader === "user") job.userCursor = job.seen.length
  else job.cursor = job.seen.length
  return out
}

function wake(job: AgentJob): void {
  const waiters = job.waiters
  job.waiters = []
  for (const resolve of waiters) resolve()
  if (job.status !== "exited") return
  const leaving = job.exitWaiters
  job.exitWaiters = []
  for (const resolve of leaving) resolve()
}

/** @returns true = something happened (new output or it ended), false = timed out waiting */
function waitForChange(job: AgentJob, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), ms)
    timer.unref?.()
    job.waiters.push(() => finish(true))
  })
}

function exited(job: AgentJob): Promise<void> {
  if (job.status === "exited") return Promise.resolve()
  return new Promise((resolve) => job.exitWaiters.push(resolve))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * One tool call written as one line.
 *
 * Deliberately **doesn't reuse cli/render.ts**: that draws cards for people (colored,
 * truncated to column width), while this line is prose for the model to read, and
 * src/agent shouldn't depend back on the rendering layer.
 */
function callLabel(part: ToolPart): string {
  const input = "input" in part.state ? (part.state.input as unknown) : undefined
  const hint = firstHint(input)
  return hint ? `${part.tool} ${hint}` : part.tool
}

/** Pick the field from the tool arguments that best says "what it's touching" */
function firstHint(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  for (const key of ["filePath", "command", "pattern", "path", "url", "query", "description"]) {
    const value = record[key]
    if (typeof value === "string" && value.length > 0) return firstLine(value).slice(0, 80)
  }
  return undefined
}

/**
 * What the last assistant message said. Synthetic messages don't count — those are
 * reminders fed back in, not its conclusion. Explicit commentary stays in the job
 * transcript, but must not masquerade as the final report handed to its parent. Stop at
 * the current dispatch's user boundary: resuming then interrupting a commentary-only run
 * must not resurrect the previous dispatch's successful answer.
 */
function lastAssistantText(history: MessageWithParts[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!
    if (entry.info.role === "user") break
    if (entry.info.role !== "assistant") continue
    const text = entry.parts
      .filter((part) => part.type === "text" && !part.synthetic && part.responses?.phase !== "commentary")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim()
    if (text.length > 0) return text
  }
  return ""
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? ""
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
