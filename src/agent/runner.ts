/**
 * At most one running turn per session, plus the single entry point for interrupts.
 *
 * ── Why interrupts are funneled through one place ──
 * The correct behavior for Ctrl-C isn't "stop rendering", it's a chain: abort → stream
 * disconnects → tools get the signal and wind themselves down (bash kills the whole process
 * group) → tool parts that never landed are rewritten to error → the message is finalized.
 * Skip any link and the symptom is never an error on the spot:
 *   - skip killing the process group → `sleep 60` becomes an orphan and keeps eating CPU
 *   - skip rewriting tool parts → history keeps a tool_use with no result, and every turn
 *     after that gets a 400
 * The CLI's SIGINT handler may only call cancel(); it may not touch the store or processes
 * itself.
 *
 * ── Why cancel waits ──
 * Allowing the next input only once the turn has truly wound down keeps two Processors from
 * writing parts into the same session when the user immediately types the next message. The
 * wait is capped (200ms by default); on timeout we let it go — blocking the user's terminal
 * is worse than an occasional write race, and the timed-out run is still tracked by drain(),
 * which waits for it before the process exits.
 */
import type { RunInput, RunResult } from "./loop.ts"
import type { Loop } from "./loop.ts"

/**
 * Cap on waiting for wind-down after an interrupt. Past it, the prompt goes back to the user
 * first.
 */
export const CANCEL_TIMEOUT_MS = 200

export class SessionBusyError extends Error {
  constructor(sessionID: string) {
    super(`Session ${sessionID} already has a turn in flight`)
    this.name = "SessionBusyError"
  }
}

export interface Run {
  sessionID: string
  controller: AbortController
  promise: Promise<RunResult>
  startedAt: number
}

export type CancelOutcome = "idle" | "settled" | "timeout"

export class Runner {
  private active = new Map<string, Run>()
  /** Turns still winding down after cancel timed out. Awaited before the process exits. */
  private draining = new Set<Promise<unknown>>()

  constructor(private readonly loop: Loop) {}

  isBusy(sessionID?: string): boolean {
    if (sessionID === undefined) return this.active.size > 0
    return this.active.has(sessionID)
  }

  /**
   * A cancel timeout only gives interactivity back; it doesn't mean the host task has ended.
   * Before switching isolation, the wind-downs must be checked as well.
   */
  hasPending(): boolean { return this.active.size > 0 || this.draining.size > 0 }

  get(sessionID: string): Run | undefined {
    return this.active.get(sessionID)
  }

  /**
   * Start a turn. Returns immediately, without waiting for it to finish.
   *
   * The caller **must** handle the returned promise (await it or attach a catch), or an
   * unexpected throw inside Loop becomes an unhandled rejection.
   */
  start(input: Omit<RunInput, "abortSignal">): Run {
    if (this.active.has(input.sessionID)) throw new SessionBusyError(input.sessionID)

    const controller = new AbortController()
    const run: Run = {
      sessionID: input.sessionID,
      controller,
      startedAt: Date.now(),
      promise: undefined as never,
    }

    run.promise = this.loop
      .run({ ...input, abortSignal: controller.signal })
      .finally(() => {
        // Delete only if the entry is still ours — otherwise, once a timeout has let the
        // session go, the new turn's record could be deleted by mistake
        if (this.active.get(input.sessionID) === run) this.active.delete(input.sessionID)
      })

    this.active.set(input.sessionID, run)
    return run
  }

  /**
   * Interrupt, and wait for it to wind down.
   *
   * @returns "idle" wasn't running to begin with / "settled" fully wound down / "timeout"
   *          still winding down, handed over to the drain queue
   */
  async cancel(sessionID: string, timeoutMs = CANCEL_TIMEOUT_MS): Promise<CancelOutcome> {
    const run = this.active.get(sessionID)
    if (!run) return "idle"

    run.controller.abort()
    // Loop's exceptions must not surface here — cancel means "stop", not "report a result"
    const settled = run.promise.catch(() => undefined)

    const raced = await Promise.race([
      settled.then(() => "settled" as const),
      delay(timeoutMs).then(() => "timeout" as const),
    ])

    if (raced === "timeout") {
      this.active.delete(sessionID) // let go, so the user can keep typing
      this.track(settled)
    }
    return raced
  }

  async cancelAll(timeoutMs = CANCEL_TIMEOUT_MS): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.cancel(id, timeoutMs)))
  }

  /**
   * Wait for every turn still winding down to finish. Called before the process exits.
   *
   * Without the wait, bash's killGroup may die with the main process before it has finished
   * — those child processes get adopted by init and keep running in the background. The
   * user thinks they've exited, but has actually left processes strewn all over.
   */
  async drain(timeoutMs = 2_000): Promise<void> {
    const pending = [
      ...this.draining,
      ...[...this.active.values()].map((run) => run.promise.catch(() => undefined)),
    ]
    if (pending.length === 0) return
    await Promise.race([Promise.all(pending), delay(timeoutMs)])
  }

  private track(promise: Promise<unknown>): void {
    this.draining.add(promise)
    void promise.finally(() => this.draining.delete(promise))
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
