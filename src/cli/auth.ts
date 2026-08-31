/**
 * `alfa auth …` —— 凭据的增删查。
 *
 * 设计上只有一条不能松的线:**任何输出都不得包含完整密钥**。
 * 没有 --show-key,没有"确认一下你输的对不对"的回显,报错信息里也不带。
 * 需要确认输对了没,就靠保存后那次真实请求 —— 那比让用户肉眼核对可靠得多。
 */
import { PROVIDER_TYPES, loadConfig, configPath, removeProvider, saveConfig, type ProviderType } from "../config/config.ts"
import { authPath, loadAuth, maskKey, removeCredential, setCredential } from "../config/auth.ts"
import { buildRegistry, resolveProviders } from "../llm/setup.ts"
import type { LLMRegistry } from "../llm/registry.ts"
import { stream } from "../llm/stream.ts"
import { InputCancelled, readLine, readSecret } from "./secret-input.ts"
import { programName } from "./program.ts"
import { theme } from "./theme.ts"

/** 见 cli/program.ts:命令示例里那个名字要跟用户刚才敲的那个一致。 */
export function authUsage(): string {
  const me = programName()
  return `Usage:
  ${me} auth login    [--provider <name>] [--type anthropic|openai-compat]
${" ".repeat(me.length + 17)}[--base-url <url>] [--model <id>] [--no-verify]
  ${me} auth list
  ${me} auth logout <name>

The API key is read without echo. When stdin is a pipe it is read from there,
so piping the key into 'auth login --provider x --type y --model z' works too.

Credentials live in a 0600 file under your home directory, never in the project.
Environment variables always win over stored values.`
}

export interface AuthOptions {
  provider?: string
  type?: string
  baseURL?: string
  model?: string
  verify?: boolean
}

export async function authCommand(argv: string[], options: AuthOptions): Promise<number> {
  const sub = argv[0]
  switch (sub) {
    case "login":
      return login(options)
    case "list":
    case "ls":
      return list()
    case "logout":
    case "remove":
      return logout(argv[1])
    default:
      process.stderr.write(`${sub ? `unknown subcommand "${sub}"\n\n` : ""}${authUsage()}\n`)
      return sub ? 2 : 0
  }
}

// ─────────────────────────────────────────────── login

async function login(options: AuthOptions): Promise<number> {
  const out = process.stdout
  try {
    const id = (options.provider ?? (await readLine(theme.bold("Provider name") + theme.dim(" (e.g. anthropic, openai, my-gateway): ")))).trim()
    if (!id) return fail("a provider name is required")
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
      return fail(`invalid provider name "${id}" — use letters, digits, dot, dash or underscore`)
    }

    const type = await resolveType(id, options)
    if (!type) return 2

    const baseURL = (options.baseURL ?? (await readLine(theme.bold("Base URL") + theme.dim(" (blank for the official endpoint): ")))).trim()
    if (baseURL) {
      const problem = checkBaseURL(baseURL, type)
      if (problem) out.write(theme.yellow(`  ! ${problem}\n`))
    }

    // 唯一一处读密钥。不回显,不回读,不进 shell history。
    const apiKey = (await readSecret(theme.bold("API key") + theme.dim(" (input hidden): "))).trim()
    if (!apiKey) return fail("an API key is required")
    if (/\s/.test(apiKey)) return fail("the API key contains whitespace — check for a stray copy/paste artifact")

    const model = (options.model ?? (await readLine(theme.bold("Default model id") + theme.dim(" (e.g. claude-sonnet-4-5, blank to skip): ")))).trim()

    // ── 落盘。config 先写:它没有密钥,写坏了也不泄露什么 ──
    const config = loadConfig()
    config.providers = { ...config.providers, [id]: { type, ...(baseURL ? { baseURL } : {}) } }
    if (model) config.model = `${id}/${model}`
    saveConfig(config)
    setCredential(id, { apiKey })

    out.write("\n")
    out.write(theme.green(`  ✓ saved ${id}`) + theme.dim(` (${maskKey(apiKey)})\n`))
    out.write(theme.dim(`    settings   ${configPath()}\n`))
    out.write(theme.dim(`    credential ${authPath()}  (mode 600)\n`))
    if (model) out.write(theme.dim(`    default model ${id}/${model}\n`))

    warnIfShadowedByEnv(id)

    if (options.verify === false) return 0
    if (!model) {
      out.write(theme.dim("\n  skipped verification (no model id given)\n"))
      return 0
    }
    if (await verifyModel(`${id}/${model}`)) return 0
    process.stderr.write(
      theme.dim(`  The credential was still saved. Fix it with: ${programName()} auth login --provider ${id}\n`),
    )
    return 1
  } catch (error) {
    if (error instanceof InputCancelled) {
      process.stderr.write(theme.dim("\ncancelled — nothing was saved\n"))
      return 130
    }
    return fail((error as Error).message)
  }
}

async function resolveType(id: string, options: AuthOptions): Promise<ProviderType | undefined> {
  if (options.type) {
    if (!PROVIDER_TYPES.includes(options.type as ProviderType)) {
      fail(`--type must be one of ${PROVIDER_TYPES.join(" | ")}`)
      return undefined
    }
    return options.type as ProviderType
  }
  // 名字本身是个很强的提示,直接当默认值,用户回车就过
  const guess: ProviderType = id.includes("anthropic") || id.includes("claude") ? "anthropic" : "openai-compat"
  const answer = (
    await readLine(theme.bold("API flavor") + theme.dim(` [anthropic | openai-compat] (default ${guess}): `))
  ).trim()
  if (!answer) return guess
  if (!PROVIDER_TYPES.includes(answer as ProviderType)) {
    fail(`unknown type "${answer}" — must be ${PROVIDER_TYPES.join(" or ")}`)
    return undefined
  }
  return answer as ProviderType
}

/**
 * baseURL 的常见错法。只提醒不阻止 —— 网关千奇百怪,不该由我们定义什么合法。
 *
 * 这里第一条是真踩过的坑:@ai-sdk/anthropic 会在 baseURL 后面直接拼
 * `/messages`,官方默认 baseURL 自带 /v1,所以自定义端点少写 /v1 就是 404,
 * 而报错里完全看不出是路径少了一截。
 */
function checkBaseURL(url: string, type: ProviderType): string | undefined {
  if (!/^https?:\/\//i.test(url)) return `base URL should start with http:// or https://`
  if (type === "anthropic" && !/\/v\d+\/?$/.test(url)) {
    return `anthropic-style endpoints usually end in /v1 — without it the SDK requests <url>/messages and you get a 404`
  }
  if (type === "openai-compat" && /\/chat\/completions\/?$/.test(url)) {
    return `drop the /chat/completions suffix — the SDK appends it`
  }
  return undefined
}

/** 存下来的 key 被环境变量顶掉了要说一声,否则用户会以为没生效。 */
function warnIfShadowedByEnv(id: string): void {
  const provider = resolveProviders({ config: loadConfig(), auth: loadAuth() }).find((p) => p.id === id)
  if (provider?.source !== "env") return
  process.stdout.write(
    theme.yellow(
      `\n  ! an environment variable currently overrides this stored key.\n` +
        `    Stored values are used only when the variable is unset.\n`,
    ),
  )
}

// ─────────────────────────────────────────────── verify

/**
 * 存下来不等于能用。发一次最小的真请求,401(key 错)和 404(baseURL 少了 /v1)
 * 在这一刻两秒就查出来了。
 *
 * ★ 引导(cli/onboard.ts)和 `auth login` 共用这一个函数。两边各写一遍的话,
 *   迟早出现"从引导进来的人验过、从 auth login 进来的人没验"这种谁都想不到的差别。
 *
 * @param registry 已经装好的注册表。不传就现读磁盘装一个
 */
export async function verifyModel(spec: string, preset?: LLMRegistry): Promise<boolean> {
  const out = process.stdout
  out.write(theme.dim(`\n  verifying ${spec} … `))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const registry = preset ?? buildRegistry({ config: loadConfig(), auth: loadAuth() })
    const handle = stream(registry, {
      model: { providerID: spec.slice(0, spec.indexOf("/")), modelID: spec.slice(spec.indexOf("/") + 1) },
      system: ["Reply with the single word: ok"],
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
      tools: [],
      makeToolContext: () => {
        throw new Error("no tools during verification")
      },
      abortSignal: controller.signal,
    })

    let text = ""
    let failure: Error | undefined
    for await (const event of handle.events) {
      if (event.type === "text-delta") text += event.text
      if (event.type === "error") failure = event.error
    }
    if (failure) throw failure

    out.write(theme.green("ok") + theme.dim(text.trim() ? ` — model replied "${truncate(text.trim(), 40)}"\n` : "\n"))
    return true
  } catch (error) {
    out.write(theme.red("failed\n"))
    // 报错原文往往就指出了问题(401 = key 错,404 = baseURL 错),照实给。
    // ★ 只说"为什么不成",**不说**"该怎么修" —— 怎么修由调用方说,它才知道
    //   provider 叫什么;两边都说的话,同一句话会在屏幕上出现两遍
    process.stderr.write(theme.red(`  ${firstLine((error as Error).message)}\n`))
    return false
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────── list / logout

function list(): number {
  const config = loadConfig()
  const auth = loadAuth()
  const providers = resolveProviders({ config, auth })
  const out = process.stdout

  const configured = providers.filter((p) => p.apiKey || config.providers?.[p.id])
  if (configured.length === 0) {
    out.write("No providers configured.\n\n")
    out.write(theme.dim(`Add one with: ${programName()} auth login\n`))
    return 0
  }

  const width = Math.max(...configured.map((p) => p.id.length))
  for (const provider of configured) {
    const key = provider.apiKey ? maskKey(provider.apiKey) : theme.red("no key")
    const origin =
      provider.source === "env"
        ? theme.yellow("env")
        : provider.source === "file"
          ? theme.dim("file")
          : theme.dim("—")
    const isDefault = config.model?.startsWith(`${provider.id}/`)
    out.write(
      `  ${provider.id.padEnd(width)}  ${theme.dim(provider.type.padEnd(14))} ${key.padEnd(14)} ${origin}` +
        (provider.baseURL ? theme.dim(`  ${provider.baseURL}`) : "") +
        (isDefault ? theme.green("  ← default") : "") +
        "\n",
    )
  }

  out.write("\n")
  if (config.model) out.write(theme.dim(`  default model  ${config.model}\n`))
  out.write(theme.dim(`  settings       ${configPath()}\n`))
  out.write(theme.dim(`  credentials    ${authPath()}\n`))
  if (providers.some((p) => p.source === "env")) {
    out.write(theme.dim(`\n  "env" means an environment variable is in effect and overrides the stored value.\n`))
  }
  return 0
}

function logout(id: string | undefined): number {
  if (!id) return fail(`which provider? usage: ${programName()} auth logout <name>`)
  const hadKey = removeCredential(id)
  const hadConfig = removeProvider(id)
  if (!hadKey && !hadConfig) return fail(`no provider named "${id}"`)
  process.stdout.write(theme.green(`  ✓ removed ${id}\n`))
  return 0
}

// ─────────────────────────────────────────────── 小工具

function fail(message: string): number {
  process.stderr.write(theme.red(`  ✗ ${message}\n`))
  return 2
}

function firstLine(text: string): string {
  return truncate(text.split("\n")[0] ?? text, 300)
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…"
}
