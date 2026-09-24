/**
 * Context usage accounting.
 *
 * The status line's gauge and automatic compaction both stand on these definitions:
 * auto-compaction fires on the gauge's ratio against `usable` (AUTO_COMPACT_AT in
 * cli/main.ts). Get one wrong and compaction fires at the wrong moments — a silent failure
 * that only shows up as "why does it keep losing context on its own".
 */
import type { ModelInfo, Tokens } from "../llm/types.ts"

/**
 * Headroom left for compaction itself and for the next turn's reply.
 *
 * Compaction isn't free: it sends a request of its own (reading the history in), and the
 * summary it produces takes up space too. Wait until the very limit to compact and the
 * compaction request itself overflows — a complete deadlock.
 */
export const COMPACTION_BUFFER = 20_000

/** Providers occasionally send undefined / NaN / negative numbers; treat all of them as 0. */
export function safe(value: number | undefined | null): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * How much context this turn actually occupies — output **not included**.
 *
 * The output has already landed in the history and is counted again as input on the next
 * turn; adding it here too would double-count.
 */
export function contextTokens(tokens: Tokens | undefined, info?: Pick<ModelInfo, "cacheInInput">): number {
  if (!tokens) return 0
  const input = safe(tokens.input)
  const cached = safe(tokens.cache?.read) + safe(tokens.cache?.write)
  // For the definition see ModelInfo.cacheInInput. Default to the Anthropic family (add
  // them up) — better to overestimate.
  return info?.cacheInInput ? Math.max(input, cached) : input + cached
}

/**
 * A tenth of the window. **Large windows reserve proportionally, small windows reserve an
 * absolute amount.**
 *
 * Reserving 50k out of a 1M window is as good as reserving nothing: a single read can eat
 * it, and compaction itself has to read the whole history in. So reserve a tenth — a 1M
 * window counts as full at 900k, which is also the denominator of the percentage on the
 * status line. Conversely, a tenth of a 200k window is only 20k, not enough for even one
 * compaction request, so there it still has to go by the absolute amount below.
 */
const HEADROOM = 0.1

/**
 * The budget actually available for history after deducting the output budget and the
 * compaction headroom. **This is the 100% line.**
 *
 * Display and overflow detection use the same function: if each computed its own, the
 * status line would say 87% while the model is already reporting context overflow.
 */
export function usable(limit: ModelInfo["limit"]): number {
  const floor = limit.output + COMPACTION_BUFFER
  const reserved = Math.max(Math.ceil(limit.context * HEADROOM), floor)
  return Math.max(0, limit.context - reserved)
}

/** Usage ratio from 0 to 1, for the status line's progress bar. */
export function usageRatio(tokens: Tokens | undefined, info: ModelInfo): number {
  const budget = usable(info.limit)
  if (budget === 0) return 0
  return Math.min(1, contextTokens(tokens, info) / budget)
}

/**
 * Sum the usage of several steps — **for billing only, never for context usage**.
 *
 * Every step's input contains the whole history, so summing across steps gives "how many
 * tokens were read in total" (the billing definition), not "how much context is occupied
 * now". Use it to detect overflow and a ten-step turn counts ten times over, and
 * compaction fires when there's no need at all.
 *
 * For context usage, pass the **last step's** tokens through contextTokens().
 */
export function accumulateBilled(a: Tokens | undefined, b: Tokens | undefined): Tokens {
  const left = a ?? emptyTokens()
  const right = b ?? emptyTokens()
  const total = safe(left.total) + safe(right.total)
  return {
    input: safe(left.input) + safe(right.input),
    output: safe(left.output) + safe(right.output),
    reasoning: safe(left.reasoning) + safe(right.reasoning),
    cache: {
      read: safe(left.cache?.read) + safe(right.cache?.read),
      write: safe(left.cache?.write) + safe(right.cache?.write),
    },
    ...(total > 0 ? { total } : {}),
  }
}

export function emptyTokens(): Tokens {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

/**
 * Rebuild "how much this session has spent so far" from the stored history.
 *
 * ── Why it must scan step-finish parts instead of reading message-level tokens ──
 * The `tokens` on a message stores **occupancy** (in processor.ts, `message.tokens =
 * this.contextTokens`, taken from the last step), not cumulative spend. Use it as the bill
 * and a turn that ran ten steps gets counted as just the last step's share.
 *
 * Spend lives on each step-finish part, and every one of them is persisted — only their
 * sum is the bill.
 *
 * ★ The shape is deliberately duck-typed: this layer shouldn't know the session schema,
 *   and all it needs is "has parts, and a part may carry tokens".
 */
export function billedFromHistory(
  history: readonly { parts: readonly { type: string; tokens?: Tokens }[] }[],
): Tokens {
  let out = emptyTokens()
  for (const message of history) {
    for (const part of message.parts) {
      if (part.type === "step-finish" && part.tokens) out = accumulateBilled(out, part.tokens)
    }
  }
  return out
}
