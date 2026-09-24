/**
 * Asking an endpoint which models it has.
 *
 * fetch is stubbed here; what's tested is **the judgment after the response arrives**:
 * which names count as chat models, saying out loud how many were cut, and what counts as
 * "couldn't find out". Real connectivity isn't tested at this layer — that takes a real
 * endpoint, and the place this module most easily goes wrong is precisely not the
 * network, it is "serving a list full of embedding and tts models to the user, as is, as
 * model candidates".
 */
import { afterEach, describe, expect, test } from "bun:test"
import { discoverModels } from "../src/llm/discover.ts"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
})

/** Records the requests and replies with the given body */
function stub(body: unknown, init: { ok?: boolean } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(url), headers: (options?.headers ?? {}) as Record<string, string> })
    return {
      ok: init.ok ?? true,
      json: async () => body,
    } as Response
  }) as unknown as typeof fetch
  return calls
}

const ids = (names: string[]) => ({ data: names.map((id) => ({ id })) })

describe("discoverModels", () => {
  test("gets the names, with the right auth header for each of the two flavors", async () => {
    let calls = stub(ids(["claude-sonnet-4-5", "claude-opus-4-1"]))
    const anthropic = await discoverModels({ type: "anthropic", apiKey: "k" })
    expect(anthropic?.models).toEqual(["claude-sonnet-4-5", "claude-opus-4-1"])
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models")
    expect(calls[0]!.headers["x-api-key"]).toBe("k")
    expect(calls[0]!.headers["anthropic-version"]).toBeTruthy()

    calls = stub(ids(["gpt-4o"]))
    await discoverModels({ type: "openai-chat", apiKey: "k" })
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/models")
    expect(calls[0]!.headers["authorization"]).toBe("Bearer k")
  })

  test("a trailing slash on baseURL doesn't produce //models", async () => {
    const calls = stub(ids(["m"]))
    await discoverModels({ type: "openai-chat", apiKey: "k", baseURL: "https://gw.example/v1/" })
    expect(calls[0]!.url).toBe("https://gw.example/v1/models")
  })

  test("★ non-chat models are dropped, and how many were dropped is reported", async () => {
    stub(ids(["gpt-4o", "text-embedding-3-small", "whisper-1", "tts-1", "dall-e-3", "gpt-4o-mini"]))
    const found = await discoverModels({ type: "openai-chat", apiKey: "k" })
    // in a candidate list with embedding and tts models in it, picking one just gets the
    // user an incomprehensible error
    expect(found?.models).toEqual(["gpt-4o", "gpt-4o-mini"])
    // a few lines quietly missing is harder to track down than some noise
    expect(found?.dropped).toBe(4)
    expect(found?.truncated).toBe(0)
  })

  test("★ name-based dropping is the opposite of an allowlist — unseen new models must stay", async () => {
    stub(ids(["some-brand-new-model-9", "Qwen3-Max", "MiniMax-M3"]))
    const found = await discoverModels({ type: "openai-chat", apiKey: "k" })
    expect(found?.models).toHaveLength(3)
  })

  test("too long gets truncated, and how many were cut is reported too", async () => {
    stub(ids(Array.from({ length: 55 }, (_, i) => `model-${i}`)))
    const found = await discoverModels({ type: "openai-chat", apiKey: "k" })
    expect(found?.models).toHaveLength(40)
    expect(found?.truncated).toBe(15)
  })

  test("★ couldn't find out is always undefined — the caller then writes nothing, not an empty list", async () => {
    stub(ids([]), { ok: false })
    expect(await discoverModels({ type: "openai-chat", apiKey: "k" })).toBeUndefined()

    stub({ error: "nope" })
    expect(await discoverModels({ type: "openai-chat", apiKey: "k" })).toBeUndefined()

    stub(ids([]))
    expect(await discoverModels({ type: "openai-chat", apiKey: "k" })).toBeUndefined()

    // got back an HTML login page: json() just throws
    globalThis.fetch = (async () =>
      ({ ok: true, json: async () => JSON.parse("<html>") }) as unknown as Response) as unknown as typeof fetch
    expect(await discoverModels({ type: "openai-chat", apiKey: "k" })).toBeUndefined()

    // network unreachable
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    expect(await discoverModels({ type: "openai-chat", apiKey: "k" })).toBeUndefined()
  })

  test("entries without an id are skipped, no undefined gets into the candidates", async () => {
    stub({ data: [{ id: "ok" }, { name: "no-id" }, { id: "" }, null] })
    const found = await discoverModels({ type: "openai-chat", apiKey: "k" })
    expect(found?.models).toEqual(["ok"])
  })
})
