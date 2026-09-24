/**
 * The sole owner of stdin.
 *
 * Mirrors stdout, which only the live area (live.ts) may write to while it's up. Same
 * reason, only harder: with two `stdin.on("data")` listeners, every keypress is
 * delivered to both, and raw mode is a global switch — whoever calls
 * `setRawMode(false)` first cripples the other side that is still reading keys.
 *
 * So this is a **handler stack**: the input box sits at the bottom, a permission prompt
 * is pushed on top to take over temporarily, and once it pops, keys go back to the
 * input box automatically. Raw mode is only really exited when the stack is empty.
 *
 * ── ESC ambiguity ──
 * A lone ESC may be the user pressing Esc, or just the first byte of `ESC [ A` to
 * arrive. The only way to tell is to wait: if nothing follows within the timeout, it
 * was the Esc key. 25ms is an empirical value — short enough that no human notices the
 * delay, long enough that a local terminal's continuation bytes always make it.
 */
import fs from "node:fs"
import tty from "node:tty"
import { decodeKeys, type Key } from "./keys.ts"

/** The top handler owns the keys and never passes them down, so it returns nothing. */
export type KeyHandler = (key: Key) => void

const ESCAPE_TIMEOUT_MS = 25

/**
 * How often to check whether the terminal is still there.
 *
 * It only matters once the terminal is already gone, so slow is fine — the cost is at
 * most one extra second of spinning. Polling every few dozen ms would instead burn
 * syscalls all day long in a perfectly normal session.
 */
const HANGUP_POLL_MS = 1000

/**
 * The terminal **was there and is now gone**.
 *
 * Both conditions are required, because either one alone misidentifies:
 *   · `isTTY` is decided at startup, and after the pty master closes it is **still
 *     true** — looking only at it, you never notice the terminal is gone;
 *   · `isatty(0)` is false in a pipe to begin with — looking only at it, you would kill
 *     a legitimate `echo x | alfa` as if it had disconnected.
 *
 * Only together do they mean "there was a terminal, and now there isn't". That is the
 * one case where we should leave.
 */
export function terminalGone(input: NodeJS.ReadStream = process.stdin): boolean {
  if (input.isTTY === true) return input.destroyed || !tty.isatty(0)
  // ── The terminal was gone **before we started** ──
  //
  // The check above can't catch this: at process init isatty(0) was already false, so
  // isTTY is false too — indistinguishable from an ordinary pipe.
  //
  // The only thing that separates them is writing to fd 1: pipes, files and /dev/null
  // all accept writes, while a pty whose master has closed returns EIO. We write 0
  // bytes, which leaves no trace.
  try {
    fs.writeSync(1, "")
    return false
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EIO"
  }
}

/** Turn bracketed paste on/off. Without it, pasting 40 lines of code = 40 submits. */
const PASTE_ON = "\u001b[?2004h"
const PASTE_OFF = "\u001b[?2004l"

export class Keyboard {
  private readonly input: NodeJS.ReadStream
  private readonly output: NodeJS.WriteStream
  private readonly stack: KeyHandler[] = []
  private buffer = ""
  private escapeTimer: ReturnType<typeof setTimeout> | undefined
  private listening = false
  private wasRaw = false
  private hangupTimer: ReturnType<typeof setInterval> | undefined

  /**
   * The terminal is gone.
   *
   * ★ If nobody handles this, the process stays around **forever**: no UI, no user,
   *   100% of one core. See the watchdog in attach().
   */
  onHangup: (() => void) | undefined

  constructor(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout) {
    this.input = input
    this.output = output
  }

  get usable(): boolean {
    return this.input.isTTY === true
  }

  /**
   * stdin has actually been taken over. False when raw mode couldn't be had — in that
   * case keys never come.
   */
  get attached(): boolean {
    return this.listening
  }

  /**
   * Take over early.
   *
   * Interactive mode has to know **before drawing the input box** whether raw mode is
   * actually available: if it isn't, it should fall back to line-by-line reading
   * instead of drawing a box that will never receive a key.
   */
  open(): boolean {
    this.attach()
    return this.listening
  }

  /**
   * Push a handler on top; returns the function that pops it.
   *
   * The pop function is idempotent and **only removes its own handler** — indexOf, not
   * pop. On error paths the order can get scrambled, and a blind pop would remove
   * someone else's handler.
   */
  push(handler: KeyHandler): () => void {
    this.stack.push(handler)
    this.attach()
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const at = this.stack.indexOf(handler)
      if (at !== -1) this.stack.splice(at, 1)
      if (this.stack.length === 0) this.detach()
    }
  }

  isCurrent(handler: KeyHandler): boolean { return this.stack.at(-1) === handler }

  private attach(): void {
    if (this.listening || !this.usable) return
    this.listening = true
    this.wasRaw = this.input.isRaw ?? false
    try {
      this.input.setRawMode?.(true)
    } catch {
      this.listening = false
      return
    }
    this.input.setEncoding("utf8")
    this.input.resume()
    this.input.on("data", this.onData)
    this.output.write(PASTE_ON)
    this.watchHangup()
  }

  /**
   * The only way to notice the terminal disappearing is to **go and look**.
   *
   * In principle we'd hook `input.on("end"/"error"/"close")`, but after the pty master
   * closes Bun emits none of them — seen in real runs: no event ever arrives, while at
   * that very moment `stdin.destroyed` is already true. In other words it knows
   * internally; it just doesn't say so.
   *
   * ★ And `isTTY` is **still true** at that point — the code everywhere uses it as the
   *   test for "is there a terminal", and in this scenario every one of those is wrong.
   *   The two things that actually flip are the ones below.
   *
   * The consequence is worse than missing a few keys: once the terminal is gone,
   * reading fd 0 returns EIO immediately and the event loop retries on the next tick —
   * an orphan process spinning at full speed. One started with setsid (automated tests
   * are) never gets SIGHUP, so it can spin like that forever. Real cost: a batch of
   * such processes once burned over four hundred CPU hours before someone happened to
   * look at btop.
   */
  private watchHangup(): void {
    if (this.hangupTimer !== undefined) return
    this.hangupTimer = setInterval(() => {
      if (!terminalGone(this.input)) return
      this.clearHangupTimer()
      const notify = this.onHangup
      // Restore the terminal first (most likely a no-op by now, nobody's watching anyway),
      // then call someone to clean up
      this.close()
      notify?.()
    }, HANGUP_POLL_MS)
    // The watchdog itself shouldn't keep the process from exiting
    this.hangupTimer.unref?.()
  }

  private clearHangupTimer(): void {
    if (this.hangupTimer === undefined) return
    clearInterval(this.hangupTimer)
    this.hangupTimer = undefined
  }

  /**
   * Re-declare the terminal modes.
   *
   * Tearing is often not just about the picture: once anything external turns off raw
   * mode or bracketed paste, the symptom is "the screen looks fine but the keys are
   * wrong". Ctrl-L repairs both the terminal state and the pixels.
   *
   * All three are **idempotent turn-ons**; writing them again has no side effects, so we
   * don't check the current state — checking would itself mean asking the terminal, and
   * this path exists precisely because "we're no longer sure of the terminal's state".
   */
  reassert(): void {
    if (!this.listening) return
    try {
      this.input.setRawMode?.(true)
    } catch {
      // The terminal is already gone. watchHangup will clean up
    }
    this.output.write(PASTE_ON)
  }

  private detach(): void {
    if (!this.listening) return
    this.listening = false
    this.clearEscapeTimer()
    this.clearHangupTimer()
    this.input.off("data", this.onData)
    this.output.write(PASTE_OFF)
    try {
      if (!this.wasRaw) this.input.setRawMode?.(false)
    } catch {
      // The terminal is already gone
    }
    if (!this.wasRaw) this.input.pause()
    this.buffer = ""
  }

  /**
   * Must be called before exiting, and on **every** exit path — miss one and the user
   * gets back to a shell whose terminal is still in raw mode: typing doesn't echo,
   * Ctrl-C does nothing, and the only way out is closing the window.
   */
  close(): void {
    this.stack.length = 0
    this.detach()
  }

  private readonly onData = (chunk: string): void => {
    this.clearEscapeTimer()
    this.buffer += chunk

    const { keys, rest, pendingEscape } = decodeKeys(this.buffer)
    this.buffer = rest
    // A batch of keys belongs to the form that started receiving it. An approval's
    // a+Enter must not leak the rest of the batch into the chat input.
    const owner = this.stack.at(-1)
    for (const key of keys) {
      if (this.stack.at(-1) !== owner) break
      this.dispatch(key)
    }

    if (pendingEscape) {
      // Wait a moment. If it really is the Esc key nothing more will come; on timeout,
      // treat it as Esc
      this.escapeTimer = setTimeout(() => {
        this.escapeTimer = undefined
        // What's left in the buffer must be exactly that ESC. If not, the following
        // bytes have already arrived — onData clears this timer first, so only a race
        // gets here — and we leave it to the next decode pass.
        if (this.buffer !== "\u001b") return
        this.buffer = ""
        this.dispatch({ name: "escape", ctrl: false, meta: false, shift: false })
      }, ESCAPE_TIMEOUT_MS)
      // The timer shouldn't keep the process from exiting
      this.escapeTimer.unref?.()
    }
  }

  private dispatch(key: Key): void {
    const handler = this.stack[this.stack.length - 1]
    if (!handler) return
    try {
      handler(key)
    } catch {
      // One key handler throwing shouldn't take the whole keyboard down. Real errors
      // surface elsewhere.
    }
  }

  private clearEscapeTimer(): void {
    if (this.escapeTimer === undefined) return
    clearTimeout(this.escapeTimer)
    this.escapeTimer = undefined
  }
}
