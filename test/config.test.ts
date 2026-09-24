/**
 * Config and credential persistence.
 *
 * Two kinds of bug are especially insidious here:
 *   - **Precedence reversed**: everything looks normal, it's just using a different
 *     key. The user exports a new key and it gets overridden by an old one saved half a
 *     year ago — maddening to track down.
 *   - **File permissions**: a 0644 key file causes no error and doesn't affect
 *     functionality; other users on the same machine can just read it. Without a test
 *     watching, nobody would ever notice.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadAuth, maskKey, removeCredential, saveAuth, setCredential } from "../src/config/auth.ts"
import { InvalidProviderTypeError, loadConfig, rememberAgentflow, rememberEffort, removeProvider, repairProviderType, saveConfig, setProvider } from "../src/config/config.ts"
import { FLOW_WINDOW } from "../src/agent/flow.ts"
import { buildRegistry, defaultModelSpec, resolveProviders } from "../src/llm/setup.ts"
import { performReset, resetScope } from "../src/cli/reset.ts"

let dir: string
let auth: string
let conf: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "apc-config-"))
  auth = join(dir, "auth.json")
  conf = join(dir, "config.json")
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ─────────────────────────────────────────────── auth.json

describe("credentials file", () => {
  test("★ created as 0600", () => {
    setCredential("minimax", { apiKey: "sk-secret" }, auth)
    expect(statSync(auth).mode & 0o777).toBe(0o600)
  })

  test("★ directory is 0700", () => {
    const nested = join(dir, "sub", "auth.json")
    setCredential("x", { apiKey: "k" }, nested)
    expect(statSync(join(dir, "sub")).mode & 0o777).toBe(0o700)
  })

  test("still 0600 after an overwrite", () => {
    setCredential("a", { apiKey: "k1" }, auth)
    chmodSync(auth, 0o644) // simulate another tool loosening it
    // The read before the overwrite warns about the loosened file; that warning is the
    // next test's subject, so here it is only kept off the test output
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      setCredential("b", { apiKey: "k2" }, auth)
    } finally {
      process.stderr.write = original
    }
    expect(statSync(auth).mode & 0o777).toBe(0o600)
  })

  test("loosened permissions warn on read, but don't fail", () => {
    setCredential("a", { apiKey: "k" }, auth)
    chmodSync(auth, 0o644)
    const warnings: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((text: string) => {
      warnings.push(String(text))
      return true
    }) as typeof process.stderr.write
    try {
      expect(loadAuth(auth)["a"]?.apiKey).toBe("k")
    } finally {
      process.stderr.write = original
    }
    expect(warnings.join("")).toContain("readable by other users")
  })

  test("add, remove, list", () => {
    setCredential("a", { apiKey: "k1" }, auth)
    setCredential("b", { apiKey: "k2" }, auth)
    expect(Object.keys(loadAuth(auth)).toSorted()).toEqual(["a", "b"])
    expect(removeCredential("a", auth)).toBe(true)
    expect(removeCredential("nope", auth)).toBe(false)
    expect(Object.keys(loadAuth(auth))).toEqual(["b"])
  })

  test("missing file = empty, not an error", () => {
    expect(loadAuth(join(dir, "missing.json"))).toEqual({})
  })

  test("★ a corrupt file is reported, never silently treated as no credentials", () => {
    writeFileSync(auth, "{ this is not json", { mode: 0o600 })
    // If it silently returned {}, the user would see "no credentials" with no way to guess
    // the file is broken
    expect(() => loadAuth(auth)).toThrow(/not valid JSON/)
  })

  test("entries without an apiKey are ignored", () => {
    writeFileSync(auth, JSON.stringify({ a: {}, b: { apiKey: "" }, c: { apiKey: "ok" } }), { mode: 0o600 })
    expect(Object.keys(loadAuth(auth))).toEqual(["c"])
  })

  test("a failed write doesn't lose existing credentials (atomic write)", () => {
    setCredential("a", { apiKey: "k1" }, auth)
    const before = readFileSync(auth, "utf8")
    try {
      saveAuth({ a: { apiKey: "k1" }, b: { apiKey: "k2" } }, join(dir, "no-such-dir-created", "x", "auth.json"))
    } catch {
      /* doesn't matter */
    }
    expect(readFileSync(auth, "utf8")).toBe(before)
  })
})

describe("maskKey", () => {
  test("keeps both ends, masks the middle", () => {
    expect(maskKey("sk-cp-ABCDEFGHIJKLMNOP")).toBe("sk-cp-…MNOP")
  })
  test("short keys are fully masked — showing both ends would show all of it", () => {
    expect(maskKey("short")).toBe("*****")
    expect(maskKey("ab")).toBe("****")
  })
  test("the mask never contains the middle of the original", () => {
    const key = "sk-cp-SECRETMIDDLE1234"
    expect(maskKey(key)).not.toContain("SECRETMIDDLE")
  })
})

// ─────────────────────────────────────────────── config.json

describe("config file", () => {
  test("round trip", () => {
    saveConfig({ model: "minimax/MiniMax-M3", providers: { minimax: { type: "anthropic", baseURL: "https://x/v1" } } }, conf)
    const loaded = loadConfig(conf)
    expect(loaded.model).toBe("minimax/MiniMax-M3")
    expect(loaded.providers?.["minimax"]).toEqual({ type: "anthropic", baseURL: "https://x/v1" })
  })

  test("agentflow: false, true (the default window) or a number from 2-12; anything else is pointed out", () => {
    writeFileSync(conf, JSON.stringify({ agentflow: 6 }))
    expect(loadConfig(conf).agentflow).toBe(6)

    writeFileSync(conf, JSON.stringify({ agentflow: false }))
    expect(loadConfig(conf).agentflow).toBe(false)

    // People hand-writing config will write true, copying the other switches. Refusing
    // to start the program to force them to write a number would be out of proportion
    writeFileSync(conf, JSON.stringify({ agentflow: true }))
    expect(loadConfig(conf).agentflow).toBe(FLOW_WINDOW)

    for (const bad of [0, 1, 99, 3.5, "6"]) {
      writeFileSync(conf, JSON.stringify({ agentflow: bad }))
      expect(() => loadConfig(conf)).toThrow(/"agentflow" must be false, or how many subagents/)
    }
  })

  test("turning agentflow off **writes false**, not deletes the key — a deleted key reads as never set", () => {
    rememberAgentflow(6, conf)
    expect(loadConfig(conf).agentflow).toBe(6)
    rememberAgentflow(false, conf)
    expect(JSON.parse(readFileSync(conf, "utf8"))).toHaveProperty("agentflow", false)
  })

  /** default is "stop sending the field", so it must leave no key behind that reads as a level */
  test("effort: a level is remembered, default removes the key, a typo names the field", () => {
    rememberEffort("xhigh", conf)
    expect(loadConfig(conf).effort).toBe("xhigh")
    rememberEffort(undefined, conf)
    expect(JSON.parse(readFileSync(conf, "utf8"))).not.toHaveProperty("effort")
    writeFileSync(conf, JSON.stringify({ effort: "extreme" }))
    expect(() => loadConfig(conf)).toThrow(/"effort" must be one of low, medium, high, xhigh, max/)
  })

  /** The model's own setting beats the provider's, which beats the default: yes (see ModelConfig.images) */
  test("images: model > provider > default yes", () => {
    writeFileSync(conf, JSON.stringify({ providers: {
      gw: { type: "openai-chat", baseURL: "https://gw/v1", images: false, models: { "text-only": {}, "vl": { images: true } } },
      local: { type: "openai-chat", baseURL: "https://local/v1", models: ["qwen"] },
    } }))
    const config = loadConfig(conf)
    const registry = buildRegistry({ config, auth: { gw: { apiKey: "k" }, local: { apiKey: "k" } }, env: {} })
    expect(registry.resolve("gw/vl").info.images).toBe(true)
    expect(registry.resolve("gw/text-only").info.images).toBe(false)
    expect(registry.resolve("local/qwen").info.images).toBe(true)
    writeFileSync(conf, JSON.stringify({ providers: { gw: { type: "openai-chat", images: "yes" } } }))
    expect(() => loadConfig(conf)).toThrow(/images must be true or false/)
  })

  test("★ no secrets ever land in config.json", () => {
    setProvider("minimax", { type: "anthropic", baseURL: "https://x/v1" }, conf)
    setCredential("minimax", { apiKey: "sk-super-secret-value" }, auth)
    expect(readFileSync(conf, "utf8")).not.toContain("sk-super-secret")
  })

  test("a wrong field names the field, instead of dumping a zod error", () => {
    writeFileSync(conf, JSON.stringify({ model: 42 }))
    expect(() => loadConfig(conf)).toThrow(/"model" must be a string/)

    writeFileSync(conf, JSON.stringify({ providers: { x: { type: "nope" } } }))
    expect(() => loadConfig(conf)).toThrow(/providers\."x"\.type must be one of/)

    writeFileSync(conf, JSON.stringify({ providers: { x: { type: "anthropic", baseURL: 1 } } }))
    expect(() => loadConfig(conf)).toThrow(/baseURL must be a non-empty string/)
  })

  test("★ the array form of models normalizes to an object — downstream accepts only one shape", () => {
    writeFileSync(conf, JSON.stringify({ providers: { x: { type: "anthropic", models: ["a", "b"] } } }))
    expect(loadConfig(conf).providers?.["x"]?.models).toEqual({ a: {}, b: {} })

    writeFileSync(
      conf,
      JSON.stringify({
        providers: { x: { type: "anthropic", models: { a: { limit: { context: 1, output: 2 } }, b: {} } } },
      }),
    )
    expect(loadConfig(conf).providers?.["x"]?.models).toEqual({ a: { limit: { context: 1, output: 2 } }, b: {} })
  })

  test("each model's own limit is validated too, and the error names the model", () => {
    writeFileSync(conf, JSON.stringify({ providers: { x: { type: "anthropic", models: { a: { limit: 5 } } } } }))
    expect(() => loadConfig(conf)).toThrow(/models\."a"\.limit must be/)
  })

  test("models accepts both forms; a wrong one says what it should look like", () => {
    writeFileSync(conf, JSON.stringify({ providers: { x: { type: "anthropic", models: "a" } } }))
    expect(() => loadConfig(conf)).toThrow(/models must be either/)

    writeFileSync(conf, JSON.stringify({ providers: { x: { type: "anthropic", models: ["a", ""] } } }))
    expect(() => loadConfig(conf)).toThrow(/models must be either/)
  })

  test("removing a provider also clears the default model that points at it", () => {
    saveConfig({ model: "minimax/M3", providers: { minimax: { type: "anthropic" }, other: { type: "openai-chat" } } }, conf)
    expect(removeProvider("minimax", conf)).toBe(true)
    const after = loadConfig(conf)
    // Left in place, the next startup goes straight to unknown model, and the user has no
    // idea why
    expect(after.model).toBeUndefined()
    expect(Object.keys(after.providers ?? {})).toEqual(["other"])
  })

  test("removing another provider leaves the default model alone", () => {
    saveConfig({ model: "minimax/M3", providers: { minimax: { type: "anthropic" }, other: { type: "openai-chat" } } }, conf)
    removeProvider("other", conf)
    expect(loadConfig(conf).model).toBe("minimax/M3")
  })

  test("★ unrecognized permission modes all fall back to auto, no special case for any old name", () => {
    writeFileSync(conf, JSON.stringify({ permission: "future-old-name" }))
    expect(loadConfig(conf).permission).toBe("auto")
  })

  test("a permission mode that isn't a string still errors", () => {
    writeFileSync(conf, JSON.stringify({ permission: 42 }))
    expect(() => loadConfig(conf)).toThrow(/"permission" must be one of/)
  })

  test("★ provider type accepts only the three current protocol names, no silent guessing from old aliases", () => {
    for (const type of ["openai", "openai-compat"]) {
      writeFileSync(conf, JSON.stringify({ providers: { gateway: { type } } }))
      try {
        loadConfig(conf)
        throw new Error("expected invalid provider type")
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidProviderTypeError)
        expect(error).toMatchObject({ providerID: "gateway", value: type, path: conf })
      }
    }
  })

  test("★ the startup repair swaps only the protocol the user picked, rewrites no other field of that provider", () => {
    writeFileSync(conf, JSON.stringify({
      model: "MINIMAX/MiniMax-M2.5",
      providers: { MINIMAX: { type: "openai", baseURL: "https://example.test/v1", futureField: { keep: true } } },
    }))
    repairProviderType("MINIMAX", "anthropic", conf)
    const raw = JSON.parse(readFileSync(conf, "utf8"))
    expect(raw).toEqual({
      model: "MINIMAX/MiniMax-M2.5",
      providers: { MINIMAX: { type: "anthropic", baseURL: "https://example.test/v1", futureField: { keep: true } } },
    })
    expect(loadConfig(conf).providers?.["MINIMAX"]?.type).toBe("anthropic")
  })
})

// ─────────────────────────────────────────────── Precedence

describe("★ environment vs. file precedence", () => {
  const config = {
    model: "minimax/MiniMax-M3",
    providers: {
      minimax: { type: "anthropic" as const, baseURL: "https://api.minimaxi.com/anthropic/v1" },
      deepseek: { type: "openai-chat" as const, baseURL: "https://api.deepseek.com/v1" },
    },
  }
  const store = { minimax: { apiKey: "file-minimax" }, deepseek: { apiKey: "file-deepseek" } }
  const find = (env: Record<string, string | undefined>, id: string) =>
    resolveProviders({ config, auth: store, env }).find((p) => p.id === id)!

  test("with no env var, the file's value is used", () => {
    const provider = find({}, "minimax")
    expect(provider.apiKey).toBe("file-minimax")
    expect(provider.source).toBe("file")
    expect(provider.baseURL).toBe("https://api.minimaxi.com/anthropic/v1")
  })

  test("the env var wins — the temporary should override the long-lived", () => {
    const provider = find({ ALFA_KEY_MINIMAX: "env-key" }, "minimax")
    expect(provider.apiKey).toBe("env-key")
    expect(provider.source).toBe("env")
  })

  test("built-in ids honor the legacy env var names (existing usage and CI must not break)", () => {
    const provider = find({ ANTHROPIC_API_KEY: "legacy" }, "anthropic")
    expect(provider.apiKey).toBe("legacy")
    expect(provider.source).toBe("env")
  })

  test("a named provider's baseURL can be overridden by env var too", () => {
    expect(find({ ALFA_BASE_URL_MINIMAX: "https://gateway/v1" }, "minimax").baseURL).toBe("https://gateway/v1")
  })

  test("hyphens in the id become underscores in the env var name", () => {
    const provider = resolveProviders({
      config: { providers: { "my-gateway": { type: "openai-chat" } } },
      auth: {},
      env: { ALFA_KEY_MY_GATEWAY: "k" },
    }).find((p) => p.id === "my-gateway")!
    expect(provider.apiKey).toBe("k")
  })

  test("the three built-in ids always exist, even with zero config", () => {
    const ids = resolveProviders({ env: {} }).map((p) => p.id)
    expect(ids).toContain("anthropic")
    expect(ids).toContain("openai")
    expect(ids).toContain("openai-chat")
  })

  test("a provider seen only in auth.json defaults to openai-chat", () => {
    const provider = resolveProviders({ auth: { mystery: { apiKey: "k" } }, env: {} }).find((p) => p.id === "mystery")!
    expect(provider.type).toBe("openai-chat")
  })

  test("★ how reasoning is replayed is decided per provider, three different paths", () => {
    const registry = buildRegistry({
      config: {
        providers: {
          minimax: { type: "anthropic", baseURL: "https://api.minimaxi.com/anthropic/v1" },
          openai: { type: "openai-responses" },
          deepseek: { type: "openai-chat", baseURL: "https://api.deepseek.com/v1" },
          picky: { type: "openai-chat", baseURL: "https://picky/v1", replayReasoning: false },
        },
      },
      auth: { minimax: { apiKey: "k" }, openai: { apiKey: "k" }, deepseek: { apiKey: "k" }, picky: { apiKey: "k" } },
      env: {},
    })
    // The anthropic one goes by signature, no choice there: it can't accept unsigned ones
    expect(registry.resolve("minimax/MiniMax-M3").replayReasoning).toBe("signed")
    // Responses summaries without item metadata can't be legally replayed
    expect(registry.resolve("openai/gpt-5").replayReasoning).toBe("none")
    // Compatible endpoints have no notion of signatures; by default send the text as is
    expect(registry.resolve("deepseek/x").replayReasoning).toBe("text")
    // An endpoint that errors on receiving reasoning_content gets it turned off in config
    expect(registry.resolve("picky/x").replayReasoning).toBe("none")
  })

  test("a non-boolean replayReasoning errors, and says which provider", () => {
    const path = join(dir, "bad-replay.json")
    writeFileSync(path, JSON.stringify({ providers: { x: { type: "openai-chat", replayReasoning: "yes" } } }))
    expect(() => loadConfig(path)).toThrow(/replayReasoning/)
  })

  test("a provider without a key is marked none", () => {
    expect(resolveProviders({ env: {} }).find((p) => p.id === "anthropic")!.source).toBe("none")
  })

  test("★ MiniMax and real Anthropic configured together — once named, they no longer clobber each other", () => {
    const providers = resolveProviders({
      config: {
        providers: {
          minimax: { type: "anthropic", baseURL: "https://api.minimaxi.com/anthropic/v1" },
          anthropic: { type: "anthropic" },
        },
      },
      auth: { minimax: { apiKey: "mm" }, anthropic: { apiKey: "ant" } },
      env: {},
    })
    const byID = Object.fromEntries(providers.map((p) => [p.id, p]))
    expect(byID["minimax"]!.apiKey).toBe("mm")
    expect(byID["minimax"]!.baseURL).toBe("https://api.minimaxi.com/anthropic/v1")
    expect(byID["anthropic"]!.apiKey).toBe("ant")
    expect(byID["anthropic"]!.baseURL).toBeUndefined() // official endpoint
  })
})

describe("default model", () => {
  test("ALFA_MODEL wins", () => {
    expect(defaultModelSpec({ config: { model: "a/b" }, env: { ALFA_MODEL: "x/y" } })).toBe("x/y")
  })

  test("then config.model", () => {
    expect(defaultModelSpec({ config: { model: "minimax/MiniMax-M3" }, env: {} })).toBe("minimax/MiniMax-M3")
  })

  test("otherwise the first provider with credentials", () => {
    const spec = defaultModelSpec({
      config: { providers: { minimax: { type: "anthropic" } } },
      auth: { minimax: { apiKey: "k" } },
      env: {},
    })
    expect(spec?.startsWith("minimax/")).toBe(true)
  })

  test("no credentials at all returns undefined — the CLI prompts for auth login", () => {
    expect(defaultModelSpec({ env: {} })).toBeUndefined()
  })

  test("★ OPENAI_BASE_URL doesn't change the protocol — the built-in openai is always Responses", () => {
    expect(defaultModelSpec({ env: { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://gateway/v1" } }))
      .toBe("openai/gpt-4o-mini")
  })

  test("with only an official OpenAI key, the default goes through Responses", () => {
    expect(defaultModelSpec({ env: { OPENAI_API_KEY: "k" } })).toBe("openai/gpt-4o-mini")
  })
})

// ─────────────────────────────────────────────── /model candidates

describe("★ the candidate list shows only models that can be listed and actually switched to", () => {
  const config = {
    providers: {
      minimax: { type: "openai-chat" as const, models: { "MiniMax-M3": {} } },
      broke: { type: "openai-chat" as const, models: { "some-model": {} } },
    },
  }

  test("a provider without credentials lists nothing — listing it would make the user test it for us", () => {
    const registry = buildRegistry({ config, auth: { minimax: { apiKey: "k" } }, env: {} })
    expect(registry.catalog()).toEqual(["minimax/MiniMax-M3"])
  })

  test("openai-chat without configured models doesn't guess — guessed candidates look selectable", () => {
    const registry = buildRegistry({
      config: { providers: { deepseek: { type: "openai-chat" } } },
      auth: { deepseek: { apiKey: "k" } },
      env: {},
    })
    expect(registry.catalog()).toEqual([])
  })

  test("★ anthropic with a changed baseURL lists nothing — that table describes the real Anthropic", () => {
    // The real config shape on the user's machine: MiniMax's Anthropic-compatible endpoint
    const registry = buildRegistry({
      config: { providers: { minimax: { type: "anthropic", baseURL: "https://api.minimaxi.com/anthropic/v1" } } },
      auth: { minimax: { apiKey: "k" } },
      env: {},
    })
    // Listing minimax/claude-sonnet-4-5 would be fabricating facts: that name most likely
    // doesn't exist over there, while the list looks exactly like a menu of choices
    expect(registry.catalog()).toEqual([])
  })

  test("anthropic has a built-in table; a configured list takes precedence", () => {
    const withTable = buildRegistry({ auth: { anthropic: { apiKey: "k" } }, env: {} }).catalog()
    expect(withTable.length).toBeGreaterThan(0)
    expect(withTable.every((spec) => spec.startsWith("anthropic/"))).toBe(true)

    // This id may well be just a compatible endpoint forwarding a few models, where that
    // table would be wrong
    const declared = buildRegistry({
      config: { providers: { anthropic: { type: "anthropic", models: { "only-this": {} } } } },
      auth: { anthropic: { apiKey: "k" } },
      env: {},
    }).catalog()
    expect(declared).toEqual(["anthropic/only-this"])
  })

  test("the template's official address still lists the built-in table", () => {
    const registry = buildRegistry({
      config: { providers: { anthropic: { type: "anthropic", baseURL: "https://api.anthropic.com/v1" } } },
      auth: { anthropic: { apiKey: "k" } },
      env: {},
    })
    expect(registry.catalog().length).toBeGreaterThan(0)
  })

  /**
   * ★ `env` is what makes this function testable, so the providers it builds must not
   *   read process.env behind its back. The base URL used to leak through: a shell with
   *   ANTHROPIC_BASE_URL set turned the "built-in table" test above red.
   */
  test("★ a registry built with env: {} ignores the real environment's base URLs", () => {
    const saved = process.env["ANTHROPIC_BASE_URL"]
    process.env["ANTHROPIC_BASE_URL"] = "https://gateway.example/anthropic"
    try {
      expect(buildRegistry({ auth: { anthropic: { apiKey: "k" } }, env: {} }).catalog().length).toBeGreaterThan(0)
    } finally {
      if (saved === undefined) delete process.env["ANTHROPIC_BASE_URL"]
      else process.env["ANTHROPIC_BASE_URL"] = saved
    }
  })
})
// ─────────────────────────────────────────────── Where the window comes from

describe("★ window: the model's own > the provider's > built-in table > fallback", () => {
  const build = (providers: Record<string, any>, id: string, model: string) =>
    buildRegistry({ config: { providers }, auth: { [id]: { apiKey: "k" } }, env: {} }).resolve(`${id}/${model}`).info

  test("the model's own limit beats the provider's", () => {
    const info = build(
      {
        gw: {
          type: "openai-chat",
          limit: { context: 128_000, output: 8_000 },
          models: { small: {}, big: { limit: { context: 1_000_000, output: 64_000 } } },
        },
      },
      "gw",
      "big",
    )
    expect(info.limit).toEqual({ context: 1_000_000, output: 64_000 })
    expect(info.limitSource).toBe("config")
  })

  test("without its own, it inherits the provider's — ten models on one gateway sharing a window is common", () => {
    const info = build(
      { gw: { type: "openai-chat", limit: { context: 128_000, output: 8_000 }, models: { small: {} } } },
      "gw",
      "small",
    )
    expect(info.limit).toEqual({ context: 128_000, output: 8_000 })
  })

  test("an unknown model uses the 256k fallback until setup or settings records its real window", () => {
    const info = build({ gw: { type: "openai-chat", models: { unknown: {} } } }, "gw", "unknown")
    expect(info.limit.context).toBe(256_000)
    expect(info.limitSource).toBe("default")
  })

  test("★ a type: anthropic provider honors limit too — it was once silently ignored", () => {
    const info = build(
      {
        mm: {
          type: "anthropic",
          baseURL: "https://api.minimaxi.com/anthropic/v1",
          models: { "MiniMax-M3": { limit: { context: 200_000, output: 32_000 } } },
        },
      },
      "mm",
      "MiniMax-M3",
    )
    expect(info.limit).toEqual({ context: 200_000, output: 32_000 })
    expect(info.limitSource).toBe("config")
  })

  test("★ config beats the built-in table — the table is for real Anthropic; a compatible endpoint may differ", () => {
    const table = buildRegistry({ auth: { anthropic: { apiKey: "k" } }, env: {} }).resolve("anthropic/claude-opus-4-1").info
    expect(table.limit.context).toBe(200_000)
    expect(table.limitSource).toBe("model")

    const overridden = build(
      { anthropic: { type: "anthropic", models: { "claude-opus-4-1": { limit: { context: 42, output: 7 } } } } },
      "anthropic",
      "claude-opus-4-1",
    )
    expect(overridden.limit).toEqual({ context: 42, output: 7 })
    expect(overridden.limitSource).toBe("config")
  })
})

// ─────────────────────────────────────────────── /reset

describe("★ reset lists only what exists, and deletes it cleanly", () => {
  test("missing directories stay off the list — a '(missing)' line would bury the two lines really being deleted", () => {
    const home = mkdtempSync(join(tmpdir(), "apc-reset-"))
    const before = { XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"], XDG_DATA_HOME: process.env["XDG_DATA_HOME"] }
    process.env["XDG_CONFIG_HOME"] = join(home, "config")
    process.env["XDG_DATA_HOME"] = join(home, "data")
    try {
      const root = join(home, "project")
      mkdirSync(root, { recursive: true })
      expect(resetScope(root).global).toEqual([])

      // Create config + credentials + a project note
      mkdirSync(join(home, "config", "alfa"), { recursive: true })
      writeFileSync(join(home, "config", "alfa", "config.json"), "{}")
      mkdirSync(join(home, "data", "alfa"), { recursive: true })
      writeFileSync(join(home, "data", "alfa", "auth.json"), '{"x":{"apiKey":"k"}}', { mode: 0o600 })
      mkdirSync(join(root, ".alfa", "memory"), { recursive: true })
      writeFileSync(join(root, ".alfa", "memory", "a.md"), "note")

      const scope = resetScope(root)
      expect(scope.global).toHaveLength(2)
      // The one holding keys gets flagged — the confirmation screen has to say separately
      // "this can't be recovered"
      expect(scope.global.some((t) => t.hasCredentials)).toBe(true)
      expect(scope.global.every((t) => t.bytes > 0)).toBe(true)
      // The project directory gets its own column: not deleted by default
      expect(scope.project).toHaveLength(1)

      // Delete only the two global ones; the project's stays
      const outcome = performReset(scope.global)
      expect(outcome.failed).toEqual([])
      expect(outcome.removed).toHaveLength(2)
      expect(existsSync(join(home, "config", "alfa"))).toBe(false)
      expect(existsSync(join(home, "data", "alfa"))).toBe(false)
      expect(existsSync(join(root, ".alfa", "memory", "a.md"))).toBe(true)
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("already gone counts as deleted — running reset a second time must not error", () => {
    const gone = join(tmpdir(), "apc-reset-never-existed")
    const outcome = performReset([{ path: gone, what: "x", bytes: 0 }])
    expect(outcome.removed).toEqual([gone])
    expect(outcome.failed).toEqual([])
  })
})


test("theme and tool-output preferences persist; an invalid theme names the field", () => {
  saveConfig({ appearance: { theme: "light", toolOutput: "expanded" } }, conf)
  expect(loadConfig(conf).appearance).toEqual({ theme: "light", toolOutput: "expanded" })
  writeFileSync(conf, JSON.stringify({ appearance: { theme: "typo" } }))
  expect(() => loadConfig(conf)).toThrow("appearance.theme")
})

test("sandbox accepts only an explicit boolean, and the off state persists across launches", () => {
  saveConfig({ sandbox: false }, conf)
  expect(loadConfig(conf).sandbox).toBe(false)
  writeFileSync(conf, '{"sandbox":"off"}')
  expect(() => loadConfig(conf)).toThrow("sandbox must be boolean")
})
