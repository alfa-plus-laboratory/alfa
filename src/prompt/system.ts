/**
 * Assembling the system prompt.
 *
 * The default/Anthropic templates are adapted from opencode (MIT); their notices are in
 * NOTICE (a .txt template can't carry a header of its own — it goes to the model
 * verbatim). The changes go beyond renaming: much of the upstream template points at
 * Task / TodoWrite / WebFetch, tool names that **don't exist here**. Leaving them in is not
 * harmless — the model dutifully calls a tool that doesn't exist, gets an error, tries
 * again, and a whole turn burns on it. So those passages were deleted, not commented out.
 *
 * ── Why the return value is an array ──
 * Two parts, matching the two system messages that finally go out:
 *   [0] template                  — fully static, constant for the process lifetime;
 *                                   the longest cacheable prefix
 *   [1] environment + conventions — changes when the date, project or host
 *                                   permissions change
 * The order cannot be reversed: once something that changes goes first, however stable
 * the rest is does not help — the cache hits by prefix.
 * The Codex profile is separately authored and opt-in until repeated model evaluations
 * justify a default change. It shares the same safety/trust/environment tail. Length
 * alone is not a reason to delete instructions, and profile wording must not infer host
 * capabilities from a provider's name.
 */
import ANTHROPIC_TEMPLATE from "./templates/anthropic.txt" with { type: "text" }
import DEFAULT_TEMPLATE from "./templates/default.txt" with { type: "text" }
import CODEX_TEMPLATE from "./templates/openai-codex.txt" with { type: "text" }
import { replyInstruction, type LanguageChoice } from "../i18n/index.ts"
import { agentflowBlock } from "./agentflow.ts"
import { MAX_FLOW_ALIVE_JOBS } from "../agent/flow.ts"
import { mcpBlock } from "./mcp.ts"
import { skillCatalogue, type SkillSet } from "./skills.ts"
import { environmentBlock, type EnvInput } from "./env.ts"
import { planBlock } from "./plan.ts"
import { safetyBlock } from "./safety.ts"
import { untrustedBlock } from "./untrusted.ts"
import { discoverInstructions, renderInstructions, type InstructionFile } from "./instructions.ts"

export type PromptTemplate = "anthropic" | "default"

export interface SystemInput extends EnvInput {
  template: PromptTemplate
  /** Selected by model capabilities/config, never guessed from a provider's display ID. */
  profile?: "generic" | "anthropic" | "openai-codex"
  home?: string
  configDirectory?: string
  /** If already discovered, pass them straight in to avoid re-reading disk every turn */
  instructions?: InstructionFile[]
  /** Language the model should answer in. Defaults to auto (follow the user's language) */
  replyLanguage?: LanguageChoice
  /**
   * If agentflow is on, the size of the concurrency window. Leave it out when it is off.
   *
   * ★ The subagent's copy of system **must not carry this section**: it has no `task` in
   *   hand, and orchestration has nothing to do with it (see subagentSystem in
   *   cli/main.ts).
   */
  agentflow?: number
  /**
   * The name typed on the command line, for the "how to configure a new provider" text
   * (the alfa-config built-in skill, prompt/skills/alfa-config.md).
   *
   * Passed in from the cli layer rather than importing programName() here: to this day
   * prompt/ does not depend on cli/, and adding that edge for one string is not worth it —
   * besides, only cli knows this value in the first place.
   */
  program?: string
  /**
   * Which skills this session has. **Only the catalogue goes into system** (name + one
   * line); the body is fetched by name through the `skill` tool — see the opening section
   * of prompt/skills.ts.
   */
  skills?: SkillSet
  /**
   * Names of the MCP servers already connected. Empty (or not given) → the whole section
   * is not sent — someone who has not connected a single server should not pay a single
   * token for it.
   */
  mcpServers?: string[]
  /**
   * Whether this folder's instruction files may go into the prompt. Defaults to true.
   *
   * ★ When false, **not a word from the project-sourced ones is sent**; the global one
   *   (`~/.config/alfa/AGENTS.md`) is still sent — the user wrote that to themselves, and
   *   it has nothing to do with which repository they happen to be standing in.
   *
   *   The filtering lives here rather than in discoverInstructions because "which ones
   *   were read" and "which ones go out this time" are two questions: `/instructions` has
   *   to be able to list the blocked ones too, otherwise the user sees "I clearly wrote
   *   AGENTS.md and it ignores it", with no clue anywhere on screen.
   *
   * For who decides this, see trustsProjectInstructions in config/folders.ts.
   */
  trustProject?: boolean
}

export interface SystemPrompt {
  /** Fed directly into LLMRequest.system */
  parts: string[]
  /** Convention files actually in effect, for the CLI startup line "loaded AGENTS.md ×2" */
  instructions: InstructionFile[]
}

export function buildSystem(input: SystemInput): SystemPrompt {
  const found =
    input.instructions ??
    discoverInstructions({
      cwd: input.cwd,
      root: input.root,
      ...(input.home ? { home: input.home } : {}),
      ...(input.configDirectory ? { configDirectory: input.configDirectory } : {}),
    })
  // See the star on SystemInput.trustProject
  const instructions = input.trustProject === false ? found.filter((file) => file.scope === "global") : found

  const profile = input.profile ?? (input.template === "anthropic" ? "anthropic" : "generic")
  const template = profile === "openai-codex" ? CODEX_TEMPLATE : profile === "anthropic" ? ANTHROPIC_TEMPLATE : DEFAULT_TEMPLATE

  // Conventions first, environment after: conventions are long-lived project-level facts,
  // while the environment carries a date that changes daily. Order inside one message
  // does not affect caching; it affects the model's attention weighting — the later, the
  // more likely to be followed, and "what's today's date" is precisely the one that least
  // needs emphasis.
  //
  // The language instruction goes **last**: by the same logic, of these three it is the
  // one that most needs to actually be obeyed. It changes with /language, so it breaks
  // the prompt cache once — only once, whereas "told to use Japanese yet still replying
  // in English" is something the user sees immediately.
  // The judgement section goes first: it is the test the model applies to everything it
  // does, not background information. The blocks after it (project conventions,
  // environment, language) are all "facts", while this one is "how to think"
  //
  // ★ Project memory is **not here**. It was once spliced onto the tail of this part; it
  //   now hangs in a memory part on the first message of a new session (see
  //   session/schema.ts), added and removed via tool/memory.ts. The reason: it has to be
  //   accounted for separately and have a change log of its own — spliced into system,
  //   `/context` would only show "system 12k", and the question that report exists to
  //   answer is exactly "which block to cut".
  const tail = [
    safetyBlock(),
    // Right after safety. These two blocks are a pair: one judges "can this be undone
    // once done", the other "who said this". The rest are all facts; only these two are
    // tests
    untrustedBlock(),
    // After judgement, before facts: like safety, it is "how to work", not background
    // information
    planBlock(),
    // Right after the plan section. When on, it covers the other half of the same thing:
    // the plan answers "how many steps is this", this section answers "which of those
    // steps should be dispatched, and who waits for whom"
    input.agentflow !== undefined ? agentflowBlock(input.agentflow, MAX_FLOW_ALIVE_JOBS) : "",
    renderInstructions(instructions),
    environmentBlock(input),
    // Right after the environment block: both speak to the same kind of thing — "where
    // you are standing" and "what ready-made plays you have at hand". ★ **Only the
    // catalogue** is here: one line per skill. It replaced "how to configure alfa itself",
    // which used to be spliced in whole (5268 chars ≈ 1300 tokens, unconditionally in
    // every request of every session, while only one percent of turns actually needed
    // it) — that text is now the body of the alfa-config built-in skill, arriving only
    // when named. The context tool follows the same on-demand criterion
    input.skills ? skillCatalogue(input.skills) : "",
    // Right after the catalogue: both answer "what do you have at hand", and this one
    // adds **where they are** — MCP tools look exactly like built-in ones in the tool
    // list, yet calling them leaves this machine
    mcpBlock(input.mcpServers ?? []),
    replyInstruction(input.replyLanguage ?? "auto"),
  ]
    .filter((block) => block.length > 0)
    .join("\n\n")

  return { parts: [template.trim(), tail], instructions }
}
