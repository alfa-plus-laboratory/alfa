/**
 * OpenAI-compatible endpoints.
 *
 * One provider covers official OpenAI, DeepSeek, Qwen, local vLLM/Ollama and all kinds of
 * self-hosted gateways, all over chat/completions. It stays clear of the Responses API and
 * its itemId pitfalls on purpose: that API got its own provider (providers/openai.ts,
 * the only user of @ai-sdk/openai) instead of a mode switch in this one.
 *
 * ── effort → `reasoning_effort`, passed through verbatim ──
 * There is no table to round against here: what this field accepts differs per server
 * (OpenAI takes low…xhigh, vLLM's gpt-oss low…high, others ignore it or 400). So it is
 * sent only when the user set one, exactly as set, and a server that rejects it says so
 * in the error — rounding `max` down on a guess would hide which value was actually
 * sent. The price of being honest is that a global /effort meant for one provider can
 * reach this one; /effort default takes it back out.
 */
import { captureProviderRequest } from "../request-metrics.ts"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { extractReasoningMiddleware, wrapLanguageModel } from "ai"
import type { Provider, ResolvedModel } from "../registry.ts"
import { DEFAULT_CONTEXT_LIMIT } from "../types.ts"

const DEFAULT_OUTPUT = 16_000

export function openAICompatProvider(options: {
  noKey?: boolean
  keyHeader?: string
  id?: string
  label?: string
  apiKey?: string
  baseURL?: string
  /** This provider's default window. Used only for models that don't set their own */
  limit?: { context: number; output: number }
  /** false = don't send thinking from history back. See the replayReasoning note below */
  replayReasoning?: boolean
  /**
   * `/model` candidates + their windows. There is **no** fallback table on this side —
   * see ProviderConfig.models in config.ts
   */
  models?: Record<string, { disabled?: boolean; images?: boolean; limit?: { context: number; output: number } }>
  /** See ModelConfig.images in config.ts. Default yes */
  images?: boolean
} = {}): Provider {
  const id = options.id ?? "openai-chat"
  const apiKey = options.apiKey ?? (options.id ? undefined : process.env["OPENAI_API_KEY"])
  // Same rule as apiKey above: with an id we were assembled by setup.ts, which already
  // read the environment through its injectable `env` — reading process.env again here
  // would leak the real environment into a registry built with `env: {}`.
  const baseURL = options.baseURL ?? (options.id ? undefined : process.env["OPENAI_BASE_URL"]) ?? "https://api.openai.com/v1"

  return {
    id,
    label: options.label ?? "OpenAI-compatible",
    missingCredentials() {
      if (apiKey || options.noKey) return undefined
      return `set OPENAI_API_KEY (and OPENAI_BASE_URL if not api.openai.com), or configure a provider with an explicit key`
    },
    models: () => Object.entries(options.models ?? {}).filter(([, m]) => !m.disabled).map(([id]) => id),
    resolve(modelID, { effort }): ResolvedModel {
      if (options.models?.[modelID]?.disabled) throw new Error(`Model disabled: ${modelID}`)
      // This model's own setting > this provider's > the fallback. There's no built-in
      // table to consult here — what sits behind a compatible endpoint, only config can say
      const declared = options.models?.[modelID]?.limit ?? options.limit
      const client = createOpenAICompatible({
        fetch: Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          captureProviderRequest("openai-chat", id, input, init)
          return globalThis.fetch(input, init)
        }, { preconnect: globalThis.fetch.preconnect }),
        name: id,
        apiKey: options.noKey || options.keyHeader ? "" : apiKey!,
        ...(options.keyHeader && apiKey ? { headers: { [options.keyHeader]: options.keyHeader.toLowerCase() === "authorization" ? `Bearer ${apiKey}` : apiKey } } : {}),
        baseURL,
        // Without this, streaming responses carry no usage at all — in real runs MiniMax
        // returns 0 for both in/out with stream=true, while a non-streaming curl has
        // values. Token counts collapsing to 0 skew every context-budget and cost display.
        includeUsage: true,
      })
      return {
        // Some models (the DeepSeek-R1 kind) put their reasoning **inline in content** on
        // the OpenAI-compatible path, wrapped in <think></think>. Left unhandled, the
        // model's private thinking gets rendered to the user as body text. The
        // Anthropic-compatible path doesn't have this problem — a live example of "one
        // provider path verified is not the same as verified".
        model: wrapLanguageModel({
          model: client(modelID),
          middleware: extractReasoningMiddleware({ tagName: "think" }),
        }),
        /**
         * There's no such thing as a signature on this path, so either send the text
         * verbatim or don't send it.
         *
         * Send by default: within one tool loop, a model that can't see what it thought
         * last step can only reverse-engineer its earlier judgment from "which tool I
         * called and what came back". The SDK handles it, serializing it as
         * `reasoning_content`.
         *
         * But this is not a standard — some endpoints 400 outright on this field (and for
         * the `<think>`-inline kind of model, it never came out of this field in the first
         * place). Hence the switch: `providers.<id>.replayReasoning: false` in
         * config.json.
         */
        replayReasoning: options.replayReasoning === false ? "none" : "text",
        /**
         * system is merged into one message. See ResolvedModel.singleSystem in registry.ts.
         *
         * Splitting it in two normally serves only Anthropic's explicit cache breakpoints,
         * and breakpoints live in the `{ anthropic: … }` namespace — dead data on this
         * path. In other words, splitting **buys nothing** here, while the cost is a
         * local inference server returning 500 outright: the vast majority of models' own
         * Jinja chat templates allow only one system message (the official Llama /
         * Mistral / Qwen / Gemma templates all have this gate), and the moment a second
         * one arrives it's `raise_exception('System message must be at the beginning.')`.
         *
         * ★ Not made a config option: no compatible endpoint gets better for receiving
         *   two. A switch with only one correct value is asking the user to make a
         *   choice for us that doesn't exist.
         */
        singleSystem: true,
        info: {
          ref: { providerID: id, modelID },
          limit: declared ?? { context: DEFAULT_CONTEXT_LIMIT, output: DEFAULT_OUTPUT },
          limitSource: declared ? "config" : "default",
          supportsThinking: false,
          promptTemplate: "default",
          // prompt_tokens already includes prompt_tokens_details.cached_tokens; don't add
          // them again
          cacheInInput: true,
          images: options.models?.[modelID]?.images ?? options.images ?? true,
        },
        temperature: 0,
        // The key is the provider's own name up to the first dot: that's the namespace the
        // compatible SDK reads (providerOptionsName in @ai-sdk/openai-compatible). An id
        // with a dot in it would otherwise have its effort silently ignored
        ...(effort ? { providerOptions: { [id.split(".")[0]!.trim()]: { reasoningEffort: effort } } } : {}),
      }
    },
  }
}
