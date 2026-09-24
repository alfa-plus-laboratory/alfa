/**
 * Ask the endpoint: which models do you have?
 *
 * ── Why this is worth doing at all ──
 * A config with only a baseURL and one model name is **half a config**: tab in `/model`
 * offers no candidates, and the user has to dig through docs and copy model names by hand.
 * Yet nearly every endpoint provides this — official Anthropic, official OpenAI and all
 * sorts of compatible gateways implement `GET /models`, and one request gets the lot.
 * Making the user hand-copy a list a machine can fetch in two seconds is passing our
 * laziness off as their homework.
 *
 * ── Names only, not windows ──
 * `/models` responses have **no common name for a context-length field**: the two official
 * APIs don't return one at all, and compatible endpoints call it context_length, or
 * max_model_len, or return nothing. Cobbling a number together from a pile of guessed field
 * names is more dangerous than leaving it blank — the window decides when to compact, and
 * an overestimate shows up as the provider suddenly rejecting requests mid-conversation,
 * which the user will take to mean this program is broken.
 *
 * So the window has three sources, and none of them is a guess: the built-in table (real
 * Anthropic), what the user wrote in config, and what onboarding asks them directly. See
 * ProviderConfig.models in config.ts.
 *
 * ── Any failure counts as "couldn't ask" ──
 * This is a nice-to-have. The endpoint has no /models, returns an HTML login page, the
 * network is down — none of these should make "configure a provider" fail.
 */
import type { ProviderType } from "../config/config.ts"

const TIMEOUT_MS = 10_000
/**
 * How many to keep at most. OpenAI's official list alone has dozens of entries, and a
 * candidate list you can't scroll to the end of is about as good as none — anyone who
 * really needs more can edit config by hand.
 */
const MAX_MODELS = 40

/**
 * Obviously not meant for chat.
 *
 * ★ This is **a guess by name**, so it only cuts a few families that are recognizable at a
 *   glance, and does not do a "keep only gpt-*" style allowlist — an allowlist would shut
 *   out every model released tomorrow, which is exactly the one the user most wants to
 *   switch to. How many were cut must be reported (see DiscoverResult.dropped): a list
 *   that is quietly missing a few rows is harder to debug than a noisy one.
 */
const NOT_CHAT = /embed|whisper|\btts\b|audio|dall-?e|moderation|rerank|speech|image|video|ocr/i

export interface DiscoverResult {
  /** Model names reported by the endpoint, already filtered and truncated */
  models: string[]
  /** How many were ruled out by name (embeddings, speech and the like) */
  dropped: number
  /** How many were cut off by hitting the cap */
  truncated: number
}

export interface DiscoverInput {
  type: ProviderType
  apiKey: string
  keyHeader?: string
  /** Omitted means that provider's official endpoint */
  baseURL?: string
  timeoutMs?: number
}

/** undefined when we couldn't ask — the caller then writes nothing, not an empty list */
export async function discoverModels(input: DiscoverInput): Promise<DiscoverResult | undefined> {
  const base = (input.baseURL ?? defaultBase(input.type)).replace(/\/+$/, "")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? TIMEOUT_MS)
  try {
    const response = await fetch(`${base}/models`, {
      redirect: "error",
      headers: input.keyHeader && input.apiKey ? { [input.keyHeader]: input.keyHeader.toLowerCase() === "authorization" ? `Bearer ${input.apiKey}` : input.apiKey } : !input.apiKey ? {} :
        input.type === "anthropic"
          ? { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" }
          : { authorization: `Bearer ${input.apiKey}` },
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as { data?: unknown }
    if (!Array.isArray(body.data)) return undefined

    const all: string[] = []
    for (const entry of body.data) {
      const id = (entry as { id?: unknown })?.id
      if (typeof id === "string" && id.length > 0) all.push(id)
    }
    if (all.length === 0) return undefined

    const chat = all.filter((id) => !NOT_CHAT.test(id))
    const kept = chat.slice(0, MAX_MODELS)
    return { models: kept, dropped: all.length - chat.length, truncated: chat.length - kept.length }
  } catch {
    // Timeout, DNS, certificate, a non-JSON response — all "couldn't ask", not errors
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

function defaultBase(type: ProviderType): string {
  return type === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"
}
