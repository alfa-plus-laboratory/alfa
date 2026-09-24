/**
 * The retry layer.
 *
 * The last group is **end to end**: it starts a real HTTP server posing as an
 * OpenAI-compatible endpoint and sends requests through the whole chain
 * @ai-sdk/openai-compatible → streamText → normalize → withRetry. Unit tests can prove
 * the decision logic is right; only this can prove that the error shapes the SDK
 * actually throws are recognized by us — that's exactly how the earlier v7 instructions
 * and includeUsage pitfalls surfaced.
 */
import { describe, expect, test } from "bun:test"
import {
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  isRetryable,
  retryDelay,
  sleep,
  streamWithRetry,
  withRetry,
} from "../src/llm/retry.ts"
import { ContextOverflowError, type LLMEvent } from "../src/llm/types.ts"
import { LLMRegistry } from "../src/llm/registry.ts"
import { openAICompatProvider } from "../src/llm/providers/openai-compat.ts"

// ─────────────────────────────────────────────── helpers

function apiError(status: number, message = "boom", headers?: Record<string, string>) {
  const error = new Error(message) as Error & { statusCode: number; responseHeaders?: Record<string, string> }
  error.statusCode = status
  if (headers) error.responseHeaders = headers
  return error
}

async function* fromEvents(...events: LLMEvent[]): AsyncGenerator<LLMEvent> {
  for (const event of events) yield event
}

async function* throwing(error: unknown, ...before: LLMEvent[]): AsyncGenerator<LLMEvent> {
  for (const event of before) yield event
  throw error
}

/** Records each sleep's duration without actually waiting */
function fakeSleep() {
  const calls: number[] = []
  return {
    calls,
    fn: async (ms: number) => {
      calls.push(ms)
    },
  }
}

async function collect(generator: AsyncIterable<LLMEvent>): Promise<LLMEvent[]> {
  const out: LLMEvent[] = []
  for await (const event of generator) out.push(event)
  return out
}

// ─────────────────────────────────────────────── isRetryable

describe("isRetryable", () => {
  test("status code takes precedence over the error message", () => {
    // the message says "timeout" but the status is 400 — bad arguments, retrying won't help
    expect(isRetryable(apiError(400, "request timeout parameter invalid"))).toBe(false)
    expect(isRetryable(apiError(401, "invalid api key"))).toBe(false)
    expect(isRetryable(apiError(403, "forbidden"))).toBe(false)
    expect(isRetryable(apiError(404, "model not found"))).toBe(false)
    expect(isRetryable(apiError(422, "unprocessable"))).toBe(false)
  })

  test("retryable status codes", () => {
    for (const status of [408, 409, 425, 429, 500, 502, 503, 504, 529]) {
      expect(isRetryable(apiError(status))).toBe(true)
    }
  })

  test("the error message is consulted only when there is no status code", () => {
    expect(isRetryable(new Error("fetch failed"))).toBe(true)
    expect(isRetryable(new Error("socket hang up"))).toBe(true)
    expect(isRetryable(new Error("Overloaded"))).toBe(true)
    expect(isRetryable(new Error("rate-limit exceeded"))).toBe(true)
    expect(isRetryable(new Error("Bad Gateway"))).toBe(true)
    expect(isRetryable(new Error("your prompt violates policy"))).toBe(false)
  })

  test("follows the cause chain — fetch wraps the real reason inside", () => {
    const inner = new Error("connect ECONNRESET 1.2.3.4:443")
    const outer = new Error("fetch failed", { cause: inner })
    expect(isRetryable(outer)).toBe(true)

    const wrapped = new Error("call failed", { cause: apiError(429) })
    expect(isRetryable(wrapped)).toBe(true)
  })

  test("a self-referencing cause doesn't loop forever", () => {
    const error = new Error("loop") as Error & { cause?: unknown }
    error.cause = error
    expect(isRetryable(error)).toBe(false)
  })

  test("a reason in responseBody counts too", () => {
    const error = new Error("call failed") as Error & { responseBody: string }
    error.responseBody = JSON.stringify({ error: { message: "The service is overloaded" } })
    expect(isRetryable(error)).toBe(true)
  })

  test("the SDK's own isRetryable flag beats guessing from strings", () => {
    const error = new Error("something opaque") as Error & { isRetryable: boolean }
    error.isRetryable = true
    expect(isRetryable(error)).toBe(true)
    error.isRetryable = false
    expect(isRetryable(error)).toBe(false)
  })

  test("context overflow is never retried", () => {
    expect(isRetryable(new ContextOverflowError("prompt is too long"))).toBe(false)
  })
})

// ─────────────────────────────────────────────── retryDelay

describe("retryDelay", () => {
  test("without headers, exponential backoff from 2s, capped at 30s", () => {
    expect(retryDelay(1)).toBe(BASE_DELAY_MS)
    expect(retryDelay(2)).toBe(4_000)
    expect(retryDelay(3)).toBe(8_000)
    expect(retryDelay(4)).toBe(16_000)
    expect(retryDelay(5)).toBe(MAX_DELAY_MS)
    expect(retryDelay(8)).toBe(MAX_DELAY_MS)
  })

  test("retry-after-ms takes precedence", () => {
    expect(retryDelay(3, { "retry-after-ms": "1500", "retry-after": "60" })).toBe(1500)
  })

  test("retry-after in seconds", () => {
    expect(retryDelay(1, { "Retry-After": "3" })).toBe(3_000)
  })

  test("retry-after HTTP date", () => {
    const at = new Date(Date.now() + 5_000).toUTCString()
    const delay = retryDelay(1, { "retry-after": at })
    expect(delay).toBeGreaterThan(3_000)
    expect(delay).toBeLessThanOrEqual(6_000)
  })

  test("a date in the past counts as 0", () => {
    expect(retryDelay(1, { "retry-after": new Date(Date.now() - 60_000).toUTCString() })).toBe(0)
  })

  test("waits at most 30s even when the server asks for more", () => {
    expect(retryDelay(1, { "retry-after": "600" })).toBe(MAX_DELAY_MS)
  })

  test("Headers objects, case-insensitive", () => {
    expect(retryDelay(1, new Headers({ "Retry-After": "2" }))).toBe(2_000)
  })

  test("garbage headers fall back to exponential backoff", () => {
    expect(retryDelay(2, { "retry-after": "soon" })).toBe(4_000)
    expect(retryDelay(2, { "retry-after": "" })).toBe(4_000)
  })
})

// ─────────────────────────────────────────────── withRetry

describe("withRetry", () => {
  test("failures before landing are retried, invisibly to downstream", async () => {
    const nap = fakeSleep()
    let attempt = 0
    const events = await collect(
      withRetry(
        () => {
          attempt++
          if (attempt < 3) return throwing(apiError(429), { type: "step-start" })
          return fromEvents({ type: "step-start" }, { type: "text-delta", id: "t", text: "ok" })
        },
        { sleep: nap.fn },
      ),
    )
    expect(attempt).toBe(3)
    expect(nap.calls).toEqual([BASE_DELAY_MS, 4_000])
    // step-start appears only once — the ones from the first two attempts were dropped
    expect(events).toEqual([
      { type: "step-start" },
      { type: "text-delta", id: "t", text: "ok" },
    ])
  })

  test("an error event is treated the same as a throw", async () => {
    const nap = fakeSleep()
    let attempt = 0
    const events = await collect(
      withRetry(
        () => {
          attempt++
          if (attempt === 1) {
            return fromEvents({ type: "step-start" }, { type: "error", error: apiError(503) })
          }
          return fromEvents({ type: "text-delta", id: "t", text: "hi" })
        },
        { sleep: nap.fn },
      ),
    )
    expect(attempt).toBe(2)
    expect(events).toEqual([{ type: "text-delta", id: "t", text: "hi" }])
  })

  test("no retry once content has been emitted", async () => {
    const nap = fakeSleep()
    let attempt = 0
    const run = collect(
      withRetry(
        () => {
          attempt++
          return throwing(apiError(429), { type: "text-delta", id: "t", text: "half" })
        },
        { sleep: nap.fn },
      ),
    )
    await expect(run).rejects.toThrow("boom")
    expect(attempt).toBe(1)
    expect(nap.calls).toEqual([])
  })

  test("an error event after landing passes through instead of retrying", async () => {
    const nap = fakeSleep()
    let attempt = 0
    const events = await collect(
      withRetry(
        () => {
          attempt++
          return fromEvents(
            { type: "text-delta", id: "t", text: "half" },
            { type: "error", error: apiError(500) },
          )
        },
        { sleep: nap.fn },
      ),
    )
    expect(attempt).toBe(1)
    expect(events).toHaveLength(2)
    expect(events[1]!.type).toBe("error")
  })

  test("non-retryable errors throw immediately", async () => {
    const nap = fakeSleep()
    let attempt = 0
    const run = collect(
      withRetry(
        () => {
          attempt++
          return throwing(apiError(401, "invalid api key"))
        },
        { sleep: nap.fn },
      ),
    )
    await expect(run).rejects.toThrow("invalid api key")
    expect(attempt).toBe(1)
  })

  test("throws at the attempt limit instead of retrying forever", async () => {
    const nap = fakeSleep()
    let attempt = 0
    const info: number[] = []
    const run = collect(
      withRetry(
        () => {
          attempt++
          return throwing(apiError(500))
        },
        { sleep: nap.fn, onRetry: (i) => info.push(i.attempt) },
      ),
    )
    await expect(run).rejects.toThrow("boom")
    expect(attempt).toBe(8)
    expect(nap.calls).toHaveLength(7)
    expect(info).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  test("maxAttempts is configurable", async () => {
    const nap = fakeSleep()
    let attempt = 0
    const run = collect(
      withRetry(() => { attempt++; return throwing(apiError(503)) }, { sleep: nap.fn, maxAttempts: 2 }),
    )
    await expect(run).rejects.toThrow("boom")
    expect(attempt).toBe(2)
  })

  test("context overflow is converted and not retried", async () => {
    const nap = fakeSleep()
    let attempt = 0
    const run = collect(
      withRetry(
        () => {
          attempt++
          return throwing(apiError(400, "prompt is too long: 250000 tokens > 200000 maximum"))
        },
        { sleep: nap.fn },
      ),
    )
    await expect(run).rejects.toBeInstanceOf(ContextOverflowError)
    expect(attempt).toBe(1)
  })

  test("a 500 whose message is a context overflow — conversion wins over retry", async () => {
    const nap = fakeSleep()
    let attempt = 0
    const run = collect(
      withRetry(
        () => { attempt++; return throwing(apiError(500, "maximum context length exceeded")) },
        { sleep: nap.fn },
      ),
    )
    await expect(run).rejects.toBeInstanceOf(ContextOverflowError)
    expect(attempt).toBe(1)
  })

  test("abort is not retried", async () => {
    const controller = new AbortController()
    const nap = fakeSleep()
    let attempt = 0
    const run = collect(
      withRetry(
        () => {
          attempt++
          controller.abort()
          return throwing(apiError(429))
        },
        { sleep: nap.fn, signal: controller.signal },
      ),
    )
    await expect(run).rejects.toThrow()
    expect(attempt).toBe(1)
    expect(nap.calls).toEqual([])
  })

  test("an abort during the wait wakes immediately instead of sleeping it out", async () => {
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 30)
    await expect(sleep(5_000, controller.signal)).rejects.toThrow(/abort/i)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("an empty response still releases the held-back events", async () => {
    const events = await collect(withRetry(() => fromEvents({ type: "step-start" })))
    expect(events).toEqual([{ type: "step-start" }])
  })

  test("step-start after landing passes straight through, unbuffered", async () => {
    const events = await collect(
      withRetry(() =>
        fromEvents(
          { type: "step-start" },
          { type: "text-delta", id: "t", text: "a" },
          { type: "step-start" },
          { type: "text-delta", id: "t", text: "b" },
        ),
      ),
    )
    expect(events.map((e) => e.type)).toEqual(["step-start", "text-delta", "step-start", "text-delta"])
  })
})

// ─────────────────────────────────────────────── end to end

describe("end to end: real HTTP + real SDK", () => {
  /** Poses as an OpenAI-compatible endpoint. plan decides what each request returns. */
  function serve(plan: Array<{ status: number; headers?: Record<string, string> }>) {
    let hit = 0
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        await request.text()
        const step = plan[Math.min(hit, plan.length - 1)]!
        hit++
        if (step.status !== 200) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: step.status,
            headers: { "content-type": "application/json", ...step.headers },
          })
        }
        const chunk = (delta: object, extra: object = {}) =>
          `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "fake",
            choices: [{ index: 0, delta, finish_reason: null }],
            ...extra,
          })}\n\n`
        const done =
          `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "fake",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
          })}\n\n` + "data: [DONE]\n\n"
        return new Response(chunk({ role: "assistant", content: "he" }) + chunk({ content: "llo" }) + done, {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    return { server, hits: () => hit }
  }

  function registryFor(url: string) {
    return new LLMRegistry().register(
      openAICompatProvider({ id: "fake", apiKey: "test-key", baseURL: url }),
    )
  }

  function request(signal: AbortSignal) {
    return {
      model: { providerID: "fake", modelID: "fake-model" },
      system: ["You are a test."],
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
      tools: [],
      makeToolContext: () => {
        throw new Error("no tools in this test")
      },
      abortSignal: signal,
    }
  }

  test("succeeds after 429 + Retry-After: 1, taking >1s total", async () => {
    const { server, hits } = serve([{ status: 429, headers: { "retry-after": "1" } }, { status: 200 }])
    try {
      const controller = new AbortController()
      const retries: number[] = []
      const started = Date.now()
      const handle = streamWithRetry(registryFor(server.url.href), request(controller.signal), {
        onRetry: (info) => retries.push(info.delayMs),
      })
      const events = await collect(handle.events)
      const elapsed = Date.now() - started

      expect(hits()).toBe(2)
      expect(retries).toEqual([1_000]) // honored the server's header, not the 2s backoff
      expect(elapsed).toBeGreaterThanOrEqual(1_000)

      const text = events
        .filter((e): e is Extract<LLMEvent, { type: "text-delta" }> => e.type === "text-delta")
        .map((e) => e.text)
        .join("")
      expect(text).toBe("hello")

      // no duplicated step-start
      expect(events.filter((e) => e.type === "step-start")).toHaveLength(1)

      const finish = events.find((e) => e.type === "step-finish")
      expect(finish).toBeDefined()
      expect((finish as Extract<LLMEvent, { type: "step-finish" }>).tokens.input).toBe(11)
    } finally {
      await server.stop(true)
    }
  }, 15_000)

  test("a persistent 500 throws instead of retrying forever", async () => {
    const { server, hits } = serve([{ status: 500 }])
    try {
      const controller = new AbortController()
      const handle = streamWithRetry(registryFor(server.url.href), request(controller.signal), {
        maxAttempts: 3,
        sleep: async () => {},
      })
      await expect(collect(handle.events)).rejects.toThrow()
      expect(hits()).toBe(3)
    } finally {
      await server.stop(true)
    }
  }, 15_000)

  test("401 gives up after one attempt", async () => {
    const { server, hits } = serve([{ status: 401 }])
    try {
      const controller = new AbortController()
      const handle = streamWithRetry(registryFor(server.url.href), request(controller.signal), {
        sleep: async () => {},
      })
      await expect(collect(handle.events)).rejects.toThrow()
      expect(hits()).toBe(1)
    } finally {
      await server.stop(true)
    }
  }, 15_000)
})
