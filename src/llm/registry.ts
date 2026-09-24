/**
 * ★ The provider registry.
 *
 * Adding a new provider = create src/llm/providers/<x>.ts + register it here in one line.
 * Zero changes to src/agent. Hooking up our own billing gateway / memory-enhanced models
 * in the future goes down exactly this path.
 *
 * This file may import SDK types (it lives inside src/llm), but src/llm/types.ts may not —
 * that one is the boundary src/agent sees.
 */
import type { LanguageModel } from "ai"
import type { ModelInfo, ModelRef, ReasoningEffort } from "./types.ts"
import { NoCredentialsError, UnknownModelError } from "./types.ts"

/**
 * How thinking blocks from history are replayed.
 *
 * There is **no cross-provider standard** for this, so it can only be decided per provider:
 *
 *   "signed" — replay only the signed ones. The Anthropic way: an unsigned thinking block
 *              is something it simply can't accept (the SDK drops the whole block and
 *              emits a warning).
 *   "text"   — replay the plain text verbatim. OpenAI Chat Completions-compatible
 *              endpoints serialize it as `reasoning_content` (see the assistant branch
 *              in @ai-sdk/openai-compatible).
 *   "none"   — replay nothing. For Responses (can't be replayed without item metadata),
 *              and for the compatible endpoints that 400 outright on `reasoning_content`.
 *
 * ⚠ Whichever level, **only thinking from the current tool loop** ever reaches here —
 *   anything older is already cut off at the agent layer (see loopStartIndex in
 *   agent/to-model-messages.ts).
 */
export type ReasoningReplay = "signed" | "text" | "none"

export interface ResolvedModel {
  model: LanguageModel
  info: ModelInfo
  /** See ReasoningReplay. Defaults to "signed" — the most conservative level */
  replayReasoning?: ReasoningReplay
  /** Only Responses adapters may replay assistant item identity and phase. */
  replayResponses?: boolean
  /**
   * Send only one system message (merge the two parts).
   *
   * ── Why this switch exists ──
   * Normally there are **two**, and the split serves exactly one thing: Anthropic's
   * explicit cache breakpoints — the longest static prefix has to be its own message,
   * otherwise the whole prefix is invalidated every time the date changes (see
   * prompt/system.ts). The breakpoints themselves live in the `{ anthropic: … }`
   * namespace, and on an OpenAI-compatible endpoint they're dead data.
   *
   * ★ In other words, on that path splitting in two **buys nothing**, while the cost is
   *   real: local inference servers run the model's own Jinja chat template, and the
   *   vast majority of those templates allow only one system message, which must come
   *   first (the official Llama / Mistral / Qwen / Gemma templates all have this gate).
   *   The moment a second one arrives it's
   *   `raise_exception('System message must be at the beginning.')` — a 500, and the
   *   error says not one word about "you sent two".
   *
   * OpenAI's wire format itself allows several, so nobody got anything wrong here; the
   * two sides' contracts just aren't equally wide. We are the ones who yield: that side
   * gains nothing, and the user can't change a template the model's authors wrote.
   */
  singleSystem?: boolean
  /**
   * providerOptions passed to streamText (thinking budget, cache control, etc.).
   * Values must be JSON-serializable — the SDK puts them straight into the request body,
   * and unknown won't pass the type check.
   */
  providerOptions?: Record<string, Record<string, any>>
  /** Some models (reasoning models) reject temperature; undefined means don't send it */
  temperature?: number
}

/**
 * Per-request knobs the provider turns into its own wire fields. Both are **requests**,
 * not guarantees: each adapter drops or rounds what its endpoint would reject (see the
 * providers/*.ts headers), because a 400 on every turn is worse than a quieter setting.
 */
export interface ResolveOptions {
  thinking?: boolean
  effort?: ReasoningEffort
}

export interface Provider {
  id: string
  /** Human-readable name, used in error messages */
  label: string
  /** Returns a hint text when credentials are missing; undefined when usable */
  missingCredentials(): string | undefined
  resolve(modelID: string, options: ResolveOptions): ResolvedModel
  /**
   * Which ones to list when tab is pressed in `/model`. **Not** "only these can be used" —
   * any provider/model can still be switched to; this just saves typing a long string
   * every time.
   *
   * Empty is perfectly normal: there's no way to ask which model names an
   * OpenAI-compatible endpoint accepts, and guessed candidates are worse than none — they
   * look selectable (see ProviderConfig.models in config.ts).
   */
  models?(): string[]
}

export class LLMRegistry {
  private providers = new Map<string, Provider>()

  register(provider: Provider): this {
    this.providers.set(provider.id, provider)
    return this
  }

  ids(): string[] {
    return [...this.providers.keys()].toSorted()
  }

  /**
   * The `/model` candidate list, shaped like ["anthropic/claude-opus-4-1", …].
   *
   * ★ Only lists providers **we hold credentials for**. Listing a model that is bound to
   *   fail with "no key" once switched to is making the user do our trial and error for
   *   us — and the whole point of this list is not having to try.
   */
  catalog(): string[] {
    const out: string[] = []
    for (const id of this.ids()) {
      const provider = this.providers.get(id)!
      if (provider.missingCredentials()) continue
      for (const model of provider.models?.() ?? []) out.push(`${id}/${model}`)
    }
    return out
  }

  /** Parses a spec string like "anthropic/claude-opus-5". */
  resolve(spec: string, options: ResolveOptions = {}): ResolvedModel {
    const ref = parseModelRef(spec)
    const provider = this.providers.get(ref.providerID)
    if (!provider) throw new UnknownModelError(spec, this.ids())

    const missing = provider.missingCredentials()
    if (missing) throw new NoCredentialsError(provider.id, missing)

    return provider.resolve(ref.modelID, options)
  }
}

/**
 * A model name **the model typed** (a task's `model`) → something runnable, or an error
 * that lists what is configured.
 *
 * A bare name stays on `current`'s provider: the model knows the name the user said
 * ("claude-haiku-4-5"), rarely the provider id they gave it in config. A name is only
 * provider-qualified when its first segment **is** a registered provider — model names
 * contain slashes too (openai-chat/org/model).
 *
 * ★ Stricter than `/model` on purpose. There, any name is free input — the user knows
 *   what they typed. Here the typist is a model, and a name outside a provider's declared
 *   list is nearly always a hallucination ("MiniMax-M2.2" for M2.5) that would only fail
 *   at the provider, after a subagent was started for nothing. A provider with no
 *   declared list (most compatible endpoints) can't be checked and is taken at its word.
 *
 * ★ But not stricter about **case**. The provider id is whatever the user typed in config
 *   (`MINIMAX`), and models re-case brand names when they copy them ("MiniMax/MiniMax-M3"
 *   from an env line saying `MINIMAX/MiniMax-M3`). Matched exactly, that prefix wasn't
 *   recognised, the whole string became a model name on the current provider
 *   (`MINIMAX/MiniMax/MiniMax-M3`), and a live run lost three parallel tasks to it. A
 *   case-only difference names one thing unambiguously, so both the provider and a listed
 *   model are matched ignoring case and rewritten to the configured spelling; a different
 *   name is still refused.
 */
export function resolveTypedModel(registry: LLMRegistry, raw: string, current: { spec: string; ref: ModelRef }): { spec: string; ref: ModelRef; info: ModelInfo } {
  const provider = registry.ids().find((id) => raw.toLowerCase().startsWith(`${id.toLowerCase()}/`))
  const typed = provider ? `${provider}${raw.slice(provider.length)}` : `${current.ref.providerID}/${raw}`
  const known = registry.catalog()
  try {
    const typedRef = parseModelRef(typed)
    const listed = known.filter((one) => one.startsWith(`${typedRef.providerID}/`))
    const spec = listed.find((one) => one === typed) ?? listed.find((one) => one.toLowerCase() === typed.toLowerCase()) ?? typed
    const ref = parseModelRef(spec)
    if (listed.length > 0 && !listed.includes(spec)) throw new Error(`"${spec}" is not one of the models configured for ${ref.providerID}.`)
    return { spec, ref, info: registry.resolve(spec).info }
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        (known.length > 0 ? `Models configured here: ${known.join(", ")}. ` : "") +
        `Leave "model" out to use your own (${current.spec}).`,
    )
  }
}

/**
 * "provider/model" → ModelRef.
 * Model names may contain slashes (e.g. openai-chat/org/model); split only at the first
 * one.
 */
export function parseModelRef(spec: string): ModelRef {
  const index = spec.indexOf("/")
  if (index === -1) throw new UnknownModelError(spec, [])
  return { providerID: spec.slice(0, index), modelID: spec.slice(index + 1) }
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.providerID}/${ref.modelID}`
}
