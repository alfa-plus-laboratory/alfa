/**
 * How many subagents can be dispatched at once.
 *
 * ── Why these few numbers get a file of their own ──
 * They have three readers, and none of the three should drag in the whole scheduler for a
 * few constants: the scheduler itself (agent/subagent.ts), config validation
 * (config/config.ts: is `"agentflow": 6` legal?), and the `/agentflow` command
 * (cli/main.ts: argument range, hint text). If config imported subagent.ts, a module that
 * only wants to read JSON would pull half the program in along Loop, and sit one step away
 * from an import cycle.
 *
 * ── Why "window" and "total" are two numbers ──
 * The window caps **how many requests are in flight at the same moment**: every subagent is
 * spending real money, and competes with the main conversation for the same provider's rate
 * limit — starting sixteen usually doesn't make things sixteen times faster, it makes the
 * main conversation start hitting 429. The total caps **the bill**: queued ones send no
 * requests, but every one in the queue will sooner or later run a whole session of its own.
 * Without that second fence, a model that misunderstood could queue two hundred in a single
 * turn, and every last one of them would run to completion.
 */

/**
 * Default window (agentflow off). Four already covers real-world uses like "split up and
 * look at three modules"
 */
export const MAX_AGENT_JOBS = 4

/** Default window with agentflow on */
export const FLOW_WINDOW = 6

/**
 * How large the window can be set.
 *
 * The cap of 12 isn't arbitrary: past it, the bottleneck shifts from "is there enough work
 * to split" to 429s, and at that point the extra few not only fail to speed things up, they
 * drag the **main conversation** down with them — what the user sees is a rate-limit error
 * in return for what they typed.
 */
export const FLOW_WINDOW_MIN = 2
export const FLOW_WINDOW_MAX = 12

/**
 * Max number alive at once (queued + running): with agentflow off / on.
 *
 * ★ With it on, this number **must be large**. It was once 24, and that stalled the feature
 *   halfway: jobs like "check each of a hundred files" or "map out twenty modules in
 *   parallel" are the very reason it exists, and blocking at 24 amounts to telling the model
 *   "don't split so finely" — so it falls back to doing the work itself. The window (how
 *   many are sending requests at once) is the rate-limit fence; this one only keeps a single
 *   run from running away.
 */
export const MAX_ALIVE_JOBS = 8
export const MAX_FLOW_ALIVE_JOBS = 100

/** Whether the value given by config / the command line is a legal window */
export function isFlowWindow(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= FLOW_WINDOW_MIN &&
    value <= FLOW_WINDOW_MAX
  )
}
