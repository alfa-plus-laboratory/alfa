/**
 * Verifies the multi-provider config contract without network access; real protocol
 * requests are acceptance-tested separately against a PTY stub server.
 */
import { test, expect } from "bun:test"
import { resolveProviders, buildRegistry } from "../src/llm/setup.ts"
import { configureProvider } from "../src/cli/providers.ts"
import { loadConfig } from "../src/config/config.ts"
import { loadAuth } from "../src/config/auth.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
test("named endpoint source, disabled state and keyless local models are each preserved", () => {
  const config = { providers: { local: { type:"openai-chat" as const, baseURL:"http://127.0.0.1:11434/v1", noKey:true, models:{ enabled:{}, disabled:{disabled:true} } }, off:{type:"anthropic" as const,disabled:true} } }
  expect(resolveProviders({config,env:{}}).some(p=>p.id==="off")).toBe(false)
  const effective=resolveProviders({config,env:{ALFA_BASE_URL_LOCAL:"http://localhost:1234/v1"}}).find(p=>p.id==="local")!
  expect(effective.baseURLSource).toBe("env");expect(effective.source).toBe("none")
  const registry=buildRegistry({config,env:{}})
  expect(registry.resolve("local/enabled").info.ref.modelID).toBe("enabled")
  expect(()=>registry.resolve("local/disabled")).toThrow("disabled")
  expect(registry.catalog()).not.toContain("local/disabled")
})
test("a failed connection test saves no provider or credentials, and the error doesn't echo the key", async () => {
  const dir=mkdtempSync(join(tmpdir(),"alfa-provider-"))
  const previousConfig=process.env.XDG_CONFIG_HOME,previousData=process.env.XDG_DATA_HOME
  process.env.XDG_CONFIG_HOME=join(dir,"config");process.env.XDG_DATA_HOME=join(dir,"data")
  const original=globalThis.fetch
  globalThis.fetch=(async()=>new Response('{"error":{"message":"reflected-secret-key-123456"}}',{status:401,headers:{"content-type":"application/json"}})) as unknown as typeof fetch
  const answers=["fixture","http://127.0.0.1:1234/v1","reflected-secret-key-123456","test",""]
  const choices=["custom","openai-chat","key","test","cancel"]
  let protocolLabels: string[] = [], protocolDefault = ""
  try {
    expect(await configureProvider({
      ask:async()=> { if(!answers.length) throw new Error("unexpected input"); return answers.shift()! },
      choose:async(_label, options, current)=> {
        if (options.some(option => option.value === "custom")) {
          expect(options.map(option => option.value)).toEqual(["anthropic", "openai", "local", "custom"])
        }
        if (options.some(option => option.value === "openai-responses")) {
          protocolLabels = options.map(option => option.label)
          protocolDefault = current ?? ""
        }
        if(!choices.length) throw new Error("unexpected choice"); return choices.shift()!
      }, say(){},
    })).toBeUndefined()
    expect(loadConfig()).toEqual({});expect(loadAuth()).toEqual({})
    expect(protocolLabels).toEqual([
      "OpenAI-compatible (Responses API)",
      "Anthropic-compatible (Anthropic API)",
      "Chat Completions (OpenAI-compatible)",
    ])
    expect(protocolDefault).toBe("openai-responses")
  } finally {
    globalThis.fetch=original
    if(previousConfig===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=previousConfig
    if(previousData===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=previousData
    rmSync(dir,{recursive:true,force:true})
  }
})


test("official provider setup reaches the optional context-window prompt without repeated advanced protocol prompts", async () => {
  const dir=mkdtempSync(join(tmpdir(),"alfa-provider-"))
  const previousConfig=process.env.XDG_CONFIG_HOME,previousData=process.env.XDG_DATA_HOME
  process.env.XDG_CONFIG_HOME=join(dir,"config");process.env.XDG_DATA_HOME=join(dir,"data")
  const originalFetch = globalThis.fetch
  // Discovery failure must still permit a manually supplied model ID, without calling
  // a real endpoint or introducing another vendor preset just for this fixture.
  globalThis.fetch = Object.assign(async () => new Response("not found", { status: 404 }), { preconnect: originalFetch.preconnect })
  const answers = ["fixture-provider", "fake-provider-key-for-regression", "fixture-model"]
  const choices = ["anthropic", "continue"]
  const prompts: Array<{ label: string; secret?: boolean }> = [], lines: string[] = []
  try {
    await expect(configureProvider({
      choose: async () => { if (!choices.length) throw new Error("unexpected menu"); return choices.shift()! },
      ask: async (label, secret) => {
        prompts.push({ label, secret })
        if (label.includes("Context window")) {
          expect(label).toContain("[256000]")
          throw new Error("stop before any network test")
        }
        if (!answers.length) throw new Error("unexpected prompt")
        return answers.shift()!
      }, say: text => { lines.push(text) },
    })).rejects.toThrow("stop before any network test")
    expect(lines.join("\n")).toContain("https://api.anthropic.com/v1")
    expect(prompts.find(p => p.label.includes("API key"))?.secret).toBe(true)
    expect(prompts.some(p => p.label.includes("Context window"))).toBe(true)
    expect(prompts.some(p => p.label.includes("Authentication header"))).toBe(false)
  } finally {
    globalThis.fetch = originalFetch
    if(previousConfig===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=previousConfig
    if(previousData===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=previousData
    rmSync(dir,{recursive:true,force:true})
  }
})
