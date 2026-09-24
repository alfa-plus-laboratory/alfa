/**
 * Process warnings all go to the log file, never to the terminal.
 *
 * ── Why ──
 * The live area at the bottom (cli/live.ts) redraws by **erasing first**: it remembers
 * how many rows above the cursor its frame starts, goes up that many, clears down and
 * repaints. A write that bypasses it lands wherever the cursor is — inside the input box
 * — and pushes lines down, and the live area **doesn't know it happened**: the next
 * erase starts from the wrong row, so the warning and a torn half of the old frame stay
 * stuck in the scrollback for good. What the user sees is boxes broken off halfway, text
 * interleaved, and it piles up with every warning.
 *
 * It happened once in a real run: while agentflow was running, a
 * TimeoutOverflowWarning plus its stack got smeared across the middle of the screen,
 * and the whole lower frame went askew (that warning has since been fixed at the source,
 * see MAX_TIMEOUT_MS in tool/bash.ts — but the next warning will always come from
 * somewhere else, so this channel itself has to be plugged too).
 *
 * ── Why "attach a listener" rather than taking over stderr ──
 * Tried on Bun: patching `process.stderr.write` doesn't catch these warnings, **not
 * even console.error does** — they are written straight to fd 2 at the native layer.
 * But as long as any listener is attached to the `warning` event, Bun stops printing
 * them itself (the default printing isn't a JS listener, so it can't be removed with
 * Node's old removeAllListeners trick either). In other words: **it can't be caught,
 * only kept from being produced**, and attaching a listener does both at once — the
 * printing is gone, and the content is still available.
 *
 * llm/stream.ts takes the same approach for AI SDK warnings (reroute them before
 * they're emitted). Together, those two are the **only two** places in this process
 * that decide "where warnings go".
 *
 * ⚠ **The "with a listener attached Bun stops printing" above no longer holds on bun
 *   1.4.0.** 1.4.0 does both: the listener still receives it, and it still prints to
 *   fd 2 as well. So on 1.4.0 this file only keeps "the content is available"; the
 *   anti-tearing half is gone.
 *
 *   Three things were tried, and only the third works:
 *     - overriding `process.emitWarning` — doesn't catch it, it writes fd 2 natively
 *     - setting `process.env.NODE_NO_WARNINGS = "1"` in-process — too late, it was
 *       already read at startup
 *     - having `NODE_NO_WARNINGS=1` set **before the process starts** — printing gone,
 *       the listener still receives it
 *   And the third has nowhere to land for a single-file binary built with `--compile`:
 *   there's no outer shell to set the variable, short of re-exec'ing ourselves (which
 *   scrambles stdio and the TTY along with it — not worth it).
 *
 *   So the current approach is **don't upgrade bun**: `bun-version` in CI is already
 *   pinned to 1.3.14 (see the ★ passage in .github/workflows/release.yml — that line
 *   decides which runtime is embedded in the shipped binary, not just what builds it).
 *   The two tests in test/warnings.test.ts are the sentinels for this: the day someone
 *   wants to upgrade bun, they'll go red first, and the reason they're red is written
 *   right here.
 */
import { logger } from "./log.ts"

const log = logger("warn")

let installed = false

/**
 * Installing once is enough. Called first thing in main(), before the mode is even
 * known — the interactive live area gets torn apart, and on the `-p` path warnings
 * mixed into the output are equally meaningless, so no path wants them printed.
 */
export function captureWarnings(): void {
  if (installed) return
  installed = true
  process.on("warning", (warning: Error) => {
    log.warn(warning.name || "warning", { message: warning.message, stack: warning.stack })
  })
}
