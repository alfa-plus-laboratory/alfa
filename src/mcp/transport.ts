/**
 * The **pipe** to one MCP server: one JSON per line, in and out.
 *
 * Transport is an interface rather than hard-coded stdio, and the reason isn't
 * abstraction for its own sake — it's that sooner or later this path has to reach remote
 * servers (HTTP). When that day comes, the change is one more implementation in this
 * file, and protocol.ts and client.ts don't change a single character: all they know is
 * "can send a line, can receive a line, can close".
 */
import { spawn, type ChildProcess } from "node:child_process"
import { buildChildEnv } from "../env/whitelist.ts"
import { killGroup } from "../tool/bash/kill.ts"
import { logger } from "../util/log.ts"
import type { McpServerEntry } from "./config.ts"

const log = logger("mcp")

export interface Transport {
  /** Send one line (without the newline; the implementation adds it) */
  send(line: string): void
  /** Received one complete message line */
  onMessage(handler: (line: string) => void): void
  /**
   * The pipe broke. The argument is a reason that can be told to a human.
   *
   * ★ **Several** can be attached, and not one may be dropped. This path has at least two
   *   listeners: JsonRpcClient has to reject every pending request, and McpClient has to
   *   record "why it broke" for the UI. Writing it as "keep only the last one" doesn't
   *   just cost one notification — those Promises never settle, and whoever awaits them
   *   waits forever (in tests, the whole test process hangs and never exits).
   */
  onClose(handler: (why: string) => void): void
  /** Close it. Must be safe to call again when already closed */
  close(): Promise<void>
}

/**
 * stdio transport: start a child process and use its stdin/stdout as the pipe.
 *
 * ── Three things that must be done right ──
 *
 * ① **Not one character of the server's stderr may reach the terminal.** Nearly all of
 *    them print startup logs to stderr, and one line written behind the live area's back
 *    tears the frame apart and leaves the debris in the scrollback (see cli/live.ts; the
 *    same hole, with the process's own warnings as the source, is plugged in
 *    util/warnings.ts). So stderr is piped, never inherited, and goes to the log file in
 *    its entirety.
 *
 * ② **It must be possible to kill it along with its descendants.** MCP servers are often
 *    `npx …`, and the thing doing the real work is the grandchild; killing only the direct
 *    child leaves behind an unsupervised resident process — one that outlives alfa (the
 *    orphaned process once burned over four hundred CPU hours; that's the lesson).
 *    So on POSIX it starts its own process group, and closing goes through bash's
 *    already-proven killGroup: there should be only one implementation of how to kill a
 *    process tree cleanly.
 *
 * ③ **One line is one message, and one line may arrive in several pieces.** stdout is a
 *    byte stream with no notion of "messages": one JSON may be cut into three chunks, or
 *    three may be squeezed into one chunk. So this buffers on its own and splits on \n.
 */
export function stdioTransport(entry: McpServerEntry, root: string): Transport {
  const proc: ChildProcess = spawn(entry.command, entry.args ?? [], {
    cwd: entry.cwd ?? root,
    // ★ Goes through the gatekeeper, not `{...process.env}`.
    //
    //   The typical MCP server is `npx some-mcp-server` — code someone else wrote, just
    //   downloaded onto this machine. Passing the whole environment through means
    //   handing it ANTHROPIC_API_KEY, ALFA_KEY_*, AWS_* and GITHUB_TOKEN all together,
    //   none of which it needs.
    //   The header of env/whitelist.ts cites exactly this scenario as its reason to
    //   exist, and this was once the only spawn in the whole repo that bypassed it.
    //
    //   entry.env comes after, so what's written explicitly in config (including
    //   `${VAR}` expansion) still takes effect — that is the proper way to "give this
    //   server the one token it needs".
    env: { ...buildChildEnv().env, ...entry.env },
    stdio: ["pipe", "pipe", "pipe"],
    // On Windows detached means something else (open a new console window); there the
    // tree is reaped with taskkill /T
    detached: process.platform !== "win32",
    windowsHide: true,
  })

  const messageHandlers: Array<(line: string) => void> = []
  const closeHandlers: Array<(why: string) => void> = []
  let closed: string | undefined
  /**
   * Already set about killing it. Separate from closed: after the process dies on its own,
   * close() still has to clean up after it
   */
  let killed = false
  let buffer = ""

  const finish = (why: string): void => {
    if (closed) return
    closed = why
    for (const handler of closeHandlers) handler(why)
  }

  proc.stdout?.setEncoding("utf8")
  proc.stdout?.on("data", (chunk: string) => {
    buffer += chunk
    let at = buffer.indexOf("\n")
    while (at >= 0) {
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      if (line.length > 0) for (const handler of messageHandlers) handler(line)
      at = buffer.indexOf("\n")
    }
  })

  proc.stderr?.setEncoding("utf8")
  proc.stderr?.on("data", (chunk: string) => {
    // To the log, not the screen. When something breaks, "what the server said on stderr
    // at the time" is first-hand evidence (the log is only written with ALFA_DEBUG=1)
    log.warn(`${entry.name} stderr`, { text: chunk.trimEnd().slice(-2000) })
  })

  // spawn itself failed (a nonexistent command is the most common kind). This must say
  // which server and which command — that config line is exactly what the user has to
  // go fix next
  proc.on("error", (error: Error) => finish(`could not start "${entry.command}" — ${error.message}`))
  proc.on("close", (code, signal) => {
    const how = signal ? `killed by ${signal}` : `exited with code ${code ?? "null"}`
    finish(`the server process ${how}`)
  })

  return {
    send(line: string): void {
      if (closed) throw new Error(`mcp server "${entry.name}" is not running`)
      proc.stdin?.write(line + "\n")
    },
    onMessage(handler) {
      messageHandlers.push(handler)
    },
    onClose(handler) {
      closeHandlers.push(handler)
      // Already dead before the handler was attached: fire it once now — otherwise the
      // caller waits for a notification that never comes
      if (closed) handler(closed)
    },
    async close(): Promise<void> {
      // ★ Closing it ourselves must go through finish too. The requests waiting on the
      //   other side can't tell "it died on its own" from "we closed it" — either way
      //   they'll get no answer, and without a notification they hang forever. A process
      //   that hangs on wrap-up is costlier to track down than any kind of error.
      const first = !killed
      killed = true
      finish("the connection to the server was closed")
      if (!first) return
      try {
        proc.stdin?.end()
      } catch {
        // Already broken — never mind; it still gets killed below
      }
      await killGroup(proc)
    },
  }
}
