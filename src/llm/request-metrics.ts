/**
 * Cache fingerprints belong at the final fetch boundary: pre-SDK tool/message objects do
 * not describe the transmitted request. AsyncLocalStorage binds concurrent SDK fetches to
 * their own measurement. The CLI enables collection for its bounded debugger ledger;
 * library callers without an observer avoid parsing or hashing requests.
 * ★ Capture is observational: the original fetch arguments are forwarded unchanged, raw
 * prompt/body/headers live only during hashing, and no capture failure may block inference.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { InvocationCache, type CacheDiagnostic, type CacheSegment, type CacheTicket, type CacheUsage } from "./cache/index.ts"
import { protocolCacheUsage, object, requestEffort, type RequestEffort, type CacheProtocol } from "./cache/protocols.ts"

interface RequestMetrics { collector: InvocationCache; ticket?: CacheTicket; protocol?: CacheProtocol; effort?: RequestEffort; rawUsage?: Record<string, unknown>; breakpoints?: number[] }
const collectors: InvocationCache[] = []
const requestMetrics = new AsyncLocalStorage<RequestMetrics>()

export function enableCacheMetrics(): () => void {
  const collector = new InvocationCache()
  collectors.push(collector)
  return () => { const index = collectors.indexOf(collector); if (index >= 0) collectors.splice(index, 1) }
}
export function createRequestMetrics(): RequestMetrics | undefined {
  const collector = collectors.at(-1)
  return collector ? { collector } : undefined
}
export function withRequestMetrics<T>(context: RequestMetrics | undefined, run: () => T): T {
  return context ? requestMetrics.run(context, run) : run()
}
export function finishRequestMetrics(context: RequestMetrics | undefined, rawUsage: unknown, sdkUsage?: CacheUsage): CacheDiagnostic | undefined {
  if (!context?.ticket || !context.protocol) return undefined
  const raw = object(context.rawUsage ?? rawUsage)
  const usage = protocolCacheUsage(context.protocol, raw)
  const rawActual = { ...usage }
  let inputTokenSource: "raw" | "sdk-normalized" = "raw"
  // Some compatible Anthropic endpoints omit cache creation entirely. The SDK has a
  // usable normalized total, but its zero default is not an observed write counter.
  // Only accept that total when measured input/read agree with the SDK accounting;
  // missing input, iterations and contradictory totals must remain unknown.
  if (context.protocol === "anthropic" && usage.totalInputTokens === null &&
      usage.cacheReadTokens !== null && usage.cacheWriteTokens === null &&
      raw?.cache_creation_input_tokens == null &&
      typeof raw?.input_tokens === "number" && Number.isSafeInteger(raw.input_tokens) && raw.input_tokens >= 0 &&
      !(Array.isArray(raw.iterations) && raw.iterations.length) &&
      sdkUsage?.cacheReadTokens === usage.cacheReadTokens && sdkUsage.cacheWriteTokens === 0 &&
      sdkUsage.totalInputTokens === raw.input_tokens + usage.cacheReadTokens) {
    usage.totalInputTokens = sdkUsage.totalInputTokens
    inputTokenSource = "sdk-normalized"
  }
  const result = context.ticket.finish(usage)
  return { ...result, protocol: context.protocol, breakpoints: context.breakpoints ?? [], inputTokenSource, rawActual,
    reasonCodes: [...result.reasonCodes, ...(inputTokenSource === "sdk-normalized" ? ["sdk_normalized_input_missing_cache_write"] : [])] }
}

/** Keep numeric usage only; SDK schemas may discard nested cache-write fields.
 * Anthropic deltas are partial updates: null means no new observation and must not
 * erase a counter from message_start. Explicit zero is still a measured update. */
export function captureCacheUsage(context: RequestMetrics | undefined, raw: unknown): void {
  if (!context?.protocol) return
  const event = object(raw)
  const usage = object(context.protocol === "anthropic" && event?.type === "message_start" ? object(event.message)?.usage : context.protocol === "openai-responses" ? object(event?.response)?.usage : event?.usage)
  if (!usage) return
  const saved = context.rawUsage ??= {}
  for (const key of ["input_tokens", "prompt_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "prompt_cache_hit_tokens"]) {
    if (typeof usage[key] === "number") saved[key] = usage[key]
  }
  for (const key of ["input_tokens_details", "prompt_tokens_details"]) {
    const details = object(usage[key])
    if (!details) continue
    const selected = object(saved[key]) ?? {}
    for (const field of ["cached_tokens", "cache_write_tokens"]) if (typeof details[field] === "number") selected[field] = details[field]
    saved[key] = selected
  }
  if (Array.isArray(usage.iterations) && usage.iterations.length) saved.iterations = [true]
}

export function captureOpenAIRequest(provider: string, input: string | Request | URL, init?: RequestInit): void {
  captureProviderRequest("openai-responses", provider, input, init)
}

export function captureProviderRequest(protocol: CacheProtocol, provider: string, input: string | Request | URL, init?: RequestInit): void {
  const context = requestMetrics.getStore()
  if (!context || context.ticket || typeof init?.body !== "string") return
  try {
    const body = object(JSON.parse(init.body))
    if (!body || typeof body.model !== "string") return
    const segments: CacheSegment[] = []
    const breakpoints: number[] = []
    const cacheControls = new Set<string>()
    const add = (kind: CacheSegment["kind"], value: unknown) => {
      if (value === undefined) return
      const block = object(value)
      if (protocol === "anthropic" && block?.cache_control !== undefined) {
        // Breakpoints migrate as history grows. Their position is not prompt content;
        // preserve the control policy in scope, and the measured boundary separately.
        const { cache_control, ...content } = block
        cacheControls.add(JSON.stringify(cache_control))
        segments.push({ kind, value: JSON.stringify(content) })
        breakpoints.push(segments.length - 1)
      } else segments.push({ kind, value: JSON.stringify(value) })
    }
    if (protocol === "anthropic") {
      if (Array.isArray(body.tools)) for (const tool of body.tools) add("tools", tool)
      else add("tools", body.tools)
      if (Array.isArray(body.system)) for (const block of body.system) add("other", block)
      else add("other", body.system)
      if (Array.isArray(body.messages)) for (const message of body.messages) {
        const item = object(message)
        if (item && Array.isArray(item.content)) {
          const { content, ...envelope } = item
          add("history", envelope)
          for (const block of content as unknown[]) add("history", block)
        } else add("history", message)
      }
    } else {
      add("tools", body.tools)
      if (protocol === "openai-responses") add("other", body.instructions)
      const messages = protocol === "openai-chat" ? body.messages : body.input
      if (Array.isArray(messages)) for (const item of messages) add("history", item)
      else add("history", messages)
    }
    const options = { ...body }
    for (const key of protocol === "anthropic" ? ["tools", "system", "messages"] : protocol === "openai-chat" ? ["tools", "messages"] : ["tools", "instructions", "input"]) delete options[key]
    const endpoint = input instanceof Request ? input.url : String(input)
    // Scope isolation includes authentication and routing without retaining their values.
    const headers = Array.from(new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)).entries()).sort(([a], [b]) => a.localeCompare(b))
    context.effort = requestEffort(protocol, body)
    context.protocol = protocol
    context.breakpoints = breakpoints
    context.ticket = context.collector.begin({
      scope: { provider, model: body.model, endpoint, isolationKey: JSON.stringify(headers), options: { protocol, body: options, ...(protocol === "anthropic" ? { cacheControls: [...cacheControls].sort() } : {}) } }, segments,
      ceilingBasis: protocol === "anthropic" ? "cache-prefix" : "input",
      ...(protocol === "anthropic" && breakpoints.length ? { cachePrefixSegments: breakpoints[breakpoints.length - 1]! + 1 } : {}),
    })
  } catch {
    // JSON/framing changes disable this observation, never the user's request.
  }
}
