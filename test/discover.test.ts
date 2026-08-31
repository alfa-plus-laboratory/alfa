/**
 * 问端点有哪些模型。
 *
 * 这里桩掉 fetch,测的是**拿到回应之后的判断**:哪些名字算聊天模型、砍了几条要
 * 说出来、什么情况算"没问到"。真实连通性不在这层测 —— 那要一个真端点,而这个
 * 模块最容易出错的地方恰恰不是网络,是"把一份带着 embedding 和 tts 的清单
 * 原样端给用户当模型候选"。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { discoverModels } from "../src/llm/discover.ts"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
})

/** 记下请求,回一份指定的 body */
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
  test("拿名字,按两种口味发不同的认证头", async () => {
    let calls = stub(ids(["claude-sonnet-4-5", "claude-opus-4-1"]))
    const anthropic = await discoverModels({ type: "anthropic", apiKey: "k" })
    expect(anthropic?.models).toEqual(["claude-sonnet-4-5", "claude-opus-4-1"])
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models")
    expect(calls[0]!.headers["x-api-key"]).toBe("k")
    expect(calls[0]!.headers["anthropic-version"]).toBeTruthy()

    calls = stub(ids(["gpt-4o"]))
    await discoverModels({ type: "openai-compat", apiKey: "k" })
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/models")
    expect(calls[0]!.headers["authorization"]).toBe("Bearer k")
  })

  test("baseURL 末尾的斜杠不该拼出 //models", async () => {
    const calls = stub(ids(["m"]))
    await discoverModels({ type: "openai-compat", apiKey: "k", baseURL: "https://gw.example/v1/" })
    expect(calls[0]!.url).toBe("https://gw.example/v1/models")
  })

  test("★ 不是拿来聊天的砍掉,而且砍了几条要说出来", async () => {
    stub(ids(["gpt-4o", "text-embedding-3-small", "whisper-1", "tts-1", "dall-e-3", "gpt-4o-mini"]))
    const found = await discoverModels({ type: "openai-compat", apiKey: "k" })
    // 一份带着 embedding 和 tts 的候选列表,用户选中一个只会拿到一条看不懂的报错
    expect(found?.models).toEqual(["gpt-4o", "gpt-4o-mini"])
    // 安静地少几行比带噪音更难查
    expect(found?.dropped).toBe(4)
    expect(found?.truncated).toBe(0)
  })

  test("★ 按名字砍是白名单的反面 —— 没见过的新模型必须留着", async () => {
    stub(ids(["some-brand-new-model-9", "Qwen3-Max", "MiniMax-M3"]))
    const found = await discoverModels({ type: "openai-compat", apiKey: "k" })
    expect(found?.models).toHaveLength(3)
  })

  test("太长要截,截掉多少条也要说出来", async () => {
    stub(ids(Array.from({ length: 55 }, (_, i) => `model-${i}`)))
    const found = await discoverModels({ type: "openai-compat", apiKey: "k" })
    expect(found?.models).toHaveLength(40)
    expect(found?.truncated).toBe(15)
  })

  test("★ 问不到一律 undefined —— 调用方据此什么都不写,而不是写一份空清单", async () => {
    stub(ids([]), { ok: false })
    expect(await discoverModels({ type: "openai-compat", apiKey: "k" })).toBeUndefined()

    stub({ error: "nope" })
    expect(await discoverModels({ type: "openai-compat", apiKey: "k" })).toBeUndefined()

    stub(ids([]))
    expect(await discoverModels({ type: "openai-compat", apiKey: "k" })).toBeUndefined()

    // 返回了个 HTML 登录页:json() 直接抛
    globalThis.fetch = (async () =>
      ({ ok: true, json: async () => JSON.parse("<html>") }) as unknown as Response) as unknown as typeof fetch
    expect(await discoverModels({ type: "openai-compat", apiKey: "k" })).toBeUndefined()

    // 网络不通
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    expect(await discoverModels({ type: "openai-compat", apiKey: "k" })).toBeUndefined()
  })

  test("条目里没有 id 就跳过,不留一个 undefined 进候选", async () => {
    stub({ data: [{ id: "ok" }, { name: "no-id" }, { id: "" }, null] })
    const found = await discoverModels({ type: "openai-compat", apiKey: "k" })
    expect(found?.models).toEqual(["ok"])
  })
})
