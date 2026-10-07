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
 * ── What the description says, and what it leaves to the parameters ──
 * The test: **what the parameter descriptions already say, don't say a second time; what
 * only takes effect after the call, must stay.** The semantics of `after` / `model` /
 * `effort` / `tools` live in the parameter descriptions (always loaded); the description
 * carries only what they can't: what happens after the call, how to split writers, where a
 * chained answer goes, how to follow up.
 *
 * ★ Tried and reverted: moving "how to use it well" (chaining, follow-ups, setup, writers)
 *   into an `alfa-subagents` built-in skill, with a closing line here saying "open it
 *   first". That line covered nearly every real dispatch, so the model opened the skill
 *   before each one — an extra step and a "let me check the skill first" line every time
 *   — and most of what it held was behavior shaping (don't duplicate, split by file, don't
 *   downgrade the model unasked), which the ★ in prompt/builtin-skills.ts says a skill
 *   can't carry. Folded back, condensed: about 1k characters in the cached prefix, and
 *   subagents don't pay it (task isn't in their tool list).
 *
 * ── Following up is `message`, not a parameter here ──
 * A finished subagent's session lies intact in the store, with no expiry; a message to it
 * wakes it holding everything it read (tool/message.ts). This tool had a `resume`
 * parameter for that; once message could reach a working subagent too, two ways to say
 * "talk to that one" only made the model choose between them, so task now only starts.
 * ⚠ The description presents following up as the normal thing to do and says nothing
 *   about history being re-sent. The old skill stressed that in bold, and the model took
 *   it as a risk to warn the user about every time they asked to continue with a subagent
 *   — when re-sending history is what every turn of every conversation does, mostly at
 *   the cached rate. The only real line is "same work → message it, unrelated work →
 *   fresh", stated without a cost argument.
 *
 * ── model / effort / tools: the setup is the caller's, the checking is not ──
 * All three default to "same as me" and are fixed for the subagent's life. Names are
 * checked in agent/subagent.ts (resolveSetup), which knows the tool list and the model
 * registry.
 */
import { z } from "zod"
import { REASONING_EFFORTS } from "../llm/types.ts"
import type { ToolDef } from "./types.ts"

const Parameters = z.object({
  name: z
    .string()
    .describe(
      'What KIND of agent this is, in a couple of words — by its nature, not by this particular job: ' +
        '"research agent", "test agent", "调查agent". Any language. It becomes the job\'s name, ' +
        "and a second one of the same kind gets -2 after it.",
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
        "is configured.",
    ),
  effort: z
    .enum(REASONING_EFFORTS)
    .optional()
    .describe(
      "How hard it thinks. Leave it out to match this conversation. Lower is faster and cheaper — enough for " +
        "finding and listing; keep it high where a subtle mistake is expensive.",
    ),
  tools: z
    .array(z.string())
    .optional()
    .describe(
      'The only tools it gets, by name — e.g. ["read", "grep", "glob"] for an investigation that cannot change ' +
        "anything. It always keeps message, its line back to you. Leave it out to give it all of yours except task and ask.",
    ),
  prompt: z
    .string()
    .describe(
      "The whole brief, sent to the subagent word for word: what to do, where to look, and exactly what to " +
        "report back. It cannot see this conversation, so everything it needs has to be in here. Its first " +
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
- It cannot ask the user anything, and it cannot start subagents of its own. If the work needs a decision from the user, get that decision first (ask tool), then send it in the brief. If something comes up mid-way it can ask you with \`message\`; answer it the same way.
- **If a skill in your catalogue covers what you are sending out, name it in the brief** — "read the \`cut-a-release\` skill first". The subagent has the same catalogue and the same \`skill\` tool, but not the conversation that made that skill relevant, and a narrow brief gives it no reason to go looking. Naming it is enough; do not paste its text.
- It CAN edit files and run commands, through the same permission gate you do — unless \`tools\` leaves those out. Two of them editing one file at the same time produce a mess, and nothing merges anything for you; waiting on each other does not prevent it, only the briefs do. Split writers by file or directory, or do the editing yourself once they report.

Chaining: with \`after\` you can lay out the whole shape of the work in one turn — fan out, then one that checks or merges what came back. A subagent that another is waiting on delivers its answer to that one, not to you, so a dozen finders do not fill your context; \`job\` can still read any of them.

Following up: a finished subagent keeps its whole conversation, and \`message\` to it wakes it — say only what is new. That is the normal way to keep working with one; when the user wants to continue with one, message it. Start a fresh one for unrelated work. \`message\` also reaches one that is still working, to correct its course or add something it needs.

Setup: set \`model\`, \`effort\` or \`tools\` only when the user asked or the job clearly calls for it — a scout that misses the answer because it was cheap costs more than it saved. Leaving \`skill\` out of \`tools\` means it cannot open a skill you named.`

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

    const name = args.name.trim()
    const after = (args.after ?? []).map((id) => id.trim()).filter((id) => id.length > 0)

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
      metadata: { preview: `${name}${setup.length > 0 ? `\n${setup.join(" · ")}` : ""}\n\n${args.prompt}` },
    })

    const job = await ctx.agents.start({
      name,
      prompt: args.prompt,
      ...(after.length > 0 ? { after } : {}),
      ...(args.model?.trim() ? { model: args.model.trim() } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
      ...(args.tools ? { tools: args.tools } : {}),
    })
    ctx.metadata({ job: job.id, description: job.command })

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
        metadata: { truncated: false, job: job.id, started: !failed, answered: !failed },
      }
    }

    return {
      output:
        `Subagent "${job.id}" is working on: ${job.command}\n\n` +
        `Its answer will be delivered to you as a message when it is done — do not poll for it, and do not ` +
        `do this work yourself in the meantime. Start any other subagents you need now. If there is nothing ` +
        `else useful to do until the answers arrive, say so in one short line and stop; you will be woken up.`,
      title: `${job.id} started`,
      metadata: { truncated: false, job: job.id, started: true },
    }
  },
}
