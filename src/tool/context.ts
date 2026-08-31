/**
 * ToolContext 构造。
 *
 * ask / onProgress 由上层(CLI)注入,工具层只见接口 —— 这样换成非交互模式
 * (-p 单次执行)或将来换 TUI 时,工具一行都不用动。
 */
import type { SkillSet } from "../prompt/skills.ts"
import type { AgentJobs } from "./background.ts"
import type { Answer, AskInput, ContextView, Question, ToolContext } from "./types.ts"

export interface ToolContextDeps {
  cwd: string
  root: string
  sessionID: string
  ask(input: AskInput): Promise<void>
  /** 停下来问用户一句。不接 = 这一路上没有界面,见 tool/ask.ts */
  inquire?(question: Question): Promise<Answer>
  /** 起/看/停后台的子 agent。不接 = 这一路起不了,见 agent/subagent.ts */
  agents?: AgentJobs
  /** 这一路是某个子 agent 的话,它叫什么。见 ToolContext.owner */
  owner?: string
  onProgress(callID: string, text: string): void
  onMetadata(callID: string, patch: Record<string, unknown>): void
  /** 现在窗口里装着什么。不接就是这一路没有这个能力 —— 见 tool/context-window.ts */
  context?(): ContextView | undefined
  skills?(): SkillSet | undefined
}

export function createToolContext(
  deps: ToolContextDeps,
  call: { messageID: string; callID: string; abortSignal: AbortSignal },
): ToolContext {
  return {
    cwd: deps.cwd,
    root: deps.root,
    sessionID: deps.sessionID,
    messageID: call.messageID,
    callID: call.callID,
    abortSignal: call.abortSignal,
    // callID 在这里补上,不让工具自己传:它们不该关心界面怎么把询问和卡片
    // 对上,而这里正好知道(见 types.ts 的 AskInput.callID)
    ask: (input) => deps.ask({ ...input, callID: call.callID }),
    onProgress: (text) => deps.onProgress(call.callID, text),
    metadata: (patch) => deps.onMetadata(call.callID, patch),
    ...(deps.context ? { context: deps.context } : {}),
    // callID 同样在这里补上,理由和权限那条一模一样:工具不该关心界面怎么把
    // 「问了什么」和「哪张卡片」对上
    ...(deps.inquire
      ? { inquire: (question: Question) => deps.inquire!({ ...question, callID: call.callID }) }
      : {}),
    ...(deps.agents ? { agents: deps.agents } : {}),
    ...(deps.skills ? { skills: deps.skills } : {}),
    ...(deps.owner ? { owner: deps.owner } : {}),
  }
}
