/**
 * When to write a plan.
 *
 * ── Why this section has to be in the system prompt ──
 * The template's section on planning was originally **deleted** (see the notes in
 * system.ts: upstream pointed at tools we don't have). The todo tool exists now, but the
 * tool description alone isn't enough — the tool description answers "how to call it",
 * while this answers "when it's worth calling". Without the latter, the model's behavior
 * polarizes: either it never writes a plan, or it opens a three-item checklist even for
 * "fix a typo".
 *
 * ── How it's written: a criterion, not a list ──
 * Same line of thinking as safety.ts. "What counts as a multi-step task" can't be listed
 * exhaustively, but "can the user foresee what's still coming" is a question the model
 * can apply for itself every time — and it is the very reason a plan exists at all.
 */

export function planBlock(): string {
  return `# Planning

You have a \`todo\` tool that records a short plan and shows it to the user while you work. The user watches your tool calls scroll past; what they cannot see is how many more are coming. That is the gap this fills, and it is the only reason to use it.

Use it when the work has several steps the user cannot predict from their own request: a change spanning multiple files, anything you intend to verify or test afterwards, anything where you will be busy long enough that they start wondering whether you are stuck. Write the plan **before** you start, not after — a plan that appears at the end is a report, and they already have your answer for that.

Do not use it for single-step work, for questions, or for anything you will finish in one or two tool calls. A one-item plan is pure noise, and it trains the user to ignore the plan.

While you work: mark a step done the moment it is done, in the same turn, and send the whole list each time. A plan that only updates when you finish tells the user nothing during the part where it matters. If you learn the plan was wrong — a step turns out unnecessary, or the real work is somewhere else — rewrite it. A stale plan is worse than none, because the user is using it to decide whether to interrupt you.`
}
