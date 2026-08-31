/**
 * JSON-RPC 2.0,跑在一根 Transport 上。
 *
 * MCP 的线上格式就是 JSON-RPC 2.0,而我们只当 **client**:发请求、收响应、收通知。
 * 手写这一层而不是装官方 SDK,理由是这个仓统共只有六个运行时依赖、而且要
 * `bun build --compile` 成一个文件 —— client 这一侧的协议面很小(握手、列工具、
 * 调工具),小到不值得为它把一整个带 server 实现的包拖进来。换回 SDK 的代价也被
 * 锁在这一层:client.ts 只认这里导出的三个方法。
 */
export interface RpcOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface JsonRpcClientOptions {
  /** 收到 server 主动发来的通知(工具列表变了之类) */
  onNotification?(method: string, params: unknown): void
  /** 默认超时。单条请求可以自己覆盖 */
  timeoutMs?: number
}

/** JSON-RPC 层面的错误。带着 code,上层要按它分开说话 */
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
 * 单条请求的超时上限:30 分钟。
 *
 * 和 tool/bash.ts 的 MAX_TIMEOUT_MS 同一个理由,而且那条已经在真机上咬过一次:
 * setTimeout 的延时超过 2^31-1 毫秒不会报错,会被**静默改成 1 毫秒** —— 于是
 * 请求当场"超时",而报出去的原因指向完全错误的方向。这里的数字可以由调用方
 * 传进来,所以必须夹住。
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
        // server 那边还在跑,礼貌地告诉它一声;它不理也无所谓
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

  /** 管子断了之后,挂着的请求一个都不能留 —— 留下的是永远不会 settle 的 Promise */
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
      // 收到一行不是 JSON 的东西:多半是 server 把日志打进了 stdout。
      // 那是它的 bug,不是我们的 —— 丢掉这一行接着读,不能让整条连接倒下
      return
    }

    const id = message["id"]

    // ① server 主动发来的请求(sampling / elicitation / roots)。我们一样都不支持,
    //    而**必须回一个错误**:不回的话它会一直等,整个调用就挂在那儿。
    //    沉默和拒绝在协议上是两回事,在体验上差一个"卡死"。
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

    // ② 通知
    if (message["method"] !== undefined) {
      this.options.onNotification?.(String(message["method"]), message["params"])
      return
    }

    // ③ 响应
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
