/**
 * Reasoning effort across the three wire protocols.
 *
 * Every assertion here is on the **serialized request body**, not on providerOptions:
 * the SDKs rename, drop and default these fields on their way out (Responses turns on a
 * detailed summary by itself whenever an effort is present; the Anthropic SDK lowers
 * some combinations on its own), so only the bytes say what the provider receives.
 */
import { describe, expect, test } from "bun:test"
import { LLMRegistry } from "../src/llm/registry.ts"
import { anthropicProvider } from "../src/llm/providers/anthropic.ts"
import { openAIProvider } from "../src/llm/providers/openai.ts"
import { openAICompatProvider } from "../src/llm/providers/openai-compat.ts"
import { stream } from "../src/llm/stream.ts"
import { clampEffort, type ReasoningEffort } from "../src/llm/types.ts"

const anthropicEvents = [
  { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
]
const chatEvents = [
  { id: "c", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
  { id: "c", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
]
const responsesEvents = [
  { type: "response.created", response: { id: "r", model: "fixture", created_at: 1 } },
  { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
]
const sse = (events: unknown[], done: boolean) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""), { headers: { "content-type": "text/event-stream" } })

async function send(registry: LLMRegistry, spec: string, options: { thinking?: boolean; effort?: ReasoningEffort } = {}) {
  const [providerID, ...rest] = spec.split("/")
  const handle = stream(registry, {
    model: { providerID: providerID!, modelID: rest.join("/") },
    system: ["static", "dynamic"],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    ...(options.thinking ? { thinking: true } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    makeToolContext: () => { throw new Error("no tools") },
    abortSignal: new AbortController().signal,
  })
  for await (const _ of handle.events) {}
}

/**
 * The official Anthropic endpoint can't be served locally — its host is what switches the
 * generation rules on — so its fetch is intercepted instead of a server being started.
 */
const realFetch = globalThis.fetch
async function officialBody(modelID: string, options: { thinking?: boolean; effort?: ReasoningEffort } = {}): Promise<any> {
  let body: any
  globalThis.fetch = Object.assign(async (_input: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body))
    return sse(anthropicEvents, false)
  }, { preconnect: realFetch.preconnect }) as typeof fetch
  try {
    await send(new LLMRegistry().register(anthropicProvider({ id: "anthropic", apiKey: "k" })), `anthropic/${modelID}`, options)
  } finally { globalThis.fetch = realFetch }
  return body
}

async function served(protocol: "responses" | "chat" | "anthropic", options: { thinking?: boolean; effort?: ReasoningEffort; modelID?: string; id?: string } = {}): Promise<any> {
  const bodies: any[] = []
  const server = Bun.serve({ port: 0, async fetch(req) {
    bodies.push(await req.json())
    return protocol === "responses" ? sse(responsesEvents, true) : protocol === "chat" ? sse(chatEvents, true) : sse(anthropicEvents, false)
  } })
  try {
    const id = options.id ?? "fixture"
    const provider = protocol === "responses"
      ? openAIProvider({ id, apiKey: "k", baseURL: server.url.href })
      : protocol === "chat"
        ? openAICompatProvider({ id, apiKey: "k", baseURL: server.url.href })
        : anthropicProvider({ id, apiKey: "k", baseURL: server.url.href })
    await send(new LLMRegistry().register(provider), `${id}/${options.modelID ?? "gpt-5.4"}`, options)
    return bodies[0]
  } finally { await server.stop(true) }
}

describe("clampEffort", () => {
  test("rounds down, never up — asking for xhigh never buys an unrequested max", () => {
    expect(clampEffort("xhigh", ["low", "medium", "high", "max"])).toBe("high")
    expect(clampEffort("max", ["low", "medium", "high"])).toBe("high")
    expect(clampEffort("medium", ["low", "medium", "high"])).toBe("medium")
    expect(clampEffort("high", [])).toBeUndefined()
  })
})

describe("unset effort sends nothing", () => {
  /**
   * ★ Unset is "the provider's default", which differs per model (medium on Opus 5.5,
   *   high on the rest). Filling in any level here would change every existing user's
   *   requests without them having asked for anything.
   */
  test("on all three protocols", async () => {
    expect((await officialBody("claude-opus-5")).output_config).toBeUndefined()
    expect((await served("responses")).reasoning).toBeUndefined()
    expect((await served("chat")).reasoning_effort).toBeUndefined()
  })
})

describe("Anthropic: output_config.effort by generation", () => {
  test("current generation takes all five levels verbatim", async () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect((await officialBody("claude-opus-5", { thinking: true, effort: level })).output_config).toEqual({ effort: level })
    }
  })

  /**
   * ★ Opus 5 accepts `disabled` only at effort high or below; `disabled` + xhigh is a 400.
   *   This is the combination that kept effort out of the adapter entirely before.
   */
  test("★ Opus 5 with thinking off caps effort at high instead of sending a 400", async () => {
    const body = await officialBody("claude-opus-5", { effort: "xhigh" })
    expect(body.thinking).toEqual({ type: "disabled" })
    expect(body.output_config).toEqual({ effort: "high" })
  })

  /**
   * ★ On Fable 5 / 5.1, Mythos and Opus 5.5 thinking can't be off: any `disabled` is a
   *   400. Before the generation table these got `disabled` whenever /think was off.
   */
  test("★ models whose thinking can't be turned off never get `disabled`", async () => {
    for (const modelID of ["claude-fable-5", "claude-fable-5-1", "claude-mythos-5", "claude-opus-5-5"]) {
      const body = await officialBody(modelID, { effort: "max" })
      expect(body.thinking).toBeUndefined()
      expect(body.temperature).toBeUndefined()
      expect(body.output_config).toEqual({ effort: "max" })
      expect((await officialBody(modelID, { thinking: true })).thinking).toEqual({ type: "adaptive" })
    }
  })

  test("4.6 has no xhigh: rounds down to high, max stays max", async () => {
    expect((await officialBody("claude-sonnet-4-6", { effort: "xhigh" })).output_config).toEqual({ effort: "high" })
    expect((await officialBody("claude-opus-4-6", { effort: "max" })).output_config).toEqual({ effort: "max" })
  })

  /** The effort field itself is a 400 on these — a remembered /effort must not break them */
  test("★ models that reject effort never get the field, dated snapshots included", async () => {
    for (const modelID of ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-5"]) {
      expect((await officialBody(modelID, { effort: "high" })).output_config).toBeUndefined()
    }
  })

  test("third-party Anthropic-compatible endpoints get effort exactly as set", async () => {
    const body = await served("anthropic", { modelID: "claude-opus-5", effort: "xhigh" })
    expect(body.output_config).toEqual({ effort: "xhigh" })
  })
})

describe("Responses: reasoning.effort", () => {
  test("levels map one to one; max becomes xhigh, the top of this protocol", async () => {
    expect((await served("responses", { effort: "medium" })).reasoning.effort).toBe("medium")
    expect((await served("responses", { effort: "max" })).reasoning.effort).toBe("xhigh")
  })

  /**
   * ★ Left alone, the SDK turns on a **detailed** summary whenever an effort is sent, so
   *   setting effort with /think off would start streaming the reasoning the user
   *   switched off.
   */
  test("★ effort with thinking off does not switch the reasoning summary on", async () => {
    const body = await served("responses", { effort: "high" })
    expect(body.reasoning).toEqual({ effort: "high" })
    expect((await served("responses", { effort: "high", thinking: true })).reasoning).toEqual({ effort: "high", summary: "auto" })
  })
})

describe("Chat Completions: reasoning_effort", () => {
  /**
   * Passed through verbatim: which values a compatible server takes differs per server,
   * and rounding on a guess would hide what was actually sent.
   */
  test("sent exactly as set, including under a provider id with a dot in it", async () => {
    expect((await served("chat", { effort: "max" })).reasoning_effort).toBe("max")
    expect((await served("chat", { effort: "low", id: "corp.gateway" })).reasoning_effort).toBe("low")
  })
})
