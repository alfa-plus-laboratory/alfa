/**
 * job tool: watch / wait on / stop what runs in the background — processes, and subagents.
 *
 * ── Why one tool with three actions, not three tools ──
 * They answer three stages of the same question: "what is running now" → "what did it
 * say" → "stop it". Split into three tools, the tool list grows by half, and the tool list
 * is something **sent again on every turn** — see the usage report in agent/context.ts.
 *
 * ── Why processes and subagents belong to the same tool ──
 * See the top of tool/background.ts. The gist: for the model, the questions to ask about
 * these two are exactly the same, and two separate sets would only force it to first
 * think "which kind is this id" every time — a question worth nothing to it. The process
 * table is a module singleton (started by bash); the subagent table is **injected** (it
 * has to start a whole loop, and src/tool doesn't know about the loop). Both sides have
 * the same shape, so there is basically no branching below.
 *
 * ── Only the new part ──
 * output takes what came "since last time" (the cursor lives on each side's own table).
 * Otherwise, a server that has been running for ten minutes could blow up the window on
 * the second ask, and 99% of it would be stuff it has already read.
 *
 * ── wait is half the reason this tool exists ──
 * If "start a server and then hit it" could only be done by polling, the model would
 * write `sleep 3 && curl` — a guessed number of seconds: too short and it fails, too long
 * and it waits for nothing. wait turns it into one definite call: wait until there is
 * output, or the process exits, or it times out, and whichever comes first is clearly
 * reported. It is for processes only: on a subagent wait is forced to 0, because its
 * result is pushed into the main conversation the moment it is done (see the ★ on waitMs
 * in execute).
 */
import { z } from "zod"
import type { AgentJobs, JobReadResult, JobSnapshot } from "./background.ts"
import { kill, list, ownedBy, read, UnknownJobError } from "./bash/jobs.ts"
import type { ToolDef, ToolContext } from "./types.ts"

/**
 * Upper limit for wait. Any longer and it should go do something else — an agent
 * shouldn't spend a whole turn waiting
 */
const MAX_WAIT_SECONDS = 120

const Parameters = z.object({
  action: z.enum(["list", "output", "suspend", "kill"]).describe("What to do"),
  id: z.string().optional().describe('The job name, e.g. "dev". Required for "output", "suspend" and "kill".'),
  wait: z
    .number()
    .min(0)
    .max(MAX_WAIT_SECONDS)
    .optional()
    .describe(
      `Only for "output", and only for PROCESSES: if there is no new output yet, wait up to this many seconds ` +
        `for some (or for the process to exit). Default 0 = return immediately. It is ignored for subagents — ` +
        `their answers are delivered to you on their own, so there is never anything to wait for.`,
    ),
})

type Args = z.infer<typeof Parameters>

const DESCRIPTION = `Inspects and controls background work: processes started with the bash tool (background: true), and subagents started with the task tool.

Actions:
- list: everything this session started, running or finished. A running job shows how long it has been going and what it is doing right now.
- output: what has been produced since you last read it, plus whether it is still alive. Output is incremental — each read gives you only what is new, so reading repeatedly is cheap and never repeats itself. For a PROCESS you may pass wait to block until there is something new: start a server, then read with wait: 10 until it prints that it is listening, instead of guessing with sleep.
- suspend (subagents only): stop a subagent you may need again. It stops working but keeps its whole memory, and \`task\` resume wakes it. A subagent that finishes on its own is suspended too.
- kill: stop a job for good and collect whatever it produced last. A killed subagent is removed — it leaves the list and can never be resumed. **Read what it tells you.** It confirms the process actually ended; when it could not, it says so and the job is still running. Never report something as stopped on the strength of having called kill — on Windows in particular, a tree can survive it and keep holding its port.

Subagents: when you judge one will not be needed again, kill it; otherwise suspend it.

Jobs are named after what they are: "npm run dev" becomes "dev", "cargo watch -x run" becomes "watch", a subagent auditing the auth flow becomes "audit". Use that name as the id; names are never reused, even after a job finishes. A job that ended is still listed, with its exit code — "not found" and "failed" are different answers.

Do NOT sit in a loop of reads waiting for a subagent to finish. Nothing in this tool blocks for a subagent, and its answer is delivered to you on its own the moment it is done. When the user asks what one is doing, "list" already answers it: read it once, say it in a line, and stop — every read is a step in which you are not talking to the user, who is still there and can send you something at any moment. When reading a subagent's output is worth it at all is in the \`alfa-subagents\` skill.

Stop the jobs you started once you no longer need them. Everything left running is stopped when the session ends, but a forgotten dev server holds its port for the rest of the session.`

export const JobTool: ToolDef<Args> = {
  id: "job",
  outputSource: "command",
  description: DESCRIPTION,
  parameters: Parameters,

  async execute(args, ctx) {
    // Permission: watching and stopping what it started itself doesn't ask again. The two
    // real gates are elsewhere — commands were authorized over in bash, dispatching work
    // was authorized over in task; nothing here touches anything new
    if (args.action === "list") {
      // A subagent only sees the processes it started (see list in bash/jobs.ts): with a
      // shared table and a shared cursor, one casual read by it would take away output the
      // main agent hasn't read yet
      const jobs = [...list(ctx.owner), ...(ctx.agents?.list() ?? [])].toSorted(
        (a, b) => a.startedAt - b.startedAt,
      )
      const running = jobs.filter((job) => job.status === "running").length
      const queued = jobs.filter((job) => job.status === "queued").length
      return {
        output: jobs.length === 0 ? "Nothing running in the background." : jobs.map(describe).join("\n"),
        title: `${running} running${queued > 0 ? ` · ${queued} queued` : ""}`,
        metadata: { truncated: false, jobs: jobs.length },
      }
    }

    const id = args.id?.trim()
    if (!id) throw new Error(`id is required for action "${args.action}". Use action "list" to see the ids.`)
    const agents = agentOwning(ctx, id)
    // A process it didn't start simply doesn't exist as far as it's concerned — report "no
    // such job" rather than "not allowed to touch it"; the latter only sets it looking for a
    // way around
    if (!agents && !ownedBy(id, ctx.owner)) throw new UnknownJobError(id)

    // ── suspend vs kill: the model's words are the user's ──
    // suspend = stop it but keep it (its memory stays, task resume wakes it); kill = it
    // won't be needed again (stopped if working, then removed for good). There used to
    // be only kill, which meant suspend: a live run "killed" three suspended subagents
    // the user wanted gone, got "Stopped" back each time, and they stayed listed.
    if (args.action === "suspend") {
      if (!agents) throw new Error(`"${id}" is a process; only subagents can be suspended. Use "kill" to stop a process.`)
      if (agents.list().find((job) => job.id === id)?.status === "exited") {
        return {
          output: `${id} has already stopped — it is suspended, keeping its memory so task resume can wake it. Nothing was changed.`,
          title: `${id} already suspended`,
          metadata: { truncated: false, job: id, suspended: true },
        }
      }
      const result = await agents.suspend(id)
      const stopped = result.job.status === "exited"
      ctx.metadata({ job: id, suspended: stopped })
      const head = stopped
        ? `Suspended ${id}: it has stopped and keeps its memory; task resume can wake it.`
        : `Could NOT stop ${id}${result.detail ? ` — ${result.detail}` : ""}. It is still running. Do not report it as suspended.`
      return {
        output: [head, tailBlock(result.output)].join("\n\n"),
        title: stopped ? `${id} suspended` : `${id} still running`,
        metadata: { truncated: false, job: id, suspended: stopped },
      }
    }

    if (args.action === "kill") {
      const agentResult = agents ? await agents.kill(id) : undefined
      const result = agentResult ?? await kill(id)
      // ★ "Stopped" must not be reported unconditionally.
      //
      // This sentence used to be hard-coded, when all it actually said was "our bookkeeping
      // has been marked done" — what real runs ran into was `job kill` replying Stopped dev
      // while that dev server still held its port. An untrustworthy success message is far
      // worse than a failure message: the model carries on with it (starts something on
      // the same port, reports "all cleaned up"), and every step rests on something that
      // never happened.
      const stopped = result.job.status === "exited"
      ctx.metadata({ job: id, killed: stopped })
      const why = result.detail
      const gone = agentResult
        ? agentResult.removed
          ? " It is removed for good: gone from the list, and it can't be resumed."
          : " It will be removed for good the moment it ends."
        : ""
      const head = stopped
        ? why
          ? `Stopped ${id} — but: ${why}. Check for yourself before you rely on it (is the port free? is the process gone?).${gone}`
          : `Stopped ${id}.${gone}`
        : `Could NOT stop ${id}${why ? ` — ${why}` : ""}. It is still running. Do not report it as stopped: ` +
          `find it yourself (by port or by name) and say plainly what you did.${gone}`
      return {
        output: [head, tailBlock(result.output)].join("\n\n"),
        title: stopped ? `${id} stopped` : `${id} still running`,
        metadata: { truncated: false, job: id, killed: stopped, exit: result.job.exit ?? null },
      }
    }

    // ★ wait on a subagent is **always treated as 0**.
    //
    // ── Why "can't", rather than "discouraged" ──
    // The description says "its answer is delivered on its own, don't wait" in three
    // places, and in real runs the model still goes `wait: 120` the moment the user asks
    // "what is that subagent doing". The cost isn't one extra step: for those two minutes
    // the main agent is **dead** — anything the user interjects isn't seen until this
    // step's tool call returns, and the very question they just asked shows they want to
    // talk.
    //
    // And for a subagent, wait never had a legitimate use: the moment it has a result, a
    // message is pushed to the main agent (see v3 in tool/task.ts), so standing there
    // waiting is pure duplication. wait is kept for processes — "start a server, then wait
    // for it to say listening" can only be done this way.
    const waitMs = agents ? 0 : Math.round((args.wait ?? 0) * 1000)
    const ignoredWait = agents !== undefined && (args.wait ?? 0) > 0
    const result: JobReadResult = agents ? await agents.read(id, waitMs) : await read(id, waitMs)
    ctx.metadata({ job: id })
    const head = describe(result.job)
    const body =
      result.output.length > 0
        ? tailBlock(result.output)
        : result.job.status === "queued"
          ? "(it has not started yet — nothing to read)"
          : result.job.status === "running"
            ? result.timedOut
              ? `(nothing new in the last ${args.wait}s — it is still going)`
              : "(nothing new since your last read — it is still going)"
            : "(no further output)"
    // If it asked for a wait it must know that the wait **did not happen**: left unsaid, it
    // would think it had already waited, so "nothing came of the wait" turns into "it's
    // stuck", and then it waits again
    const note =
      ignoredWait && result.job.status !== "exited"
        ? `\n\n(wait does not apply to a subagent — nothing was waited for. Its answer will be delivered to you ` +
          `as a message when it is ready. Say one short line to the user and stop; you will be woken up.)`
        : ""
    return {
      output: [head, body].join("\n\n") + note,
      title: `${id} · ${result.output.length > 0 ? "new output" : result.job.status}`,
      metadata: {
        truncated: false,
        job: id,
        alive: result.job.status !== "exited",
        exit: result.job.exit ?? null,
      },
    }
  },
}

/**
 * Is this id a subagent.
 *
 * Names are unique across both kinds of job (see reserveName in tool/background.ts), so
 * one question is enough; it can never hit on both sides. When neither side knows it,
 * **fall back to the process path** — let that throw UnknownJobError, whose message says
 * "use list to see what there is".
 */
function agentOwning(ctx: ToolContext, id: string): AgentJobs | undefined {
  return ctx.agents?.has(id) ? ctx.agents : undefined
}

/**
 * A one-line status, for the model. The user's `/jobs` and `/agents` lines are built
 * separately, in cli/main.ts
 */
function describe(job: JobSnapshot): string {
  const ran = elapsed((job.endedAt ?? Date.now()) - job.startedAt)
  // Say who started it, too: when a process you never started suddenly shows up in the
  // list and it doesn't say which subagent started it, the model can only guess — and it
  // will most likely guess "I started it and forgot"
  const by = job.owner ? ` (started by subagent ${job.owner})` : ""
  // The setup a task chose, so a read-only scout and an editor aren't told apart only by
  // memory of the call that started them
  const setup = job.setup
    ? ` [${[
        job.setup.model ? `model ${job.setup.model}` : "",
        job.setup.effort ? `effort ${job.setup.effort}` : "",
        job.setup.tools ? `tools ${job.setup.tools.join(",")}` : "",
      ].filter((part) => part.length > 0).join("; ")}]`
    : ""
  const what = (job.kind === "agent" ? `subagent: ${job.command}` : job.command) + by + setup
  if (job.status === "queued") {
    // Spell out who it is waiting for. Say just "queued" and the model's next step is to
    // ask "why isn't it running" — when the answer (it is waiting for scout and scout-2)
    // was right at hand
    const behind = job.after && job.after.length > 0 ? `waiting for ${job.after.join(", ")}` : "waiting for a free slot"
    return `${job.id}  queued (${behind})  ${what}`
  }
  if (job.status === "running") {
    const pending = job.pending > 0 ? `, ${job.pending} chars unread` : ""
    const doing = job.activity ? `, now: ${job.activity}` : ""
    return `${job.id}  running ${ran}${pending}${doing}  ${what}`
  }
  const how = job.signal ? `stopped by ${job.signal}` : `exit ${job.exit ?? "?"}`
  // A finished subagent is suspended, not gone: say so where the model looks, or "finished"
  // reads as "used up" and it dispatches a blank one to redo the background it already has
  if (job.kind === "agent") return `${job.id}  suspended after ${ran} (${how}, ${job.steps ?? 0} steps; task resume:"${job.id}" wakes it with its memory)  ${what}`
  return `${job.id}  finished after ${ran} (${how})  ${what}`
}

/**
 * Duration. **Deliberately not reusing the one in cli/render.ts**: src/tool shouldn't
 * depend back on the rendering layer, and the two want different things anyway — that one
 * is for a six-column terminal cell, this one is prose for the model to read, where
 * `2m14s` is easier to understand than `134.0s`.
 */
function elapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m${Math.round((ms % 60_000) / 1000)}s`
}

function tailBlock(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : "(no output)"
}
