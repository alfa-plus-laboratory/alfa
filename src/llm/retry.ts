/**
 * Retry. Wraps the **whole stream**, not the HTTP request.
 *
 * ── Why not the SDK's own maxRetries ──
 * The SDK's retry: no UI feedback (the user just sees a hang), ignores the retry-after
 * header, and can't tell "rate limited" apart from "your key is wrong". So stream.ts
 * hard-codes maxRetries: 0 and this file takes over.
 *
 * ── Core constraint: once a stream has "landed" it can't be retried ──
 * Retrying a stream that has already emitted half its text to the user means saying the
 * content twice. So this keeps a **commit point**: until the first event "carrying
 * content" goes out, the stream can still be redone; an error after that can only be
 * thrown to the layer above as-is.
 *
 * step-start doesn't count as content — it arrives **before** the HTTP error, and if it
 * were passed straight through, downstream would see a ghost like "step-start → (retry) →
 * step-start". So content-free events before the commit point are held back and released
 * together once real content arrives. On retry the buffer is thrown away too, and
 * downstream never sees that a retry happened at all.
 */
import { ContextOverflowError, type LLMEvent } from "./types.ts"
import { stream, type StreamHandle } from "./stream.ts"
import type { LLMRegistry } from "./registry.ts"
import type { LLMRequest } from "./types.ts"

/** Cap on total attempts (incl. the first). Throws when reached — not infinite retry. */
export const MAX_ATTEMPTS = 8
export const BASE_DELAY_MS = 2_000
export const MAX_DELAY_MS = 30_000

/**
 * Only used when **there's no HTTP status code** (network-layer errors, a provider that
 * swallowed the status). When there is a status code it wins — a 400 whose error message
 * happens to contain "timeout" should not be retried.
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
 * Context overflow. Recognized and turned into ContextOverflowError so the main loop knows
 * to compact history rather than retry — retrying a "too long" just makes it too long
 * again.
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
 * 408 request timeout / 409 conflict / 425 too early / 429 rate limit / 5xx / 529
 * Anthropic overloaded. Every other 4xx is never retried — wrong key, wrong parameters:
 * retry ten thousand times and it's still wrong.
 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])

export interface RetryInfo {
  /** Which attempt just failed (1-based) */
  attempt: number
  maxAttempts: number
  delayMs: number
  error: Error
}

export interface RetryOptions {
  maxAttempts?: number
  /**
   * Called once each time we decide to retry, so the CLI can print "rate limited,
   * retrying in 2s (2/8)"
   */
  onRetry?(info: RetryInfo): void
  /** Abort signal. Aborts are never retried, and an abort mid-wait must wake at once. */
  signal?: AbortSignal
  /** Test injection, so tests don't actually sleep 30 seconds */
  sleep?(ms: number, signal?: AbortSignal): Promise<void>
}

// ─────────────────────────────────────────────── Public entry points

/**
 * Retrying version of stream(). info is resolved once; events rebuilds the stream on every
 * attempt.
 */
export function streamWithRetry(
  registry: LLMRegistry,
  request: LLMRequest,
  options: RetryOptions = {},
): StreamHandle {
  const probe = stream(registry, request)
  let first: StreamHandle | undefined = probe
  const factory = () => {
    // The first time, reuse the probe directly, to avoid resolving the model again
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
 * Generic retry wrapper. Every call to factory must produce a **brand-new** stream.
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
    /** Whether any content has gone out downstream yet — once true, no more retries ever */
    let committed = false
    /** Content-free events held back before the commit point */
    const held: LLMEvent[] = []
    let failure: Error | undefined

    try {
      for await (const event of factory()) {
        if (event.type === "error") {
          // A stream that has landed: pass the error through as-is; downstream decides how
          // to display it
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
      // Ended normally but without a single content event (empty response) — the held
      // events still have to go out
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

// ─────────────────────────────────────────────── Classification

/**
 * Only these events count as "content". step-start doesn't — it arrives before the HTTP
 * error. step-finish does, because it carries token usage; missing it would leave a hole
 * in the billing stats.
 */
function carriesContent(event: LLMEvent): boolean {
  return event.type !== "step-start"
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof ContextOverflowError) return false

  const status = statusOf(error)
  if (status !== undefined) return RETRYABLE_STATUS.has(status)

  // The AI SDK's APICallError carries this verdict itself, and it's more accurate than
  // guessing from strings
  const flag = pick(error, "isRetryable")
  if (typeof flag === "boolean") return flag

  const message = messageOf(error)
  return RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
}

/**
 * Backoff duration. The server has the final say; only if it says nothing do we use
 * exponential backoff starting at 2s.
 *
 * The 30s cap is hard: when the server asks us to wait 10 minutes we still retry after
 * 30s, and after a few tries we hit the 8-attempt limit and throw. For an interactive CLI,
 * making the user watch the terminal sleep for ten minutes is worse than just erroring —
 * with an error they at least know what happened.
 */
export function retryDelay(attempt: number, headers?: HeaderLike): number {
  const asked = headerDelay(headers)
  if (asked !== undefined) return clamp(asked)
  // Jitter is pointless: a single-user CLI has no thundering herd
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
    // Integer seconds
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

/**
 * Context overflow disguised as a plain 400 — recognize it and convert the type, so the
 * main loop can go compact instead of retrying.
 */
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

// ─────────────────────────────────────────────── Digging into errors
//
// Duck typing rather than instanceof APICallError: with two copies of the same SDK
// installed, instanceof silently stops working, and self-built providers don't
// necessarily use the SDK's error classes.

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
    // Providers often stuff the real reason into responseBody
    const body = pick(link, "responseBody")
    if (typeof body === "string") parts.push(body.slice(0, 2000))
  }
  return parts.join(" | ")
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(typeof value === "string" ? value : JSON.stringify(value))
}

// ─────────────────────────────────────────────── Waiting

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
