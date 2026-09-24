/**
 * Model discovery is a separate settings operation: saving a candidate must neither
 * rewrite credentials nor switch a live conversation. Exercise the real forms and host
 * callbacks with isolated config and an HTTP stub, including manual fallback and cancel.
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { configPath, loadConfig, saveConfig } from "../src/config/config.ts"
import { authPath, loadAuth, saveAuth } from "../src/config/auth.ts"
import { addProviderModels, configureProvider, manageProviders } from "../src/cli/providers.ts"
import { settings, type SettingsHost } from "../src/cli/settings.ts"
import type { Form } from "../src/cli/form.ts"

let dir: string, originalFetch: typeof fetch
let previous: Record<string, string | undefined>
let requests: Array<{ url: string; method: string; key: string | null }>
let unavailable = false
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alfa-model-settings-"))
  previous = Object.fromEntries(["XDG_CONFIG_HOME", "XDG_DATA_HOME", "ALFA_KEY_FIXTURE", "ALFA_BASE_URL_FIXTURE", "ALFA_MODEL"].map(key => [key, process.env[key]]))
  process.env.XDG_CONFIG_HOME = join(dir, "config")
  process.env.XDG_DATA_HOME = join(dir, "data")
  delete process.env.ALFA_KEY_FIXTURE
  delete process.env.ALFA_BASE_URL_FIXTURE
  delete process.env.ALFA_MODEL
  saveConfig({ model: "fixture/old", providers: { fixture: { type: "openai-chat", baseURL: "https://fixture.example.invalid/v1", keyHeader: "x-fixture-key", discovery: "none", models: { old: { limit: { context: 64000, output: 4000 } } } } } })
  saveAuth({ fixture: { apiKey: "fixture-key-not-real" } })
  originalFetch = globalThis.fetch
  requests = []
  unavailable = false
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
    requests.push({ url: request.url, method: request.method, key: request.headers.get("x-fixture-key") })
    if (request.method === "GET") return unavailable ? new Response("unavailable", { status: 404 }) : Response.json({ data: [{ id: "old" }, { id: "new-a" }, { id: "new-b" }] })
    const data = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }] }
    return new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  }, { preconnect: originalFetch.preconnect })
})
afterEach(() => {
  globalThis.fetch = originalFetch
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  rmSync(dir, { recursive: true, force: true })
})

function form(choices: string[], answers: string[] = []): Form {
  return {
    say() {},
    ask: async () => { if (!answers.length) throw new Error("Unexpected prompt for connection or credentials"); return answers.shift()! },
    choose: async (_title, options, initial) => {
      const value = choices.shift()
      expect(options.some(option => option.value === value)).toBe(true)
      if (options.some(option => option.value === "another")) expect(initial).toBe("save")
      if (!value) throw new Error("Unexpected menu")
      return value
    },
  }
}

test("settings discovers through saved credentials and saves without switching or changing the startup default", async () => {
  const beforeAuth = readFileSync(authPath(), "utf8")
  const switched: string[] = []
  let reloads = 0
  const host: SettingsHost = {
    state: () => ({ model: "fixture/old", classifier: undefined, limit: { context: 64000, output: 4000 }, sandbox: true, permission: "default", trust: "trusted", interface: "en", reply: "auto", check: false, thinking: false, agentflow: false, autoCompact: true, theme: "terminal", toolOutput: "compact", animation: "on", reasoning: "preview" }),
    models: () => ["fixture/old"], reload: () => { reloads++ }, switch: spec => { switched.push(spec); return undefined },
    async command() {}, setClassifier() { return undefined }, setLimit() {}, appearance() {}, access: { list: () => [], add() {}, async revoke() {} },
  }
  await settings(form(["add-model", "fixture", "model:new-a", "save"]), host, "model")
  expect(switched).toEqual([])
  expect(reloads).toBeGreaterThan(0)
  expect(loadConfig().model).toBe("fixture/old")
  expect(loadConfig().providers?.fixture?.models).toEqual({ old: { limit: { context: 64000, output: 4000 } }, "new-a": { disabled: false } })
  expect(readFileSync(authPath(), "utf8")).toBe(beforeAuth)
  expect(requests).toEqual([{ url: "https://fixture.example.invalid/v1/models", method: "GET", key: "fixture-key-not-real" }])
})

test("provider management saves several discoveries using one list fetch and retains existing model metadata", async () => {
  const config = loadConfig()
  config.providers!.fixture!.models!["new-a"] = { limit: { context: 128000, output: 12000 }, disabled: true }
  saveConfig(config)
  expect(await manageProviders(form(["add-model", "fixture", "model:new-a", "another", "model:new-b", "save"]))).toBeUndefined()
  expect(loadConfig().providers?.fixture?.models?.["new-a"]).toEqual({ limit: { context: 128000, output: 12000 }, disabled: false })
  expect(loadConfig().providers?.fixture?.models?.["new-b"]).toEqual({ disabled: false })
  expect(requests).toHaveLength(1)
  expect(loadConfig().model).toBe("fixture/old")
})

for (const action of ["switch", "default"] as const) test(`adding a model returns a switch only when explicitly choosing ${action}`, async () => {
  expect(await addProviderModels(form(["fixture", "model:new-a", action]))).toBe("fixture/new-a")
  expect(loadConfig().model).toBe(action === "default" ? "fixture/new-a" : "fixture/old")
})

test("failed discovery still supports manual IDs and cancellation writes nothing", async () => {
  unavailable = true
  const before = readFileSync(configPath(), "utf8")
  expect(await addProviderModels(form(["fixture", "__manual__", "cancel", "__back__"], ["manual-model"]))).toBeUndefined()
  expect(readFileSync(configPath(), "utf8")).toBe(before)
  await addProviderModels(form(["fixture", "__manual__", "save"], ["manual-model"]))
  expect(loadConfig().providers?.fixture?.models?.["manual-model"]).toEqual({ disabled: false })
})

test("discovery honors effective endpoint and credential overrides without saving them", async () => {
  process.env.ALFA_KEY_FIXTURE = "fixture-override-key"
  process.env.ALFA_BASE_URL_FIXTURE = "https://override.example.invalid/v1"
  await addProviderModels(form(["fixture", "model:new-a", "save"]))
  expect(requests[0]).toEqual({ url: "https://override.example.invalid/v1/models", method: "GET", key: "fixture-override-key" })
  expect(loadConfig().providers?.fixture?.baseURL).toBe("https://fixture.example.invalid/v1")
  expect(loadAuth().fixture?.apiKey).toBe("fixture-key-not-real")
})

test("optional connection testing does not save a cancelled model", async () => {
  const before = readFileSync(configPath(), "utf8")
  await addProviderModels(form(["fixture", "model:new-a", "test", "cancel", "__back__"]))
  expect(requests.filter(r => r.method === "POST")).toHaveLength(1)
  expect(readFileSync(configPath(), "utf8")).toBe(before)
})

test("model limits can be edited without reopening provider credentials", async () => {
  await addProviderModels(form(["fixture", "model:new-a", "limits", "save"], ["128000", "16000"]))
  expect(loadConfig().providers?.fixture?.models?.["new-a"]?.limit).toEqual({ context: 128000, output: 16000 })
  expect(loadConfig().providers?.fixture?.models?.old?.limit).toEqual({ context: 64000, output: 4000 })
})

test("editing a connection offers save-only after verification and preserves the active startup preference", async () => {
  expect(await configureProvider(form(["continue", "old", "test", "save"], ["", ""]), "fixture")).toBeUndefined()
  expect(loadConfig().model).toBe("fixture/old")
  expect(loadAuth().fixture?.apiKey).toBe("fixture-key-not-real")
  expect(requests.filter(r => r.method === "POST")).toHaveLength(1)
})
