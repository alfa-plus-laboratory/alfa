/**
 * What a classifier backend is: evidence in, a probability per level per question out.
 *
 * ★ The backend only scores. Whether the operation runs is decided by policy.ts, in
 *   code, from those scores — so swapping the LLM for a dedicated classifier (Jev and the
 *   like) changes how fast and how calibrated the numbers are, never what they mean or
 *   what the agent is told. It also keeps arithmetic out of the model: "the highest of
 *   three scores against a threshold" is something a classifier is documented to be bad
 *   at and code is not.
 *
 * Distributions rather than single levels because that is what a calibrated classifier
 * returns, and the policy can use it ("30% chance of severe harm" is worth acting on). An
 * LLM that only names a level returns a one-hot distribution, and the policy then reduces
 * to plain level comparisons.
 *
 * A backend throws ClassifierError when it cannot produce scores (unreadable answer,
 * provider error). That is a failure of the review, not a risk verdict, and the agent is
 * told so; see index.ts.
 */
import type { AgentExecutionContext } from "../../llm/types.ts"
import type { Dimension, ScoreQuestion } from "./rubric.ts"

/** Probability per level; index = level. Sums to 1 (backends normalize). */
export type Distribution = number[]
export type Scores = Record<Dimension, Distribution>

/**
 * Everything the classifier sees. All of it is data: the operation is agent-proposed,
 * user.replyingTo and delegatedTask are agent-written, only user.messages and
 * user.answers carry the user's own words. See evidence.ts.
 */
export interface ClassifierState {
  workspace: string
  operation: {
    tool: string
    targets: string[]
    details: Record<string, unknown>
  }
  user: {
    /** The user's own recent messages, oldest first */
    messages: string[]
    /** Answers the user gave to the agent's questions (the ask tool), oldest first */
    answers: string[]
    /** The end of the agent's message the latest user message replied to */
    replyingTo?: string
  }
  /** For a subagent: the brief the main agent gave it. Agent-written */
  delegatedTask?: string
}

export interface Classifier {
  /** Shown in failure messages, e.g. "llm:anthropic/claude-haiku-4-5" */
  readonly id: string
  score(state: ClassifierState, questions: readonly ScoreQuestion[], signal: AbortSignal, execution?: Partial<AgentExecutionContext>): Promise<Scores>
}

export class ClassifierError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ClassifierError"
  }
}

/** A single named level as a distribution: what an LLM backend returns. */
export function oneHot(level: number, size = 4): Distribution {
  return Array.from({ length: size }, (_, index) => (index === level ? 1 : 0))
}
