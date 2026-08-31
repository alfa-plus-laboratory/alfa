/**
 * 配置与凭据持久化。
 *
 * 两类 bug 在这里格外阴:
 *   - **优先级搞反**:一切看起来都正常,只是用了另一把 key。用户 export 了
 *     新 key 却被半年前存的旧 key 顶掉,查起来会疯。
 *   - **文件权限**:0644 的密钥文件不会报错、不会影响功能,只是同机器上
 *     别的用户能读走。没有测试盯着就没人会发现。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadAuth, maskKey, removeCredential, saveAuth, setCredential } from "../src/config/auth.ts"
import { loadConfig, rememberAgentflow, removeProvider, saveConfig, setProvider } from "../src/config/config.ts"
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

describe("凭据文件", () => {
  test("★ 创建出来就是 0600", () => {
    setCredential("minimax", { apiKey: "sk-secret" }, auth)
    expect(statSync(auth).mode & 0o777).toBe(0o600)
  })

  test("★ 目录是 0700", () => {
    const nested = join(dir, "sub", "auth.json")
    setCredential("x", { apiKey: "k" }, nested)
    expect(statSync(join(dir, "sub")).mode & 0o777).toBe(0o700)
  })

  test("覆盖写之后权限仍然是 0600", () => {
    setCredential("a", { apiKey: "k1" }, auth)
    chmodSync(auth, 0o644) // 模拟被别的工具改宽
    setCredential("b", { apiKey: "k2" }, auth)
    expect(statSync(auth).mode & 0o777).toBe(0o600)
  })

  test("权限被放宽时读取要出声,但不失败", () => {
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

  test("增删查", () => {
    setCredential("a", { apiKey: "k1" }, auth)
    setCredential("b", { apiKey: "k2" }, auth)
    expect(Object.keys(loadAuth(auth)).toSorted()).toEqual(["a", "b"])
    expect(removeCredential("a", auth)).toBe(true)
    expect(removeCredential("nope", auth)).toBe(false)
    expect(Object.keys(loadAuth(auth))).toEqual(["b"])
  })

  test("文件不存在 = 空,不是报错", () => {
    expect(loadAuth(join(dir, "missing.json"))).toEqual({})
  })

  test("★ 文件损坏要明说,不能静默当成没有凭据", () => {
    writeFileSync(auth, "{ this is not json")
    // 静默返回 {} 的话,用户看到的是 "no credentials",完全猜不到是文件坏了
    expect(() => loadAuth(auth)).toThrow(/not valid JSON/)
  })

  test("缺 apiKey 的条目忽略掉", () => {
    writeFileSync(auth, JSON.stringify({ a: {}, b: { apiKey: "" }, c: { apiKey: "ok" } }))
    expect(Object.keys(loadAuth(auth))).toEqual(["c"])
  })

  test("写坏一次不会丢掉已有凭据(原子写)", () => {
    setCredential("a", { apiKey: "k1" }, auth)
    const before = readFileSync(auth, "utf8")
    try {
      saveAuth({ a: { apiKey: "k1" }, b: { apiKey: "k2" } }, join(dir, "no-such-dir-created", "x", "auth.json"))
    } catch {
      /* 无所谓 */
    }
    expect(readFileSync(auth, "utf8")).toBe(before)
  })
})

describe("maskKey", () => {
  test("留两端,中间遮掉", () => {
    expect(maskKey("sk-cp-ABCDEFGHIJKLMNOP")).toBe("sk-cp-…MNOP")
  })
  test("短 key 全遮 —— 露两端等于露完", () => {
    expect(maskKey("short")).toBe("*****")
    expect(maskKey("ab")).toBe("****")
  })
  test("掩码里不含原文中段", () => {
    const key = "sk-cp-SECRETMIDDLE1234"
    expect(maskKey(key)).not.toContain("SECRETMIDDLE")
  })
})

// ─────────────────────────────────────────────── config.json

describe("配置文件", () => {
  test("往返", () => {
    saveConfig({ model: "minimax/MiniMax-M3", providers: { minimax: { type: "anthropic", baseURL: "https://x/v1" } } }, conf)
    const loaded = loadConfig(conf)
    expect(loaded.model).toBe("minimax/MiniMax-M3")
    expect(loaded.providers?.["minimax"]).toEqual({ type: "anthropic", baseURL: "https://x/v1" })
  })

  test("agentflow:false 或者一个 2-12 的数,别的都要指出来", () => {
    writeFileSync(conf, JSON.stringify({ agentflow: 6 }))
    expect(loadConfig(conf).agentflow).toBe(6)

    writeFileSync(conf, JSON.stringify({ agentflow: false }))
    expect(loadConfig(conf).agentflow).toBe(false)

    // 手写配置的人会照着别的开关写 true。为了逼他改成数字而让程序打不开,不成比例
    writeFileSync(conf, JSON.stringify({ agentflow: true }))
    expect(loadConfig(conf).agentflow).toBe(FLOW_WINDOW)

    for (const bad of [0, 1, 99, 3.5, "6"]) {
      writeFileSync(conf, JSON.stringify({ agentflow: bad }))
      expect(() => loadConfig(conf)).toThrow(/"agentflow" must be false, or how many subagents/)
    }
  })

  test("agentflow 关掉是**写一个 false**,不是把键删掉 —— 删掉读起来像没设置过", () => {
    rememberAgentflow(6, conf)
    expect(loadConfig(conf).agentflow).toBe(6)
    rememberAgentflow(false, conf)
    expect(JSON.parse(readFileSync(conf, "utf8"))).toHaveProperty("agentflow", false)
  })

  test("★ config.json 里不该出现密钥", () => {
    setProvider("minimax", { type: "anthropic", baseURL: "https://x/v1" }, conf)
    setCredential("minimax", { apiKey: "sk-super-secret-value" }, auth)
    expect(readFileSync(conf, "utf8")).not.toContain("sk-super-secret")
  })

  test("字段写错要指出是哪个字段,不是吐 zod 报错", () => {
    writeFileSync(conf, JSON.stringify({ model: 42 }))
    expect(() => loadConfig(conf)).toThrow(/"model" must be a string/)

    writeFileSync(conf, JSON.stringify({ providers: { x: { type: "nope" } } }))
    expect(() => loadConfig(conf)).toThrow(/providers\."x"\.type must be one of/)

    writeFileSync(conf, JSON.stringify({ providers: { x: { type: "anthropic", baseURL: 1 } } }))
    expect(() => loadConfig(conf)).toThrow(/baseURL must be a non-empty string/)
  })

  test("★ models 的数组写法归一成对象 —— 下游只认一种形状", () => {
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

  test("每个模型自己的 limit 也要校验,而且报得出是哪个模型", () => {
    writeFileSync(conf, JSON.stringify({ providers: { x: { type: "anthropic", models: { a: { limit: 5 } } } } }))
    expect(() => loadConfig(conf)).toThrow(/models\."a"\.limit must be/)
  })

  test("models 两种写法都收,写错要说清该长什么样", () => {
    writeFileSync(conf, JSON.stringify({ providers: { x: { type: "anthropic", models: "a" } } }))
    expect(() => loadConfig(conf)).toThrow(/models must be either/)

    writeFileSync(conf, JSON.stringify({ providers: { x: { type: "anthropic", models: ["a", ""] } } }))
    expect(() => loadConfig(conf)).toThrow(/models must be either/)
  })

  test("删 provider 时把指向它的默认模型一起清掉", () => {
    saveConfig({ model: "minimax/M3", providers: { minimax: { type: "anthropic" }, other: { type: "openai-compat" } } }, conf)
    expect(removeProvider("minimax", conf)).toBe(true)
    const after = loadConfig(conf)
    // 留着的话下次启动直接 unknown model,而用户完全不知道为什么
    expect(after.model).toBeUndefined()
    expect(Object.keys(after.providers ?? {})).toEqual(["other"])
  })

  test("删别的 provider 不动默认模型", () => {
    saveConfig({ model: "minimax/M3", providers: { minimax: { type: "anthropic" }, other: { type: "openai-compat" } } }, conf)
    removeProvider("other", conf)
    expect(loadConfig(conf).model).toBe("minimax/M3")
  })

  test("★ 老配置里存着的 permission: auto 照样能启动,读成 trust", () => {
    // 改名那次留下的存档。一个升级之后启动不了的程序,比一个改了名的模式糟糕得多
    writeFileSync(conf, JSON.stringify({ permission: "auto" }))
    expect(loadConfig(conf).permission).toBe("trust")
  })

  test("认不出来的模式名还是要报错", () => {
    writeFileSync(conf, JSON.stringify({ permission: "yolo" }))
    expect(() => loadConfig(conf)).toThrow(/"permission" must be one of/)
  })
})

// ─────────────────────────────────────────────── 优先级

describe("★ 环境变量与文件的优先级", () => {
  const config = {
    model: "minimax/MiniMax-M3",
    providers: {
      minimax: { type: "anthropic" as const, baseURL: "https://api.minimaxi.com/anthropic/v1" },
      deepseek: { type: "openai-compat" as const, baseURL: "https://api.deepseek.com/v1" },
    },
  }
  const store = { minimax: { apiKey: "file-minimax" }, deepseek: { apiKey: "file-deepseek" } }
  const find = (env: Record<string, string | undefined>, id: string) =>
    resolveProviders({ config, auth: store, env }).find((p) => p.id === id)!

  test("没有环境变量时用文件里的", () => {
    const provider = find({}, "minimax")
    expect(provider.apiKey).toBe("file-minimax")
    expect(provider.source).toBe("file")
    expect(provider.baseURL).toBe("https://api.minimaxi.com/anthropic/v1")
  })

  test("环境变量赢 —— 临时的应该盖住长期的", () => {
    const provider = find({ ALFA_KEY_MINIMAX: "env-key" }, "minimax")
    expect(provider.apiKey).toBe("env-key")
    expect(provider.source).toBe("env")
  })

  test("内置 id 认老的环境变量名(不能破坏现有用法和 CI)", () => {
    const provider = find({ ANTHROPIC_API_KEY: "legacy" }, "anthropic")
    expect(provider.apiKey).toBe("legacy")
    expect(provider.source).toBe("env")
  })

  test("具名 provider 也能被环境变量覆盖 baseURL", () => {
    expect(find({ ALFA_BASE_URL_MINIMAX: "https://gateway/v1" }, "minimax").baseURL).toBe("https://gateway/v1")
  })

  test("id 里的连字符在环境变量名里变下划线", () => {
    const provider = resolveProviders({
      config: { providers: { "my-gateway": { type: "openai-compat" } } },
      auth: {},
      env: { ALFA_KEY_MY_GATEWAY: "k" },
    }).find((p) => p.id === "my-gateway")!
    expect(provider.apiKey).toBe("k")
  })

  test("两个内置 id 永远存在,即使零配置", () => {
    const ids = resolveProviders({ env: {} }).map((p) => p.id)
    expect(ids).toContain("anthropic")
    expect(ids).toContain("openai-compat")
  })

  test("只在 auth.json 里出现过的 provider 默认按 openai-compat 处理", () => {
    const provider = resolveProviders({ auth: { mystery: { apiKey: "k" } }, env: {} }).find((p) => p.id === "mystery")!
    expect(provider.type).toBe("openai-compat")
  })

  test("★ 思考怎么回灌由 provider 定,两条路不一样", () => {
    const registry = buildRegistry({
      config: {
        providers: {
          minimax: { type: "anthropic", baseURL: "https://api.minimaxi.com/anthropic/v1" },
          deepseek: { type: "openai-compat", baseURL: "https://api.deepseek.com/v1" },
          picky: { type: "openai-compat", baseURL: "https://picky/v1", replayReasoning: false },
        },
      },
      auth: { minimax: { apiKey: "k" }, deepseek: { apiKey: "k" }, picky: { apiKey: "k" } },
      env: {},
    })
    // anthropic 那条按签名走,没得选:没签名的它收不了
    expect(registry.resolve("minimax/MiniMax-M3").replayReasoning).toBe("signed")
    // 兼容端点没有签名这一说,默认原样发文本
    expect(registry.resolve("deepseek/x").replayReasoning).toBe("text")
    // 收到 reasoning_content 会报错的端点,配置里关掉
    expect(registry.resolve("picky/x").replayReasoning).toBe("none")
  })

  test("replayReasoning 不是布尔就报错,而且说清哪个 provider", () => {
    const path = join(dir, "bad-replay.json")
    writeFileSync(path, JSON.stringify({ providers: { x: { type: "openai-compat", replayReasoning: "yes" } } }))
    expect(() => loadConfig(path)).toThrow(/replayReasoning/)
  })

  test("没有 key 的 provider 标成 none", () => {
    expect(resolveProviders({ env: {} }).find((p) => p.id === "anthropic")!.source).toBe("none")
  })

  test("★ 同时配 MiniMax 和真 Anthropic —— 具名之后不再互相顶掉", () => {
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
    expect(byID["anthropic"]!.baseURL).toBeUndefined() // 官方端点
  })
})

describe("默认模型", () => {
  test("ALFA_MODEL 最大", () => {
    expect(defaultModelSpec({ config: { model: "a/b" }, env: { ALFA_MODEL: "x/y" } })).toBe("x/y")
  })

  test("其次是 config.model", () => {
    expect(defaultModelSpec({ config: { model: "minimax/MiniMax-M3" }, env: {} })).toBe("minimax/MiniMax-M3")
  })

  test("都没有就挑第一个有凭据的 provider", () => {
    const spec = defaultModelSpec({
      config: { providers: { minimax: { type: "anthropic" } } },
      auth: { minimax: { apiKey: "k" } },
      env: {},
    })
    expect(spec?.startsWith("minimax/")).toBe(true)
  })

  test("一个凭据都没有时返回 undefined —— 让 CLI 去提示 auth login", () => {
    expect(defaultModelSpec({ env: {} })).toBeUndefined()
  })
})

// ─────────────────────────────────────────────── /model 的候选

describe("★ 候选清单只列得出来、又切得过去的", () => {
  const config = {
    providers: {
      minimax: { type: "openai-compat" as const, models: { "MiniMax-M3": {} } },
      broke: { type: "openai-compat" as const, models: { "some-model": {} } },
    },
  }

  test("没凭据的那家一个都不列 —— 列出来等于让用户替我们试错", () => {
    const registry = buildRegistry({ config, auth: { minimax: { apiKey: "k" } }, env: {} })
    expect(registry.catalog()).toEqual(["minimax/MiniMax-M3"])
  })

  test("没配 models 的 openai-compat 不猜 —— 猜出来的候选看起来是能选的", () => {
    const registry = buildRegistry({
      config: { providers: { deepseek: { type: "openai-compat" } } },
      auth: { deepseek: { apiKey: "k" } },
      env: {},
    })
    expect(registry.catalog()).toEqual([])
  })

  test("★ 换了 baseURL 的 anthropic 一个都不列 —— 那张表讲的是真 Anthropic", () => {
    // 用户机器上的真配置形状:MiniMax 的 Anthropic 兼容端点
    const registry = buildRegistry({
      config: { providers: { minimax: { type: "anthropic", baseURL: "https://api.minimaxi.com/anthropic/v1" } } },
      auth: { minimax: { apiKey: "k" } },
      env: {},
    })
    // 列 minimax/claude-sonnet-4-5 是在凭空造事实:那个名字在那边多半不存在,
    // 而清单看起来就是一张可选列表
    expect(registry.catalog()).toEqual([])
  })

  test("anthropic 有自带的一张表,配置写了就以配置为准", () => {
    const withTable = buildRegistry({ auth: { anthropic: { apiKey: "k" } }, env: {} }).catalog()
    expect(withTable.length).toBeGreaterThan(0)
    expect(withTable.every((spec) => spec.startsWith("anthropic/"))).toBe(true)

    // 这个 id 很可能只是个转发某几个模型的兼容端点,那张表在那儿是错的
    const declared = buildRegistry({
      config: { providers: { anthropic: { type: "anthropic", models: { "only-this": {} } } } },
      auth: { anthropic: { apiKey: "k" } },
      env: {},
    }).catalog()
    expect(declared).toEqual(["anthropic/only-this"])
  })
})
// ─────────────────────────────────────────────── 窗口从哪来

describe("★ 窗口:模型自己的 > 这一家的 > 内置表 > 兜底", () => {
  const build = (providers: Record<string, any>, id: string, model: string) =>
    buildRegistry({ config: { providers }, auth: { [id]: { apiKey: "k" } }, env: {} }).resolve(`${id}/${model}`).info

  test("模型自己写的赢过这一家写的", () => {
    const info = build(
      {
        gw: {
          type: "openai-compat",
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

  test("没写自己的就往上取这一家的 —— 一个网关上十个模型同一个窗口是常事", () => {
    const info = build(
      { gw: { type: "openai-compat", limit: { context: 128_000, output: 8_000 }, models: { small: {} } } },
      "gw",
      "small",
    )
    expect(info.limit).toEqual({ context: 128_000, output: 8_000 })
  })

  test("★ type: anthropic 的 provider 也要认 limit —— 它一度被安静地忽略", () => {
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

  test("★ 配置压过内置那张表 —— 表讲的是真 Anthropic,而兼容端点可能给另一个窗口", () => {
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

describe("★ 重置只列存在的东西,而且删得干净", () => {
  test("不存在的目录不进清单 —— 一行「(不存在)」会把真要删的那两行淹掉", () => {
    const home = mkdtempSync(join(tmpdir(), "apc-reset-"))
    const before = { XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"], XDG_DATA_HOME: process.env["XDG_DATA_HOME"] }
    process.env["XDG_CONFIG_HOME"] = join(home, "config")
    process.env["XDG_DATA_HOME"] = join(home, "data")
    try {
      const root = join(home, "project")
      mkdirSync(root, { recursive: true })
      expect(resetScope(root).global).toEqual([])

      // 造出配置 + 凭据 + 项目便条
      mkdirSync(join(home, "config", "alfa"), { recursive: true })
      writeFileSync(join(home, "config", "alfa", "config.json"), "{}")
      mkdirSync(join(home, "data", "alfa"), { recursive: true })
      writeFileSync(join(home, "data", "alfa", "auth.json"), '{"x":{"apiKey":"k"}}')
      mkdirSync(join(root, ".alfa", "memory"), { recursive: true })
      writeFileSync(join(root, ".alfa", "memory", "a.md"), "note")

      const scope = resetScope(root)
      expect(scope.global).toHaveLength(2)
      // 有 key 的那个要立起旗子 —— 确认那一屏得单独说一句"找不回来"
      expect(scope.global.some((t) => t.hasCredentials)).toBe(true)
      expect(scope.global.every((t) => t.bytes > 0)).toBe(true)
      // 项目目录单独一栏:默认不删
      expect(scope.project).toHaveLength(1)

      // 只删全局那两个,项目的留着
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

  test("已经不在了也算删掉 —— 重置不该因为跑第二遍而报错", () => {
    const gone = join(tmpdir(), "apc-reset-never-existed")
    const outcome = performReset([{ path: gone, what: "x", bytes: 0 }])
    expect(outcome.removed).toEqual([gone])
    expect(outcome.failed).toEqual([])
  })
})
