/**
 * ★ The tool registration boundary.
 *
 * This file is a hard-constraint line: no file under src/tool/** may import "ai" or
 * "@ai-sdk/*". Tools only know the ToolDef / ToolContext here; translating them into the
 * SDK's shape happens in one place, src/llm/adapt-tools.ts.
 *
 * Why it had to be drawn on day one: later on we will add our own capabilities (a memory
 * layer, managing remote hosts, our own tool ecosystem), and those tools run in an
 * execution environment completely different from local tools. If tools grew directly on
 * the SDK's tool(), every new kind of tool would mean touching the loop.
 */
import type { AccessManager } from "../security/access.ts"
import type { ZodType } from "zod"
import type { SkillSet } from "../prompt/skills.ts"
import type { AgentJobs } from "./background.ts"

/** Outcome of a permission prompt. */
export type AskDecision = "once" | "session" | "always" | "reject"

export interface AskInput {
  /** Permission key, usually the tool name (edit/write share "edit"). */
  permission: string
  /**
   * Concrete targets: paths, commands, URLs. One ask can cover several (after bash
   * splits a command, one per sub-command).
   */
  patterns: string[]
  /** Extra information for the UI to render, e.g. edit's diff. */
  metadata?: Record<string, unknown>
  /**
   * When true, the user may not pick "always" (e.g. the command contains a subshell, so
   * the reduction can't be trusted).
   */
  forbidAlways?: boolean
  /**
   * Override allow rules and force a prompt.
   *
   * For the case "the rules seem to allow it, but this call itself is risky": when the bash
   * splitter finds a subshell / redirect / privilege elevation / network egress, it must
   * ask even if `git *` is configured as allow — because the danger isn't in the command
   * name, it is in the structure around it.
   * (Pipes are **not** on this list: each segment goes through the rule table on its own,
   * see the note in bash/scan.ts.)
   * Note: force **cannot** turn a deny into an ask; under default/confirm, deny
   * short-circuits; auto allows everything wholesale, ahead of the rules.
   */
  force?: boolean
  /**
   * Which tool call this prompt belongs to.
   *
   * ★ **Filled in by ToolContext; tools must not pass it themselves** (see
   *   tool/context.ts). The callID is known the moment the context is built, and tools
   *   shouldn't care how the UI matches "what was asked" to "which card" — that is
   *   rendering's business.
   *
   * The UI uses it to **draw the authorization outcome back onto that very call**, rather
   * than starting another line below. Several tools may be running at once (the SDK runs
   * multiple calls in the same step concurrently), so it can't just guess "the last one
   * that's running".
   */
  callID?: string
  /**
   * Whose death this prompt dies with.
   *
   * ★ Without it, the UI hangs it on **the current turn** — right for the main agent,
   *   wrong for a subagent: that one runs in the background, and whether it lives or dies
   *   has nothing to do with the turn in the user's hands. The consequence of not wiring
   *   this is very concrete — after a subagent is stopped by `/clear`, its box is still in
   *   the queue; a while later the user presses "allow", and the edit / command of an
   *   **already dead** agent lands anyway.
   */
  signal?: AbortSignal
  /**
   * Which session's tool call this is. Filled in by the host, like callID; tools must
   * not pass it. auto mode's classifier reads the user's words from the main session and,
   * when this is a subagent's session, that subagent's brief (see permission/auto/).
   */
  sessionID?: string
}

/**
 * A question put to the user. See tool/ask.ts.
 *
 * ★ It is **not** the same thing as AskInput; don't think of them together: AskInput is
 *   "I'm about to touch this, may I", with only three answers, defined by the permission
 *   gate; this is "how do you want this handled", with options the model lists itself.
 *   The former is a security boundary, the latter part of the conversation — the only
 *   thing they share is that both have to stop and wait for a human, so both share the
 *   same modal queue in the UI (see `modal` in cli/main.ts).
 */
export interface Question {
  /** The question itself. One sentence, not a paragraph. */
  question: string
  options: QuestionOption[]
  /** Multi-select: the user may tick several. */
  multiple: boolean
  /**
   * Which tool call this question belongs to.
   *
   * ★ Same rule as AskInput.callID: **filled in by ToolContext; tools must not pass it
   *   themselves**.
   */
  callID?: string
  /**
   * When several are asked at once, which one this is.
   *
   * The UI must show it: someone answers one question and another box pops up on screen —
   * without "2/3" they can't tell whether this is "two more to go" or "it just thought of
   * another one". Omitted when there is only one in total.
   */
  position?: { index: number; total: number }
  /**
   * What this question was last answered with (present only when **going back to
   * change it**).
   *
   * The UI uses it to put the state back: what was ticked stays ticked, what was typed is
   * still there. Without putting it back, "go back to the previous question to see what I
   * just picked" simply can't be done — going back shows a blank question, when what the
   * user wants to confirm is precisely which one they picked.
   */
  previous?: Answer
}

export interface QuestionOption {
  /** The option itself. The answer goes back to the model verbatim, so it must stand alone */
  label: string
  /** One more line: why pick it, what it costs. If there's nothing to say, don't invent it */
  description?: string
}

/**
 * The user's answer.
 *
 * ★ The four **must** be kept apart; merging any two of them makes the model do the
 *   wrong thing:
 *   picked      chose one of the given options — do that
 *   typed       none fit, typed something of their own — that's a new instruction, and
 *               it takes priority over the question itself
 *   cancelled   saw it but doesn't want to answer — don't ask the same thing again, find
 *               another way forward
 *   unavailable there is nobody on this path at all (-p / pipe / CI) — decide for
 *               yourself, and say plainly what you assumed
 */
export type Answer =
  | { kind: "picked"; choices: string[] }
  | { kind: "typed"; text: string }
  | { kind: "cancelled" }
  | { kind: "unavailable" }
  /**
   * "I want to go back to the previous question". **Not an answer** but a navigation — it
   * can only come up when several are asked at once, and it is always consumed by the ask
   * tool itself, never reaching the model (see tool/ask.ts).
   *
   * It lives in Answer rather than getting a return channel of its own: all four layers of
   * the asking path (tool → host → modal queue → state machine) pass this type along, and
   * one more channel would mean one more branch in each of the four.
   */
  | { kind: "back" }

export interface ToolContext {
  runtime?(): import("../security/runtime.ts").RuntimeSnapshot
  ssh?(input: import("../security/ssh.ts").SshRequest, signal: AbortSignal, onProgress: (text: string) => void): Promise<import("../security/ssh.ts").SshResult>
  access?: AccessManager
  /** Current working directory. The base tools resolve relative paths against. */
  cwd: string
  /**
   * Workspace root (the git worktree root; falls back to cwd when it can't be derived).
   * The boundary for the out-of-bounds guard.
   */
  root: string
  sessionID: string
  messageID: string
  /** The toolCallId given by the provider. */
  callID: string
  /**
   * Abort signal. Long-running operations must check it themselves or forward it to child
   * processes.
   */
  abortSignal: AbortSignal
  /**
   * Request authorization from the user. Throws when rejected, so tools don't handle the
   * rejection branch themselves — the thrown error goes back to the model as the tool
   * result, so it tries a different approach.
   */
  ask(input: AskInput): Promise<void>
  /**
   * Stop and ask the user something (see tool/ask.ts).
   *
   * Not wired means **there is no UI on this path** (test fixtures, a future
   * non-interactive host), and the tool must treat it as unavailable — not as "the user is
   * ignoring me" and hang there waiting. The genuine "nobody to ask" case is answered with
   * unavailable by the implementation itself: in -p and pipe mode the keyboard isn't
   * available, but the function is still wired then; it just replies "nobody here" at
   * once.
   */
  inquire?(question: Question): Promise<Answer>
  /**
   * **Which subagent** this call happens in (its name). Absent when the main agent runs
   * it itself.
   *
   * It has exactly one use: background processes it starts must be booked to it (see
   * JobSnapshot.owner in tool/background.ts) — a dev server a subagent started in passing,
   * with its start and stop reported into the conversation the user is reading, is a
   * crossed wire; the user didn't ask anyone to start it.
   */
  owner?: string
  /**
   * Subagents running in the background (see agent/subagent.ts).
   *
   * ★ It is **injected**, not imported — a subagent has to start a whole Loop, and
   *   src/tool doesn't know about the loop.
   *   Only the interface is known here. Not wired = this host can't start subagents, and
   *   the `task` tool says so plainly.
   */
  agents?: AgentJobs
  /** Push intermediate progress to the UI (never enters the model's context). */
  onProgress(text: string): void
  /** Accumulate into this call's metadata; visible to both the UI and storage. */
  metadata(patch: Record<string, unknown>): void
  /**
   * Which skills this session has at hand (see prompt/skills.ts).
   *
   * ★ **Injected** rather than letting the tool scan the disk itself: the catalogue is
   *   that passage in the system prompt, the body is fetched by this tool — if each side
   *   scanned on its own, sooner or later you'd get "listed in the catalogue, but opening
   *   it says it doesn't exist". The same thing should only be found once.
   *
   * Not wired = no skills on this path (test fixtures), and the tool says so plainly.
   */
  skills?(): SkillSet | undefined
  /**
   * What the context window holds right now. See tool/context-window.ts.
   *
   * Not wired means undefined — that is "no such capability here" (one-shot mode, test
   * fixtures), not "the window is empty", and the tool must tell the two apart.
   */
  context?(): ContextView | undefined
}

/**
 * The **shape** of context usage.
 *
 * Only the shape is declared; ContextReport from `src/agent/context.ts` is not imported:
 * `src/tool` doesn't know about the loop.
 * The value is injected by the CLI layer when it builds the ToolContext.
 */
export interface ContextView {
  /** How many tokens are in use now */
  used: number
  /**
   * The line that counts as 100%. Smaller than limit — room has to be left for the reply
   * and for compaction itself
   */
  budget: number
  /** The model's context window */
  limit: number
  /** This number is a local estimate (the provider hasn't reported yet) */
  estimated: boolean
  /** Number of messages that will be sent to the model */
  messages: number
  /** Number folded away by compaction and no longer sent */
  folded: number
  slices: Array<{ key: string; tokens: number }>
}

export interface ToolResult {
  /** The text returned to the model. */
  output: string
  /** Structured extras for the UI / storage. truncated is a convention field, required. */
  metadata: Record<string, unknown> & { truncated: boolean }
  /** A one-line summary, used as the tool card title in terminal rendering. */
  title?: string
}

export interface ToolDef<Args = unknown> {
  id: string
  /**
   * The tool description the model sees. May be a lazy function — bash has to render it
   * dynamically from the current shell and its limit constants. Deliberately not given the
   * ToolContext: the description is **one per request**, while the context is **one per
   * call**; tying the two together would make the description change with each call and
   * wreck the prompt cache outright.
   */
  description: string | (() => string)
  parameters: ZodType<Args>
  /**
   * JSON Schema handed straight to the provider. For tools whose **parameter shape isn't
   * ours to define** (today only MCP: whatever shape the server reports is the shape).
   *
   * ── Why not convert it to zod ──
   * JSON Schema → zod → back to JSON Schema is a lossy round trip: anyOf, $ref, custom
   * formats, nested oneOf — each needs a zod equivalent, and whatever has none can only be
   * dropped. And the dropped part raises no error — it shows up as the model receiving a
   * looser shape than the server actually requires, then getting rejected by the server
   * at call time, with the error pointing at the arguments themselves. Passing it through
   * as is is the only way that doesn't quietly change the contract.
   *
   * When it is given, `parameters` is used only for the local validation (see
   * llm/adapt-tools.ts), which for these tools is a loose fallback — the real validation
   * is on the server side, which has to do it anyway.
   */
  rawSchema?: unknown
  /**
   * The output is text nobody vetted (command output, file matches, a job's log), so the
   * registry runs it through `inspectLocalText` and puts any warning in front of it. See
   * the ★ on inspectLocalText. Tools that already handle their own untrusted content
   * (read, webfetch, MCP) leave this unset so the warning isn't given twice.
   */
  outputSource?: "command"
  execute(args: Args, ctx: ToolContext): Promise<ToolResult>
}

/**
 * Thrown when permission is denied, so the layer above can tell "the user rejected it"
 * from "the tool itself failed".
 *
 * ★ The pointer in the last sentence is **deliberate**: this moment is exactly when the
 *   model most needs alfa-permissions — it has hit a wall, and the user's next question is
 *   most likely "why did it ask me" or "how do I make it stop asking". And this is
 *   precisely when it is least likely to open that skill: it has just been handed an
 *   explanation that looks complete. A sentence saying "the part you think you know is
 *   elsewhere" is worth these dozen-odd tokens, and it only shows up on a denial.
 */
export class PermissionDeniedError extends Error {
  readonly permission: string
  readonly pattern: string
  constructor(permission: string, pattern: string, reason?: string) {
    super(
      reason ??
        `Permission denied: ${permission} on "${pattern}". The user rejected this action. Do not retry the same action; ask the user what to do instead. If they want to change what gets asked, open the \`alfa-permissions\` skill rather than guessing at the settings.`,
    )
    this.name = "PermissionDeniedError"
    this.permission = permission
    this.pattern = pattern
  }
}

/**
 * Thrown when tool argument validation fails; the message goes back to the model verbatim
 * so it can self-correct.
 */
export class InvalidArgumentsError extends Error {
  constructor(toolID: string, detail: string) {
    super(`Invalid arguments for tool "${toolID}": ${detail}`)
    this.name = "InvalidArgumentsError"
  }
}
