/**
 * 重试。包在整条流的**外面**,不是包在 HTTP 请求外面。
 *
 * ── 为什么不用 SDK 自带的 maxRetries ──
 * SDK 的重试:没有 UI 反馈(用户看到的是干等)、不认 retry-after 头、
 * 不区分「限流」和「你的 key 错了」。所以 stream.ts 里写死 maxRetries: 0,
 * 由这里接管。
 *
 * ── 核心约束:流一旦「落地」就不能重试 ──
 * 重试一个已经吐了半截文本给用户的流,等于把内容说两遍。所以这里维护一个
 * **提交点**:在第一个「带内容」的事件吐出去之前,流都还能重来;之后出错
 * 只能原样抛给上层。
 *
 * step-start 不算内容 —— 它会在 HTTP 错误**之前**先到,如果直接透传,
 * 下游就会看到「step-start → (重试) → step-start」这种重影。所以提交点之前
 * 的无内容事件先攒着,等真的有内容了再一起放出去。重试时连缓冲一起丢掉,
 * 下游完全看不见重试发生过。
 */
import { ContextOverflowError, type LLMEvent } from "./types.ts"
import { stream, type StreamHandle } from "./stream.ts"
import type { LLMRegistry } from "./registry.ts"
import type { LLMRequest } from "./types.ts"

/** 总尝试次数上限(含首次)。到顶就抛,不是无限重试。 */
export const MAX_ATTEMPTS = 8
export const BASE_DELAY_MS = 2_000
export const MAX_DELAY_MS = 30_000

/**
 * 只在**拿不到 HTTP 状态码**时才用(网络层错误、provider 把状态吞了)。
 * 有状态码就以状态码为准 —— 一个 400 的错误信息里出现 "timeout" 字样
 * 不该被重试。
 */
export const RETRYABLE_MESSAGE_PATTERNS: RegExp[] = [
  /\b(429|too many requests|rate.?limit)/i,
  /\b(500|502|503|504|internal server error|bad gateway|service unavailable|gateway time-?out)/i,
  /\b(overloaded|capacity|try again later|temporarily unavailable)/i,
  /\b(econnreset|econnrefused|etimedout|epipe|enotfound|eai_again|ehostunreach|enetunreach)\b/i,
  /(socket hang up|network error|fetch failed|premature close|connection (closed|reset|error)|stream (closed|terminated))/i,
  /\b(timeout|timed out)\b/i,
]

/**
 * 上下文超限。识别出来转成 ContextOverflowError,主循环才知道该去压缩历史
 * 而不是重试 —— 重试一个「太长了」只会再长一遍。
 */
const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
  /prompt is too long/i,
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /exceeds? the (maximum )?context/i,
  /input length and `?max_tokens`? exceed/i,
  /too many (input )?tokens/i,
]

/**
 * 408 请求超时 / 409 冲突 / 425 too early / 429 限流 / 5xx / 529 Anthropic overloaded。
 * 其余 4xx 一律不重试 —— key 错了、参数错了,重试一万次也是错的。
 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])

export interface RetryInfo {
  /** 刚失败的是第几次尝试(从 1 开始) */
  attempt: number
  maxAttempts: number
  delayMs: number
  error: Error
}

export interface RetryOptions {
  maxAttempts?: number
  /** 每次决定重试时回调一次,给 CLI 打「限流中,2s 后重试 (2/8)」 */
  onRetry?(info: RetryInfo): void
  /** 中断信号。中断不重试,且等待期间中断要立刻醒。 */
  signal?: AbortSignal
  /** 测试注入,避免真的睡 30 秒 */
  sleep?(ms: number, signal?: AbortSignal): Promise<void>
}

// ─────────────────────────────────────────────── 对外主体

/** stream() 的重试版。info 只解析一次,events 每次尝试重新建流。 */
export function streamWithRetry(
  registry: LLMRegistry,
  request: LLMRequest,
  options: RetryOptions = {},
): StreamHandle {
  const probe = stream(registry, request)
  let first: StreamHandle | undefined = probe
  const factory = () => {
    // 第一次直接复用探针,避免多解析一遍模型
    if (first) {
      const handle = first
      first = undefined
      return handle.events
    }
    return stream(registry, request).events
  }
  return {
    info: probe.info,
    events: withRetry(factory, { signal: request.abortSignal, ...options }),
  }
}

/**
 * 通用重试包装。factory 每次调用必须产出一条**全新**的流。
 */
export async function* withRetry(
  factory: () => AsyncIterable<LLMEvent>,
  options: RetryOptions = {},
): AsyncGenerator<LLMEvent> {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS
  const nap = options.sleep ?? sleep
  let attempt = 0

  while (true) {
    attempt++
    /** 是否已经有内容吐给下游 —— 一旦为 true 就再也不能重试 */
    let committed = false
    /** 提交点之前攒下的无内容事件 */
    const held: LLMEvent[] = []
    let failure: Error | undefined

    try {
      for await (const event of factory()) {
        if (event.type === "error") {
          // 已落地的流:错误原样透传,交给下游决定怎么显示
          if (committed) {
            yield event
            return
          }
          failure = event.error
          break
        }
        if (!carriesContent(event)) {
          if (committed) yield event
          else held.push(event)
          continue
        }
        if (!committed) {
          committed = true
          for (const earlier of held) yield earlier
          held.length = 0
        }
        yield event
      }
    } catch (error) {
      if (committed) throw error
      failure = toError(error)
    }

    if (!failure) {
      // 正常结束但一个内容事件都没有(空响应)—— 攒下的也得放出去
      for (const earlier of held) yield earlier
      return
    }

    const error = normalizeError(failure)
    if (isAbort(error, options.signal)) throw error
    if (error instanceof ContextOverflowError) throw error
    if (attempt >= maxAttempts || !isRetryable(error)) throw error

    const delayMs = retryDelay(attempt, headersOf(failure))
    options.onRetry?.({ attempt, maxAttempts, delayMs, error })
    await nap(delayMs, options.signal)
  }
}

// ─────────────────────────────────────────────── 判定

/**
 * 只有这些事件算「内容」。step-start 不算 —— 它会先于 HTTP 错误到达。
 * step-finish 算,因为它带 token 用量,漏了会让计费统计缺一块。
 */
function carriesContent(event: LLMEvent): boolean {
  return event.type !== "step-start"
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof ContextOverflowError) return false

  const status = statusOf(error)
  if (status !== undefined) return RETRYABLE_STATUS.has(status)

  // AI SDK 的 APICallError 自带这个判断,它比猜字符串准
  const flag = pick(error, "isRetryable")
  if (typeof flag === "boolean") return flag

  const message = messageOf(error)
  return RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
}

/**
 * 退避时长。服务端说了算,没说才用 2s 起步的指数退避。
 *
 * 上限 30s 是硬的:服务端要求等 10 分钟时我们仍然 30s 后重试,几次之后
 * 撞满 8 次抛出。对一个交互式 CLI 来说,让用户看着终端睡十分钟比直接
 * 报错更糟 —— 报错他至少知道发生了什么。
 */
export function retryDelay(attempt: number, headers?: HeaderLike): number {
  const asked = headerDelay(headers)
  if (asked !== undefined) return clamp(asked)
  // 抖动没意义:单用户 CLI,不存在惊群
  return clamp(BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1))
}

function clamp(ms: number): number {
  if (!Number.isFinite(ms)) return BASE_DELAY_MS
  return Math.min(MAX_DELAY_MS, Math.max(0, Math.round(ms)))
}

export type HeaderLike = Headers | Record<string, string | string[] | undefined> | undefined

function headerDelay(headers: HeaderLike): number | undefined {
  const ms = header(headers, "retry-after-ms")
  if (ms) {
    const value = Number(ms)
    if (Number.isFinite(value)) return Math.max(0, value)
  }
  const after = header(headers, "retry-after")
  if (after) {
    // 整数秒
    const seconds = Number(after)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
    // HTTP date
    const at = Date.parse(after)
    if (Number.isFinite(at)) return Math.max(0, at - Date.now())
  }
  return undefined
}

function header(headers: HeaderLike, name: string): string | undefined {
  if (!headers) return undefined
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined
  }
  const record = headers as Record<string, string | string[] | undefined>
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() !== name) continue
    const value = record[key]
    const flat = Array.isArray(value) ? value[0] : value
    if (typeof flat === "string" && flat.trim().length > 0) return flat.trim()
  }
  return undefined
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  const name = pick(error, "name")
  if (name === "AbortError" || name === "TimeoutError") return true
  return /\b(aborted|abortederror|operation was aborted)\b/i.test(messageOf(error))
}

/** 上下文超限伪装成普通 400 —— 认出来转型,主循环才能走压缩而不是重试。 */
function normalizeError(error: Error): Error {
  if (error instanceof ContextOverflowError) return error
  const message = messageOf(error)
  if (CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message))) {
    const overflow = new ContextOverflowError(error.message)
    overflow.cause = error
    return overflow
  }
  return error
}

// ─────────────────────────────────────────────── 错误挖掘
//
// 鸭子类型而不是 instanceof APICallError:同一个 SDK 装了两份副本时
// instanceof 会静默失效,而且自建 provider 未必用 SDK 的错误类。

const MAX_CAUSE_DEPTH = 5

function chain(error: unknown): unknown[] {
  const out: unknown[] = []
  let current = error
  for (let i = 0; i < MAX_CAUSE_DEPTH && current; i++) {
    out.push(current)
    const next = pick(current, "cause")
    if (next === current) break
    current = next
  }
  return out
}

function pick(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined
  return (value as Record<string, unknown>)[key]
}

function statusOf(error: unknown): number | undefined {
  for (const link of chain(error)) {
    for (const key of ["statusCode", "status"]) {
      const value = pick(link, key)
      if (typeof value === "number" && value >= 100 && value < 600) return value
    }
    const response = pick(link, "response")
    const status = pick(response, "status")
    if (typeof status === "number" && status >= 100 && status < 600) return status
  }
  return undefined
}

function headersOf(error: unknown): HeaderLike {
  for (const link of chain(error)) {
    for (const key of ["responseHeaders", "headers"]) {
      const value = pick(link, key)
      if (value && typeof value === "object") return value as HeaderLike
    }
    const response = pick(link, "response")
    const headers = pick(response, "headers")
    if (headers && typeof headers === "object") return headers as HeaderLike
  }
  return undefined
}

function messageOf(error: unknown): string {
  const parts: string[] = []
  for (const link of chain(error)) {
    const message = pick(link, "message")
    if (typeof message === "string") parts.push(message)
    else if (typeof link === "string") parts.push(link)
    const code = pick(link, "code")
    if (typeof code === "string") parts.push(code)
    // provider 常把真实原因塞在 responseBody 里
    const body = pick(link, "responseBody")
    if (typeof body === "string") parts.push(body.slice(0, 2000))
  }
  return parts.join(" | ")
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(typeof value === "string" ? value : JSON.stringify(value))
}

// ─────────────────────────────────────────────── 等待

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return signal?.aborted ? Promise.reject(abortError()) : Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function abortError(): Error {
  const error = new Error("aborted")
  error.name = "AbortError"
  return error
}
