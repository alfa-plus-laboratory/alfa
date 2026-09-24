/**
 * `alfa auth …` — add, remove and list credentials.
 *
 * There's only one line in the design that must never loosen: **no output may ever contain
 * a full key**. No --show-key, no "let me echo that back so you can check" readback, and
 * never in error messages either. Confirming it was typed correctly relies on the real
 * request made before saving — far more reliable than having the user eyeball it.
 */
import { PROVIDER_TYPES, loadConfig, configPath, removeProvider, saveConfig, type Config, type ProviderType } from "../config/config.ts"
import { authPath, loadAuth, saveAuth, maskKey, removeCredential, setCredential, type AuthStore } from "../config/auth.ts"
import { alternateAnthropicBaseURL } from "../llm/base-url.ts"
import { buildRegistry, resolveProviders } from "../llm/setup.ts"
import type { LLMRegistry } from "../llm/registry.ts"
import { stream } from "../llm/stream.ts"
import { InputCancelled, readLine, readSecret } from "./secret-input.ts"
import { programName } from "./program.ts"
import { theme } from "./theme.ts"
import { uiText } from "../i18n/index.ts"

/** See cli/program.ts: the name in command examples must match what the user just typed. */
export function authUsage(): string {
  const me = programName()
  return uiText(`Usage:
  ${me} auth login    [--provider <name>] [--type anthropic|openai-responses|openai-chat]
${" ".repeat(me.length + 17)}[--base-url <url>] [--model <id>] [--no-verify]
  ${me} auth list
  ${me} auth logout <name>

The API key is read without echo. When stdin is a pipe it is read from there,
so piping the key into 'auth login --provider x --type y --model z' works too.

Credentials live in a 0600 file under your home directory, never in the project.
Environment variables always win over stored values.`, `用法：
  ${me} auth login    [--provider <名称>] [--type anthropic|openai-responses|openai-chat]
${" ".repeat(me.length + 17)}[--base-url <地址>] [--model <ID>] [--no-verify]
  ${me} auth list
  ${me} auth logout <名称>

API 密钥输入时不会回显。标准输入为管道时，将从管道读取密钥。
凭据以 0600 权限保存在用户目录中，不会写入项目。
环境变量始终优先于已保存的值。`, `使用方法：
  ${me} auth login    [--provider <名前>] [--type anthropic|openai-responses|openai-chat]
${" ".repeat(me.length + 17)}[--base-url <URL>] [--model <ID>] [--no-verify]
  ${me} auth list
  ${me} auth logout <名前>

API キーは表示せずに読み取ります。標準入力がパイプの場合は、そこから読み取ります。
認証情報はプロジェクトではなく、ユーザーディレクトリの 0600 ファイルに保存されます。
環境変数は保存値より常に優先されます。`)
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
      process.stderr.write(`${sub ? uiText(`unknown subcommand "${sub}"\n\n`, `未知子命令“${sub}”\n\n`, `不明なサブコマンド「${sub}」\n\n`) : ""}${authUsage()}\n`)
      return sub ? 2 : 0
  }
}

// ─────────────────────────────────────────────── login

async function login(options: AuthOptions): Promise<number> {
  const out = process.stdout
  try {
    const id = (options.provider ?? (await readLine(theme.bold(uiText("Provider name", "Provider 名称", "プロバイダー名")) + theme.dim(uiText(" (e.g. anthropic, openai, my-gateway): ", "（例如 anthropic、openai、my-gateway）：", "（例：anthropic、openai、my-gateway）："))))).trim()
    if (!id) return fail(uiText("a provider name is required", "请输入 provider 名称", "プロバイダー名を入力してください"))
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
      return fail(uiText(`invalid provider name "${id}" — use letters, digits, dot, dash or underscore`, `provider 名称“${id}”无效，只能使用字母、数字、点、连字符或下划线`, `プロバイダー名「${id}」は無効です。英数字、ピリオド、ハイフン、アンダースコアを使用してください`))
    }

    const type = await resolveType(id, options)
    if (!type) return 2

    const baseURL = (options.baseURL ?? (await readLine(theme.bold("Base URL") + theme.dim(uiText(" (blank for the official endpoint): ", "（留空使用官方端点）：", "（公式エンドポイントは空欄）："))))).trim()
    if (baseURL) {
      const problem = checkBaseURL(baseURL, type)
      if (problem) out.write(theme.yellow(`  ! ${problem}\n`))
    }

    // The only place the key is read. No echo, no readback, never in shell history.
    const apiKey = (await readSecret(theme.bold("API key") + theme.dim(uiText(" (input hidden): ", "（输入内容不回显）：", "（入力は表示されません）：")))).trim()
    if (!apiKey) return fail(uiText("an API key is required", "请输入 API 密钥", "API キーを入力してください"))
    if (/\s/.test(apiKey)) return fail(uiText("the API key contains whitespace — check for a stray copy/paste artifact", "API 密钥中包含空白字符，请检查复制内容", "API キーに空白が含まれています。貼り付け内容を確認してください"))

    const model = (options.model ?? (await readLine(theme.bold(uiText("Default model ID", "默认模型 ID", "デフォルトモデル ID")) + theme.dim(uiText(" (e.g. claude-sonnet-4-5, blank to skip): ", "（例如 claude-sonnet-4-5，留空跳过）：", "（例：claude-sonnet-4-5、空欄でスキップ）："))))).trim()

    // Verify the draft first; keep models and limits — swapping a key must not wipe out the
    // provider's whole configuration.
    const config = loadConfig()
    config.providers = { ...config.providers, [id]: { ...config.providers?.[id], type, noKey: false, ...(baseURL ? { baseURL } : {}) } }
    if (model) config.model = `${id}/${model}`
    const previousAuth = loadAuth()
    const draftAuth = { ...previousAuth, [id]: { apiKey } }
    if (model && options.verify !== false && !await verifyConfiguredModel(`${id}/${model}`, config, draftAuth)) return 1
    try { saveAuth(draftAuth); saveConfig(config) }
    catch (error) { saveAuth(previousAuth); throw error }

    out.write("\n")
    out.write(theme.green(`  ✓ ${uiText("saved", "已保存", "保存しました")} ${id}`) + theme.dim(` (${maskKey(apiKey)})\n`))
    out.write(theme.dim(`    ${uiText("settings", "设置", "設定")}   ${configPath()}\n`))
    out.write(theme.dim(`    ${uiText("credential", "凭据", "認証情報")} ${authPath()}  (mode 600)\n`))
    if (model) out.write(theme.dim(`    ${uiText("default model", "默认模型", "デフォルトモデル")} ${id}/${model}\n`))

    warnIfShadowedByEnv(id)

    return 0
  } catch (error) {
    if (error instanceof InputCancelled) {
      process.stderr.write(theme.dim(uiText("\ncancelled — nothing was saved\n", "\n已取消，未保存任何内容\n", "\nキャンセルしました。保存されていません\n")))
      return 130
    }
    return fail((error as Error).message)
  }
}

async function resolveType(id: string, options: AuthOptions): Promise<ProviderType | undefined> {
  if (options.type) {
    if (!PROVIDER_TYPES.includes(options.type as ProviderType)) {
      fail(uiText(`--type must be one of ${PROVIDER_TYPES.join(" | ")}`, `--type 必须是 ${PROVIDER_TYPES.join(" | ")} 之一`, `--type は ${PROVIDER_TYPES.join(" | ")} のいずれかを指定してください`))
      return undefined
    }
    return options.type as ProviderType
  }
  // The name itself is a strong hint; use it as the default so the user can just hit enter
  const guess: ProviderType = id.includes("anthropic") || id.includes("claude") ? "anthropic" : "openai-responses"
  const answer = (
    await readLine(theme.bold(uiText("API protocol", "API 协议", "API プロトコル")) + theme.dim(uiText(` [anthropic | openai-responses | openai-chat] (default ${guess}): `, ` [anthropic | openai-responses | openai-chat]（默认 ${guess}）：`, ` [anthropic | openai-responses | openai-chat]（既定 ${guess}）：`)))
  ).trim()
  if (!answer) return guess
  if (!PROVIDER_TYPES.includes(answer as ProviderType)) {
    fail(uiText(`unknown type "${answer}" — must be ${PROVIDER_TYPES.join(" or ")}`, `未知类型“${answer}”，必须是 ${PROVIDER_TYPES.join("、")} 之一`, `不明なタイプ「${answer}」です。${PROVIDER_TYPES.join("、")} のいずれかを指定してください`))
    return undefined
  }
  return answer as ProviderType
}

/**
 * Common baseURL mistakes. Warn, don't block — gateways come in every shape imaginable,
 * and it's not our place to define what's legal.
 *
 * Anthropic's version segment is detected by the connection test; static rules no longer
 * dictate the gateway's format here. The warning about a full `/messages` stays: that's
 * the final request URL, and the SDK appends it again.
 */
function checkBaseURL(url: string, type: ProviderType): string | undefined {
  if (!/^https?:\/\//i.test(url)) return uiText("base URL should start with http:// or https://", "Base URL 应以 http:// 或 https:// 开头", "Base URL は http:// または https:// で始めてください")
  if (type === "anthropic" && /\/messages\/?$/.test(url)) {
    return uiText("drop the /messages suffix — the connection test detects whether this base URL needs /v1", "请移除 /messages 后缀；连接测试会自动检测是否需要 /v1", "/messages を外してください。/v1 の要否は接続テストで判定します")
  }
  if (type === "openai-chat" && /\/chat\/completions\/?$/.test(url)) {
    return uiText("drop the /chat/completions suffix — the SDK appends it", "请移除 /chat/completions 后缀，SDK 会自动添加", "/chat/completions を外してください。SDK が追加します")
  }
  if (type === "openai-responses" && /\/responses\/?$/.test(url)) {
    return uiText("drop the /responses suffix — the SDK appends it", "请移除 /responses 后缀，SDK 会自动添加", "/responses を外してください。SDK が追加します")
  }
  return undefined
}

/** Speak up when an env variable overrides the stored key, or the user thinks it didn't take. */
function warnIfShadowedByEnv(id: string): void {
  const provider = resolveProviders({ config: loadConfig(), auth: loadAuth() }).find((p) => p.id === id)
  if (provider?.source !== "env") return
  process.stdout.write(
    theme.yellow(
      uiText(
        `\n  ! an environment variable currently overrides this stored key.\n    Stored values are used only when the variable is unset.\n`,
        `\n  ! 当前环境变量会覆盖已保存的密钥。\n    取消设置该变量后，才会使用已保存的值。\n`,
        `\n  ! 現在は環境変数が保存済みキーより優先されています。\n    環境変数を解除すると保存値が使われます。\n`,
      ),
    ),
  )
}

// ─────────────────────────────────────────────── verify

interface VerifyAttempt {
  ok: boolean
  status?: number
  timedOut: boolean
}

/** The auth subcommand owns stdout; interactive settings inject their live-region sink. */
export interface VerifyOutput {
  write(text: string): void
  error(text: string): void
}

const terminalVerifyOutput: VerifyOutput = {
  write: text => { process.stdout.write(text) },
  error: text => { process.stderr.write(text) },
}

/**
 * Move on to the next candidate only when the previous one was an explicit 404. Retrying
 * paths on a 401 is pointless, and retrying a timeout just makes the user wait another half
 * minute; a 404, though, is the status shared by "wrong model name" and "base path missing
 * / has an extra segment". The latter can't be told apart from the standard error fields,
 * so at most one mirrored form is tried.
 */
async function verifyCandidates(
  spec: string,
  presets: LLMRegistry[],
  output: VerifyOutput = terminalVerifyOutput,
): Promise<number | undefined> {
  output.write(theme.dim(`\n  ${uiText("verifying", "正在验证", "確認中")} ${spec} … `))

  let failure: VerifyAttempt | undefined
  for (let index = 0; index < presets.length; index++) {
    const result = await verifyAttempt(spec, presets[index]!)
    if (result.ok) {
      output.write(theme.green(uiText("ok\n", "成功\n", "成功\n")))
      return index
    }
    failure = result
    if (result.status !== 404 || index === presets.length - 1) break
    output.write(theme.dim(uiText("trying alternate API path … ", "正在尝试备用 API 路径… ", "別の API パスを試しています… ")))
  }

  output.write(theme.red(uiText("failed\n", "失败\n", "失敗\n")))
  const status = failure?.status
  const hint = status === 401 || status === 403 ? uiText("Authentication rejected: check key, header and permissions.", "认证被拒绝，请检查密钥、请求头和权限。", "認証が拒否されました。キー、ヘッダー、権限を確認してください。")
    : status === 404 && presets.length > 1 ? uiText("Endpoint or model not found: checked both Anthropic base-path forms; check the model ID.", "未找到端点或模型；已检查两种 Anthropic 基础路径，请确认模型 ID。", "エンドポイントまたはモデルが見つかりません。Anthropic の両方のベースパスを確認済みです。モデル ID を確認してください。")
    : status === 404 ? uiText("Endpoint or model not found: check API base path and model ID.", "未找到端点或模型，请检查 API 基础路径和模型 ID。", "エンドポイントまたはモデルが見つかりません。API のベースパスとモデル ID を確認してください。")
    : status === 429 ? uiText("Rate limit or quota exceeded: check billing and retry later.", "已达到速率或配额限制，请检查账单并稍后重试。", "レート制限またはクォータを超えました。請求状況を確認し、後で再試行してください。")
    : failure?.timedOut ? uiText("Connection timed out: check endpoint, proxy and network.", "连接超时，请检查端点、代理和网络。", "接続がタイムアウトしました。エンドポイント、プロキシ、ネットワークを確認してください。")
    : uiText("Request failed: check protocol, endpoint, model ID, TLS/proxy and service status.", "请求失败，请检查协议、端点、模型 ID、TLS/代理和服务状态。", "リクエストに失敗しました。プロトコル、エンドポイント、モデル ID、TLS/プロキシ、サービス状態を確認してください。")
  output.error(theme.red(`  ${hint}${status ? ` (HTTP ${status})` : ""}\n`))
  return undefined
}

async function verifyAttempt(spec: string, registry: LLMRegistry): Promise<VerifyAttempt> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
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

    if (!text.trim()) throw new Error("Empty model response")
    return { ok: true, timedOut: false }
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode
    return { ok: false, ...(status !== undefined ? { status } : {}), timedOut: controller.signal.aborted }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Stored doesn't mean usable. Send one minimal real request, and a 401 (wrong key) or a
 * 404 (baseURL missing /v1) shows up right then, in two seconds. This plain form (no
 * alternate path) backs "Test connection" in the manage menu (cli/providers.ts).
 *
 * @param preset An already-built registry. If omitted, one is built fresh from disk
 */
export async function verifyModel(
  spec: string,
  preset?: LLMRegistry,
  output: VerifyOutput = terminalVerifyOutput,
): Promise<boolean> {
  const registry = preset ?? buildRegistry({ config: loadConfig(), auth: loadAuth() })
  return await verifyCandidates(spec, [registry], output) !== undefined
}

/**
 * The real probe run before a draft is saved. Environment variables take precedence over
 * the file, and such an address can't be fixed by editing the draft; the official domain
 * is normalized by the SDK itself. Otherwise, on a 404 try the other form once (with /
 * without the version segment), and write it back into the draft only if it succeeds.
 *
 * ★ The provider form (cli/providers.ts, which onboarding also goes through) and
 *   `auth login` share this one function. If each wrote its own, sooner or later you'd get
 *   a difference nobody would think of: "people coming in through onboarding got
 *   verified, people coming in through auth login didn't".
 */
export async function verifyConfiguredModel(
  spec: string,
  config: Config,
  auth: AuthStore,
  output: VerifyOutput = terminalVerifyOutput,
): Promise<boolean> {
  const id = spec.slice(0, spec.indexOf("/"))
  const declared = config.providers?.[id]
  const effective = resolveProviders({ config, auth }).find((provider) => provider.id === id)
  const first = buildRegistry({ config, auth })
  if (declared?.type !== "anthropic" || !declared.baseURL || effective?.baseURLSource !== "file") {
    return await verifyCandidates(spec, [first], output) !== undefined
  }
  try {
    if (new URL(declared.baseURL).hostname === "api.anthropic.com") {
      return await verifyCandidates(spec, [first], output) !== undefined
    }
  } catch {
    return await verifyCandidates(spec, [first], output) !== undefined
  }
  const alternate = alternateAnthropicBaseURL(declared.baseURL)
  if (!alternate || alternate === declared.baseURL) return await verifyCandidates(spec, [first], output) !== undefined
  const alternateConfig: Config = {
    ...config,
    providers: { ...config.providers, [id]: { ...declared, baseURL: alternate } },
  }
  const chosen = await verifyCandidates(spec, [first, buildRegistry({ config: alternateConfig, auth })], output)
  if (chosen === 1) {
    declared.baseURL = alternate
    output.write(theme.dim(`    ${uiText("detected Anthropic base URL", "检测到 Anthropic Base URL", "Anthropic Base URL を検出")} ${alternate}\n`))
  }
  return chosen !== undefined
}

// ─────────────────────────────────────────────── list / logout

function list(): number {
  const config = loadConfig()
  const auth = loadAuth()
  const providers = resolveProviders({ config, auth })
  const out = process.stdout

  const configured = providers.filter((p) => p.apiKey || config.providers?.[p.id])
  if (configured.length === 0) {
    out.write(uiText("No providers configured.\n\n", "尚未配置 provider。\n\n", "プロバイダーが設定されていません。\n\n"))
    out.write(theme.dim(uiText(`Add one with: ${programName()} auth login\n`, `使用以下命令添加：${programName()} auth login\n`, `次のコマンドで追加：${programName()} auth login\n`)))
    return 0
  }

  const width = Math.max(...configured.map((p) => p.id.length))
  for (const provider of configured) {
    const key = provider.apiKey ? maskKey(provider.apiKey) : theme.red(uiText("no key", "无密钥", "キーなし"))
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
        (isDefault ? theme.green(uiText("  ← default", "  ← 默认", "  ← デフォルト")) : "") +
        "\n",
    )
  }

  out.write("\n")
  if (config.model) out.write(theme.dim(`  ${uiText("default model", "默认模型", "デフォルトモデル")}  ${config.model}\n`))
  out.write(theme.dim(`  ${uiText("settings", "设置", "設定")}       ${configPath()}\n`))
  out.write(theme.dim(`  ${uiText("credentials", "凭据", "認証情報")}    ${authPath()}\n`))
  if (providers.some((p) => p.source === "env")) {
    out.write(theme.dim(uiText(`\n  "env" means an environment variable is in effect and overrides the stored value.\n`, `\n  “env”表示环境变量正在生效，并覆盖已保存的值。\n`, `\n  「env」は環境変数が有効で、保存値より優先されていることを示します。\n`)))
  }
  return 0
}

function logout(id: string | undefined): number {
  if (!id) return fail(uiText(`which provider? usage: ${programName()} auth logout <name>`, `请指定 provider。用法：${programName()} auth logout <名称>`, `プロバイダーを指定してください。使用方法：${programName()} auth logout <名前>`))
  const hadKey = removeCredential(id)
  const hadConfig = removeProvider(id)
  if (!hadKey && !hadConfig) return fail(uiText(`no provider named "${id}"`, `没有名为“${id}”的 provider`, `「${id}」というプロバイダーはありません`))
  process.stdout.write(theme.green(`  ✓ ${uiText("removed", "已删除", "削除しました")} ${id}\n`))
  return 0
}

// ─────────────────────────────────────────────── small helpers

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
