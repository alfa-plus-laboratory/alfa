/**
 * `/setting` 那一屏的**内容**:每一项现在是什么、改了之后要做什么。
 *
 * 画面在 tui/panes/settings.ts —— 那边不认识任何一项设置,只认识"一棵页组成
 * 的树"。分开的理由和别的面板一样,但这里还多一条:**这些项散落在四五个地方**
 * (config.json、auth.json、按文件夹那张表、权限门卫、注册表),而把它们收进
 * 一张清单是这一屏存在的全部意义。让画面去认识那五个地方,等于把它们又抄了
 * 一遍。
 *
 * ── ★ 每一次打开都重算,不缓存 ──
 * 值必须是**现取**的:`/agentflow` 在别处按过、子 agent 刚把信任标记翻过来、
 * 环境变量压着模型 —— 这一屏画的是"现在",而一份缓存下来的清单画的是
 * "打开它那一刻"。这也是它做成 `page(id)` 而不是一个静态常量的原因。
 *
 * ── 密钥这一段刻意做得窄 ──
 * 能改现有 provider 的 key、能删,**不能在这里从头加一个 provider**。
 * 加一个要问四五件事(名字、口味、baseURL、模型、窗口),还要当场发一次真实
 * 请求去验 —— 那是 `alfa auth login` 那条路上的一整套问答(见 cli/auth.ts),
 * 搬进一个只有上下左右的格子里只会做成一个更差的版本。这一屏负责的是
 * 「我的 key 过期了,换一个」,那才是它天天要干的事。
 */
import type { PermissionMode } from "../permission/mode.ts"
import { MODES, modeInfo } from "../permission/mode.ts"
import type { SettingsPage, SettingsResult, SettingsSource, SettingRow } from "../tui/panes/settings.ts"
import type { TrustState } from "../config/config.ts"
import { VIEW_MODES, type ViewMode } from "../config/config.ts"
import { FLOW_WINDOW, MAX_FLOW_ALIVE_JOBS } from "../agent/flow.ts"
import { LANGUAGE_CHOICES, t, type LanguageChoice } from "../i18n/index.ts"

/** 一个 provider 在这一屏上的样子。由宿主从注册表 + auth.json 算出来 */
export interface ProviderRow {
  id: string
  type: string
  /** 密钥从哪来。env = 环境变量压着,这里改不动 */
  source: "env" | "file" | "none"
  /** 掩码过的密钥。没有就是 undefined。★ 永远不是完整密钥 */
  masked?: string
}

export interface SettingsHost {
  view(): ViewMode
  setView(view: ViewMode): void
  panels(): boolean
  setPanels(on: boolean): void
  trust(): TrustState
  trustedAt(): string | undefined
  setTrust(state: TrustState): void
  /** 派人去读一遍。返回一句话 = 没派出去,那句话就是原因 */
  checkTrust(): string | undefined
  mode(): PermissionMode
  setMode(mode: PermissionMode): void
  thinking(): boolean
  setThinking(value: boolean): void
  agentflow(): number | false
  setAgentflow(value: number | false): void
  autoCompact(): boolean
  setAutoCompact(value: boolean): void
  checkCommand(): string | undefined
  checkEnabled(): boolean
  setCheckEnabled(value: boolean): void
  language(kind: "interface" | "reply"): LanguageChoice
  setLanguage(kind: "interface" | "reply", value: LanguageChoice): void
  model(): string
  modelChoices(): string[]
  /** 换过去。返回一句话 = 没换成,里面写着为什么 */
  switchModel(spec: string): string | undefined
  /** 存不下来的理由(环境变量在启动时压过配置)。能存就 undefined */
  modelBlockedBy(): string | undefined
  providers(): ProviderRow[]
  /** 存一个新 key。返回一句话 = 没存成 */
  setKey(id: string, apiKey: string): string | undefined
  clearKey(id: string): void
}

const ON_OFF = (on: string, off: string) => [
  { value: "on", label: on },
  { value: "off", label: off },
]

const bool = (value: boolean) => (value ? "on" : "off")

export function createSettings(host: SettingsHost): SettingsSource {
  return {
    page: (id) => buildPage(id, host),
    choose: (pageID, rowID, value) => apply(pageID, rowID, value, host),
  }
}

/** provider 那一页的 id 形如 `provider:anthropic` */
const PROVIDER_PREFIX = "provider:"

export function buildPage(id: string, host: SettingsHost): SettingsPage | undefined {
  if (id === "root") return rootPage(host)
  if (id === "model") return modelPage(host)
  if (id === "keys") return keysPage(host)
  if (id.startsWith(PROVIDER_PREFIX)) return providerPage(id.slice(PROVIDER_PREFIX.length), host)
  return undefined
}

function rootPage(host: SettingsHost): SettingsPage {
  const flow = host.agentflow()
  const trust = host.trust()
  const at = host.trustedAt()
  const command = host.checkCommand()
  return {
    id: "root",
    title: t.settingsTitle,
    sections: [
      {
        // 这一节和下一节的分界是**存在哪**:这三项按文件夹存,下面那些是全局的。
        // 说出来是必要的 —— 「我在另一个仓库里改过了,这里怎么没变」
        title: t.settingsFolderSection,
        rows: [
          {
            id: "view",
            label: t.settingsView,
            value: host.view(),
            hint: host.view() === "session" ? t.viewSessionHint : t.viewStreamHint,
            kind: "choice",
            choices: VIEW_MODES.map((mode) => ({
              value: mode,
              label: mode === "session" ? t.settingsViewSession : t.settingsViewStream,
            })),
          },
          {
            id: "panels",
            label: t.settingsPanels,
            value: bool(host.panels()),
            hint: t.settingsPanelsHint,
            kind: "choice",
            choices: ON_OFF(t.settingsOn, t.settingsOff),
          },
          {
            id: "trust",
            label: t.settingsTrust,
            // 日期跟着一起写。它不参与任何判断,存在只为了回答"这是我什么时候
            // 放行的" —— 一条没有日期的许可,一年之后没人说得清它是想清楚了
            // 给的还是某天手滑按出来的
            value: trust,
            hint: at !== undefined && trust === "trusted" ? t.settingsTrustedAt(at) : t.settingsTrustHint,
            kind: "choice",
            tone: trust === "trusted" ? undefined : "warn",
            choices: [
              { value: "trusted", label: t.settingsTrustYes },
              { value: "untrusted", label: t.settingsTrustNo },
              { value: "checking", label: t.settingsTrustCheck },
            ],
          },
        ],
      },
      {
        title: t.settingsAgentSection,
        rows: [
          {
            id: "permission",
            label: t.settingsPermission,
            value: host.mode(),
            hint: modeInfo(host.mode()).hint,
            kind: "choice",
            // trust 模式必须一眼看得见。用户任何时候都不该"不知道自己开着自动放行"
            tone: host.mode() === "trust" ? "warn" : undefined,
            choices: MODES.map((mode) => ({ value: mode, label: mode })),
          },
          {
            id: "thinking",
            label: t.settingsThinking,
            value: bool(host.thinking()),
            hint: host.thinking() ? t.thinkingHint : t.thinkingOff,
            kind: "choice",
            choices: ON_OFF(t.settingsOn, t.settingsOff),
          },
          {
            id: "agentflow",
            label: t.settingsAgentflow,
            value: bool(flow !== false),
            // 开着的时候把那两个数写进说明。它们就是这个开关的全部内容
            hint: flow === false ? t.agentflowOffHint : t.agentflowOn(flow, MAX_FLOW_ALIVE_JOBS),
            kind: "choice",
            choices: ON_OFF(t.settingsOn, t.settingsOff),
          },
          {
            id: "autoCompact",
            label: t.settingsAutoCompact,
            value: bool(host.autoCompact()),
            hint: t.settingsAutoCompactHint,
            kind: "choice",
            choices: ON_OFF(t.settingsOn, t.settingsOff),
          },
          {
            id: "check",
            label: t.settingsCheck,
            value: bool(host.checkEnabled()),
            // 认出来的那条命令写在说明里 —— 一个"开着"但没说要跑什么的开关,
            // 用户没法判断它到底会不会做事
            hint: command === undefined ? t.settingsCheckNone : t.settingsCheckCommand(command),
            kind: "choice",
            choices: ON_OFF(t.settingsOn, t.settingsOff),
          },
        ],
      },
      {
        title: t.settingsModelSection,
        rows: [
          {
            id: "model",
            label: t.settingsModel,
            value: host.model(),
            hint: host.modelBlockedBy() ? t.modelEnvWins(host.modelBlockedBy()!) : t.settingsModelHint,
            kind: "page",
          },
          {
            id: "keys",
            label: t.settingsKeysRow,
            value: t.settingsKeysCount(host.providers().filter((one) => one.source !== "none").length),
            hint: t.settingsKeysHint,
            kind: "page",
          },
        ],
      },
      {
        title: t.settingsLanguageSection,
        rows: [
          {
            id: "language.interface",
            label: t.settingsLanguageInterface,
            value: host.language("interface"),
            hint: t.languageInterfaceHint,
            kind: "choice",
            choices: languageChoices(),
          },
          {
            id: "language.reply",
            label: t.settingsLanguageReply,
            value: host.language("reply"),
            hint: t.languageReplyHint,
            kind: "choice",
            choices: languageChoices(),
          },
        ],
      },
    ],
  }
}

function languageChoices() {
  return LANGUAGE_CHOICES.map((choice) => ({
    value: choice,
    label:
      choice === "auto"
        ? t.settingsLanguageAuto
        : choice === "en"
          ? t.languageEnglish
          : choice === "zh"
            ? t.languageChinese
            : t.languageJapanese,
  }))
}

/**
 * 换模型那一页。
 *
 * 当前那个也留在清单里,只是打上记号 —— 一张把"你在哪"抠掉的清单,看的人
 * 得先数一遍才知道自己在不在上面(和 `/model` 不带参数时那张表同一条)。
 */
function modelPage(host: SettingsHost): SettingsPage {
  const current = host.model()
  const choices = host.modelChoices()
  const at = choices.indexOf(current)
  return {
    id: "model",
    title: t.settingsModelTitle,
    // 一条也没有很正常:没人配过候选。`/model <provider>/<name>` 照旧能自由输入
    empty: t.modelNoChoices,
    // 光标落在当前那个上。清单里全是长得差不多的模型名,停在第一行的话
    // 用户第一件事是先找自己在哪
    ...(at >= 0 ? { selected: at } : {}),
    sections: [
      {
        title: "",
        rows: choices.map((spec) => ({
          id: spec,
          label: spec === current ? `● ${spec}` : `  ${spec}`,
          value: "",
          hint: spec === current ? t.settingsModelCurrent : t.settingsModelSwitch,
          kind: "action" as const,
          ...(spec === current ? { tone: "good" as const } : {}),
        })),
      },
    ],
  }
}

function keysPage(host: SettingsHost): SettingsPage {
  const providers = host.providers()
  return {
    id: "keys",
    title: t.settingsKeysTitle,
    empty: t.settingsKeysEmpty,
    sections: [
      {
        title: "",
        rows: providers.map((one) => ({
          id: PROVIDER_PREFIX + one.id,
          label: one.id,
          value: describeKey(one),
          hint: one.source === "env" ? t.settingsKeyFromEnv(one.id) : t.settingsKeyHint,
          kind: "page" as const,
          ...(one.source === "none" ? { tone: "warn" as const } : {}),
        })),
      },
    ],
  }
}

function describeKey(one: ProviderRow): string {
  if (one.source === "none") return t.settingsKeyMissing
  return `${one.masked ?? ""} · ${one.source === "env" ? t.settingsKeySourceEnv : t.settingsKeySourceFile}`
}

function providerPage(id: string, host: SettingsHost): SettingsPage {
  const one = host.providers().find((each) => each.id === id)
  if (!one) return { id: PROVIDER_PREFIX + id, title: id, sections: [], empty: t.settingsKeysEmpty }
  const rows: SettingRow[] = [
    {
      id: "paste",
      label: t.settingsKeyPaste,
      value: describeKey(one),
      // ★ 灰掉的那一行,说明就得是**为什么灰掉**。留着「⏎ 然后粘贴」的话,
      //   用户按下去只会得到一句教他怎么做一件他做不了的事的话 —— 而 App
      //   在灰行上按回车时正是把这一句放到状态行上(见 tui/app.ts 的 locked 分支)
      hint: one.source === "env" ? t.settingsKeyFromEnv(one.id) : t.settingsKeyPasteHint,
      kind: "secret",
      // 环境变量压着的时候存了也不生效。灰掉并且说清为什么 —— 抠掉的话
      // 用户会以为自己没配过
      ...(one.source === "env" ? { locked: true } : {}),
    },
  ]
  if (one.source === "file") {
    rows.push({
      id: "clear",
      label: t.settingsKeyRemove,
      value: "",
      hint: t.settingsKeyRemoveHint,
      kind: "action",
      tone: "warn",
    })
  }
  return { id: PROVIDER_PREFIX + id, title: `${t.settingsKeysTitle} · ${id}`, sections: [{ title: "", rows }] }
}

// ─────────────────────────────────────────────── 改

function apply(pageID: string, rowID: string, value: string, host: SettingsHost): SettingsResult {
  if (pageID === "root") return applyRoot(rowID, value, host)
  if (pageID === "model") {
    if (rowID === host.model()) return { note: t.modelAlready(rowID) }
    const failure = host.switchModel(rowID)
    // ★ 换成了就退回上一层。留在原地的话,那一页上"● 当前"的记号已经挪到了
    //   另一行,而用户按下回车要的是"换过去",不是"再看一遍这张表"
    return failure ? { error: failure } : { note: t.modelSwitched(rowID), back: true }
  }
  if (pageID.startsWith(PROVIDER_PREFIX)) {
    const id = pageID.slice(PROVIDER_PREFIX.length)
    if (rowID === "clear") {
      host.clearKey(id)
      return { note: t.settingsKeyRemoved(id) }
    }
    const key = value.trim()
    if (key.length === 0) return { error: t.settingsKeyEmpty }
    // 粘贴里夹着换行/空格是最常见的一种"key 明明是对的却报 401"
    if (/\s/.test(key)) return { error: t.settingsKeyWhitespace }
    const failure = host.setKey(id, key)
    return failure ? { error: failure } : { note: t.settingsKeySaved(id) }
  }
  return {}
}

function applyRoot(rowID: string, value: string, host: SettingsHost): SettingsResult {
  switch (rowID) {
    case "view":
      host.setView(value as ViewMode)
      return { note: t.settingsChanged(t.settingsView, value) }
    case "panels":
      host.setPanels(value === "on")
      return { note: t.settingsChanged(t.settingsPanels, value) }
    case "trust": {
      if (value === "checking") {
        const failure = host.checkTrust()
        return failure ? { error: failure } : { note: t.trustChecking }
      }
      host.setTrust(value as TrustState)
      return { note: t.settingsChanged(t.settingsTrust, value) }
    }
    case "permission":
      host.setMode(value as PermissionMode)
      return { note: t.settingsChanged(t.settingsPermission, value) }
    case "thinking":
      host.setThinking(value === "on")
      return { note: t.settingsChanged(t.settingsThinking, value) }
    case "agentflow":
      // 关的时候记 false,开的时候记缺省窗口。窗口要调的人有 `/agentflow N` ——
      // 把 2 到 12 全列成候选,会让一条二值开关看上去像一道要先想清楚的题
      host.setAgentflow(value === "on" ? FLOW_WINDOW : false)
      return { note: t.settingsChanged(t.settingsAgentflow, value) }
    case "autoCompact":
      host.setAutoCompact(value === "on")
      return { note: t.settingsChanged(t.settingsAutoCompact, value) }
    case "check":
      host.setCheckEnabled(value === "on")
      return { note: t.settingsChanged(t.settingsCheck, value) }
    case "language.interface":
      host.setLanguage("interface", value as LanguageChoice)
      return { note: t.settingsChanged(t.settingsLanguageInterface, value) }
    case "language.reply":
      host.setLanguage("reply", value as LanguageChoice)
      return { note: t.settingsChanged(t.settingsLanguageReply, value) }
    default:
      return {}
  }
}
