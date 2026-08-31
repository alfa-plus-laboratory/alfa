/**
 * 非密钥配置。
 *
 * 和 auth.json 分开是刻意的:这个文件里**一个字节的密钥都没有**,所以它可以
 * 进 dotfiles 仓库、可以贴给同事、可以 diff。两者混在一起的话,整个文件就都
 * 得当密钥对待,"我的模型配置"这件事从此没法分享。
 *
 * 用户手改这个文件是被支持的用法,所以出错要说人话:指出是哪个字段、期望
 * 什么值,而不是把 zod 的报错原样吐出来。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { ensureDirSync } from "../fs/dir.ts"
import { dirname, join } from "node:path"
import { FLOW_WINDOW, FLOW_WINDOW_MAX, FLOW_WINDOW_MIN, isFlowWindow } from "../agent/flow.ts"
import { isLanguageChoice, LANGUAGE_CHOICES, type LanguageChoice } from "../i18n/index.ts"
import { MODES, normalizeMode, type PermissionMode } from "../permission/mode.ts"
import { configDir } from "../util/xdg.ts"

/** 内置的两种接入形态。新增 provider 类型时扩这里。 */
export const PROVIDER_TYPES = ["anthropic", "openai-compat"] as const
export type ProviderType = (typeof PROVIDER_TYPES)[number]

/**
 * 全屏时中间那一栏画什么。
 *
 *   session —— 摘要 / 当前提问 / 活动区 三段
 *   stream  —— 经典的滚动对话记录
 *
 * 这个落盘。纯属口味的东西每次启动重设一遍才是烦人。
 */
export const VIEW_MODES = ["session", "stream"] as const
export type ViewMode = (typeof VIEW_MODES)[number]

export function isViewMode(value: string): value is ViewMode {
  return (VIEW_MODES as readonly string[]).includes(value)
}

/**
 * 一个文件夹的信任状态。
 *
 * ── 为什么需要它 ──
 * `alfa` 在一个陌生仓库里启动时,那个仓库能对它说话:`AGENTS.md` / `CLAUDE.md`
 * 会进 system prompt,`.alfa/mcp.json` 能指定要跑的进程。两者都是"clone 完
 * 敲一下命令"就生效的 —— 而 clone 谁的仓库是一件太随手的事。
 *
 * 信任是**默认给的**,这一点没得商量:一个每进一个目录就要按一次 y 的工具,
 * 三天之内就会被人练成条件反射,那时候这道门等于不存在。它的价值在于**有一条
 * 明确的路可以不给**,以及给了之后**记着是哪天给的**。
 *
 *   trusted   —— 照常。项目里的说明文件进 system prompt
 *   checking  —— 用户选了"先看一眼"。派一个子 agent 通读那些文件,干净就自己
 *                转成 trusted(见 cli/trust.ts)。在那之前按 untrusted 走
 *   untrusted —— 看过之后有话说,或者用户自己 `/trust off`。项目里的说明文件
 *                **一个字都不进 system prompt**
 */
export const TRUST_STATES = ["trusted", "checking", "untrusted"] as const
export type TrustState = (typeof TRUST_STATES)[number]

export function isTrustState(value: string): value is TrustState {
  return (TRUST_STATES as readonly string[]).includes(value)
}

/**
 * 一个文件夹自己的那几项。**存在这台机器的 config 里,不进仓库。**
 *
 * ── 为什么不放进仓库 ──
 * 「左边要不要有文件树」是**这个人这块屏幕**的事,不是这个仓库的属性:同一个
 * 仓库在 27 寸显示器上和在手机 SSH 里想要的排布根本不是一回事。而信任更不能
 * 放进仓库 —— 一个能自己声明"我是可信的"的文件,写它等于没写。
 *
 * ── 为什么按文件夹存,而不是一个全局默认 ──
 * 因为答案真的按文件夹不同:天天写的那个后端仓要文件树,顺手 clone 下来看一眼
 * 的那个不要。全局默认能表达的只有"我大部分时候要什么",而这里问的是"这个
 * 仓库要什么"。
 */
export interface FolderConfig {
  /** 中间栏画什么。不写就往上取全局的 `view` */
  view?: ViewMode
  /** 左边的文件树和右边的预览栏。缺省 false —— 见 cli/folder-setup.ts */
  panels?: boolean
  trust?: TrustState
  /** 打上信任标记那天。`YYYY-MM-DD`,给人看的 */
  trustedAt?: string
  /** 第一次在这儿跑是哪天。有这个键就说明开场那张卡片问过了,不再问第二遍 */
  seenAt?: string
}

export interface LanguageConfig {
  /** 界面文案 */
  interface?: LanguageChoice
  /** 模型回答 */
  reply?: LanguageChoice
}

export interface ModelLimit {
  context: number
  output: number
}

export interface ModelConfig {
  /**
   * 这个模型自己的窗口。不写就往上取 provider 的 limit,再没有才用兜底默认。
   *
   * 一定要能单独写:同一家的 M2 和 M3、mini 和满血版,窗口经常差好几倍,
   * 而窗口是**压缩什么时候触发**的唯一依据 —— 按一个偏大的数去估,表现是
   * 聊到一半突然被 provider 拒收;按偏小的估,是没必要地反复压缩。
   */
  limit?: ModelLimit
}

export interface ProviderConfig {
  type: ProviderType
  /** 官方端点就不用填 */
  baseURL?: string
  /**
   * 这一家的**默认**窗口 —— 只在某个模型没写自己的 limit 时才生效。
   *
   * 留着它不是偷懒:一个自建网关上所有模型都是同一个 128k,是常见事实,
   * 而让用户在十个模型下面把同一个数抄十遍,抄错一个是迟早的事。
   */
  limit?: ModelLimit
  /**
   * 这家能切到哪几个模型(`/model` 的候选),以及各自的窗口。
   *
   * 两种写法,后者是前者的超集:
   *   "models": ["gpt-4o", "gpt-4o-mini"]
   *   "models": { "gpt-4o": { "limit": { "context": 128000, "output": 16000 } },
   *               "gpt-4o-mini": {} }
   * 只想让它出现在候选里就写数组;要给某个模型单独定窗口才需要对象。
   *
   * 必须由用户写:除了 anthropic 那张写死的表(而且只在对着官方端点时才作数),
   * 我们不去猜一个第三方端点认哪些模型名 —— 猜出来的候选比没有候选更糟,
   * 它看起来是能选的。
   *
   * 不写也照样能切,`/model <provider>/<任意模型名>` 一直是自由输入 ——
   * 这个列表只决定按 tab 时弹出什么、以及窗口按多大算。
   */
  models?: Record<string, ModelConfig>
  /**
   * 一趟工具循环里,要不要把模型自己的思考发回给它(openai-compat 专用)。
   *
   * 缺省开。关掉的唯一理由是这个端点收到 `reasoning_content` 会报错 ——
   * 那不是标准字段,各家做法不一样。anthropic 那条路不看这个键:它按签名走,
   * 没得选(见 llm/registry.ts 的 ReasoningReplay)。
   */
  replayReasoning?: boolean
}

export interface Config {
  /** 默认模型,形如 "anthropic/claude-sonnet-4-5" */
  model?: string
  providers?: Record<string, ProviderConfig>
  /** 全屏中间栏的形态。缺省 session。按文件夹的那份优先(见 FolderConfig) */
  view?: ViewMode
  /**
   * 按文件夹记的那几项,键是**工作区根的绝对路径**。
   *
   * ⚠ 这张表会随着用过的仓库一直长。刻意**不做自动清理** —— 一个仓库暂时挪走
   *   过、或者挂载点没挂上,都会让"目录不存在"这个判据把用户攒下来的偏好和
   *   信任日期一起删掉,而那是不可逆的。几十字节一条,长一年也没人看得出来。
   */
  folders?: Record<string, FolderConfig>
  language?: LanguageConfig
  /**
   * 扩展思考开着吗(`/think`)。缺省关。
   *
   * 落盘是因为它**不是一次性选择**:想看模型怎么想的人,每一轮都想看,而
   * `--thinking` 是个每次启动都要重敲的开关 —— 那样的开关等于没有。
   */
  thinking?: boolean
  /**
   * 窗口快满时自己压一次(见 main.ts 的 AUTO_COMPACT_AT)。**缺省开**。
   *
   * 默认开是想清楚了才这么定的:关着的话,一场长会话的结局是撞满窗口然后
   * 每一轮都失败 —— 而那时候用户手里唯一的招正是 /compact,他却多半正在
   * 一件干到一半的事情中间。有损总好过撞墙,何况原文一个字都不删。
   *
   * 落盘是因为这是个偏好而不是一次性选择,而且它**会花钱**(每次自动触发都是
   * 一次真实的模型调用)—— 不想让它自作主张的人得能一次关掉、以后都不再问。
   */
  autoCompact?: boolean
  /**
   * 全局的 MCP server 定义:`{ "mcp": { "servers": { "github": { "command": … } } } }`。
   *
   * 这里**只认到"是个对象"为止**,每条定义对不对由 mcp/config.ts 逐条判 ——
   * 那边还要和项目里那份 `.alfa/mcp.json` 合并,两处的判断必须是同一份代码,
   * 不然同一条写法在两个文件里会有两种下场。而且一条写坏的 server 定义不该让
   * 整个程序起不来(这个文件里别的字段都是抛异常的,MCP 这一段刻意不是)。
   */
  mcp?: { servers?: Record<string, unknown>; library?: Record<string, unknown> }
  /**
   * agentflow(`/agentflow`)。数字 = 开着,而且同时最多几个子 agent;false = 关。
   * 缺省关。
   *
   * ── 为什么"开"是一个数而不是 true ──
   * 这个开关只有一个参数,而那个参数正是它的全部代价:同时几个,就是同时几份
   * 账单、几路一起撞 provider 限流。写成 `"agentflow": 6` 的配置文件自己就说清了
   * 这件事;写成 true 的话,真正生效的那个数藏在代码里,而它是用户最该看见的东西。
   *
   * ★ 它落盘,所以启动横幅上**必须写出来**(见 main.ts 的 banner)——
   *   和权限模式同一条规矩:存下来的东西可以忘,屏幕上写着的忘不了。
   *   一个不记得自己开过 flow 的人,看到的是"它怎么突然派了十六个人"。
   */
  agentflow?: number | false
  /**
   * 上次用的权限模式(`/permission`、shift-tab)。缺省 default。
   *
   * ★ 这个键一度**故意不存**:它是安全边界,而「上周开的 auto 这周还开着」
   *   正是看不见的自动化。现在存了,代价必须当场还回去 —— 启动横幅上非 default
   *   的模式**一定要写出来**(见 main.ts 的 banner)。存下来的东西可以忘,
   *   屏幕上写着的忘不了。
   */
  permission?: PermissionMode
  /**
   * 收口前的自动检查(见 agent/check.ts)。
   *
   *   缺省      —— 按项目自动认(tsconfig + 本地 tsc / Cargo.toml / go.mod)
   *   false     —— 关掉
   *   "命令"    —— 换成你自己的,比如 "bun run typecheck && bun run lint"
   *
   * 写成字符串的那条**照旧要过权限门卫**。配置文件不是绕过授权的后门 ——
   * 一个能让任意命令悄悄跑起来的配置项,和一个远程执行漏洞的区别只是措辞。
   */
  check?: string | false
}

export function configPath(): string {
  return join(configDir(), "config.json")
}

export function loadConfig(path = configPath()): Config {
  if (!existsSync(path)) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    throw new Error(`${path} is not valid JSON. Fix it, or delete it to start over.`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`)
  }

  const source = parsed as Record<string, unknown>
  const config: Config = {}

  if (source["model"] !== undefined) {
    if (typeof source["model"] !== "string") throw new Error(`${path}: "model" must be a string like "anthropic/claude-sonnet-4-5".`)
    config.model = source["model"]
  }

  if (source["providers"] !== undefined) {
    const raw = source["providers"]
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${path}: "providers" must be an object keyed by provider name.`)
    }
    const providers: Record<string, ProviderConfig> = {}
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      providers[id] = parseProvider(path, id, value)
    }
    config.providers = providers
  }

  if (source["view"] !== undefined) {
    const view = source["view"]
    if (typeof view !== "string" || !isViewMode(view)) {
      throw new Error(`${path}: "view" must be one of ${VIEW_MODES.map((v) => `"${v}"`).join(" | ")}.`)
    }
    config.view = view
  }

  if (source["folders"] !== undefined) {
    const raw = source["folders"]
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${path}: "folders" must be an object keyed by absolute folder path.`)
    }
    const folders: Record<string, FolderConfig> = {}
    for (const [dir, value] of Object.entries(raw as Record<string, unknown>)) {
      folders[dir] = parseFolder(path, dir, value)
    }
    config.folders = folders
  }

  if (source["thinking"] !== undefined) {
    const thinking = source["thinking"]
    if (typeof thinking !== "boolean") {
      throw new Error(`${path}: "thinking" must be true or false.`)
    }
    config.thinking = thinking
  }
  if (source["autoCompact"] !== undefined) {
    const autoCompact = source["autoCompact"]
    if (typeof autoCompact !== "boolean") {
      throw new Error(`${path}: "autoCompact" must be true or false.`)
    }
    config.autoCompact = autoCompact
  }
  if (source["mcp"] !== undefined) {
    const mcp = source["mcp"]
    if (mcp === null || typeof mcp !== "object" || Array.isArray(mcp)) {
      throw new Error(`${path}: "mcp" must be an object with a "servers" key.`)
    }
    const servers = (mcp as { servers?: unknown }).servers
    if (servers !== undefined && (servers === null || typeof servers !== "object" || Array.isArray(servers))) {
      throw new Error(`${path}: "mcp.servers" must be an object of name → definition.`)
    }
    // 货架。和 servers 长得一样,区别只在**没人自动连它** —— 项目那份
    // `.alfa/mcp.json` 里 `use: [...]` 点了名才起(见 mcp/config.ts)
    const library = (mcp as { library?: unknown }).library
    if (library !== undefined && (library === null || typeof library !== "object" || Array.isArray(library))) {
      throw new Error(`${path}: "mcp.library" must be an object of name → definition.`)
    }
    config.mcp = {
      ...(servers === undefined ? {} : { servers: servers as Record<string, unknown> }),
      ...(library === undefined ? {} : { library: library as Record<string, unknown> }),
    }
  }
  if (source["agentflow"] !== undefined) {
    const flow = source["agentflow"]
    // true 也认:手写配置的人会照着别的开关写 true,而"开着"这件事本身是明确的 ——
    // 报错让他打不开程序,只为了逼他改成一个数字,不成比例
    const value = flow === true ? FLOW_WINDOW : flow
    if (value !== false && !isFlowWindow(value)) {
      throw new Error(
        `${path}: "agentflow" must be false, or how many subagents may run at once (${FLOW_WINDOW_MIN}-${FLOW_WINDOW_MAX}).`,
      )
    }
    config.agentflow = value
  }

  if (source["permission"] !== undefined) {
    const mode = source["permission"]
    // normalizeMode 而不是 isPermissionMode:一个升级之后启动不了的程序,
    // 比一个已经改了名的模式糟糕得多。老配置里的 "auto" 读成 trust
    const resolved = typeof mode === "string" ? normalizeMode(mode) : undefined
    if (!resolved) {
      throw new Error(`${path}: "permission" must be one of ${MODES.map((m) => `"${m}"`).join(" | ")}.`)
    }
    config.permission = resolved
  }

  if (source["check"] !== undefined) {
    const check = source["check"]
    if (check !== false && (typeof check !== "string" || check.trim().length === 0)) {
      throw new Error(`${path}: "check" must be false, or a command string like "bun run typecheck".`)
    }
    config.check = check === false ? false : check
  }

  if (source["language"] !== undefined) {
    config.language = parseLanguage(path, source["language"])
  }

  return config
}

function parseLanguage(path: string, value: unknown): LanguageConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: "language" must be an object like { "interface": "en", "reply": "auto" }.`)
  }
  const source = value as Record<string, unknown>
  const config: LanguageConfig = {}
  for (const key of ["interface", "reply"] as const) {
    const raw = source[key]
    if (raw === undefined) continue
    if (typeof raw !== "string" || !isLanguageChoice(raw)) {
      throw new Error(
        `${path}: language."${key}" must be one of ${LANGUAGE_CHOICES.map((l) => `"${l}"`).join(" | ")}.`,
      )
    }
    config[key] = raw
  }
  return config
}

function parseFolder(path: string, dir: string, value: unknown): FolderConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: folders."${dir}" must be an object.`)
  }
  const source = value as Record<string, unknown>
  const config: FolderConfig = {}

  const view = source["view"]
  if (view !== undefined) {
    if (typeof view !== "string" || !isViewMode(view)) {
      throw new Error(`${path}: folders."${dir}".view must be one of ${VIEW_MODES.map((v) => `"${v}"`).join(" | ")}.`)
    }
    config.view = view
  }

  const panels = source["panels"]
  if (panels !== undefined) {
    if (typeof panels !== "boolean") throw new Error(`${path}: folders."${dir}".panels must be true or false.`)
    config.panels = panels
  }

  const trust = source["trust"]
  if (trust !== undefined) {
    if (typeof trust !== "string" || !isTrustState(trust)) {
      throw new Error(`${path}: folders."${dir}".trust must be one of ${TRUST_STATES.map((s) => `"${s}"`).join(" | ")}.`)
    }
    config.trust = trust
  }

  // 两个日期只是给人看的备注,不参与任何判断 —— 所以格式松一点,是个字符串就收。
  // 为一个从来没人 parse 过的字段做严格校验,换来的只是"改错一个字母就打不开程序"
  for (const key of ["trustedAt", "seenAt"] as const) {
    const raw = source[key]
    if (raw === undefined) continue
    if (typeof raw !== "string") throw new Error(`${path}: folders."${dir}".${key} must be a date string like "2026-08-31".`)
    config[key] = raw
  }

  return config
}

function parseProvider(path: string, id: string, value: unknown): ProviderConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: providers."${id}" must be an object.`)
  }
  const source = value as Record<string, unknown>

  const type = source["type"]
  if (typeof type !== "string" || !PROVIDER_TYPES.includes(type as ProviderType)) {
    throw new Error(
      `${path}: providers."${id}".type must be one of ${PROVIDER_TYPES.map((t) => `"${t}"`).join(" | ")}.`,
    )
  }

  const config: ProviderConfig = { type: type as ProviderType }

  const baseURL = source["baseURL"]
  if (baseURL !== undefined) {
    if (typeof baseURL !== "string" || baseURL.length === 0) {
      throw new Error(`${path}: providers."${id}".baseURL must be a non-empty string.`)
    }
    config.baseURL = baseURL
  }

  const replay = source["replayReasoning"]
  if (replay !== undefined) {
    if (typeof replay !== "boolean") {
      throw new Error(`${path}: providers."${id}".replayReasoning must be true or false.`)
    }
    config.replayReasoning = replay
  }

  const models = source["models"]
  if (models !== undefined) {
    config.models = parseModels(path, id, models)
  }

  const limit = source["limit"]
  if (limit !== undefined) {
    config.limit = parseLimit(limit, `${path}: providers."${id}".limit`)
  }

  return config
}

const MODELS_SHAPE = 'must be either ["name", …] or { "name": { "limit": { "context": …, "output": … } }, … }'

/** 数组和对象两种写法都收,内部统一成对象 —— 下游只认一种形状 */
function parseModels(path: string, id: string, value: unknown): Record<string, ModelConfig> {
  const where = `${path}: providers."${id}".models`
  const out: Record<string, ModelConfig> = {}

  if (Array.isArray(value)) {
    for (const name of value) {
      if (typeof name !== "string" || name.length === 0) throw new Error(`${where} ${MODELS_SHAPE}.`)
      out[name] = {}
    }
    return out
  }

  if (!value || typeof value !== "object") throw new Error(`${where} ${MODELS_SHAPE}.`)
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (name.length === 0) throw new Error(`${where} ${MODELS_SHAPE}.`)
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} ${MODELS_SHAPE}.`)
    const declared = (raw as Record<string, unknown>)["limit"]
    out[name] = declared === undefined ? {} : { limit: parseLimit(declared, `${where}."${name}".limit`) }
  }
  return out
}

function parseLimit(value: unknown, where: string): ModelLimit {
  const record = value as Record<string, unknown>
  if (!value || typeof value !== "object" || typeof record["context"] !== "number" || typeof record["output"] !== "number") {
    throw new Error(`${where} must be { "context": number, "output": number }.`)
  }
  return { context: record["context"], output: record["output"] }
}

export function saveConfig(config: Config, path = configPath()): void {
  ensureDirSync(dirname(path))
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n")
  renameSync(tmp, path)
}

/** 往 providers 里塞一条并落盘。 */
export function setProvider(id: string, provider: ProviderConfig, path = configPath()): Config {
  const config = loadConfig(path)
  config.providers = { ...config.providers, [id]: provider }
  saveConfig(config, path)
  return config
}

export function removeProvider(id: string, path = configPath()): boolean {
  const config = loadConfig(path)
  if (!config.providers || !(id in config.providers)) return false
  delete config.providers[id]
  // 默认模型指向的 provider 没了就一并清掉,否则下次启动直接报 unknown model
  if (config.model && config.model.split("/")[0] === id) delete config.model
  saveConfig(config, path)
  return true
}

export function setDefaultModel(model: string, path = configPath()): void {
  const config = loadConfig(path)
  config.model = model
  saveConfig(config, path)
}

/**
 * 存视图和语言。
 *
 * 落盘失败**不抛** —— 用户按的是「换个视图」,不是「写配置文件」。配置目录
 * 只读(容器里挂了只读卷是常见的)时,界面照切,只是下次启动不记得;为这个
 * 把正在跑的会话打断是完全不成比例的。
 */
export function rememberView(view: ViewMode, path = configPath()): void {
  update(path, (config) => {
    config.view = view
  })
}

export function rememberThinking(value: boolean, path = configPath()): void {
  update(path, (config) => {
    config.thinking = value
  })
}

export function rememberAutoCompact(value: boolean, path = configPath()): void {
  update(path, (config) => {
    config.autoCompact = value
  })
}

/** 关 = 写一个 false,不是把键删掉:删掉读起来像"没设置过",而它是设置过的 */
export function rememberAgentflow(value: number | false, path = configPath()): void {
  update(path, (config) => {
    config.agentflow = value
  })
}

/**
 * 开 = 把这个键删掉(回到自动认),而不是写一个 true。
 *
 * 存 true 的话,用户哪天在配置里写了自定义命令,一个从界面按出来的 true 会
 * 把它盖掉 —— 而他完全不知道是什么时候盖的。
 */
export function rememberCheck(value: string | false | undefined, path = configPath()): void {
  update(path, (config) => {
    if (value === undefined) delete config.check
    else config.check = value
  })
}

/** 见 Config.permission 上那颗星:存它的前提是启动时把它说出来。 */
export function rememberPermission(mode: PermissionMode, path = configPath()): void {
  update(path, (config) => {
    config.permission = mode
  })
}

export function rememberLanguage(kind: keyof LanguageConfig, choice: LanguageChoice, path = configPath()): void {
  update(path, (config) => {
    config.language = { ...config.language, [kind]: choice }
  })
}

function update(path: string, mutate: (config: Config) => void): void {
  try {
    const config = loadConfig(path)
    mutate(config)
    saveConfig(config, path)
  } catch {
    // 见上:记不住比中断当前操作好
  }
}
