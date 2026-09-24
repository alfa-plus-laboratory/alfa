/**
 * JSON-RPC 2.0, running over one Transport.
 *
 * MCP's wire format is simply JSON-RPC 2.0, and we only act as the **client**: send
 * requests, receive responses, receive notifications. This layer is hand-written instead
 * of installing the official SDK because this repo has only seven runtime dependencies in
 * total and has to `bun build --compile` into a single file — the client side of the
 * protocol is small (handshake, list tools, call tools), too small to be worth dragging in
 * a whole package that ships a server implementation. The cost of switching back to the
 * SDK is also contained in this layer: client.ts only knows the three methods exported
 * here.
 */
export interface RpcOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface JsonRpcClientOptions {
  /** A notification the server sent on its own (tool list changed and the like) */
  onNotification?(method: string, params: unknown): void
  /** Default timeout. Individual requests can override it */
  timeoutMs?: number
}

/** A JSON-RPC-level error. Carries code, which the layer above uses to word things apart */
export class RpcError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = "RpcError"
    this.code = code
    this.data = data
  }
}

const DEFAULT_TIMEOUT_MS = 120_000
/**
 * Cap on a single request's timeout: 30 minutes.
 *
 * Same reason as MAX_TIMEOUT_MS in tool/bash.ts, and that one has already bitten in real
 * runs: a setTimeout delay above 2^31-1 ms doesn't error, it's **silently changed to 1 ms**
 * — so the request "times out" on the spot, and the reported cause points in completely
 * the wrong direction. The number here can be passed in by the caller, so it must be
 * clamped.
 */
const MAX_TIMEOUT_MS = 1_800_000

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  cleanup(): void
}

export interface Transportish {
  send(line: string): void
  onMessage(handler: (line: string) => void): void
  onClose(handler: (why: string) => void): void
}

export class JsonRpcClient {
  private readonly transport: Transportish
  private readonly options: JsonRpcClientOptions
  private readonly pending = new Map<number, Pending>()
  private nextID = 1
  private dead: string | undefined

  constructor(transport: Transportish, options: JsonRpcClientOptions = {}) {
    this.transport = transport
    this.options = options
    transport.onMessage((line) => this.receive(line))
    transport.onClose((why) => this.die(why))
  }

  notify(method: string, params?: unknown): void {
    if (this.dead) return
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }))
  }

  request(method: string, params?: unknown, options: RpcOptions = {}): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error(this.dead))
    const id = this.nextID++
    const timeoutMs = Math.min(options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)

    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.get(id)?.cleanup()
        this.pending.delete(id)
        // The server side is still running; politely let it know. Fine if it ignores us
        this.notify("notifications/cancelled", { requestId: id, reason: "client aborted" })
        reject(new Error("Interrupted."))
      }
      const timer = setTimeout(() => {
        this.pending.get(id)?.cleanup()
        this.pending.delete(id)
        this.notify("notifications/cancelled", { requestId: id, reason: "timed out" })
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      const cleanup = (): void => {
        clearTimeout(timer)
        options.signal?.removeEventListener("abort", onAbort)
      }

      this.pending.set(id, { resolve, reject, timer, cleanup })

      if (options.signal) {
        if (options.signal.aborted) {
          cleanup()
          this.pending.delete(id)
          reject(new Error("Interrupted."))
          return
        }
        options.signal.addEventListener("abort", onAbort, { once: true })
      }

      try {
        this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }))
      } catch (error) {
        cleanup()
        this.pending.delete(id)
        reject(error as Error)
      }
    })
  }

  /**
   * Once the pipe breaks, not one pending request may be left behind — what's left is a
   * Promise that will never settle
   */
  private die(why: string): void {
    if (this.dead) return
    this.dead = why
    for (const [, one] of this.pending) {
      one.cleanup()
      one.reject(new Error(why))
    }
    this.pending.clear()
  }

  private receive(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Got a line that isn't JSON: most likely the server printed its logs to stdout.
      // That's its bug, not ours — drop the line and keep reading; don't let the whole
      // connection go down
      return
    }

    const id = message["id"]

    // ① A request the server sent on its own (sampling / elicitation / roots). We support
    //    none of them, and **must reply with an error**: without a reply it waits forever,
    //    and the whole call hangs there. Silence and refusal are two different things in
    //    the protocol; to the user, the difference between them is a hang.
    if (message["method"] !== undefined && id !== undefined && id !== null) {
      this.transport.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `alfa is an MCP client only; it does not implement ${String(message["method"])}` },
        }),
      )
      return
    }

    // ② Notifications
    if (message["method"] !== undefined) {
      this.options.onNotification?.(String(message["method"]), message["params"])
      return
    }

    // ③ Responses
    if (typeof id !== "number") return
    const waiting = this.pending.get(id)
    if (!waiting) return
    this.pending.delete(id)
    waiting.cleanup()

    const error = message["error"]
    if (error !== undefined && error !== null) {
      const shape = error as { code?: unknown; message?: unknown; data?: unknown }
      waiting.reject(
        new RpcError(
          typeof shape.code === "number" ? shape.code : -1,
          typeof shape.message === "string" ? shape.message : "unknown error",
          shape.data,
        ),
      )
      return
    }
    waiting.resolve(message["result"])
  }
}
