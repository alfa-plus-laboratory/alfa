/**
 * ToolContext construction.
 *
 * ask / onProgress are injected by the layer above (CLI); the tool layer only sees the
 * interface — so switching to non-interactive mode (-p one-shot runs) or to a TUI later
 * doesn't change a single line in the tools.
 */
import type { AccessManager } from "../security/access.ts"
import type { SkillSet } from "../prompt/skills.ts"
import type { AgentJobs } from "./background.ts"
import type { Answer, AskInput, ContextView, Question, ToolContext } from "./types.ts"

export interface ToolContextDeps {
  runtime?: ToolContext["runtime"]
  ssh?: ToolContext["ssh"]
  access?: AccessManager
  cwd: string
  root: string
  sessionID: string
  ask(input: AskInput): Promise<void>
  /** Stop and ask the user something. Not wired = no UI on this path, see tool/ask.ts */
  inquire?(question: Question): Promise<Answer>
  /**
   * Start/watch/stop background subagents. Not wired = can't start any on this path, see
   * agent/subagent.ts
   */
  agents?: AgentJobs
  /** If this path belongs to a subagent, its name. See ToolContext.owner */
  owner?: string
  onProgress(callID: string, text: string): void
  onMetadata(callID: string, patch: Record<string, unknown>): void
  /**
   * What the window holds right now. Not wired = this path has no such capability — see
   * tool/context-window.ts
   */
  context?(): ContextView | undefined
  skills?(): SkillSet | undefined
}

export function createToolContext(
  deps: ToolContextDeps,
  call: { messageID: string; callID: string; abortSignal: AbortSignal },
): ToolContext {
  return {
    access: deps.access,
    ...(deps.runtime ? { runtime: deps.runtime } : {}),
    ...(deps.ssh ? { ssh: deps.ssh } : {}),
    cwd: deps.cwd,
    root: deps.root,
    sessionID: deps.sessionID,
    messageID: call.messageID,
    callID: call.callID,
    abortSignal: call.abortSignal,
    // callID is filled in here rather than passed by the tools themselves: they shouldn't
    // care how the UI matches a prompt to its card, and this spot happens to know (see
    // AskInput.callID in types.ts)
    ask: (input) => deps.ask({ ...input, callID: call.callID }),
    onProgress: (text) => deps.onProgress(call.callID, text),
    metadata: (patch) => deps.onMetadata(call.callID, patch),
    ...(deps.context ? { context: deps.context } : {}),
    // callID is filled in here too, for exactly the same reason as the permission one: tools
    // shouldn't care how the UI matches "what was asked" to "which card"
    ...(deps.inquire
      ? { inquire: (question: Question) => deps.inquire!({ ...question, callID: call.callID }) }
      : {}),
    ...(deps.agents ? { agents: deps.agents } : {}),
    ...(deps.skills ? { skills: deps.skills } : {}),
    ...(deps.owner ? { owner: deps.owner } : {}),
  }
}
