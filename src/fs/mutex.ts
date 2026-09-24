/**
 * Per-path mutex.
 *
 * The critical section must cover the whole of read → match → ask (which may block for
 * tens of seconds waiting for a keypress) → write. If it doesn't cover ask, B changes
 * the file while the user is looking at A's diff, and when A is approved and written
 * back that's a lost update based on stale content.
 *
 * ⚠ Known costs:
 * - An entry is dropped when its last holder releases. The one leak left: a waiter that
 *   timed out while being the tail leaves its entry behind — dropping it would let the
 *   next caller skip past the holder that is still inside. One entry, only after a
 *   timeout; accepted.
 * - Waiting has a 60s timeout. When the model calls edit in parallel,
 *   a timeout error beats the UI hanging forever with
 *   no idea what it's waiting for.
 */
const locks = new Map<string, Promise<unknown>>()

const WAIT_TIMEOUT_MS = 60_000

export class LockTimeoutError extends Error {
  constructor(path: string) {
    super(`Timed out after ${WAIT_TIMEOUT_MS / 1000}s waiting for a lock on "${path}". Another edit may be awaiting user approval.`)
    this.name = "LockTimeoutError"
  }
}

export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(path) ?? Promise.resolve()

  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  // ★ Compare against this exact object when cleaning up. It used to compare against
  //   `current`, which is never what the Map holds — the cleanup never ran.
  const tail = previous.then(() => current)
  locks.set(path, tail)

  let acquired = false
  try {
    await withTimeout(previous, path)
    acquired = true
    return await fn()
  } finally {
    release()
    // Only a holder that got in and is still the tail may drop the entry: a later waiter
    // has chained onto it otherwise, and a timed-out waiter never held the lock at all
    if (acquired && locks.get(path) === tail) locks.delete(path)
  }
}

async function withTimeout(promise: Promise<unknown>, path: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LockTimeoutError(path)), WAIT_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** For tests only. */
export function __clearLocksForTest(): void {
  locks.clear()
}

/** For tests only. */
export function __lockCountForTest(): number {
  return locks.size
}
