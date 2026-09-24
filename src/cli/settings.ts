/**
 * Settings are a list of states you can back out of. Borrows Pi's "name / current value /
 * description of the selected item", without copying its component implementation.
 * ★ Current values are read fresh from the host every time; opening the menu must not
 *   call side-effecting bare commands like /think or /check to probe state.
 * Cancelling a submenu backs out one level only. Whatever has a slash command (sandbox,
 * thinking, permission, trust, checks, subagents, compaction, languages) is changed by
 * running that command via host.command, so the command line and the menu never grow
 * two separate sources of truth for it. Model switch, the auto classifier's model, window
 * limits, appearance and external-path grants go through their own SettingsHost methods
 * instead, and providers through cli/providers.ts.
 */
import { FLOW_WINDOW, FLOW_WINDOW_MAX, FLOW_WINDOW_MIN, MAX_AGENT_JOBS } from "../agent/flow.ts"
import { uiText as tr } from "../i18n/index.ts"
import { choose, type Choice, type Form } from "./form.ts"
import { addProviderModels, manageProviders } from "./providers.ts"
import { InputCancelled } from "./secret-input.ts"
import type { ThemeName } from "./theme.ts"

export interface SettingsState {
  /**
   * The saved preference, not whether it is in force: in auto the two differ, and a
   * submenu showing "off" right after the user chose "on" reads as a broken switch
   */
  sandbox: boolean
  limit: { context: number; output: number }
  model: string
  /** auto mode's classifier model; undefined = same as the conversation's */
  classifier: string | undefined
  permission: string
  trust: string
  interface: string
  reply: string
  check: boolean
  thinking: boolean
  /** Absent = the provider's default */
  effort?: string
  agentflow: number | false
  autoCompact: boolean
  theme: ThemeName
  toolOutput: "compact" | "expanded"
  animation: "on" | "off"
  reasoning: "off" | "preview" | "full"
}
export interface SettingsHost {
  command(text: string): Promise<unknown>
  reload(): void
  switch(spec: string): string | undefined
  /** A returned sentence = not changed. undefined = same as the conversation's model */
  setClassifier(spec: string | undefined): string | undefined
  state(): SettingsState
  setLimit(limit: { context: number; output: number }): void
  models(): string[]
  appearance(key: "theme" | "toolOutput" | "animation" | "reasoning", value: string): void
  access: {
    list(): { path: string; mode: string; persistent: boolean }[]
    add(path: string, mode: "read" | "write", persistent: boolean): void
    revoke(path: string): Promise<void>
  }
}
const entry = (value: string, label: string, description?: string): Choice => ({ value, label, description })
const back = () => entry("back", tr("Back", "返回", "戻る"))
const onOff = () => [entry("on", tr("On", "开启", "オン")), entry("off", tr("Off", "关闭", "オフ"))]
const enabled = (value: boolean) => value ? tr("On", "开启", "オン") : tr("Off", "关闭", "オフ")
const menu = (form: Form, title: string, items: Choice[], initial?: string) => choose(form, title, items, initial, { receipt: false })

export async function settings(form: Form, host: SettingsHost, page?: string): Promise<void> {
  let selected = "model"
  for (;;) {
    const s = host.state()
    let choice: string
    try {
      choice = page === "model" ? "model" : await menu(form, tr("Settings", "设置", "設定"), [
        { value: "model", label: tr("Model", "模型", "モデル"), current: s.model, description: tr("Switch the model for this conversation.", "切换当前对话使用的模型。", "会話のモデルを切り替えます。") },
        { value: "limits", label: tr("Model window", "模型窗口", "モデル上限"), current: `${s.limit.context} / ${s.limit.output}`, description: tr("Context / maximum output tokens for the current model.", "当前模型的上下文 / 最大输出 token 数。", "現在のモデルのコンテキスト / 最大出力 token 数。") },
        { value: "providers", label: tr("Providers & credentials", "厂商与凭据", "接続と認証情報"), current: "›", description: tr("Add, test or edit connections and model records.", "添加、测试或编辑连接与模型记录。", "接続とモデルを追加・テスト・編集。") },
        { value: "theme", label: tr("Theme", "主题", "テーマ"), current: s.theme },
        { value: "toolOutput", label: tr("Tool output", "工具输出", "ツール出力"), current: s.toolOutput, description: tr("Compact shows a preview; expanded prints full output.", "精简显示输出摘要；展开显示完整输出。", "要約または完全な出力を表示。") },
        { value: "animation", label: tr("Animation", "动画", "アニメーション"), current: s.animation, description: tr("The moving alfa mark and turn clock while it works. Off keeps the line still.", "运行时会动的 alfa 标志和回合计时。关闭后运行行保持静止。", "実行中に動く alfa マークと経過時間。オフで静止表示。") },
        { value: "reasoning", label: tr("Thinking display", "思考显示", "思考の表示"), current: s.reasoning, description: tr("Preview shows the live tail and a receipt; full streams it into the transcript.", "预览显示实时尾巴和一行回执；全文写进对话记录。", "プレビューは末尾と記録1行、全文は記録に流します。") },
        { value: "thinking", label: tr("Thinking", "扩展思考", "思考"), current: enabled(s.thinking) },
        { value: "effort", label: tr("Reasoning effort", "推理强度", "推論の深さ"), current: s.effort ?? tr("Provider default", "厂商默认", "プロバイダー既定"), description: tr("How hard the model thinks. Subagents follow it unless their task says otherwise.", "模型思考的深度。子代理默认跟随，除非任务另行指定。", "モデルが考える深さ。サブエージェントもタスクで指定がなければこれに従います。") },
        { value: "permission", label: tr("Permissions", "权限模式", "権限モード"), current: s.permission },
        { value: "classifier", label: tr("Auto classifier", "auto 分类器", "auto 分類器"), current: s.classifier ?? tr("Same as model", "同主模型", "モデルと同じ"), description: tr("The model that scores risky operations in auto mode.", "auto 模式下给有风险的操作打分的模型。", "auto モードで危険な操作を採点するモデル。") },
        { value: "access", label: tr("External paths", "外部目录访问", "外部パス"), current: String(host.access.list().length) },
        { value: "trust", label: tr("Project trust", "项目信任", "プロジェクトの信頼"), current: s.trust },
        { value: "interface", label: tr("Interface language", "界面语言", "表示言語"), current: s.interface },
        { value: "reply", label: tr("Reply language", "回答语言", "回答言語"), current: s.reply },
        { value: "check", label: tr("Checks", "收口检查", "チェック"), current: enabled(s.check) },
        { value: "agentflow", label: tr("Agentflow parallel mode", "Agentflow 主动并行", "Agentflow 並列モード"), current: s.agentflow === false ? enabled(false) : tr(`${s.agentflow} running at once`, `同时运行 ${s.agentflow} 个`, `同時実行 ${s.agentflow} 件`), description: tr(`Off still allows up to ${MAX_AGENT_JOBS} running subagents. On encourages parallel delegation, ${FLOW_WINDOW} at once by default (${FLOW_WINDOW_MIN}–${FLOW_WINDOW_MAX}); additional tasks queue.`, `关闭后仍可按需使用子代理，最多同时运行 ${MAX_AGENT_JOBS} 个；开启后鼓励主动并行，默认同时运行 ${FLOW_WINDOW} 个（可设 ${FLOW_WINDOW_MIN}–${FLOW_WINDOW_MAX}），超出的任务排队。`, `オフでも必要に応じて最大 ${MAX_AGENT_JOBS} 件を同時実行します。オンでは積極的に並列化し、既定で ${FLOW_WINDOW} 件を同時実行します（${FLOW_WINDOW_MIN}–${FLOW_WINDOW_MAX}）。超えたタスクは待機します。`) },
        { value: "autoCompact", label: tr("Auto compaction", "自动压缩", "自動圧縮"), current: enabled(s.autoCompact) },
        { value: "compact", label: tr("Compact now", "立即压缩", "今すぐ圧縮"), current: "›" },
        { value: "sandbox", label: tr("OS sandbox (experimental)", "沙盒（功能不完整）", "OS サンドボックス（実験的機能）"), current: enabled(s.sandbox), description: tr("Off by default; platform support is incomplete. Applies in every permission mode, auto included.", "默认关闭，平台支持不完整；所有权限模式都生效，包括 auto。", "既定はオフ。プラットフォーム対応は不完全です。auto を含むすべての権限モードで有効です。") },
        back(),
      ], selected)
    } catch (error) { if (error instanceof InputCancelled) return; throw error }
    if (choice === "back") return
    selected = choice
    try {
      if (choice === "model") {
        const items = host.models().map(value => entry(value, value, value === s.model ? tr("Current model", "当前模型", "現在のモデル") : undefined))
        const model = await menu(form, tr("Choose a model", "选择模型", "モデルを選択"), [...items, entry("add-model", tr("Discover & add models…", "获取列表并添加模型…", "モデルを取得して追加…")), entry("manual", tr("Enter model ID…", "手动输入模型 ID…", "モデル ID を入力…")), entry("providers", tr("Manage providers…", "管理厂商…", "接続を管理…")), back()], s.model)
        if (model === "providers") await providers(form, host)
        else if (model === "add-model") await providers(form, host, true)
        else if (model !== "back") {
          const spec = model === "manual" ? (await form.ask(tr("provider/model", "provider/model", "provider/model"))).trim() : model
          if (spec) { const error = host.switch(spec); if (error) form.say(error); else form.say(tr(`Active model: ${spec}`, `当前模型：${spec}`, `現在のモデル: ${spec}`)) }
        }
      } else if (choice === "classifier") {
        const items = host.models().map(value => entry(value, value, value === s.classifier ? tr("Current classifier", "当前分类器", "現在の分類器") : undefined))
        const picked = await menu(form, tr("Auto classifier model", "auto 分类器模型", "auto 分類器のモデル"), [entry("same", tr("Same as model", "同主模型", "モデルと同じ"), tr("Follows the conversation's model, including /model switches.", "跟随当前对话的模型，包括 /model 切换。", "会話のモデルに従います（/model の切り替えを含む）。")), ...items, entry("manual", tr("Enter model ID…", "手动输入模型 ID…", "モデル ID を入力…")), back()], s.classifier ?? "same")
        if (picked !== "back") {
          const spec = picked === "same" ? undefined : picked === "manual" ? (await form.ask("provider/model")).trim() || undefined : picked
          if (picked === "manual" && spec === undefined) continue
          const error = host.setClassifier(spec)
          if (error) form.say(error)
          else form.say(spec ? tr(`Auto classifier: ${spec}`, `auto 分类器：${spec}`, `auto 分類器: ${spec}`) : tr("Auto classifier follows the conversation's model.", "auto 分类器跟随主模型。", "auto 分類器は会話のモデルに従います。"))
        }
      } else if (choice === "limits") {
        form.say(tr("Token budget used by alfa; it does not increase the provider's actual capacity. Blank keeps the current value.", "这是 alfa 使用的 token 预算，不会提高服务商实际支持的上限。留空保留当前值。", "alfa の token 予算です。サービス側の能力は変わりません。空欄は現在値を保持。"))
        const context = (await form.ask(tr(`Context tokens [${s.limit.context}]`, `上下文窗口 token 数 [${s.limit.context}]`, `コンテキスト token 数 [${s.limit.context}]`))).trim()
        const output = (await form.ask(tr(`Maximum output tokens [${s.limit.output}]`, `最大输出 token 数 [${s.limit.output}]`, `最大出力 token 数 [${s.limit.output}]`))).trim()
        if (context || output) {
          const limit = { context: Number(context || s.limit.context), output: Number(output || s.limit.output) }
          if (![limit.context, limit.output].every(n => Number.isSafeInteger(n) && n > 0) || limit.output > limit.context) throw new Error(tr("Use positive integers; output must not exceed context.", "请填写正整数，最大输出不能超过上下文窗口。", "正の整数を入力。出力はコンテキスト以下。"))
          host.setLimit(limit)
          form.say(tr("Saved; active immediately.", "已保存，立即生效。", "保存して適用しました。"))
        }
      } else if (choice === "providers") await providers(form, host)
      else if (choice === "access") await accessMenu(form, host)
      else if (choice === "theme" || choice === "toolOutput" || choice === "animation" || choice === "reasoning") {
        const options = {
          theme: [tr("Theme", "主题", "テーマ"), [entry("terminal", tr("Terminal colors", "跟随终端配色", "端末の配色")), entry("dark", tr("Dark", "深色", "ダーク")), entry("light", tr("Light", "浅色", "ライト"))]],
          toolOutput: [tr("Tool output", "工具输出", "ツール出力"), [entry("compact", tr("Compact", "精简", "要約")), entry("expanded", tr("Expanded", "展开", "完全"))]],
          animation: [tr("Animation", "动画", "アニメーション"), onOff()],
          reasoning: [tr("Thinking display", "思考显示", "思考の表示"), [entry("preview", tr("Preview", "预览", "プレビュー")), entry("full", tr("Full", "全文", "全文")), entry("off", tr("Off", "关闭", "オフ"))]],
        } as const satisfies Record<string, readonly [string, Choice[]]>
        const [title, items] = options[choice]
        const value = await menu(form, title, [...items, back()], s[choice])
        if (value !== "back") host.appearance(choice, value)
      } else if (choice === "interface" || choice === "reply") {
        const value = await menu(form, tr("Language", "语言", "言語"), [entry("auto", tr("Automatic", "自动", "自動")), entry("en", "English"), entry("zh", "中文"), entry("ja", "日本語"), back()], s[choice])
        if (value !== "back") await host.command(`/language ${choice} ${value}`)
      } else {
        const menus: Record<string, { title: string; items: Choice[]; current?: string; command: string }> = {
          sandbox: { title: tr("OS sandbox (experimental)", "沙盒（功能不完整）", "OS サンドボックス（実験的機能）"), items: onOff(), current: s.sandbox ? "on" : "off", command: "/sandbox" },
          thinking: { title: tr("Thinking", "扩展思考", "思考"), items: onOff(), current: s.thinking ? "on" : "off", command: "/think" },
          effort: { title: tr("Reasoning effort", "推理强度", "推論の深さ"), items: [entry("default", tr("Provider default", "厂商默认", "プロバイダー既定"), tr("Send nothing; each model uses its provider's default.", "不发送，各模型使用厂商默认值。", "何も送らず、各モデルはプロバイダーの既定値を使います。")), ...["low", "medium", "high", "xhigh", "max"].map(level => entry(level, level))], current: s.effort ?? "default", command: "/effort" },
          permission: { title: tr("Permissions", "权限模式", "権限"), items: [entry("confirm", "confirm", tr("Ask before each operation", "每次操作都询问", "操作ごとに確認")), entry("default", "default", tr("Follow the permission rules", "遵循权限规则", "権限ルールに従う")), entry("auto", "auto", tr("Work automatically; major risks are blocked", "自动工作；重大风险会被拦截", "自動で作業し、重大リスクはブロック"))], current: s.permission, command: "/permission" },
          trust: { title: tr("Project trust", "项目信任", "プロジェクトの信頼"), items: [...onOff(), entry("check", tr("Review project instructions", "审查项目说明", "プロジェクト指示を確認"))], current: s.trust === "trusted" ? "on" : "off", command: "/trust" },
          check: { title: tr("Checks", "收口检查", "チェック"), items: [...onOff(), entry("run", tr("Run now", "立即运行", "今すぐ実行"))], current: s.check ? "on" : "off", command: "/check" },
          agentflow: { title: tr("Agentflow concurrency", "Agentflow 同时运行数量", "Agentflow 同時実行数"), items: [entry("off", enabled(false), tr(`Use subagents as needed, up to ${MAX_AGENT_JOBS} running at once.`, `按需使用子代理，最多同时运行 ${MAX_AGENT_JOBS} 个。`, `必要に応じて最大 ${MAX_AGENT_JOBS} 件を同時実行します。`)), ...[...new Set([FLOW_WINDOW_MIN, 4, FLOW_WINDOW, 8, FLOW_WINDOW_MAX])].sort((a, b) => a - b).map(n => entry(String(n), n === FLOW_WINDOW ? tr(`${n} (default)`, `${n}（默认）`, `${n}（既定）`) : String(n))), entry("custom", tr("Custom…", "自定义…", "カスタム…"))], current: s.agentflow === false ? "off" : String(s.agentflow), command: "/agentflow" },
          autoCompact: { title: tr("Auto compaction", "自动压缩", "自動圧縮"), items: onOff(), current: s.autoCompact ? "on" : "off", command: "/compact auto" },
          compact: { title: tr("Compact this conversation?", "压缩当前对话？", "会話を圧縮しますか？"), items: [entry("run", tr("Compact now", "立即压缩", "今すぐ圧縮"))], command: "/compact" },
        }
        const item = menus[choice]
        if (item) {
          let value = await menu(form, item.title, [...item.items, back()], item.current)
          if (value === "custom") value = (await form.ask(tr(`Concurrency (${FLOW_WINDOW_MIN}–${FLOW_WINDOW_MAX})`, `并发数（${FLOW_WINDOW_MIN}–${FLOW_WINDOW_MAX}）`, `同時実行数（${FLOW_WINDOW_MIN}–${FLOW_WINDOW_MAX}）`))).trim()
          if (value && value !== "back") await host.command(value === "run" ? item.command : `${item.command} ${value}`)
        }
      }
    } catch (error) { if (!(error instanceof InputCancelled)) form.say(error instanceof Error ? error.message : String(error)) }
    if (page === "model") return
  }
}

async function providers(form: Form, host: SettingsHost, addModels = false): Promise<void> {
  try {
    const spec = await (addModels ? addProviderModels(form) : manageProviders(form))
    if (spec) { host.reload(); const error = host.switch(spec); if (error) form.say(error); else form.say(tr(`Active model: ${spec}`, `当前模型：${spec}`, `現在のモデル: ${spec}`)) }
  } finally { host.reload() }
}

async function accessMenu(form: Form, host: SettingsHost): Promise<void> {
  const grants = host.access.list()
  const choice = await menu(form, tr("External path access", "外部目录访问", "外部パスへのアクセス"), [entry("add", tr("Add directory…", "添加目录…", "ディレクトリを追加…")), ...grants.map((g, i) => ({ value: String(i), label: g.path, current: g.mode, description: g.persistent ? tr("Persistent grant", "持久授权", "永続的な許可") : tr("This session only", "仅本次会话", "このセッションのみ") })), back()])
  if (choice === "back") return
  if (choice === "add") {
    const path = (await form.ask(tr("Absolute directory path", "目录的绝对路径", "ディレクトリの絶対パス"))).trim()
    if (!path) return
    const mode = await menu(form, tr("Access", "访问方式", "アクセス"), [entry("read", tr("Read", "读取", "読み取り")), entry("write", tr("Read and write", "读写", "読み書き"))])
    const scope = await menu(form, tr("Duration", "有效期", "期間"), [entry("session", tr("This session", "本次会话", "このセッション")), entry("persistent", tr("Remember", "持久保存", "保存する"))])
    host.access.add(path, mode as "read" | "write", scope === "persistent")
    form.say(tr(`Access granted: ${path}`, `已授权：${path}`, `許可しました: ${path}`))
  } else {
    const grant = grants[Number(choice)]
    if (grant && await menu(form, grant.path, [back(), entry("revoke", tr("Revoke access", "撤销授权", "許可を取り消す"))]) === "revoke") { await host.access.revoke(grant.path); form.say(tr("Access revoked", "已撤销授权", "許可を取り消しました")) }
  }
}
