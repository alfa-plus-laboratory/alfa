/**
 * Built-in skills — what alfa knows about **itself**.
 *
 * ── Why these live in skills and not in the system prompt ──
 * They share one shape: **irreplaceable when needed, and not a word of them is used in
 * nine turns out of ten**. "Where the two config files are, how to write a provider"
 * can't be read out of the project (it exists only in this program's own conventions),
 * yet a code-editing session never touches it from start to finish. Measured once: that
 * section was 5268 characters ≈ 1300 tokens, and it used to go into every session and
 * every request unconditionally.
 *
 * ★ But this yardstick **only works for "knowledge", not for "behavior shaping"**. The
 *   safety / untrusted / plan / agentflow sections stay in system not because nobody
 *   measured them, but because the model won't go and open a skill that constrains it
 *   of its own accord — loading them on demand would amount to switching them off.
 *
 * ── Why the body is a .md file and not a string here ──
 * Built-in skills and user-written ones must be the same kind of thing: the same
 * frontmatter parser, the same set of fields. So `skills/*.md` doubles as a live sample
 * of "how a skill should be written", and the bar for adding a piece of built-in
 * knowledge is writing a skill, not changing code. The files are embedded into the
 * binary at compile time (`type: "text"`), so single-file distribution still holds.
 *
 * To add a new one: write a `.md` under `skills/`, then add a line to the array below.
 */
import type { BuiltinSkill } from "./skills.ts"
import alfaConfig from "./skills/alfa-config.md" with { type: "text" }
import alfaMcp from "./skills/alfa-mcp.md" with { type: "text" }
import alfaPermissions from "./skills/alfa-permissions.md" with { type: "text" }
import alfaSkills from "./skills/alfa-skills.md" with { type: "text" }
import alfaSubagents from "./skills/alfa-subagents.md" with { type: "text" }

export function builtinSkills(): BuiltinSkill[] {
  return [
    { text: alfaConfig, source: "built in (skills/alfa-config.md)" },
    // These two are a **net addition**: how the permission system works and how to hook
    // up a server were not in the prompt at all before this — when the user asked, it
    // could only guess, and a guessed answer sounds just as confident. They were never
    // fit to send every turn, so before skills there was genuinely no way to add them
    { text: alfaPermissions, source: "built in (skills/alfa-permissions.md)" },
    { text: alfaMcp, source: "built in (skills/alfa-mcp.md)" },
    // How to write a skill is itself a skill. Without it, when the user says "save this
    // workflow", the model can only guess the directory, the file name, the frontmatter
    // — and a wrong guess shows up as that skill **never appearing at all** (no
    // description, not picked up), leaving the user with nothing but "but I did write it"
    { text: alfaSkills, source: "built in (skills/alfa-skills.md)" },
    // This one isn't "how alfa works"; it's the half **moved out of task's description**:
    // the mechanics of chained orchestration, the bookkeeping of resume, what happens when
    // two of them write the same file. The test for whether it could move: the parameter
    // descriptions already say what each thing is (the describe for `after` / `resume` is
    // always loaded), and that part of the description only said it again in other words
    // — while "how to use it well" only matters in the few turns where a whole team is
    // actually being sent out
    { text: alfaSubagents, source: "built in (skills/alfa-subagents.md)" },
  ]
}
