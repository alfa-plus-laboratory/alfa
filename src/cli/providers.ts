/**
 * Creating and editing share one draft, committed only after a real request succeeds.
 * ★ What gets tested is the effective config (env overrides included), not just the draft.
 * ★ Credentials are asked exactly once, with hidden input; no mode choice that also looks
 *   like it wants a key may come before it.
 * Keys still go separately into auth.json; if the second write fails the first one is
 * rolled back, and cancelling / a failed test never leaves half a provider behind.
 * Adding models reuses the saved connection and writes only model records. Returning a
 * model spec means the user explicitly chose to switch; saving alone returns nothing.
 */
import { uiText } from "../i18n/index.ts"
import { loadConfig, saveConfig, type ProviderConfig } from "../config/config.ts"
import { loadAuth, saveAuth } from "../config/auth.ts"
import { buildRegistry, resolveProviders } from "../llm/setup.ts"
import { discoverModels } from "../llm/discover.ts"
import { PROVIDER_TEMPLATES } from "../llm/templates.ts"
import { verifyConfiguredModel, verifyModel, type VerifyOutput } from "./auth.ts"
import { choose, section, type Choice, type Form } from "./form.ts"

/**
 * The settings page and the startup repair page must offer the same three options; two
 * copies would sooner or later diverge in wording or order.
 */
export function providerProtocolChoices(): Choice[] {
  return [
    { value: "openai-responses", label: "OpenAI-compatible (Responses API)", description: uiText("Default", "默认", "既定") },
    { value: "anthropic", label: "Anthropic-compatible (Anthropic API)", description: "Messages" },
    { value: "openai-chat", label: "Chat Completions (OpenAI-compatible)", description: "/chat/completions" },
  ]
}

/** Preserve the live area's erase/write/redraw order while a network probe is running. */
function verificationOutput(form: Form): VerifyOutput {
  const say = (text: string) => form.say(text.replace(/^\n/, "").replace(/\n$/, ""))
  return { write: say, error: say }
}

export async function configureProvider(form: Form, editing?: string, options: { startup?: boolean } = {}): Promise<string | undefined> {
  const original = loadConfig(), oldAuth = loadAuth()
  const tr = uiText
  section(form, 1, 5, tr("Connect a model provider", "连接模型厂商", "モデルに接続"), tr("Choose a starting point. Nothing is saved until the connection test passes.", "先选厂商。连接测试通过前，不保存任何配置。", "接続テストに成功するまで設定は保存されません。"))
  const template = editing ? undefined : await choose(form, tr("Provider template", "选择厂商", "プロバイダーを選択"), [
    { value: "anthropic", label: "Anthropic", description: "Claude API" },
    { value: "openai", label: "OpenAI", description: "Responses API" },
    { value: "local", label: tr("Local model", "本地模型", "ローカルモデル"), description: "Ollama / LM Studio / vLLM" },
    { value: "custom", label: tr("Custom API / gateway", "自定义 API / 网关", "カスタム API / ゲートウェイ"), description: tr("Bring your own endpoint", "自行填写协议与端点", "プロトコルと URL を指定") },
  ])
  const previous = editing ? original.providers?.[editing] : undefined
  const provider: ProviderConfig = { ...(previous ?? PROVIDER_TEMPLATES[template ?? "custom"]!) }
  let id = editing ?? ""
  while (!id) {
    const fallback = template !== "custom" ? template : undefined
    const value = (await form.ask(tr(`Connection name${fallback ? ` [${fallback}]` : ""}`, `连接名称${fallback ? ` [${fallback}]` : ""}`, `接続名${fallback ? ` [${fallback}]` : ""}`))).trim() || fallback || ""
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value)) { form.say(tr("Use letters, digits, dot, dash or underscore.", "请使用字母、数字、点、连字符或下划线。", "英数字・点・ハイフン・下線を使ってください。")); continue }
    if (original.providers?.[value]) { form.say(tr("This name already exists. Choose another name or edit it in settings.", "名称已存在，请换个名称，或在设置里编辑原连接。", "名前が存在します。別名を指定するか設定から編集してください。")); continue }
    id = value
  }
  let apiKey = oldAuth[id]?.apiKey, model = "", stage = 2
  for (;;) {
    if (stage === 2) {
      section(form, 2, 5, tr("Connection", "连接信息", "接続先"), id)
      if (provider.baseURL) form.say(`${provider.type}
${provider.baseURL}`)
      const change = !provider.baseURL || await choose(form, tr("Connection settings", "连接设置", "接続設定"), [
        { value: "continue", label: tr("Use these settings", "使用以上设置", "この設定を使用") },
        { value: "edit", label: tr("Change endpoint / protocol", "修改端点 / 协议", "URL / プロトコルを変更") },
        { value: "advanced", label: tr("Advanced settings", "高级设置", "詳細設定"), description: tr("Custom auth header and model discovery", "自定义鉴权头、模型发现方式", "認証ヘッダーとモデル取得") },
      ])
      if (change === true || change === "edit") {
        provider.type = await choose(form, tr("API protocol", "API 协议", "API プロトコル"), providerProtocolChoices(), provider.type) as ProviderConfig["type"]
        for (;;) {
          const candidate = (await form.ask(tr(`API base URL${provider.baseURL ? ` [${provider.baseURL}]` : ""}`, `API 端点${provider.baseURL ? ` [${provider.baseURL}]` : ""}`, `API URL${provider.baseURL ? ` [${provider.baseURL}]` : ""}`))).trim() || provider.baseURL
          try {
            const url = new URL(candidate ?? "")
            if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
            provider.baseURL = candidate; break
          } catch { form.say(tr("Enter a complete http(s) API URL without credentials or query parameters.", "请输入完整 http(s) 地址，不包含凭据或查询参数。", "認証情報やクエリなしの完全な http(s) URL を入力してください。")) }
        }
      } else if (change === "advanced") {
        const header = (await form.ask(tr("Header name (not the key; blank uses protocol default)", "鉴权头名称（不是密钥；留空使用协议默认值）", "ヘッダー名（キーではありません。空欄で既定値）"))).trim()
        if (header && !/^[a-zA-Z0-9-]+$/.test(header)) { form.say(tr("Invalid header name.", "鉴权头名称无效。", "ヘッダー名が正しくありません。")); continue }
        provider.keyHeader = header || undefined
        provider.discovery = await choose(form, tr("Model discovery", "模型发现", "モデル取得"), [
          { value: "models", label: tr("Try fetching models", "尝试获取模型列表", "モデル一覧を取得") },
          { value: "none", label: tr("Enter model IDs manually", "手动输入模型 ID", "モデル ID を手入力") },
        ], provider.discovery ?? "models") as "models" | "none"
        continue
      }
      stage = 3
    }
    if (stage === 3) {
      section(form, 3, 5, tr("API credentials", "API 凭据", "API 認証情報"), tr("Input is hidden. Keys are stored separately from ordinary settings.", "输入不会回显。密钥单独存储，不进入普通配置。", "入力は非表示。キーは設定とは別に保存されます。"))
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(provider.baseURL!).hostname)
      const noKey = local && await choose(form, tr("Local authentication", "本地端点认证", "ローカル認証"), [
        { value: "none", label: tr("No API key needed", "不需要 API 密钥", "API キー不要") },
        { value: "key", label: tr("Use an API key", "使用 API 密钥", "API キーを使用") },
      ], provider.noKey ? "none" : "key") === "none"
      provider.noKey = noKey
      if (!noKey) {
        const entered = (await form.ask(tr("API key — paste here (blank keeps saved/environment key)", "API 密钥 — 在这里粘贴（留空保留已存 / 环境变量密钥）", "API キー — ここに貼り付け（空欄で既存キーを維持）"), true)).trim()
        apiKey = entered || apiKey
        const key = resolveProviders({ config: { ...original, providers: { ...original.providers, [id]: provider } }, auth: { ...oldAuth, ...(apiKey ? { [id]: { apiKey } } : {}) } }).find(p => p.id === id)?.apiKey
        if (!key || /\s/.test(key)) { form.say(tr("A key without whitespace is required. Please try again.", "请输入不含空白字符的密钥。", "空白を含まないキーを入力してください。")); continue }
      }
      stage = model ? 5 : 4
    }
    const config = { ...original, providers: { ...original.providers, [id]: { ...provider, disabled: false } } }
    const auth = { ...oldAuth }
    if (apiKey && !provider.noKey) auth[id] = { apiKey }; else delete auth[id]
    const effective = resolveProviders({ config, auth }).find(p => p.id === id)!
    if (provider.noKey && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(effective.baseURL!).hostname)) throw new Error(tr(
      "An environment override moved a no-key endpoint away from loopback. Check ALFA_BASE_URL_<NAME>.",
      "环境变量把免密端点改到了非本机地址。请检查 ALFA_BASE_URL_<NAME>。",
      "環境変数により、キー不要の接続先がループバック以外へ変更されています。ALFA_BASE_URL_<NAME> を確認してください。",
    ))
    if (stage === 4) {
      section(form, 4, 5, tr("Choose a model", "选择模型", "モデルを選択"), tr("Use the exact model ID available to your account.", "填写你的账号 / 套餐可用的精确模型 ID。", "アカウントで利用可能な正確なモデル ID を指定。"))
      let candidates = Object.keys(provider.models ?? {})
      if (provider.discovery !== "none") {
        form.say(tr("Fetching model candidates…", "正在获取模型候选…", "モデル候補を取得中…"))
        const found = await discoverModels({ type: provider.type, apiKey: effective.apiKey ?? "", baseURL: effective.baseURL, keyHeader: provider.keyHeader })
        candidates = [...new Set([...candidates, ...(found?.models ?? [])])]
        form.say(found ? tr("The list may be incomplete. Manual IDs are always accepted.", "列表可能不完整，始终可以手动输入。", "一覧は不完全な場合があります。手入力も可能です。") : tr("Discovery unavailable. You can still enter a model ID.", "无法获取列表，仍可手动输入模型 ID。", "一覧を取得できません。モデル ID を手入力できます。"))
      }
      const selected = candidates.length ? await choose(form, tr("Model", "模型", "モデル"), [...candidates.map(value => ({ value, label: value })), { value: "__manual", label: tr("Enter another model ID", "手动输入其它模型 ID", "別のモデル ID を入力") }]) : "__manual"
      model = selected === "__manual" ? (await form.ask(tr(`Model ID${model ? ` [${model}]` : ""}`, `模型 ID${model ? ` [${model}]` : ""}`, `モデル ID${model ? ` [${model}]` : ""}`))).trim() || model : selected
      if (!model) { form.say(tr("A model ID is required.", "模型 ID 不能为空。", "モデル ID が必要です。")); continue }
      const currentRecord = provider.models?.[model] ?? {}
      const effectiveLimit = buildRegistry({
        config: { ...config, providers: { ...config.providers, [id]: { ...provider, models: { ...provider.models, [model]: currentRecord } } } },
        auth,
        env: process.env,
      }).resolve(`${id}/${model}`).info.limit
      const window = (await form.ask(tr(
        `Context window tokens [${effectiveLimit.context}]`,
        `最大上下文 token 数 [${effectiveLimit.context}]`,
        `最大コンテキスト token 数 [${effectiveLimit.context}]`,
      ))).trim()
      if (window) {
        const context = Number(window)
        if (!Number.isSafeInteger(context) || context <= 0 || context < effectiveLimit.output) {
          form.say(tr(
            `Enter a positive integer no smaller than the maximum output (${effectiveLimit.output}).`,
            `请输入不小于最大输出（${effectiveLimit.output}）的正整数。`,
            `最大出力（${effectiveLimit.output}）以上の正の整数を入力してください。`,
          ))
          continue
        }
        provider.models = { ...provider.models, [model]: { ...currentRecord, limit: { context, output: effectiveLimit.output } } }
      }
      stage = 5
    }
    section(form, 5, 5, tr("Review & connect", "检查并连接", "確認して接続"), tr("Review the effective settings before the test request.", "确认实际生效的配置，再发起测试请求。", "テスト前に有効な設定を確認してください。"))
    form.say(`${id} / ${model}
${effective.type}
${effective.baseURL} (${effective.baseURLSource})
${tr("Key source", "密钥来源", "キー取得元")}: ${effective.source}`)
    if (process.env.ALFA_MODEL) form.say(tr("ALFA_MODEL overrides the saved startup default.", "ALFA_MODEL 会覆盖已保存的启动模型。", "ALFA_MODEL は保存済みの起動モデルより優先されます。"))
    const action = await choose(form, tr("Ready to connect?", "准备连接", "接続しますか？"), [
      { value: "test", label: tr("Test connection", "测试连接", "接続テスト"), description: tr("Sends one real request; a small charge may apply", "发送一次真实请求，可能产生少量费用", "実際のリクエストを送信。少額の料金が発生する場合があります") },
      { value: "connection", label: tr("Edit connection", "修改连接信息", "接続先を編集") },
      { value: "credentials", label: tr("Change API key", "修改密钥", "キーを変更") },
      { value: "model", label: tr("Change model", "修改模型", "モデルを変更") },
      { value: "cancel", label: tr("Cancel without saving", "取消，不保存", "保存せず中止") },
    ])
    if (action === "cancel") return undefined
    if (action !== "test") { stage = action === "connection" ? 2 : action === "credentials" ? 3 : 4; continue }
    const spec = `${id}/${model}`
    config.providers[id]!.models = { ...provider.models, [model]: { ...provider.models?.[model], disabled: false } }
    if (!await verifyConfiguredModel(spec, config, auth, verificationOutput(form))) { form.say(tr("Nothing saved. Edit the settings above or retry.", "尚未保存，可以修改配置或重试。", "未保存です。設定を編集するか再試行してください。")); continue }
    const save = await choose(form, tr("Connected successfully", "连接成功", "接続成功"), [
      ...(!options.startup ? [{ value: "save", label: tr("Save without switching", "保存，不切换", "切り替えずに保存") }] : []),
      { value: "switch", label: tr("Save & switch now", "保存并切换当前对话", "保存して今すぐ切り替え") },
      { value: "default", label: tr("Save as default & switch", "设为默认并切换", "デフォルトに設定して切り替え") },
      { value: "cancel", label: tr("Cancel without saving", "取消，不保存", "保存せず中止") },
    ], options.startup ? "default" : "save")
    if (save === "cancel") return undefined
    if (save === "default") config.model = spec
    try { saveAuth(auth); saveConfig(config) } catch (error) { saveAuth(oldAuth); throw error }
    form.say(tr(`Ready · ${spec}`, `已就绪 · ${spec}`, `準備完了 · ${spec}`))
    return save === "save" ? undefined : spec
  }
}

/** Discovery is a read, not a provider edit or a paid connection test. Keep its results
 * in this form so adding several models does not repeat credentials or network discovery.
 * A saved record preserves its limits/profile; switching is a separate explicit outcome. */
export async function addProviderModels(form: Form): Promise<string | undefined> {
  let config = loadConfig()
  const auth = loadAuth()
  const available = resolveProviders({ config, auth }).filter(p => config.providers?.[p.id] || p.source !== "none" || p.noKey)
  if (!available.length) {
    form.say(uiText("Add a provider connection first.", "请先添加厂商连接。", "先に接続を追加してください。"))
    return undefined
  }
  const id = await choose(form, uiText("Add models from provider", "从厂商添加模型", "接続からモデルを追加"), [
    ...available.map(p => ({ value: p.id, label: p.id, description: p.baseURL ?? p.type })),
    { value: "__back__", label: uiText("Back", "返回", "戻る") },
  ])
  if (id === "__back__") return undefined
  const effective = available.find(p => p.id === id)!
  form.say(uiText("Fetching model candidates…", "正在获取模型候选…", "モデル候補を取得中…"))
  const found = effective.apiKey || effective.noKey ? await discoverModels({ type: effective.type, apiKey: effective.apiKey ?? "", baseURL: effective.baseURL, keyHeader: effective.keyHeader }) : undefined
  if (!found) form.say(uiText("Discovery unavailable. You can still enter a model ID.", "无法获取列表，仍可手动输入模型 ID。", "一覧を取得できません。モデル ID を手入力できます。"))
  else if (found.dropped || found.truncated) form.say(uiText("Some results were filtered or omitted; manual model IDs are always accepted.", "部分结果已过滤或省略，仍可手动输入模型 ID。", "一部の結果は省略されています。モデル ID は手入力も可能です。"))
  for (;;) {
    config = loadConfig()
    const provider = config.providers?.[id] ?? { type: effective.type }
    const candidates = [...new Set([...(found?.models ?? []), ...Object.keys(provider.models ?? {})])]
    const picked = await choose(form, uiText("Choose a model to add", "选择要添加的模型", "追加するモデルを選択"), [
      ...candidates.map(model => ({ value: `model:${model}`, label: model, current: provider.models?.[model] ? uiText("Saved", "已保存", "保存済み") : undefined })),
      { value: "__manual__", label: uiText("Enter model ID…", "手动输入模型 ID…", "モデル ID を入力…") },
      { value: "__back__", label: uiText("Back", "返回", "戻る") },
    ])
    if (picked === "__back__") return undefined
    const model = picked === "__manual__" ? (await form.ask(uiText("Model ID:", "模型 ID：", "モデル ID："))).trim() : picked.slice("model:".length)
    if (!model) continue
    const spec = `${id}/${model}`
    const record = { ...provider.models?.[model], disabled: false }
    const draft = { ...config, providers: { ...config.providers, [id]: { ...provider, models: { ...provider.models, [model]: record } } } }
    for (;;) {
      const action = await choose(form, spec, [
        { value: "save", label: uiText("Save without switching", "保存，不切换", "切り替えずに保存") },
        { value: "another", label: uiText("Save & add another", "保存并继续添加", "保存して次を追加") },
        { value: "switch", label: uiText("Save & switch now", "保存并切换当前对话", "保存して今すぐ切り替え") },
        { value: "default", label: uiText("Save as default & switch", "设为默认并切换", "デフォルトに設定して切り替え") },
        { value: "limits", label: uiText("Edit token limits", "修改 token 上限", "トークン上限を編集") },
        { value: "test", label: uiText("Test connection (sends a request)", "测试连接（发送一次请求）", "接続テスト（リクエストを送信）") },
        { value: "cancel", label: uiText("Back without saving", "返回，不保存", "保存せず戻る") },
      ], "save")
      if (action === "cancel") break
      if (action === "test") { await verifyConfiguredModel(spec, draft, auth, verificationOutput(form)); continue }
      if (action === "limits") {
        const current = buildRegistry({ config: draft, auth }).resolve(spec).info.limit
        const context = (await form.ask(uiText(`Context tokens [${current.context}]`, `上下文 token 数 [${current.context}]`, `コンテキスト token 数 [${current.context}]`))).trim()
        const output = (await form.ask(uiText(`Maximum output tokens [${current.output}]`, `最大输出 token 数 [${current.output}]`, `最大出力 token 数 [${current.output}]`))).trim()
        if (context || output) {
          const limit = { context: Number(context || current.context), output: Number(output || current.output) }
          if (![limit.context, limit.output].every(n => Number.isSafeInteger(n) && n > 0) || limit.output > limit.context) {
            form.say(uiText("Use positive integers; output must not exceed context.", "请填写正整数，输出不能超过上下文。", "正の整数を入力。出力はコンテキスト以下。"))
            continue
          }
          record.limit = limit
        }
        continue
      }
      if (action === "default") draft.model = spec
      saveConfig(draft)
      form.say(uiText(`Saved model: ${spec}`, `已保存模型：${spec}`, `モデルを保存しました: ${spec}`))
      if (action === "another") break
      return action === "switch" || action === "default" ? spec : undefined
    }
  }
}

export async function manageProviders(form: Form): Promise<string | undefined> {
  const config = loadConfig()
  const auth = loadAuth()
  const providers = resolveProviders({ config, auth, includeDisabled: true })
  const action = await choose(form, uiText("Manage connections", "管理连接", "接続の管理"), [
    {value:"add",label:uiText("Add provider", "添加厂商", "追加")},
    {value:"add-model",label:uiText("Discover & add models", "获取列表并添加模型", "モデルを取得して追加")},
    {value:"switch",label:uiText("Switch model", "切换模型", "モデル切替")},
    {value:"edit",label:uiText("Edit provider", "编辑厂商", "編集")},
    {value:"model",label:uiText("Manage model records", "管理模型记录", "モデル管理")},
    {value:"test",label:uiText("Test connection", "测试连接", "接続テスト")},
    {value:"disable",label:uiText("Disable provider", "禁用厂商", "無効化")},
    {value:"enable",label:uiText("Enable provider", "启用厂商", "有効化")},
    {value:"key-clear",label:uiText("Remove saved key", "删除已存密钥", "保存キーを削除")},
    {value:"delete",label:uiText("Delete provider", "删除厂商", "接続を削除")},
    {value:"back",label:uiText("Back", "返回", "戻る")},
  ])
  if (action === "back" || !action) return undefined
  if (action === "add") return configureProvider(form)
  if (action === "add-model") return addProviderModels(form)
  if (action === "switch" || action === "test") {
    const candidates = providers.filter(p => !p.disabled).flatMap(p => Object.entries(p.models ?? {}).filter(([, m]) => !m.disabled).map(([id]) => `${p.id}/${id}`))
    const selected = await choose(form, uiText("Choose a model", "选择模型", "モデルを選択"), [...candidates.map(value => ({ value, label: value })), { value: "manual", label: uiText("Enter model ID…", "手动输入模型 ID…", "モデル ID を入力…") }])
    const spec = selected === "manual" ? (await form.ask(uiText("provider/model:", "provider/model：", "provider/model："))).trim() : selected
    if (action === "test") { await verifyModel(spec, undefined, verificationOutput(form)); return undefined }
    return spec
  }
  const saved = providers.filter(p => config.providers?.[p.id])
  if (!saved.length) { form.say(uiText("No saved providers. Add a connection first.", "没有已保存的厂商，请先添加连接。", "保存済みの接続がありません。")); return undefined }
  const id = await choose(form, uiText("Provider", "厂商", "プロバイダー"), saved.map(p => ({
    value: p.id,
    label: p.id,
    current: p.disabled ? uiText("disabled", "已禁用", "無効") : p.type,
    description: `${p.baseURL ?? uiText("protocol default", "协议默认值", "プロトコル既定値")} · ${p.source}`,
  })))
  if (action === "edit") return configureProvider(form, id)
  const provider = config.providers?.[id]
  if (!provider) throw new Error(uiText("Edit this provider first to create a saved configuration.", "请先编辑该厂商以创建已保存的配置。", "先にこのプロバイダーを編集して設定を保存してください。"))
  if (action === "key-clear") {
    if (await form.ask(uiText(
      `Type ${id} to remove its saved key (environment credentials are unaffected):`,
      `输入 ${id} 以删除已保存的密钥（不影响环境变量中的凭据）：`,
      `${id} と入力すると保存済みキーを削除します（環境変数の認証情報には影響しません）：`,
    )) !== id) return undefined
    delete auth[id]
    if (!provider.noKey) provider.disabled = true
  } else if (action === "delete") {
    if (await form.ask(uiText(`Type ${id} to delete its settings and saved key:`, `输入 ${id} 以删除其设置和已保存的密钥：`, `${id} と入力すると設定と保存済みキーを削除します：`)) !== id) return undefined
    delete config.providers![id]; delete auth[id]
  } else if (action === "disable" || action === "enable") provider.disabled = action === "disable"
  else if (action === "model") {
    const selected = await choose(form, uiText("Model records", "模型记录", "モデル"), [...Object.keys(provider.models ?? {}).map(value => ({ value, label: value })), { value: "__new__", label: uiText("Add model…", "添加模型…", "モデルを追加…") }])
    const model = selected === "__new__" ? (await form.ask(uiText("Model ID:", "模型 ID：", "モデル ID："))).trim() : selected
    if (!model) throw new Error(uiText("Model ID required.", "请输入模型 ID。", "モデル ID が必要です。"))
    const op = selected === "__new__" ? "add" : await choose(form, uiText("Model action", "模型操作", "モデル操作"), [
      { value: "edit", label: uiText("Edit ID / limits", "编辑 ID / 上下文限制", "ID / 上限を編集") },
      { value: "enable", label: uiText("Enable", "启用", "有効化") },
      { value: "disable", label: uiText("Disable", "禁用", "無効化") },
      { value: "delete", label: uiText("Delete", "删除", "削除") },
    ])
    provider.models ??= {}
    if (op === "edit") {
      const nextID = (await form.ask(uiText(`Model ID [${model}]:`, `模型 ID [${model}]：`, `モデル ID [${model}]：`))).trim() || model
      if (nextID !== model && provider.models[nextID]) throw new Error(uiText("Target model ID already exists.", "目标模型 ID 已存在。", "変更先のモデル ID は既に存在します。"))
      const record = { ...provider.models[model] }
      const effectiveLimit = buildRegistry({ config: { ...config, providers: { ...config.providers, [id]: { ...provider, disabled: false, noKey: true, models: { ...provider.models, [model]: { ...record, disabled: false } } } } }, auth }).resolve(`${id}/${model}`).info.limit
      const context = (await form.ask(uiText(`Context tokens [${effectiveLimit.context}]:`, `上下文 token 数 [${effectiveLimit.context}]：`, `コンテキスト token 数 [${effectiveLimit.context}]：`))).trim()
      const output = (await form.ask(uiText(`Output tokens [${effectiveLimit.output}]:`, `输出 token 数 [${effectiveLimit.output}]：`, `出力 token 数 [${effectiveLimit.output}]：`))).trim()
      if (context || output) {
        const limit = { context: Number(context || effectiveLimit.context), output: Number(output || effectiveLimit.output) }
        if (!Object.values(limit).every(n => Number.isSafeInteger(n) && n > 0) || limit.output > limit.context) throw new Error(uiText("Use positive context/output limits with output no greater than context.", "上下文和输出上限必须为正整数，且输出不得超过上下文。", "コンテキストと出力の上限は正の整数で、出力はコンテキスト以下にしてください。"))
        record.limit = limit
      }
      delete provider.models[model]; provider.models[nextID] = record
      if (config.model === `${id}/${model}`) config.model = `${id}/${nextID}`
    } else if (op === "delete") delete provider.models[model]
    else if (["add", "disable", "enable"].includes(op)) provider.models[model] = { ...provider.models[model], disabled: op === "disable" }
    else throw new Error(uiText("Unknown model action.", "未知的模型操作。", "不明なモデル操作です。"))
    if (config.model === `${id}/${model}` && ["delete", "disable"].includes(op)) delete config.model
  } else throw new Error(uiText("Unknown action.", "未知操作。", "不明な操作です。"))
  if ((action === "delete" || action === "disable" || action === "key-clear") && config.model?.startsWith(id + "/")) delete config.model
  const oldAuth = loadAuth()
  try { saveAuth(auth); saveConfig(config) } catch (error) { saveAuth(oldAuth); throw error }
  form.say(uiText("Saved. Environment overrides remain active until unset in your shell.", "已保存。环境变量仍会优先生效，直至在 Shell 中取消设置。", "保存しました。環境変数は Shell で解除するまで引き続き優先されます。"))
  return undefined
}
