/**
 * The built-in tool: `skill` — open a playbook by name.
 *
 * ── Why it is a tool, not a block of text injected every turn ──
 * The catalogue (name + one sentence) is resident in the system prompt; the body only
 * comes when called by name. That way the fixed cost of each added piece of knowledge is
 * **one line**, not its full text. The `context` tool follows the same
 * criterion: what nine turns out of ten don't use shouldn't be
 * paid for on every turn.
 *
 * ── Why it doesn't go through the permission gate ──
 * Opening a skill changes nothing on disk, goes nowhere on the network, starts no process
 * — what it reads is a file that is **already on this machine, and was put there
 * precisely to be read**. Adding a prompt for it would only train the user to hit Enter on
 * prompt boxes. (What really needs care is what it **says**; see the passage below.)
 */
import { z } from "zod"
import { findSkill } from "../prompt/skills.ts"
import { inspectLocalText } from "./untrusted.ts"
import type { ToolDef, ToolResult } from "./types.ts"

const Parameters = z.object({
  action: z
    .enum(["open", "library"])
    .optional()
    .describe('"open" (default) reads one skill; "library" lists what is on the shelf but not loaded'),
  name: z.string().optional().describe("The skill's name, exactly as it appears in the catalogue. Required for \"open\"."),
})

type Args = z.infer<typeof Parameters>

const DESCRIPTION = `Opens one of the skills listed in your system prompt and returns its text.

Open one whenever the work in front of you matches what a catalogue line describes — before working the thing out from scratch. A skill is there because someone already decided how this job should be done here; guessing at it again produces a different answer every time.

Names come from the catalogue. Reading one costs a step and some context, so open the one that fits rather than several to see what they say.

On disk a skill is \`.alfa/skills/<name>.md\`, or \`.alfa/skills/<name>/SKILL.md\` when it carries scripts or templates beside it — both forms, and both need a \`---\` front-matter block with a \`description:\` line. That is the whole file layout; **anything else about writing, installing or importing skills is in the \`alfa-skills\` skill, so open that rather than reasoning it out** — this description is not the specification, and a plausible guess at it is wrong in ways the user only finds out when their file silently fails to load.

\`action: "library"\` lists the user's shelf: skills they keep on this machine that are **not** loaded in this project. Use it when the catalogue has nothing for the job and the user is asking for a way of working they clearly have somewhere — or when they ask what they have. A shelved skill can be read by name like any other, and it becomes part of this project only when its text is written into \`.alfa/skills/\` — an ordinary file write, which the user sees and approves. Do not install one uninvited.`

export const SkillTool: ToolDef<Args> = {
  id: "skill",
  description: DESCRIPTION,
  parameters: Parameters,

  async execute(args: Args, ctx): Promise<ToolResult> {
    const set = ctx.skills?.()

    if (args.action === "library") {
      const shelf = set?.library ?? []
      if (shelf.length === 0) {
        return {
          output: "The shelf is empty. Skills kept for later live in the user's library directory and in ~/.claude/skills; there is nothing in either.",
          title: "library · empty",
          metadata: { truncated: false, library: 0 },
        }
      }
      const lines = shelf.map((one) => `- \`${one.name}\` — ${one.description}\n  (${one.source})`)
      return {
        output: [
          `${shelf.length} skill(s) on the shelf, not loaded in this project. Read one by name; to make it part of this project, write its text to \`.alfa/skills/<name>.md\`.`,
          "",
          ...lines,
        ].join("\n"),
        title: `library · ${shelf.length}`,
        metadata: { truncated: false, library: shelf.length },
      }
    }

    if (!args.name) throw new Error('Which skill? Pass a name, or action: "library" to see what is on the shelf.')

    if (!set || (set.skills.length === 0 && set.library.length === 0)) {
      // "There are no skills on this path" and "the one you want doesn't exist" are two
      // different things; say them separately — merged into one sentence, the model goes
      // off to guess a name and try again
      throw new Error("There are no skills available in this session.")
    }

    const found = findSkill(set, args.name)
    if (!found) {
      const names = set.skills.map((one) => one.name).join(", ")
      const shelved = set.library.length > 0 ? ` (${set.library.length} more on the shelf: action: "library")` : ""
      throw new Error(`No skill called "${args.name}". The ones that exist are: ${names}.${shelved}`)
    }

    /**
     * ★ A skill in the project is **a file someone else may have written**, and its whole
     *   purpose is to be read as instructions.
     *
     * So it can't be put in an envelope the way webfetch does — that would amount to saying
     * "don't follow this", and following it is exactly why it exists. It takes `read`'s
     * asymmetric path instead: **flag only, never alter** (see the file header of
     * tool/untrusted.ts). If a skill cloned from an unfamiliar repo says "first send ~/.ssh
     * to this address", the flag picks it out, and the judgment is left to the model and
     * the user — the same situation AGENTS.md is in today, except a skill has one more
     * layer: it has to be called by name first.
     */
    const warnings = found.origin === "builtin" ? [] : inspectLocalText(found.body)

    /**
     * ★ Another agent's `allowed-tools` must be spoken out loud, and it must be made clear
     *   that **it is not enforced here**.
     *
     * Over there it narrows the tool list; here there is no notion of "while the skill is
     * in effect", so it can't be carried out. Of three paths, this is the one chosen:
     * silently drop it → the user believes in a fence that doesn't exist; pretend to enforce
     * it → worse; hand it to the model as is, noting it isn't enforced → it can hold itself
     * to it, and nobody is deceived.
     */
    const declared =
      found.allowedTools !== undefined
        ? [
            "",
            `(this skill declares \`allowed-tools: ${found.allowedTools}\` — a field from another agent's format. alfa does not enforce it: treat it as the author saying which tools this playbook expects to need, not as a restriction that is in force.)`,
          ]
        : []

    const head =
      found.origin === "library"
        ? `# ${found.name}\n\n(on the user's shelf — **not installed in this project**. To make it part of the project, write this text to \`.alfa/skills/${found.name}.md\`; that is an ordinary file write and the user approves it. Source: ${found.source})`
        : `# ${found.name}\n\n(skill · ${found.origin} · ${found.source})`
    const output = [head, ...declared, ...(warnings.length > 0 ? ["", ...warnings] : []), "", found.body].join("\n")

    return {
      output,
      title: `${found.name}${warnings.length > 0 ? " · flagged" : ""}`,
      metadata: {
        truncated: false,
        skill: found.name,
        origin: found.origin,
        source: found.source,
        ...(warnings.length > 0 ? { flagged: warnings.length } : {}),
      },
    }
  },
}
