/**
 * task tool: dispatch a subagent and **come straight back**; you'll be told when it's done.
 *
 * ── Three versions back and forth, worth writing down ──
 * v1: return as soon as it starts, collect the result with `job output`. In real runs the
 *   model, having sent someone out and with nothing left on its hands, went on to do the
 *   same job all over again itself — because nobody had told it "just wait".
 * v2: stand and wait instead. That stopped the duplicate work, but a whole turn was tied
 *   up, and the user could not get a word in until the subagent finished — when the point
 *   of "sending someone out" already includes "I can do other things meanwhile", and the
 *   same goes for the user.
 * v3 (this one): **return as soon as it starts, but the result is pushed to it, not fetched
 *   by it**. The moment the subagent finishes talking, its report enters the main session
 *   as a synthetic message and the main agent is woken up to carry on. So all three
 *   parties end up where they belong: the subagent works quietly in the background, the
 *   main agent waits when it should wait and talks to the user when it should talk, and
 *   the prompt in the user's hands stays theirs the whole time.
 *
 * ── So this tool **does not wait**, and the model should not poll either ──
 * That is why the description hard-codes two things: the result comes back on its own (do
 * not go fishing for it in `job output`), and if there is nothing else to do after
 * dispatching, say one short line and stop — stopping is not slacking off, it is handing
 * the conversation back to the user.
 *
 * ── Why only half of the description is left ──
 * The **semantics** of `after` / `resume` are already spelled out in the parameter
 * descriptions, and parameter descriptions are always loaded. The old DESCRIPTION told the
 * same story again in other words — those two paragraphs alone ran to over a thousand
 * characters, paid for in every session and on every request, while the turns that
 * actually send out a team are very few.
 *
 * So what moved out is "how to use it well" (the cost of chaining, the cost of resume, what
 * happens when two of them write the same file), and it went to the `alfa-subagents`
 * built-in skill; what stayed is "when to use it, and what to do afterwards" — the latter
 * is **behavior shaping**, and loading on demand does nothing for it (see the ★ in
 * prompt/builtin-skills.ts: the model will not go and open a skill that constrains itself).
 *
 * The test is this one: **what the parameter descriptions already say, don't say a second
 * time; what only takes effect after the call, must stay.**
 *
 * ── A finished one can still be woken (resume), and there is **no expiry** ──
 * Its whole session lies intact in the store; waking it costs just one more run of the
 * loop — and it is still holding everything it read last round. When following up on the
 * same thing, dispatching a blank one means explaining the background all over again and
 * re-reading the same batch of files. Conversely, the description also says plainly when
 * not to use it: carrying on the conversation means its tens of thousands of tokens of
 * history get re-sent every turn, and the whole point of dispatching a subagent is to burn
 * those somewhere else.
 *
 * ── model / effort / tools: the setup is the caller's, the checking is not ──
 * All three default to "same as me". Their semantics live in the parameter descriptions
 * (always loaded); how to choose them well lives in the `alfa-subagents` skill — same
 * split as after/resume above. Names are checked in agent/subagent.ts (resolveSetup),
 * which knows the tool list and the model registry; this file only refuses the
 * combinations that can't mean anything, like choosing a setup for a resumed agent.
 */
import { z } from "zod"
import { REASONING_EFFORTS } from "../llm/types.ts"
import type { ToolDef } from "./types.ts"

const Parameters = z.object({
  name: z
    .string()
    .optional()
    .describe(
      'What KIND of agent this is, in a couple of words — by its nature, not by this particular job: ' +
        '"research agent", "test agent", "调查agent". Any language. It becomes the job\'s name, ' +
        "and a second one of the same kind gets -2 after it. Leave it out when you are using resume.",
    ),
  resume: z
    .string()
    .optional()
    .describe(
      "The name of a subagent that has already finished, to wake up and give more work to. It still has its " +
        "whole conversation, so you do not have to explain any of it again. Use this instead of name when you " +
        "are following up on what that same agent just did.",
    ),
  after: z
    .array(z.string())
    .optional()
    .describe(
      "Names of subagents this one has to wait for. It does not start until they have all finished, and their " +
        "reports are pasted into the top of its brief automatically — so the brief only needs to say what to DO " +
        "with them. Use it to build a whole pipeline in one turn: several finders, then one that checks their " +
        "findings, then one that writes them up. Only names you started earlier in this conversation.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      'The model it runs on, as "provider/model" — or just a model name to stay on your own provider. ' +
        "Leave it out to use your own model. A cheaper, faster model suits broad or mechanical work (finding, " +
        "listing, summarising); keep a strong one for judgement calls. A wrong name fails with the list of what " +
        "is configured. Not with resume.",
    ),
  effort: z
    .enum(REASONING_EFFORTS)
    .optional()
    .describe(
      "How hard it thinks. Leave it out to match this conversation. Lower is faster and cheaper — enough for " +
        "finding and listing; keep it high where a subtle mistake is expensive. Not with resume.",
    ),
  tools: z
    .array(z.string())
    .optional()
    .describe(
      'The only tools it gets, by name — e.g. ["read", "grep", "glob"] for an investigation that cannot change ' +
        "anything. Leave it out to give it all of yours except task and ask. Not with resume.",
    ),
  prompt: z
    .string()
    .describe(
      "The whole brief, sent to the subagent word for word: what to do, where to look, and exactly what to " +
        "report back. For a new subagent it cannot see this conversation, so everything it needs has to be in " +
        "here; for a resumed one, it already remembers its own work, so say only what is new. Its first " +
        "line is what the user sees in /agents, so make that line say what this job is.",
    ),
})

type Args = z.infer<typeof Parameters>

const DESCRIPTION = `Hands one job to a subagent working in the background, and returns immediately.

A subagent is a full agent with its own context: by default your model and your tools minus \`task\` and \`ask\` (\`model\`, \`effort\` and \`tools\` change that), the same permissions, its own conversation. Use it when the work would flood your own context with material you do not need to keep — finding where something lives in a large codebase, reading a directory to summarise it, digging out how one subsystem works. Only its final answer comes back to you, not the twenty files it read to get there. That is the point: you get the conclusion without paying for the search.

ITS ANSWER IS DELIVERED TO YOU AUTOMATICALLY when it finishes, as a new message in this conversation. You do not poll for it, and you do not need the job tool to collect it.

So after starting one:
- Do NOT start doing the same work yourself. It is being done.
- Start the other subagents too, if the job splits into independent parts. They run at the same time — and if more are started than there are slots, the rest queue up and start on their own as slots free.
- If there is nothing useful left to do until the answers arrive, say so in one short line and stop. Stopping hands the conversation back to the user, who can keep talking to you while the work runs — you will be woken up when each answer lands.
- If there IS something useful you can do meanwhile — work the user can use right now, or a question you can already answer — do it.

Do not use it for work you can finish in two or three tool calls yourself: a subagent costs a whole conversation of its own.

Usage rules:
- The brief must stand alone. The subagent cannot see this conversation, your instructions, or what the user said. Spell out the goal, where to start, and what "done" looks like.
- Say what to report back, and how much: "list every call site with file:line" gets you that; "look into X" gets you an essay.
- It cannot ask the user anything, and it cannot start subagents of its own. If the work needs a decision from the user, get that decision first (ask tool), then send it in the brief.
- **If a skill in your catalogue covers what you are sending out, name it in the brief** — "read the \`cut-a-release\` skill first". The subagent has the same catalogue and the same \`skill\` tool, but not the conversation that made that skill relevant, and a narrow brief gives it no reason to go looking. Naming it is enough; do not paste its text.
- It CAN edit files and run commands, through the same permission gate you do — unless \`tools\` leaves those out. Two of them editing one file at the same time produce a mess, and nothing merges anything for you.

Chaining several with \`after\`, waking a finished one with \`resume\`, choosing \`model\` / \`effort\` / \`tools\`, or sending out a wave that writes: **open the \`alfa-subagents\` skill first.** What those cost, and how to split the work so they do not collide, is there rather than here — it is the difference between a fleet that pays for itself and one that does not.`

export const TaskTool: ToolDef<Args> = {
  id: "task",
  description: DESCRIPTION,
  parameters: Parameters,

  async execute(args, ctx) {
    if (!ctx.agents) {
      throw new Error(
        "Subagents are not available in this run. Do the work yourself, in this conversation.",
      )
    }

    const resume = args.resume?.trim()
    const name = args.name?.trim()
    const after = (args.after ?? []).map((id) => id.trim()).filter((id) => id.length > 0)
    // Given both, it most likely hasn't made up its mind which one it wants. Pick one and
    // run with it, and the other intent gets silently dropped — and those two intents
    // (start a new one / continue the last one) are far apart
    if (resume && name) {
      throw new Error(
        'Give either "name" (start a new subagent) or "resume" (wake one that already finished), not both.',
      )
    }
    if (!resume && !name) {
      throw new Error('name is required: what kind of agent this is. Use "resume" instead to wake a finished one.')
    }
    // ★ resume + after is not allowed, and the reason is not "not implemented". The one
    //   being woken is an **old node**; make it wait on a newer job and you can build a
    //   cycle — and the whole dependency graph stays acyclic precisely because "new ones
    //   can only point at old ones" (see AgentJob.after in agent/subagent.ts)
    // ★ Nor a new setup for a woken one: its history was produced under the old model and
    //   tool list, and switching either re-sends all of it at full price — for something a
    //   fresh subagent gives for free (see the file header of agent/subagent.ts)
    if (resume && (args.model !== undefined || args.effort !== undefined || args.tools !== undefined)) {
      throw new Error(
        '"model", "effort" and "tools" only apply when starting a new subagent. One you wake keeps the setup it ' +
          "was started with; if it needs a different one, start a new subagent with name instead.",
      )
    }
    if (resume && after.length > 0) {
      throw new Error(
        '"after" only works when starting a new subagent. One you are waking up has already done a round of ' +
          "work; if it needs to wait for something, wait for that yourself and then resume it with what came back.",
      )
    }

    // One pass through the permission gate. The subagent still goes through the gate on
    // every step of its own (it uses the same rule table); what is asked here is a
    // different question: **whether to let it go at all**. Someone who doesn't want the
    // agent dispatching work on its own needs a place to say no, and that place can only
    // be here
    // The setup goes on the card too: "a subagent that can only read" and "one that can run
    // anything" are different things to approve, and the brief alone doesn't say which
    const setup = [
      args.model?.trim() ? `model: ${args.model.trim()}` : "",
      args.effort ? `effort: ${args.effort}` : "",
      args.tools ? `tools: ${args.tools.join(", ")}` : "",
    ].filter((line) => line.length > 0)
    await ctx.ask({
      permission: "task",
      patterns: ["*"],
      metadata: { preview: `${resume ? `${resume} (resumed)` : name}${setup.length > 0 ? `\n${setup.join(" · ")}` : ""}\n\n${args.prompt}` },
    })

    const job = resume
      ? await ctx.agents.resume(resume, args.prompt)
      : await ctx.agents.start({
          name: name!,
          prompt: args.prompt,
          ...(after.length > 0 ? { after } : {}),
          ...(args.model?.trim() ? { model: args.model.trim() } : {}),
          ...(args.effort ? { effort: args.effort } : {}),
          ...(args.tools ? { tools: args.tools } : {}),
        })
    ctx.metadata({ job: job.id, description: job.command, ...(resume ? { resumed: true } : {}) })

    // The queued ones, too, must **say right away what they are waiting for**. Reply with
    // just "it has been dispatched" and a little later the model notices in `job list` that
    // it hasn't moved at all, then goes fishing in `job output` — when it hasn't done
    // anything yet
    if (job.status === "queued") {
      const behind = after.length > 0 ? `waiting for ${after.join(", ")}` : "waiting for a free slot"
      return {
        output:
          `Subagent "${job.id}" is queued (${behind}): ${job.command}\n\n` +
          `It starts on its own as soon as ${after.length > 0 ? "those have finished" : "a slot frees up"}` +
          `${after.length > 0 ? ", with their reports already in its brief" : ""}. Carry on laying out the rest ` +
          `of the work — you do not have to wait here, and you do not have to start it yourself later.`,
        title: `${job.id} queued`,
        metadata: { truncated: false, job: job.id, started: true, queued: true },
      }
    }

    // Two ways it can already be over within the few hundred ms after starting, and they
    // **must be told apart**:
    //   exit 0   — the job was tiny, it has already answered. Report it as a "failure"
    //              and the model will dispatch it all over again
    //   non-zero — wrong credentials, a mistyped model name and the like: report it as the
    //              failure it is, not as "it has been dispatched"
    // Both must **hand over the report right here**, and claim it with claimReport —
    // otherwise the push at completion delivers the same conclusion a second time (see
    // AgentJobs.claimReport)
    if (job.status === "exited") {
      const report = ctx.agents.claimReport(job.id) ?? "It said nothing."
      const failed = job.exit !== 0
      return {
        output: failed
          ? `The subagent "${job.id}" stopped without doing the work:\n\n${report}`
          : `Subagent "${job.id}" was quick — it has already finished. Its answer:\n\n${report}`,
        title: failed ? `${job.id} failed to start` : `${job.id} · done`,
        metadata: { truncated: false, job: job.id, started: !failed, answered: !failed, ...(resume ? { resumed: true } : {}) },
      }
    }

    return {
      output:
        `Subagent "${job.id}" is ${resume ? "awake again and working on" : "working on"}: ${job.command}\n\n` +
        `Its answer will be delivered to you as a message when it is done — do not poll for it, and do not ` +
        `do this work yourself in the meantime. Start any other subagents you need now. If there is nothing ` +
        `else useful to do until the answers arrive, say so in one short line and stop; you will be woken up.`,
      title: `${job.id} started`,
      metadata: { truncated: false, job: job.id, started: true, ...(resume ? { resumed: true } : {}) },
    }
  },
}
