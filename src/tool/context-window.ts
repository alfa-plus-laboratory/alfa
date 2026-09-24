/**
 * context tool: lets the model take a look at its own context window.
 *
 * ── Why the model needs this ──
 * It is **completely blind** to "how much is left". A full window doesn't show up as an
 * error message; it shows up as a 400 from the provider, or a silent truncation — and up
 * to that point it has been working on the assumption of "infinite": reading a
 * 30,000-line file whole, pasting a lump of build log back verbatim, starting eight
 * background jobs in one turn.
 *
 * The gradient gauge in the UI answers this question for **the user** (see
 * cli/context.ts), and what the user can do after seeing it (`/compact`) is precisely what
 * the model cannot. So the two are not two copies of the same information: the user's is
 * for deciding whether to compact, the model's is for deciding **how to work next** —
 * read the whole thing or grep to locate first, paste the log back or only the few error
 * lines, keep digging or say what it has concluded so far.
 *
 * ── Why a tool, not injected every turn ──
 * Injected every turn, every turn pays for a number that is useless nine times out of
 * ten, and since it is **always sitting there**, it gets treated as background noise. As a
 * tool, it is called once, exactly when the model really starts to wonder "should I read
 * this file whole" — the one moment the number has decision value.
 *
 * ── Boundary ──
 * `src/tool` doesn't know about the loop, so
 * the report is not computed here: the shape is declared in types.ts, and the value is
 * injected by the CLI layer when it builds the ToolContext (see cli/main.ts).
 */
import { z } from "zod"
import type { ContextView, ToolDef } from "./types.ts"

const Parameters = z.object({})

type Args = z.infer<typeof Parameters>

/**
 * Above this line it should speak up unprompted. Same value as the UI's yellow line (see
 * WARN_AT in cli/context.ts)
 */
const CROWDED = 0.8

const DESCRIPTION = `Reports how much of your context window is in use right now, and what is taking up the space.

You cannot feel the window filling up — it does not warn you, it just fails or silently truncates. Call this when the answer would change what you do next:

- Before reading something big. If space is tight, locate with grep/glob and read with offset/limit instead of pulling in a whole file.
- Before pasting a large command output, build log or dump back into your answer.
- Partway through a long task, to decide whether to keep digging or to land what you already have.
- When the user asks what is filling the context, or why you are running out.

You cannot compact the history yourself — only the user can, with /compact. If the window is nearly full, say so plainly and suggest it, rather than quietly working around it.

Do not call this on every turn. It costs a step and the number rarely moves enough between calls to change any decision.`

export const ContextTool: ToolDef<Args> = {
  id: "context",
  description: DESCRIPTION,
  parameters: Parameters,

  async execute(_args, ctx) {
    // It only reads an in-process number and touches nothing on disk or network. It is in
    // the permission table for the same reason todo is: someone who wants it off needs a
    // place to write that down (see permission/rules.ts)
    await ctx.ask({ permission: "context", patterns: ["*"] })

    const view = ctx.context?.()
    if (!view) {
      // One-shot mode / test fixtures may not wire it up. Say plainly this is "not
      // available here", not "the window is empty"
      return {
        output: "Context reporting is not available in this run.",
        metadata: { truncated: false, available: false },
      }
    }

    const percent = view.budget > 0 ? Math.round((view.used / view.budget) * 100) : 0
    const lines = [
      `Context: ${num(view.used)} of ${num(view.budget)} used (${percent}%), ${num(Math.max(0, view.budget - view.used))} free.`,
      `The window is ${num(view.limit)}; ${num(view.budget)} of it counts as full — the rest is held back for your reply.`,
      view.estimated
        ? "These numbers are estimated locally; the provider has not reported usage yet this session."
        : "Total reported by the provider; the split below is estimated locally.",
      view.folded > 0
        ? `${view.messages} messages in context, ${view.folded} more already folded into a summary by an earlier /compact.`
        : `${view.messages} messages in context.`,
      "",
      "What is filling it:",
    ]

    // List only the ones with weight. A report with ten lines of "0" makes the reader hunt
    // for the line that matters
    const shown = view.slices.filter((slice) => slice.tokens > 0).sort((a, b) => b.tokens - a.tokens)
    if (shown.length === 0) lines.push("  (nothing yet)")
    for (const slice of shown) {
      const share = view.used > 0 ? Math.round((slice.tokens / view.used) * 100) : 0
      lines.push(`  ${label(slice.key).padEnd(18)}${num(slice.tokens).padStart(6)}  ${String(share).padStart(3)}%`)
    }

    if (percent >= CROWDED * 100) {
      lines.push(
        "",
        "This is nearly full. Say so and suggest /compact — you cannot run it yourself. Until then, read narrowly (grep first, offset/limit) and keep tool output out of your replies.",
      )
    }

    ctx.metadata({ used: view.used, budget: view.budget, percent })
    return {
      output: lines.join("\n"),
      title: `${percent}% of ${num(view.budget)}`,
      metadata: { truncated: false, available: true, used: view.used, budget: view.budget, percent },
    }
  },
}

/**
 * Names of the breakdown items.
 *
 * Not reusing the UI's (those entries in the i18n directory): those follow `/language`,
 * while this text is **sent to the model** — the user switching the UI to Japanese
 * shouldn't make the model receive field names in Japanese.
 */
function label(key: string): string {
  switch (key) {
    case "system":
      return "system prompt"
    case "tools":
      return "tool definitions"
    case "summary":
      return "compacted summary"
    case "memory":
      return "project memory"
    case "user":
      return "user messages"
    case "reply":
      return "your replies"
    case "thinking":
      return "your thinking"
    case "call":
      return "tool calls"
    case "result":
      return "tool results"
    default:
      return key
  }
}

/**
 * `306k`, `1.2M`.
 *
 * Our own rather than the one in cli/render.ts: `src/tool` doesn't import `src/cli`. And the two have different audiences — that
 * one has to squeeze into one cell of the status line, this one is a line of text for the
 * model to read; from here on each changes on its own.
 */
function num(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(value)
}
