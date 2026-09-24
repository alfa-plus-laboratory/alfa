/**
 * Anthropic and Anthropic-compatible endpoints.
 *
 * baseURL is overridable — besides the official API, plenty of gateways also offer an
 * /anthropic-compatible endpoint. That lets the same code run two provider paths against
 * the same backend for comparison, which is the only way to verify that "event
 * normalization really did smooth out the differences".
 * Protocol compatibility is not model identity: third-party non-Claude models keep the
 * generic prompt even when their transport is Anthropic-compatible.
 */
import { captureProviderRequest } from "../request-metrics.ts"
import { createAnthropic } from "@ai-sdk/anthropic"
import type { Provider, ResolvedModel } from "../registry.ts"
import { clampEffort, DEFAULT_CONTEXT_LIMIT, REASONING_EFFORTS, type ReasoningEffort } from "../types.ts"

/**
 * Known models use the table below; unknown ones fall back to the shared default (see
 * DEFAULT_CONTEXT_LIMIT).
 */
const DEFAULT_OUTPUT = 32_000

/** Budget table for known models. A miss falls back to the defaults and doesn't block. */
const LIMITS: Record<string, { context: number; output: number }> = {
  "claude-fable-5-1": { context: 1_000_000, output: 128_000 },
  "claude-fable-5": { context: 1_000_000, output: 128_000 },
  "claude-opus-5-5": { context: 1_000_000, output: 128_000 },
  "claude-opus-5": { context: 1_000_000, output: 128_000 },
  "claude-opus-4-8": { context: 1_000_000, output: 128_000 },
  "claude-opus-4-7": { context: 1_000_000, output: 128_000 },
  "claude-opus-4-6": { context: 1_000_000, output: 128_000 },
  "claude-sonnet-5": { context: 1_000_000, output: 128_000 },
  "claude-sonnet-4-6": { context: 1_000_000, output: 128_000 },
  "claude-opus-4-5": { context: 200_000, output: 64_000 },
  "claude-opus-4-1": { context: 200_000, output: 32_000 },
  "claude-sonnet-4-5": { context: 200_000, output: 64_000 },
  "claude-haiku-4-5": { context: 200_000, output: 64_000 },
}

/**
 * Request shape is tiered by generation — **this is not tuning, it's whether the request
 * can be sent at all**.
 *
 * With the 4.7 generation Anthropic **removed** two parameters, not deprecated them:
 *   · `temperature` / `top_p` / `top_k`
 *   · `thinking.budgetTokens` (the very idea of a fixed thinking budget was replaced by
 *     adaptive)
 * Sending them anyway is a 400, and the error won't tell you which field is the extra one.
 * Effort and the "thinking can't be off" generation added two more such rules; all of
 * them live in GENERATIONS below.
 *
 * ★ Only the **official endpoint** is tiered. Any other baseURL means someone else's
 *   Anthropic-compatible endpoint, and only it knows which set it accepts — send the old
 *   way, because that is the combination running today.
 *
 * ⚠ "Official" is decided by host, not by whether a baseURL is set. The provider template
 *   writes `https://api.anthropic.com/v1` into config, and some environments export
 *   `ANTHROPIC_BASE_URL=https://api.anthropic.com`; treating either as a third party sent
 *   temperature to the current generation — a 400 on every request, with no hint why.
 */
export function isOfficialAnthropic(baseURL: string | undefined): boolean {
  if (baseURL === undefined) return true
  try {
    return new URL(baseURL).hostname === "api.anthropic.com"
  } catch {
    return false
  }
}

/**
 * What each generation accepts — thinking switch, sampling, effort levels. Official
 * endpoint only (see isOfficialAnthropic).
 *
 * ── Why one table instead of the two name sets it replaced ──
 * The old MODERN / ADAPTIVE_OK split answered one question ("adaptive or budget, and is
 * temperature allowed"), and effort adds a third axis that doesn't line up with it: 4.6
 * is adaptive but has no xhigh, Opus 5 is modern but caps effort when thinking is off.
 * Two more parallel sets would be three places to update per model launch.
 *
 * thinking:
 *   "always"   — thinking can't be turned off; **any** `disabled` is a 400, at every
 *                effort level. Off = omit the field (it then runs adaptive anyway).
 *                MODERN used to hold fable-5 / mythos-5 and sent them `disabled` —
 *                every thinking-off request to those models was a 400.
 *   "adaptive" — adaptive on, `disabled` off.
 *   "budget"   — `enabled` + budgetTokens on, omitted off.
 * effort: the levels `output_config.effort` accepts. Empty = the field itself is a 400
 *   (Haiku 4.5, Sonnet 4.5, Opus 4.1), so it is never sent there.
 * disabledCapsEffort: Opus 5 accepts `disabled` only at effort high or below —
 *   `disabled` + xhigh/max is a 400. This is the combination that kept effort out of
 *   this file entirely until it had a rule of its own.
 */
interface Generation {
  thinking: "always" | "adaptive" | "budget"
  temperature: boolean
  effort: readonly ReasoningEffort[]
  disabledCapsEffort?: boolean
}

const ALL_EFFORTS = REASONING_EFFORTS
/** xhigh arrived with Opus 4.7 */
const NO_XHIGH: readonly ReasoningEffort[] = ["low", "medium", "high", "max"]

const ALWAYS: Generation = { thinking: "always", temperature: false, effort: ALL_EFFORTS }
const MODERN: Generation = { thinking: "adaptive", temperature: false, effort: ALL_EFFORTS }

const GENERATIONS: Record<string, Generation> = {
  "claude-fable-5-1": ALWAYS,
  "claude-fable-5": ALWAYS,
  "claude-mythos-5-1": ALWAYS,
  "claude-mythos-5": ALWAYS,
  "claude-opus-5-5": ALWAYS,
  "claude-opus-5": { ...MODERN, disabledCapsEffort: true },
  "claude-opus-4-8": MODERN,
  "claude-opus-4-7": MODERN,
  "claude-sonnet-5": MODERN,
  // Accept adaptive (and it's officially recommended), but still take temperature
  "claude-opus-4-6": { thinking: "adaptive", temperature: true, effort: NO_XHIGH },
  "claude-sonnet-4-6": { thinking: "adaptive", temperature: true, effort: NO_XHIGH },
  "claude-opus-4-5": { thinking: "budget", temperature: true, effort: ["low", "medium", "high"] },
}

/**
 * Unknown names and every third-party endpoint: the request shape running before this
 * table existed. effort passes through as asked — only the endpoint knows what it takes,
 * and the user set it explicitly.
 */
const LEGACY: Generation = { thinking: "budget", temperature: true, effort: ALL_EFFORTS }
/** Known old models where the effort field itself is rejected */
const NO_EFFORT = new Set(["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-1"])

/**
 * Dated snapshots (`claude-haiku-4-5-20251001`) share their family's rules. Without this
 * a dated Haiku falls through to LEGACY and gets sent the effort field it 400s on.
 */
function family(modelID: string): string {
  return modelID.replace(/-\d{8}$/, "")
}

export function anthropicGeneration(modelID: string, official: boolean): Generation {
  if (!official) return LEGACY
  const name = family(modelID)
  const known = GENERATIONS[name]
  if (known) return known
  return NO_EFFORT.has(name) ? { ...LEGACY, effort: [] } : LEGACY
}

export function anthropicProvider(
  options: {
    apiKey?: string
    baseURL?: string
    noKey?: boolean
  keyHeader?: string
  id?: string
    /** Candidate models + their windows. See ProviderConfig.models in config.ts */
    models?: Record<string, { disabled?: boolean; images?: boolean; limit?: { context: number; output: number } }>
    /** This provider's default window. Used only for models that don't set their own */
    limit?: { context: number; output: number }
    /** See ModelConfig.images in config.ts. Default yes */
    images?: boolean
  } = {},
): Provider {
  const id = options.id ?? "anthropic"
  const apiKey = options.apiKey ?? (options.id ? undefined : process.env["ANTHROPIC_API_KEY"])
  // With an id we were assembled by setup.ts, which already read the environment through
  // its injectable `env`; see openai-compat.ts
  const baseURL = options.baseURL ?? (options.id ? undefined : process.env["ANTHROPIC_BASE_URL"])
  const official = isOfficialAnthropic(baseURL)

  return {
    id,
    label: "Anthropic",
    missingCredentials() {
      if (apiKey || options.noKey) return undefined
      return "set ANTHROPIC_API_KEY, or configure a provider with an explicit key"
    },
    /**
     * ★ That table describes **real Anthropic**, so it only serves as the candidate list
     *   when talking to the official endpoint.
     *
     * Any other baseURL means this is someone else's Anthropic-compatible endpoint (a company
     * gateway, a local proxy, a third-party relay). Listing claude-opus-4-1 as "models
     * usable on this machine" is inventing facts out of thin air: those names most likely
     * don't exist over there at all, yet the list looks like a menu to pick from — the
     * user picks one and gets a provider error nobody can make sense of.
     *
     * Which models exist over there, only the config can say: providers.<id>.models.
     */
    models: () => (options.models ? Object.entries(options.models).filter(([, m]) => !m.disabled).map(([id]) => id) : official ? Object.keys(LIMITS) : []),
    resolve(modelID, { thinking, effort }): ResolvedModel {
      if (options.models?.[modelID]?.disabled) throw new Error(`Model disabled: ${modelID}`)
      const client = createAnthropic({
        fetch: Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          captureProviderRequest("anthropic", id, input, init)
          return globalThis.fetch(input, init)
        }, { preconnect: globalThis.fetch.preconnect }), apiKey: options.noKey || options.keyHeader ? "" : apiKey!,
        ...(options.keyHeader && apiKey ? { headers: { [options.keyHeader]: options.keyHeader.toLowerCase() === "authorization" ? `Bearer ${apiKey}` : apiKey } } : {}), ...(baseURL ? { baseURL } : {}) })

      /**
       * The window is taken in this order: **this model's own setting > this provider's >
       * the built-in table > the fallback**.
       *
       * Config ranking above the table is a hard requirement — the table describes real
       * Anthropic, and a third-party compatible endpoint that remaps the model field may
       * well give you a different window. A number the user wrote down explicitly is
       * always closer to the truth than one we looked up.
       *
       * ★ At one point this **didn't look at options.limit at all**: assembly never passed
       *   it to this provider (only to openai-chat). The symptom was "I wrote limit in
       *   config and nothing happened", with no error — a program that quietly ignores the
       *   user's config is far worse than one that errors.
       */
      const declared = options.models?.[modelID]?.limit ?? options.limit
      const known = LIMITS[modelID]
      const limit = declared ?? known ?? { context: DEFAULT_CONTEXT_LIMIT, output: DEFAULT_OUTPUT }

      // See the note above GENERATIONS: only against the official endpoint do we dare
      // trim parameters by generation
      const generation = anthropicGeneration(modelID, official)

      /**
       * ★ With thinking off we must still send disabled **explicitly**, not omit it — from
       *   Claude Opus 5 on, thinking is on by default, so omitting means on. On older
       *   models omitting means off; the two are opposite. The "always" generation is the
       *   exception that can't be expressed at all: there `disabled` is a 400, so off can
       *   only mean "don't ask for it" (lower the effort instead).
       */
      const thinkingOption =
        generation.thinking === "always"
          ? thinking
            ? ({ type: "adaptive" } as const)
            : undefined
          : generation.thinking === "adaptive"
            ? thinking
              ? ({ type: "adaptive" } as const)
              : ({ type: "disabled" } as const)
            : thinking
              ? ({ type: "enabled", budgetTokens: Math.min(16_000, Math.floor(limit.output / 2)) } as const)
              : undefined

      /**
       * effort goes in only when the user set one — unset means the provider default,
       * which differs by model (medium on Opus 5.5, high elsewhere).
       *
       * ★ The Opus 5 cap must be applied here rather than left to the SDK. @ai-sdk/anthropic
       *   does lower `disabled` + xhigh to high on its own, but only for the model ids its
       *   own table knows, and only with a warning into the log; a model this file knows
       *   and the SDK version doesn't would get the 400.
       */
      let effortOption = effort ? clampEffort(effort, generation.effort) : undefined
      if (effortOption && generation.disabledCapsEffort && thinkingOption?.type === "disabled") {
        effortOption = clampEffort(effortOption, ["low", "medium", "high"])
      }
      const anthropicOptions = {
        ...(thinkingOption ? { thinking: thinkingOption } : {}),
        ...(effortOption ? { effort: effortOption } : {}),
      }

      return {
        model: client(modelID),
        // Thinking within one tool loop must be sent back verbatim, and sending it back
        // requires the signature. The entries without one (stream cut off midway; the
        // signature rides on reasoning-end) can only be dropped — sending them back is a
        // 400, and stripping the signature and sending them back is **also** a 400
        replayReasoning: "signed",
        info: {
          ref: { providerID: id, modelID },
          limit,
          // Order must match the order limit is taken in above. `/context` relies on this
          // field to tell the truth: a gauge that draws a guessed window as a progress bar
          // is likelier to lead someone to a wrong decision than no gauge at all
          limitSource: declared ? "config" : known ? "model" : "default",
          supportsThinking: true,
          promptTemplate: official || /^claude-/i.test(modelID) ? "anthropic" : "default",
          // ★ This field describes the convention **as it reaches us**, not the raw
          //   Anthropic API's.
          //
          //   The raw API does report input_tokens and cache_read_input_tokens
          //   separately, and going by that this would be false — which is what it once
          //   was. But @ai-sdk/anthropic's convertAnthropicUsage has already added them
          //   up once:
          //       inputTokens.total = input_tokens + cache_creation + cache_read
          //   and ai core takes exactly .total. So by the time it reaches stream.ts it
          //   **already includes cache**; treating it as "excluding" and adding it a
          //   second time doubles context usage outright.
          //
          //   Doubling isn't just ugly on screen: contextTokens() is what triggers
          //   auto-compaction, and the higher the hit rate, the closer the computed
          //   number gets to twice the real one, so compaction fires at half the real
          //   usage. In real runs (MiniMax's /anthropic endpoint, 99% hit rate):
          //   real 11,425 → computed as 22,665.
          cacheInInput: true,
          images: options.models?.[modelID]?.images ?? options.images ?? true,
        },
        ...(Object.keys(anthropicOptions).length > 0 ? { providerOptions: { anthropic: anthropicOptions } } : {}),
        // Models with thinking on don't accept temperature; not sending it is safer than
        // sending 0. The current generation **never** accepts it (see GENERATIONS): not
        // even with thinking off
        temperature: !generation.temperature || thinking ? undefined : 0,
      }
    },
  }
}
