/**
 * Scores → run or not, and what the agent is told. Pure; no model, no I/O.
 *
 * ── The rule ──
 *   risk = max(harm, reach, leak)
 *   risk ≤ 1           → run
 *   otherwise          → run only if intent ≥ risk
 * The more an operation can cost, the more directly the user must have asked for it. A
 * risk-3 operation needs intent 3: the user asked for exactly this, or said yes when
 * asked. That is the whole point of returning scores instead of a verdict — a block
 * names the number that was short, and the only number the agent can't raise by changing
 * approach is intent, which the user raises by answering.
 *
 * ── Reading a distribution ──
 * A level counts when the probability of being *at least* that level crosses a
 * threshold, and the two thresholds lean the same way on purpose:
 *   RISK_AT   0.3 — a 30% chance of severe harm is severe enough to require intent
 *   INTENT_AT 0.7 — "the user asked for this" has to be fairly certain
 * Doubt raises risk and lowers intent; it never does the reverse. With a one-hot
 * distribution (an LLM naming a level) both reduce to the named level.
 *
 * ⚠ Levels below 2 never block, whatever intent says. Intent 0 on a harmless read is
 *   common (the agent looking around) and blocking it would bring back the approval
 *   fatigue auto exists to remove; the classifier's job is the high end.
 */
import type { Distribution, Scores } from "./classifier.ts"

export const RISK_AT = 0.3
export const INTENT_AT = 0.7

/** The highest level whose at-least probability reaches `threshold`; 0 if none. */
export function levelAt(distribution: Distribution, threshold: number): number {
  let tail = 0
  for (let level = distribution.length - 1; level > 0; level--) {
    tail += distribution[level] ?? 0
    if (tail >= threshold) return level
  }
  return 0
}

export interface Assessment {
  intent: number
  harm: number
  reach: number
  leak: number
  risk: number
  allow: boolean
}

export function assess(scores: Scores): Assessment {
  const harm = levelAt(scores.harm, RISK_AT)
  const reach = levelAt(scores.reach, RISK_AT)
  const leak = levelAt(scores.leak, RISK_AT)
  const intent = levelAt(scores.intent, INTENT_AT)
  const risk = Math.max(harm, reach, leak)
  return { intent, harm, reach, leak, risk, allow: risk <= 1 || intent >= risk }
}

/**
 * The tool error a blocked agent reads. Scores first, because they are the answer; then
 * the two ways forward. Model-facing, so English.
 *
 * ★ "ask the user" is offered on purpose (replacing the earlier "never seek approval" rule): the
 *   user's explicit yes is what intent 3 means, so asking is not a way around the gate,
 *   it is the gate working. What stays forbidden is resubmitting unchanged or routing
 *   the same effect through another tool.
 */
export function explain(assessment: Assessment, scores: Scores, options: { subagent?: boolean } = {}): string {
  const { intent, harm, reach, leak, risk } = assessment
  const lines = [
    `Blocked by the auto-mode classifier: intent=${intent} harm=${harm} reach=${reach} leak=${leak} (0-3). ` +
      `Risk ${risk} needs intent ${risk}; the user's request scores ${intent}.`,
  ]
  const odds = probabilities(scores, risk)
  if (odds) lines.push(odds)
  lines.push(
    "intent = how directly the user asked for this; harm = worst realistic damage; reach = where side effects land; leak = private data exposed or sent out.",
    // A subagent has no ask tool (agent/subagent.ts): the question has to travel up
    options.subagent
      ? "Do not resubmit this unchanged or reach the same effect through another tool. Either take a lower-risk approach, " +
        "or, if this exact operation is what the task needs, stop and say so in your report; only the main agent can ask the user, " +
        "and their explicit confirmation is what raises intent."
      : "Do not resubmit this unchanged or reach the same effect through another tool. Either take a lower-risk approach, " +
        "or, if this exact operation is what the task needs, ask the user whether to do it (say what it does and what it risks); " +
        "their explicit confirmation is what raises intent.",
  )
  return lines.join("\n")
}

/**
 * Only for calibrated backends: a one-hot distribution says nothing the levels didn't,
 * and printing "P=1.00" everywhere would read as false precision.
 */
function probabilities(scores: Scores, risk: number): string | undefined {
  const calibrated = Object.values(scores).some((distribution) => distribution.some((p) => p > 0 && p < 1))
  if (!calibrated) return undefined
  const atLeast = (distribution: Distribution, level: number) =>
    distribution.slice(level).reduce((sum, p) => sum + p, 0).toFixed(2)
  const parts = (["harm", "reach", "leak"] as const)
    .filter((key) => levelAt(scores[key], RISK_AT) === risk)
    .map((key) => `P(${key}>=${risk})=${atLeast(scores[key], risk)}`)
  parts.push(`P(intent>=${risk})=${atLeast(scores.intent, risk)}`)
  return parts.join(" ")
}
