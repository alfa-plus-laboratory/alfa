/**
 * auto mode's decision for one operation: fast path → classifier scores → policy.
 *
 * The pieces, each replaceable on its own:
 *   fastpath.ts   what runs without a classifier call
 *   evidence.ts   what the classifier is shown
 *   rubric.ts     the four questions and their levels
 *   classifier.ts the backend interface (llm.ts today; a System-One model such as Jev
 *                 plugs in here)
 *   policy.ts     scores → run or block, and the text the agent gets back
 *
 * ── Failure is not a verdict ──
 * A timeout, a provider error or an unreadable answer blocks the operation — running
 * something nobody reviewed is not an option — but the agent is told it was the review
 * that failed, and that retrying is fine. The previous reviewer said "do not retry" for
 * both, so one flaky request made the agent abandon a perfectly ordinary step.
 *
 * ★ No approval is remembered. Each call is scored on its own evidence, so leaving auto
 *   leaves nothing behind, and a "yes" from the user counts because it is in the
 *   history the next score reads, not because a grant was written somewhere.
 */
import type { AgentExecutionContext } from "../../llm/types.ts"
import type { AskInput } from "../../tool/types.ts"
import type { Classifier, ClassifierState } from "./classifier.ts"
import { describeOperation } from "./evidence.ts"
import { isFastPath } from "./fastpath.ts"
import { assess, explain, type Assessment } from "./policy.ts"
import { QUESTIONS } from "./rubric.ts"

export type AutoVerdict =
  | { allow: true; assessment?: Assessment }
  /** `failed`: the review didn't happen (timeout, error); not a block, see the gate's counter */
  | { allow: false; message: string; assessment?: Assessment; failed?: true }

export type AutoDecider = (input: AskInput) => Promise<AutoVerdict>

const TIMEOUT_MS = 20_000

export function createAutoDecider(options: {
  root: string
  /** Read per call: the settings can switch the backend's model while running */
  classifier(): Classifier
  /** The user's side of the evidence, read fresh for every decision */
  context(input: AskInput): Pick<ClassifierState, "user" | "delegatedTask">
  execution?(input: AskInput): Partial<AgentExecutionContext>
  timeoutMs?: number
}): AutoDecider {
  return async (input) => {
    if (isFastPath(input, options.root)) return { allow: true }
    let classifier: Classifier | undefined
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancel = () => {}
    try {
      classifier = options.classifier()
      const state: ClassifierState = { workspace: options.root, operation: describeOperation(input, options.root), ...options.context(input) }
      const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
      // ★ Raced, not just aborted: a backend that ignores the signal must still not hold
      //   the operation past the limit
      const stopped = new Promise<never>((_, reject) => {
        cancel = () => { controller.abort(); reject(new Error("cancelled")) }
        timer = setTimeout(() => { controller.abort(); reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)) }, timeoutMs)
        input.signal?.addEventListener("abort", cancel, { once: true })
        if (input.signal?.aborted) cancel()
      })
      stopped.catch(() => {})
      const scores = await Promise.race([classifier.score(state, QUESTIONS, controller.signal, options.execution?.(input)), stopped])
      const assessment = assess(scores)
      if (assessment.allow) return { allow: true, assessment }
      return { allow: false, message: explain(assessment, scores, { subagent: state.delegatedTask !== undefined }), assessment }
    } catch (error) {
      return { allow: false, failed: true, message: failure(classifier?.id ?? "classifier", error) }
    } finally {
      controller.abort()
      clearTimeout(timer)
      input.signal?.removeEventListener("abort", cancel)
    }
  }
}

function failure(id: string, error: unknown): string {
  const why = error instanceof Error ? error.message : String(error)
  return (
    `The auto-mode classifier (${id}) could not score this operation: ${why}. This is not a risk verdict.\n` +
    "You may retry once. If it keeps failing, tell the user: they can choose another classifier model in /settings (Auto classifier) or leave auto mode."
  )
}
