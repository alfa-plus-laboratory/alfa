/**
 * OpenAI's official Responses API.
 *
 * It must stay separate from openai-chat: that one serves third-party endpoints that only
 * implement Chat Completions, and swapping it to Responses in place would break existing
 * DeepSeek, Ollama, vLLM etc. configs all at once.
 * ★ Requests set `store: false` explicitly: alfa holds the full session itself and has no
 *   need for the server to keep another copy of the state.
 * ⚠ A reasoning summary can't be fed back as text alone the way Anthropic's signed blocks
 * can; without item metadata the SDK drops it with a warning, so the loop currently uses
 * none as well, and tool calls and results are still sent with the full history.
 *
 * ── effort → `reasoning.effort` ──
 * The scale maps one to one except `max`, which Responses doesn't have: it becomes
 * `xhigh`, the top of this protocol's range. Non-reasoning models (gpt-4o, gpt-5-chat)
 * are the SDK's call — it recognizes them by name and drops the field with a warning
 * rather than sending a 400. A gateway alias the SDK can't parse (`my-gpt`) is treated
 * the same way, so effort there does nothing; /cache-hit shows the transmitted effort,
 * which is where that becomes visible.
 * ★ `/think` still decides the summary. Left to itself the SDK turns on a **detailed**
 *   summary whenever an effort is sent, so setting effort with thinking off would start
 *   streaming reasoning the user switched off — hence the explicit null.
 */
import { captureOpenAIRequest } from "../request-metrics.ts"
import { createOpenAI } from "@ai-sdk/openai"
import type { Provider, ResolvedModel } from "../registry.ts"
import { DEFAULT_CONTEXT_LIMIT } from "../types.ts"

const DEFAULT_OUTPUT = 32_000

export function openAIProvider(options: {
  noKey?: boolean
  keyHeader?: string
  id?: string
  label?: string
  apiKey?: string
  baseURL?: string
  limit?: { context: number; output: number }
  /** See ModelConfig.images in config.ts. Default yes */
  images?: boolean
  models?: Record<string, { disabled?: boolean; images?: boolean; promptProfile?: "generic" | "openai-codex"; limit?: { context: number; output: number } }>
} = {}): Provider {
  const id = options.id ?? "openai"
  const apiKey = options.apiKey ?? (options.id ? undefined : process.env["OPENAI_API_KEY"])
  // Same rule as apiKey above: with an id we were assembled by setup.ts, which already
  // read the environment through its injectable `env` — reading process.env again here
  // would leak the real environment into a registry built with `env: {}`.
  const baseURL = options.baseURL ?? (options.id ? undefined : process.env["OPENAI_BASE_URL"]) ?? "https://api.openai.com/v1"

  return {
    id,
    label: options.label ?? "OpenAI",
    missingCredentials() {
      if (apiKey || options.noKey) return undefined
      return "set OPENAI_API_KEY, or configure the OpenAI provider with an explicit key"
    },
    models: () => Object.entries(options.models ?? {}).filter(([, model]) => !model.disabled).map(([modelID]) => modelID),
    resolve(modelID, { thinking, effort }): ResolvedModel {
      if (options.models?.[modelID]?.disabled) throw new Error(`Model disabled: ${modelID}`)
      const declared = options.models?.[modelID]?.limit ?? options.limit
      const client = createOpenAI({
        name: id,
        apiKey: options.noKey || options.keyHeader ? "" : apiKey!,
        ...(options.keyHeader && apiKey ? { headers: { [options.keyHeader]: options.keyHeader.toLowerCase() === "authorization" ? `Bearer ${apiKey}` : apiKey } } : {}),
        baseURL,
        fetch: Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          captureOpenAIRequest(id, input, init)
          return globalThis.fetch(input, init)
        }, { preconnect: globalThis.fetch.preconnect }),
      })

      return {
        model: client.responses(modelID),
        replayReasoning: "none",
        replayResponses: true,
        singleSystem: true,
        providerOptions: {
          openai: {
            store: false,
            ...(thinking ? { reasoningSummary: "auto" } : effort ? { reasoningSummary: null } : {}),
            ...(effort ? { reasoningEffort: effort === "max" ? "xhigh" : effort } : {}),
          },
        },
        info: {
          ref: { providerID: id, modelID },
          limit: declared ?? { context: DEFAULT_CONTEXT_LIMIT, output: DEFAULT_OUTPUT },
          limitSource: declared ? "config" : "default",
          supportsThinking: true,
          promptTemplate: "default",
          promptProfile: options.models?.[modelID]?.promptProfile ?? "generic",
          cacheInInput: true,
          images: options.models?.[modelID]?.images ?? options.images ?? true,
        },
        // The new generation of reasoning models rejects temperature; when it's omitted,
        // non-reasoning models still have a reliable default.
        temperature: undefined,
      }
    },
  }
}
