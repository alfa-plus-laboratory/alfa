/**
 * Process-tree termination.
 *
 * ── Why proc.kill() alone won't do ──
 * `npm test` forks a whole pile of children, and `sleep 60 &` detaches outright. Kill only
 * the direct child and after Ctrl-C `pgrep` still shows a field of orphans, still eating
 * CPU, still writing files. So the child must be started `detached: true` in its **own
 * process group**, and kill uses a negative pid to take out the whole group.
 *
 * ── ★ Direct child exited ≠ process group empty ──
 * This is an escape route caught in real runs:
 *
 *   bash -c 'trap "" TERM; exec sleep 60' >/dev/null 2>&1 </dev/null & wait
 *
 * The outer shell doesn't trap, so it dies on SIGTERM; the grandchild traps TERM (and
 * SIG_IGN is **inherited across fork/exec**, so sleep is immune as well), and it also
 * redirects its stdio away so it no longer holds the parent's pipes — so ChildProcess's
 * 'close' fires immediately, the old implementation returned after 2ms declaring success,
 * and that sleep in the process group stayed alive the whole time.
 *
 * So once the direct child has exited we still have to **ask once more whether the process
 * group is there**, and if it is, escalate to SIGKILL. SIGKILL cannot be ignored; it is the
 * last line.
 *
 * ── The degraded path must exist ──
 * In some containers / PID namespaces detached fails, and then `process.kill(-pid)` throws
 * ESRCH. Catch it and degrade to killing only the direct child — an incomplete kill beats
 * the whole tool crashing. This degraded path is covered by tests; it is not a
 * better-than-nothing try/catch.
 */
import { spawn, type ChildProcess } from "node:child_process"

/**
 * Grace period from SIGTERM to SIGKILL.
 *
 * 300ms rather than the usual 3s. Not for the prompt: after Ctrl-C it comes back within
 * CANCEL_TIMEOUT_MS (200ms, agent/runner.ts) however long this takes — a kill still under
 * way carries on in the background, and drain() waits for it before the process exits.
 * But drain() gives up after 2s, and a 3s grace would outlast it: quit right after an
 * interrupt and a group that ignores SIGTERM is orphaned before SIGKILL is ever sent. A
 * well-behaved program has plenty of time to wrap up in 300ms after SIGTERM; one that
 * refuses to leave wasn't going to leave within 3s either.
 */
const SIGKILL_GRACE_MS = 300
/** Polling limits for confirming the process group is gone after SIGKILL. */
const REAP_POLL_MS = 20
const REAP_MAX_POLLS = 10

/**
 * The outcome of this termination. It **must exist** — see tool/job.ts:
 * this used to return void, so "stopped" was reported unconditionally, when all it
 * actually said was "our bookkeeping has been marked done". That is exactly what the user
 * ran into in real runs: `job kill` said Stopped, and the port was still taken.
 */
export interface KillOutcome {
  /** The direct child is really gone (or was gone to begin with) */
  stopped: boolean
  /** If the kill was incomplete, one sentence to follow up on. Absent on a clean kill */
  detail?: string
}

export async function killGroup(proc: ChildProcess): Promise<KillOutcome> {
  const pid = proc.pid
  if (pid === undefined) return { stopped: true }

  // Windows has no such thing as a process group, and a negative pid doesn't mean "the
  // whole group" — none of the sequence above (SIGTERM → wait → check the group is still
  // there → SIGKILL) holds over there. See killTree
  if (process.platform === "win32") return killTree(proc, pid)

  /**
   * Whether we have successfully signalled the **process group**.
   *
   * Only when this is true may we later send SIGKILL to -pid: it proves that a moment ago
   * -pid really was a process group we had permission to act on. Fire at -pid without that
   * evidence and, should detached not have taken effect and the number happen to collide
   * with someone else's process group, we kill unrelated processes.
   */
  let groupSignalled = false

  if (proc.exitCode === null && proc.signalCode === null) {
    groupSignalled = send(proc, pid, "SIGTERM")
    await raceExit(proc, SIGKILL_GRACE_MS)
  }

  // detached didn't take effect (already degraded to killing only the direct child), or the
  // process was already gone when we came in — this is as far as we go.
  // ★ On the degraded path **we don't know whether the kill was complete**: only the direct
  //   child got the signal, and whatever it forked is out of reach. Say so plainly; don't
  //   report a "stopped" nobody can follow up on
  if (!groupSignalled) {
    return gone(proc)
      ? { stopped: true }
      : { stopped: false, detail: "only the direct child could be signalled (no process group here)" }
  }
  if (!groupAlive(pid)) return { stopped: true }

  // Something in the group is still alive. SIGKILL cannot be caught or ignored.
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    return gone(proc) ? { stopped: true } : { stopped: false, detail: "SIGKILL to the process group failed" }
  }

  if (proc.exitCode === null && proc.signalCode === null) {
    await raceExit(proc, SIGKILL_GRACE_MS)
  }
  // Confirm the group really is empty before returning — Runner's drain() relies on this
  // to guarantee "no orphans on exit"
  for (let i = 0; i < REAP_MAX_POLLS && groupAlive(pid); i++) {
    await delay(REAP_POLL_MS)
  }
  if (groupAlive(pid)) {
    return { stopped: false, detail: "the process group survived SIGKILL (a stuck uninterruptible child?)" }
  }
  return { stopped: true }
}

/** Is the direct child already gone */
function gone(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null
}

/**
 * The Windows half: `taskkill /T /F`.
 *
 * ── Why proc.kill() alone won't do ──
 * Same reason as on POSIX, only the means differ: Node's kill on Windows terminates only
 * the direct child, while in `cmd /c npm test` what is really running is the grandchild
 * layer. `/T` is "along with all descendants", `/F` is force — there is no SIGTERM-style
 * "ask nicely first" over there; a console program waiting on stdin gets no signal it
 * could exit gracefully on.
 *
 * If taskkill itself won't start (PATH was changed, a stripped-down system), degrade to
 * killing only the direct child — an incomplete kill beats the whole tool crashing, the
 * same stance as the degraded path on POSIX.
 */
async function killTree(proc: ChildProcess, pid: number): Promise<KillOutcome> {
  if (gone(proc)) return { stopped: true }
  // ★ taskkill's exit code **must be checked**. This used to be
  //   `once("close", () => resolve())`, where success and "access denied" looked exactly
  //   alike — and the layer above still reported "stopped". 1 = access denied (an
  //   elevated process, someone else's session), 128 = no such pid (most likely it is
  //   already gone)
  let why: string | undefined
  try {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    const code = await new Promise<number | null>((resolve) => {
      killer.once("close", (value) => resolve(value))
      killer.once("error", () => resolve(null))
    })
    if (code === null) why = "taskkill could not be started"
    else if (code !== 0 && code !== 128) why = `taskkill exited with ${code}`
  } catch {
    why = "taskkill could not be started"
  }
  if (!gone(proc)) {
    try {
      proc.kill()
    } catch {
      // already gone
    }
    await raceExit(proc, SIGKILL_GRACE_MS)
  }
  if (gone(proc)) {
    // ⚠ The direct child being gone **does not mean** the tree is gone: when taskkill /T
    //   fails, what is really listening on the port in `cmd /c npm run dev` is the
    //   grandchild layer, which Node's kill can't reach. So carry taskkill's failure
    //   reason up regardless
    return why ? { stopped: true, detail: `${why} — its child processes may still be running` } : { stopped: true }
  }
  return { stopped: false, detail: why ?? "the process did not exit" }
}

/**
 * @returns whether the whole process group got the signal (false = degraded to killing
 * only the direct child)
 */
function send(proc: ChildProcess, pid: number, signal: NodeJS.Signals): boolean {
  try {
    // Negative pid = the whole process group. With detached in effect, this is the only
    // way to kill cleanly.
    process.kill(-pid, signal)
    return true
  } catch {
    // detached didn't take effect (some containers / PID namespaces): degrade to killing
    // only the direct child
    try {
      proc.kill(signal)
    } catch {
      // the process is already gone
    }
    return false
  }
}

/** Signal 0 only checks existence and permission; no signal is actually delivered. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

function raceExit(proc: ChildProcess, ms: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.off("close", onClose)
      resolve(false)
    }, ms)
    const onClose = () => {
      clearTimeout(timer)
      resolve(true)
    }
    proc.once("close", onClose)
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
