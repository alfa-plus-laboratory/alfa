/**
 * CLI 入口。把所有零件拼起来。
 *
 * ── 三种运行形态,共用同一套装配 ──
 *   -p "…"          跑一次就退出。没有活动区,输出干净到能进管道。
 *   交互 + TTY      底部钉一个输入框(shell.ts),输出从上面流过。
 *   交互 + 管道     没法接管终端,退回逐行读。CI 和 `echo … | alfa` 走这条。
 *
 * 差别只在「谁来提供下一句话」和「有没有活动区」,再往下的循环、工具、权限
 * 三种形态一模一样。
 *
 * ── 退出前必须 drain ──
 * 见 agent/runner.ts。不等收尾就退,bash 起的子进程会被 init 收养继续跑。
 */
import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative, resolve } from "node:path"
import { parseArgs } from "node:util"
import { checkReminder, detectChecker, runCheck, worthChecking } from "../agent/check.ts"
import { applyCompaction, createCompactor, type CompactFn, type CompactResult } from "../agent/compact.ts"
import { ContextMeter, contextReport, type ContextReport, type ContextSnapshot } from "../agent/context.ts"
import { Emitter, type UIEvent } from "../agent/events.ts"
import { isSettled, Loop } from "../agent/loop.ts"
import { Runner } from "../agent/runner.ts"
import { compactionIndex } from "../agent/to-model-messages.ts"
import { billedFromHistory, usable } from "../agent/tokens.ts"
import {
  createCatchUp,
  createSummarizer,
  type CatchUpFn,
  type SummarizeFn,
  type SummaryResult,
  type TurnDigest,
} from "../agent/summarize.ts"
import { streamWithRetry } from "../llm/retry.ts"
import { stream } from "../llm/stream.ts"
import { buildRegistry, defaultModelSpec } from "../llm/setup.ts"
import { resolveShell } from "../env/shell.ts"
import { setModelChoices } from "./commands.ts"
import { manualSetupHint, onboard } from "./onboard.ts"
import { VERSION as ALFA_VERSION } from "../update/release.ts"
import { upgrade, sweepParkedBinary, type UpgradeEvent } from "../update/upgrade.ts"
import type { UpgradeState } from "../tui/panes/upgrade.ts"
import { checkForUpdate } from "../update/check.ts"
import { performReset, resetScope, type ResetTarget } from "./reset.ts"
import { envNameInUse } from "../env/vars.ts"
import {
  FLOW_WINDOW,
  FLOW_WINDOW_MAX,
  FLOW_WINDOW_MIN,
  isFlowWindow,
  MAX_FLOW_ALIVE_JOBS,
} from "../agent/flow.ts"
import {
  isViewMode,
  loadConfig,
  configPath,
  rememberAgentflow,
  rememberCheck,
  rememberLanguage,
  rememberPermission,
  rememberAutoCompact,
  rememberThinking,
  rememberView,
  setDefaultModel,
  VIEW_MODES,
  type LanguageConfig,
  type TrustState,
  type ViewMode,
} from "../config/config.ts"
import {
  isLanguageChoice,
  LANGUAGE_CHOICES,
  languageLabel,
  setInterfaceLanguage,
  t,
} from "../i18n/index.ts"
import { loadAuth } from "../config/auth.ts"
import { authCommand, authUsage } from "./auth.ts"
import { parseModelRef } from "../llm/registry.ts"
import { NoCredentialsError, UnknownModelError, type LLMRequest, type ModelInfo, type ModelRef } from "../llm/types.ts"
import { buildSystem } from "../prompt/system.ts"
import { discoverInstructions } from "../prompt/instructions.ts"
import {
  isFirstVisit,
  markTrust,
  panelsFor,
  rememberFolder,
  rememberFolderPanels,
  rememberFolderView,
  trustFor,
  trustsProjectInstructions,
  viewFor,
  folderConfig,
} from "../config/folders.ts"
import { folderSetup } from "./folder-setup.ts"
import { copyTargets } from "../tui/panes/copy.ts"
import { settleTrustReview, TRUST_AGENT_NAME, trustReviewPrompt, trustSummary } from "./trust.ts"
import { discoverMemories, renderMemories } from "../prompt/memory.ts"
import { gitContextBlock } from "../prompt/git.ts"
import { AGENTS_FILE, initPrompt, initScaffold } from "../prompt/init.ts"
import { forgetApprovals, loadApprovals, rememberApprovals, toRuleset } from "../permission/approvals.ts"
import { PermissionGate, type PromptFn, type PromptRequest } from "../permission/gate.ts"
import { HardDenyError } from "../permission/gate.ts"
import { modeInfo, MODES, normalizeMode, type PermissionMode } from "../permission/mode.ts"
import type { Answer, AskDecision, Question } from "../tool/types.ts"
import { newMessageID, newPartID, newSessionID } from "../session/id.ts"
import { Store, type SessionInfo } from "../session/store.ts"
import type { MessageWithParts, ToolPart } from "../session/schema.ts"
import { killAll as killAllJobs, list as listJobs, setJobObserver } from "../tool/bash/jobs.ts"
import type { JobSnapshot } from "../tool/background.ts"
import { SubagentJobs } from "../agent/subagent.ts"
import { subagentBlock } from "../prompt/subagent.ts"
import { askInPlain } from "./ask.ts"
import { createToolContext } from "../tool/context.ts"
import { registerBuiltins } from "../tool/builtin.ts"
import { ToolRegistry } from "../tool/registry.ts"
import { forgetReads } from "../fs/freshness.ts"
import { PRODUCT, programName } from "./program.ts"
import { findProjectDirsCommand, performUninstall, runningFromSource, uninstallScope } from "./uninstall.ts"
import { findWorkspaceRoot, homePath, workspaceLabel, type WorkspaceLabel } from "../fs/workspace.ts"
import { configDir, startToolOutputGC } from "../util/xdg.ts"
import { loadMcpConfig, type McpProblem, type McpServerConfig } from "../mcp/config.ts"
import { discoverSkills, LIBRARY_DIR, skillCatalogue, type SkillSet } from "../prompt/skills.ts"
import { builtinSkills } from "../prompt/builtin-skills.ts"
import { McpManager, MCP_SERVER_PERMISSION, type McpStatus } from "../mcp/manager.ts"
import { captureWarnings } from "../util/warnings.ts"
import { confirm, trustNote } from "./confirm.ts"
import { renderContextReport, WARN_AT } from "./context.ts"
import { Editor } from "./editor.ts"
import { appendHistory, loadHistory, trimHistory } from "./history.ts"
import { Keyboard, terminalGone } from "./keyboard.ts"
import { LiveRegion } from "./live.ts"
import { FileIndex } from "./mentions.ts"
import { pickSession } from "./picker.ts"
import { compact as compactNumber, duration, firstLine, Renderer, shortenPaths, userLines } from "./render.ts"
import { digests, replay, restoreLastTurn } from "./replay.ts"
import { relativeTime } from "./sessions.ts"
import { Shell } from "./shell.ts"
import { displayWidth, padToWidth } from "./width.ts"
import { App } from "../tui/app.ts"
import type { NoteTone } from "../tui/chat/board.ts"
import { ChatModel } from "../tui/chat/model.ts"
import { ChatPane } from "../tui/panes/chat.ts"
import type { Detail } from "../tui/panes/detail.ts"
import { Screen } from "../tui/screen.ts"
import { Transcript } from "../tui/transcript.ts"
import { setColorEnabled, theme } from "./theme.ts"

/**
 * 版本号从 package.json 来(bun 编译时把 JSON 内联进二进制)。
 *
 * 三处各写一份的话,迟早出现"横幅说 0.3.0、release 页写着 v0.4.0" ——
 * 而发版前 CI 会核对 tag 和它一致(见 .github/workflows/release.yml)
 */
const VERSION = ALFA_VERSION

/**
 * `-p` 里最多等子 agent 多久。
 *
 * 有上限不是不信任它们(它们自己有步数上限),是因为这条路多半跑在脚本或 CI 里,
 * 而一条永远不返回的命令比一份不完整的答案难查得多。
 */
const ONE_SHOT_AGENT_LIMIT_MS = 15 * 60_000

/**
 * 终端没了之后,留给收摊多久。
 *
 * 这不是"够不够用"的问题 —— 正常收摊几百毫秒就完事。它是给**收不完**的那种
 * 情况兜底:没有终端就没有人能看见卡住了,超时了也得走。
 */
const HANGUP_SHUTDOWN_MS = 3_000

/**
 * 帮助现取而不是写死一份常量:命令示例里那个名字要跟用户刚才敲的那个一致。
 * 见 cli/program.ts —— 它可能以别的名字被调起。
 */
function usage(): string {
  const me = programName()
  return `${PRODUCT} ${VERSION}${me === PRODUCT ? "" : ` (as ${me})`}

Usage:
  ${me} [options]              start an interactive session
  ${me} -p "<prompt>"          run one prompt and exit
  ${me} auth <cmd>             manage saved API credentials
  ${me} upgrade [--force]      replace this binary with the latest release
                              (also /upgrade inside a session)
  ${me} uninstall              remove alfa and everything it stored
                              (lists what goes first; add "confirm" to do it)

Options:
  -p, --prompt <text>   non-interactive: run once, print, exit
  -m, --model <spec>    provider/model (default: $ALFA_MODEL)
  -c, --cwd <dir>       working directory (default: current)
      --continue        pick up the most recent session in this directory
      --resume          choose an earlier session from a list
      --thinking        enable extended thinking where supported
      --reasoning       show the model's reasoning as it streams
      --no-color        disable ANSI colors
      --no-markdown     print the model's replies as raw text
      --plain           skip the full-screen UI, keep terminal scrollback
      --no-mouse        do not capture the mouse (keeps native text selection;
                        with the mouse on, hold Shift to select as usual)
      --permission <m>  confirm | default | trust (shift-tab switches it live)
  -h, --help            show this help
  -v, --version         print version

Interactive keys:
  enter                 send (queues while a turn is running)
  ctrl-j / alt-enter    newline
  esc                   interrupt the current turn
  tab                   next pane      ctrl-b files  ctrl-p plan  ctrl-] detail
  shift-tab             permission mode (confirm / default / trust)
  /                     command palette (/resume switches sessions)
  ctrl-c                clear input; twice on an empty line to exit

Credentials:
  ${me} auth login             save a provider (stored 0600 in your home dir)
  ${me} auth list              show configured providers, keys masked

  Environment variables always override stored values:
    ANTHROPIC_API_KEY  [ANTHROPIC_BASE_URL]
    OPENAI_API_KEY     [OPENAI_BASE_URL]
    ALFA_KEY_<NAME>  [ALFA_BASE_URL_<NAME>]
    ALFA_MODEL
`
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // ★ 第一件事。告警一旦打印出去就没法收回,而它落在哪一帧上是随机的 ——
  //   所以这条通道要在任何东西开始画之前就改道(见 util/warnings.ts)
  captureWarnings()
  // auth 有自己一套参数,先分流出去,不要和主命令的 parseArgs 混在一起
  if (argv[0] === "auth") return authSubcommand(argv.slice(1))
  // upgrade 同理。它在**任何配置之前**就能跑 —— 一个装坏了的旧版本,
  // 用户能做的第一件事就该是把它换掉,而不是先去配一个 provider
  if (argv[0] === "upgrade") return upgradeSubcommand(argv.slice(1))
  // uninstall 同理,而且更该在配置之前:一个"我不想用了"的人,不该先被要求
  // 配一个 provider 才准走。它也**只有**这一个入口 —— 见 cli/uninstall.ts 头注释
  if (argv[0] === "uninstall") return uninstallSubcommand(argv.slice(1))

  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        prompt: { type: "string", short: "p" },
        model: { type: "string", short: "m" },
        cwd: { type: "string", short: "c" },
        thinking: { type: "boolean", default: false },
        reasoning: { type: "boolean", default: false },
        // ⚠ Node 的 parseArgs **不支持** --no-xxx 自动取反(这一点没有任何提示,
        //   只会报 "Unknown option")。想要 --no-color 就得显式声明一个 no-color。
        //   help 里写了却没声明的话,用户照着敲就是报错 —— 本项目已经栽过一次。
        "no-color": { type: "boolean", default: false },
        // 同上,--no-xxx 一律要显式声明
        "no-mouse": { type: "boolean", default: false },
        "no-markdown": { type: "boolean", default: false },
        plain: { type: "boolean", default: false },
        // 两条都是长选项:-c 已经是 --cwd 了,再让 -c 变成 --continue 是在
        // 用一个字母换一整类"我以为它换目录了"的事故
        continue: { type: "boolean", default: false },
        resume: { type: "boolean", default: false },
        permission: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
      allowPositionals: true,
    })
  } catch (error) {
    process.stderr.write(theme.red(`${(error as Error).message}\n\n`) + usage())
    return 2
  }

  const flags = parsed.values
  if (flags.help) {
    process.stdout.write(usage())
    return 0
  }
  if (flags.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  // 颜色:显式 --no-color 优先,其次沿用 picocolors 对 NO_COLOR / TTY 的判断
  if (flags["no-color"] === true) setColorEnabled(false)

  /** 命令行 > 配置。配置里那份是上次 /permission 或 shift-tab 留下来的 */
  let startMode: PermissionMode | undefined
  if (flags.permission !== undefined) {
    const resolved = normalizeMode(flags.permission)
    if (!resolved) {
      process.stderr.write(theme.red(`Unknown permission mode "${flags.permission}".\n`))
      process.stderr.write(theme.dim(`Try: ${MODES.join(", ")}\n`))
      return 2
    }
    startMode = resolved
  }

  const cwd = flags.cwd ? resolve(flags.cwd) : process.cwd()
  const root = findWorkspaceRoot(cwd)
  const oneShot = flags.prompt !== undefined
  /**
   * 现在能不能问用户一句话。
   *
   * 两头都得是终端:stdin 不是就没人可以答(`echo … | alfa` 那条路),
   * stdout 不是就问了也看不见(输出进了管道或日志)。-p 同理 —— 它的契约是
   * 「跑一次,打印,退出」,中途弹个提示会让调用它的脚本挂在那里。
   */
  const canPrompt = (): boolean => !oneShot && process.stdin.isTTY === true && process.stdout.isTTY === true

  // ── 模型 ──
  let config
  let auth
  try {
    config = loadConfig()
    auth = loadAuth()
  } catch (error) {
    // 配置文件坏了要说清是哪个文件、怎么修,不能退化成"没有凭据"
    process.stderr.write(theme.red(`${(error as Error).message}\n`))
    return 1
  }

  // 命令行没说的话,用上次留下来的那个模式。★ 它会在启动横幅上写出来 ——
  // 存一个安全边界的前提就是别让它悄悄生效(见 config.ts 的 Config.permission)
  const restoredMode = startMode === undefined && config.permission !== undefined ? config.permission : undefined
  if (restoredMode) startMode = restoredMode

  // 语言要在**任何一行文案出现之前**定下来 —— 包括下面几条报错。
  // 设置界面语言之后再去报「没有模型」,用户才不会先看到一句英文再看到一句中文
  const language: Required<LanguageConfig> = {
    interface: config.language?.interface ?? "auto",
    reply: config.language?.reply ?? "auto",
  }
  setInterfaceLanguage(language.interface)

  let registry = buildRegistry({ config, auth })
  let spec = flags.model ?? defaultModelSpec({ config, auth })
  /**
   * 扩展思考。**可变** —— `/think` 当场改它,下一轮就生效。
   *
   * `--thinking` 只是这一次的初值:命令行说了就听命令行,否则用配置里存的那份。
   */
  let thinking = flags.thinking === true || config.thinking === true
  /** 快满了自己压一次。**缺省开** —— 见 config.ts 的 autoCompact */
  let autoCompact = config.autoCompact !== false
  /**
   * 这个文件夹的信任状态。**可变** —— 「先看一眼」那条路会在会话中途把它翻过来,
   * `/trust` 也会。谁读它见 buildSystemParts 里 trustProject 那颗星。
   */
  let trust = trustFor(root, config)
  /**
   * agentflow:开着的话同时最多几个子 agent,false = 关。**可变**,`/agentflow` 当场改。
   *
   * 它同时是三样东西的真值源:调度器的窗口(SubagentDeps.flow)、system 里那一段
   * (prompt/agentflow.ts)、以及横幅上那一行。三处各存一份的话,切换之后
   * 「界面说开着、模型不知道」这种错要跑一整轮才现形
   */
  let agentflow: number | false = isFlowWindow(config.agentflow) ? config.agentflow : false
  /**
   * 什么都没配。
   *
   * ★ 有终端就**引导**,没终端才报错。第一次运行是这个程序唯一一次能假设
   *   "用户什么都还不知道"的时刻,把它用在打印一条错误上是浪费(见 cli/onboard.ts)。
   *   管道和 -p 那两条路照旧一句话退出 —— 那边没人可以问,而卡在一个等输入的
   *   提示上的脚本比一条报错难查得多。
   */
  if (!spec) {
    if (!canPrompt()) {
      process.stderr.write(theme.red("No model configured.\n"))
      process.stderr.write(theme.dim(`\nRun: ${programName()} auth login\n`))
      return 1
    }
    const result = await onboard("no-model")
    if (!result.spec) {
      if (!result.hinted) process.stdout.write(manualSetupHint())
      return result.cancelled ? 0 : 1
    }
    // 引导刚往磁盘上写了 provider 和 key,现在那两份都得重读 —— 手里这一份是
    // 进程启动那一刻的快照,照着它装出来的注册表里没有刚存的那家
    spec = result.spec
    config = loadConfig()
    registry = buildRegistry({ config, auth: loadAuth() })
  }

  /**
   * 当前模型。**是个可变的盒子**,不是三个变量 —— 和 session 同一条理由:
   * `/model` 会在程序跑着的时候换掉它,而系统提示词、每一轮请求、上下文仪表、
   * 摘要、压缩五处都得跟着换。各自捕获一份的话,换掉的只有其中几处,
   * 表现出来是"说切好了,但状态行还写着旧的,而摘要照旧发给旧模型"。
   *
   * 三样必须一起换:spec 是给人看的那串字(横幅、状态行、`/context`),
   * ref 是发请求用的,info 是窗口多大、是猜的还是查到的。
   */
  let model: { spec: string; ref: ModelRef; info: ModelInfo }
  try {
    // 提前解析一次:凭据缺失要在用户输入之前就说清楚
    model = { spec, ref: parseModelRef(spec), info: registry.resolve(spec).info }
  } catch (error) {
    if (error instanceof NoCredentialsError || error instanceof UnknownModelError) {
      // 配了模型但没有它的 key —— 同样是"还没弄好",同样值得引导一次。
      // 认不出的模型名不引导:那不是没配好,是打错了,该看见原话
      if (error instanceof NoCredentialsError && canPrompt()) {
        const result = await onboard("no-credentials")
        if (result.spec) {
          spec = result.spec
          config = loadConfig()
          registry = buildRegistry({ config, auth: loadAuth() })
          model = { spec, ref: parseModelRef(spec), info: registry.resolve(spec).info }
        } else {
          if (!result.hinted) process.stdout.write(manualSetupHint())
          return result.cancelled ? 0 : 1
        }
      } else {
        process.stderr.write(theme.red(`${error.message}\n`))
        process.stderr.write(theme.dim(`\nConfigured providers: ${registry.ids().join(", ") || "(none)"}\n`))
        process.stderr.write(theme.dim(`Add one with: ${programName()} auth login\n`))
        return 1
      }
    } else {
      throw error
    }
  }

  // `/model` 按 tab 时列哪几个。一场里灌一次 —— 注册表在进程生命周期内不变
  setModelChoices(registry.catalog())

  // ── 装配 ──
  const store = new Store()
  /**
   * 当前会话。**是个可变的盒子**,不是一个 id。
   *
   * `/resume` 会在程序跑着的时候把它换掉,而循环、工具上下文、摘要三处都得
   * 跟着换。各自捕获一份 id 的话,换掉的只有其中一处 —— 表现出来是"接上了旧
   * 会话,但新说的话写进了旧会话的隔壁",而且不报错。
   */
  const session = { id: newSessionID() }
  // --continue 不需要问任何人,在装配之前就能定下来。--resume 要挑,得等键盘,
  // 所以它在交互模式那一段才发生(见 openResume)
  const continued = flags.continue === true ? store.latestSession(cwd) : undefined
  if (continued) session.id = continued.id
  else store.createSession(session.id, cwd)
  startToolOutputGC()
  // 上一次 Windows 上的自更新留下的 .old,现在没人占着了(见 update/upgrade.ts)
  sweepParkedBinary()

  const isTTY = process.stdout.isTTY === true && process.stdin.isTTY === true
  /** 全屏三栏。-p、管道、--plain 都不走它 */
  const fullscreen = !oneShot && isTTY && flags.plain !== true

  // -p / 管道模式不要活动区:输出多半要进管道或日志,发光标控制只会污染它
  /** --plain 模式下由 Shell 顶上:改大小要按新宽度重排输入框,不能原样重画 */
  let onResize = (): void => {}
  const region = new LiveRegion({
    enabled: !oneShot && !fullscreen && process.stdout.isTTY === true,
    onResize: () => onResize(),
  })
  /** 全屏模式下渲染结果进对话缓冲(自己折行、自己滚),否则直接落终端 */
  const transcript = fullscreen ? new Transcript() : undefined
  const renderer = new Renderer({
    sink: transcript ?? region,
    showReasoning: flags.reasoning === true,
    root,
    // 和颜色同一条判断线:输出进了管道就一律原样。加粗和项目符号对下游程序
    // 是噪音,而 -p 的输出被塞进脚本是真实用法
    markdown: flags["no-markdown"] !== true && process.stdout.isTTY === true,
    // 署名是给人看的。-p 和管道的输出会被别的程序吃掉,多一行 `◆ agent`
    // 就是多一行要被下游过滤的噪音
    speakers: !oneShot && process.stdout.isTTY === true,
  })
  /**
   * session 视图的状态。
   *
   * 和 transcript **同时**挂在事件流上:两个视图各自是同一份事件的投影,
   * 谁也不是谁的缓存。所以 `/view` 切过去看到的是完整历史,而不是「从现在开始记」。
   */
  const chatModel = oneShot ? undefined : new ChatModel({ root })
  const emitter = new Emitter<UIEvent>()
  emitter.on((event) => renderer.handle(event))
  if (chatModel) emitter.on((event) => chatModel.handle(event))

  /**
   * 活动区那一端。交互模式下由 Shell 顶上,其它形态是空实现 ——
   * 这样 loop 的装配不必知道现在是哪种形态。
   */
  const ui = {
    preview(_label: string, _text: string): void {},
    clearPreview(): void {},
    detail(_detail: Detail): void {},
    filesMayHaveChanged(): void {},
    /**
     * 后台那一栏变了(子 agent 换了一步、跑完了)。
     *
     * 必须有这一声:空闲时全屏界面是**不重绘**的,而子 agent 的变化不来自
     * 任何一次按键 —— 没人叫的话,面板会一直停在十分钟前那一步上,直到用户
     * 随便按个键才突然跳到最新,看着像 bug。
     */
    jobsChanged(): void {},
  }

  /**
   * agent 在本次会话里写过的文件。判官靠它分辨「来路不明的脚本」和
   * 「用户刚看着它写出来的脚本」—— 后者被当成前者,是 auto 模式最烦人的
   * 失败方式(见 judge.ts 的 JudgeContext.written)。
   */
  const written = new Set<string>()

  // 工具的实时输出只带 callID,工具名要从事件流里认
  const toolNames = new Map<string, string>()
  emitter.on((event) => {
    if (event.type !== "tool.state") return
    const part = event.part
    if (part.state.status === "running") {
      toolNames.set(part.callID, part.tool)
    } else if (part.state.status !== "pending") {
      toolNames.delete(part.callID)
      ui.clearPreview()
      // 任何工具跑完都可能动过盘(write/edit 显然,bash 更是什么都能干)。
      // 重扫只是 readdir 几个展开着的目录,便宜,而且有防抖。
      ui.filesMayHaveChanged()
    }
    // 真的落盘了才算 —— 授权过但失败的那些不算「用户看过 diff」
    if (part.state.status === "completed" && (part.tool === "edit" || part.tool === "write")) {
      const input = part.state.input as Record<string, unknown> | undefined
      const filePath = input?.["filePath"]
      if (typeof filePath === "string" && filePath.length > 0) written.add(resolve(cwd, filePath))
    }
    const detail = toDetail(part, root)
    if (detail) ui.detail(detail)
  })

  /** 当前 turn 的中断信号,交给确认框,这样等待按键时 Ctrl-C 也能立刻退出 */
  let turnSignal: AbortSignal | undefined
  /** 交互模式下 stdin 的持有者。-p 和管道模式下没有。 */
  let keyboard: Keyboard | undefined
  /**
   * 怎么问权限。默认走 confirm.ts(写进滚动区),全屏模式会换成模态框。
   *
   * 必须是可替换的:在 alternate screen 里直接往 stdout 写会盖穿合成器画好的
   * 画面,而且合成器的前台缓冲还以为屏幕没变 —— 之后每一帧的差分都对着错的
   * 基准算,界面永久花掉。这不是显示不好看,是不可恢复。
   */
  let askPermission: PromptFn = (request) =>
    confirm(request, {
      ...(keyboard ? { keyboard } : {}),
      region,
      // 请求自带的信号优先:后台子 agent 的问题跟着**它**死,不跟着用户这一轮
      ...(request.signal ?? turnSignal ? { signal: request.signal ?? turnSignal! } : {}),
    })
  /**
   * 怎么问用户一句(见 tool/ask.ts)。和权限同一条路子:默认写进滚动区,
   * 全屏模式换成模态框。
   *
   * -p / 管道下 keyboard 是 undefined,askInPlain 会回 unavailable —— 那是
   * 「这儿没人可问」,不是「用户不理我」,两句话对模型的意思完全不同。
   */
  let inquire = (question: Question): Promise<Answer> =>
    askInPlain(question, {
      ...(keyboard ? { keyboard } : {}),
      region,
      ...(turnSignal ? { signal: turnSignal } : {}),
    })
  /** 用户自己的最后一句话。给摘要 agent 用 */
  let lastUserText = ""
  /**
   * 两个视图都要留的收据。全屏模式下会被换成「瀑布流追一行 + 看板记一条」。
   *
   * 默认实现只写瀑布流 —— --plain 和管道模式下没有看板。
   */
  let receipt = (line: string, _tone: NoteTone, _text: string): void => renderer.line(line)
  /**
   * trust 没问就放行的那条收据。**和普通收据分开一条路** —— 全屏下它不追加
   * 看板行,而是把记号打在那次调用本行上(见 tui/panes/chat.ts 的 trusted)。
   */
  let trustReceipt = (line: string, _summary: string, _callID?: string): void => renderer.line(line)
  /** 斜杠命令的回答。全屏模式下会被换成「两个视图都写」 */
  let reply = (text: string): void => {
    for (const line of text.split("\n")) renderer.line(line)
  }
  const gate = new PermissionGate((request) => askPermission(request), {
    // 自动放行必须留痕。看不见的自动化不是省事,是失控。
    //
    // ★ 但**子 agent 那些不写进这一场**:它是后台的一场,它跑的每一条命令
    //   都记在它自己的输出里(`job output` 读得到),面板上那一行也写着它此刻
    //   在干什么。写进用户正看着的对话里,他会看到一串自己没让谁干的 bash
    //   在"未询问直接放行" —— 和子 agent 的进程记录混进主会话是同一种串味
    //   (见 agent/subagent.ts)。问框那一侧相反:那个必须写清是谁要的
    onTrusted: (request) => {
      const note = trustNote(request)
      if (note) trustReceipt(note.line, note.summary, request.callID)
    },
    root,
    remember: (rules) => rememberApprovals(root, rules),
  })
  if (startMode) gate.setMode(startMode)
  // 上次在这个工作区按过的 always。按 root 取而不是 cwd:规则里的路径是相对
  // 工作区的,在子目录里启动看到的必须是同一批
  const remembered = loadApprovals(root)
  gate.restoreApproved(toRuleset(remembered))

  const tools = registerBuiltins(new ToolRegistry())

  /**
   * MCP:第二条 tool source(设计约束 #2 说的那条边界,到这里才算真被用过一次)。
   *
   * 配置两处都读 —— 全局那份是"这台机器有哪些 server",项目那份是"这个仓库要用
   * 哪几个"。后者是**别人可能写的文件**,而它能指定要跑的进程,所以来路是
   * project 的 server 要用户点过头才连(许可存在和「以后不再问」同一个地方,
   * 按工作区分开)。连接全在后台,一个 server 连不上的代价是少几个工具。
   */
  const mcpConfig = loadMcpConfig({
    ...(config.mcp?.servers ? { global: config.mcp.servers as Record<string, McpServerConfig> } : {}),
    // 货架:定义在全局配置里,但只有项目 `use: [...]` 点了名才连
    ...(config.mcp?.library ? { library: config.mcp.library as Record<string, McpServerConfig> } : {}),
    globalSource: configPath(),
    root,
  })
  const mcpTrusted = new Set(
    loadApprovals(root)
      .filter((one) => one.permission === MCP_SERVER_PERMISSION)
      .map((one) => one.pattern),
  )
  const mcp = new McpManager({
    root,
    entries: mcpConfig.servers,
    isTrusted: (entry) => mcpTrusted.has(entry.name),
  })
  mcp.start()

  /**
   * Skills:目录进 system(一条一行),正文由 `skill` 工具按名取回。
   *
   * ★ 只在这里找一次,然后**同一份**同时喂给 system 和工具。两边各扫一遍的话,
   *   迟早出现"目录里列着、点开说没有" —— 而那种不一致是从模型的角度看不出来的,
   *   它只会以为自己名字打错了,然后换一个再试。
   */
  const skills = discoverSkills({
    root,
    program: programName(),
    userDir: join(configDir(), "skills"),
    // 货架:存着不生效。不进目录、不进上下文,只有被点名才花钱
    libraryDir: join(configDir(), LIBRARY_DIR),
    // 别家的用户级目录。项目那半在 discoverSkills 里按 root 拼(见 CLAUDE_SKILLS_DIR)
    claudeUserDir: join(homedir(), ".claude", "skills"),
    builtin: builtinSkills(),
  })

  /**
   * 这一趟真正拿得到的 skill。
   *
   * ── ★ 项目来路的那些也归信任管 ──
   * `.alfa/skills/` 和 `.claude/skills/` 是**跟着仓库走的文件**,而它们的
   * 「名字 + 一句说明」是无条件拼进 system prompt 的(见 prompt/skills.ts 的
   * skillCatalogue)。正文要点名才来,但**那一行说明本身就够用了** ——
   * 一句 "use this whenever the user asks about deployment" 是攻击者能写进
   * system prompt 的一整句话,而且它读起来完全像一条正经的目录项。
   *
   * 所以不信任的时候整条不给:不进目录,`skill` 工具也点不开(点不开是必须的 ——
   * 只从目录里拿掉的话,模型猜对一个名字就把正文读进来了)。
   *
   * ⚠ **现算**,和 trustProject 同一条理由:信任会在会话中途翻过来。
   *   `skills` 那个常量是启动时扫的一份磁盘快照,信任是活的,两者分开。
   */
  const visibleSkills = (): SkillSet =>
    trust === "trusted" ? skills : { ...skills, skills: skills.skills.filter((one) => one.origin !== "project") }

  /**
   * 这一轮实际会发出去的工具和 system。
   *
   * 抽成两个函数是因为**上下文仪表盘要看的必须是同一份**:自己再拼一遍的话,
   * 报出来的占用和真正发出去的那一份会慢慢分叉,而分叉的方向永远是"报得比
   * 实际少",直到某天毫无预兆地撞上上限。
   */
  // MCP 的工具拼在内建后面。顺序不用管:adaptTools 那边照 id 排过,而排序正是
  // prompt cache 的前提(见 llm/adapt-tools.ts)。一个 server 中途连上,它的工具
  // 从**下一轮**开始出现 —— 这会让缓存前缀作废一次,所以只在真变了的时候变
  const enabledTools = () => [...tools.list(), ...mcp.tools()].filter((tool) => !gate.disabled(tool.id))
  /**
   * 这一轮**主 agent** 手上有哪些工具。agentflow 开着也是同一份。
   *
   * ── 强制措施拆过三版,三版都比它要治的病更贵 ──
   * 一版是把 write/edit/bash 从领班手上拿掉,二版留 write 拿掉两个,三版改成
   * 「每个用户回合五次」的额度。三版都撞在同一件事上:**agentflow 的一"轮"
   * 长得离谱**。用户开口算一轮,而子 agent 交报告把领班叫醒的那几十次续跑
   * 都还在同一轮里(见 runTurn 的 text === undefined 那条路)。于是额度在
   * 开头看代码的时候就花光了,而真正需要动手的时刻——服务起不来、要重跑一次
   * 测试、要删掉一个陈旧的产物——全在后面,全被拒。
   *
   * 用户看到的是一个中途开始说"我不能"的领班。而它接下来会做的事更糟:
   * 拿到一个硬拒绝之后去找绕路,而不是老老实实派人。
   *
   * ★ 所以这里不再拦。「你是领班」现在完全由 prompt/agentflow.ts 那一段承担,
   *   它也确实还会输给"自己干更快"——但输的代价是一次多余的自己动手,
   *   而拦的代价是一次当着用户面的拒绝。后者更贵,而且更难看。
   */
  const activeTools = () => enabledTools()
  const buildSystemParts = (flow: number | false) =>
    buildSystem({
      template: modelInfoTemplate(model.spec),
      cwd,
      root,
      model: model.spec,
      replyLanguage: language.reply,
      // 用户实际敲的那个名字。见 prompt/config.ts —— 那一段里印着一条
      // `<程序名> auth login`,写死的话只装了另一个名字的人会抄到 command not found
      program: programName(),
      skills: visibleSkills(),
      // 只报已经连上的。连接中/失败的那些工具还不在表里,写进去等于告诉它
      // 有一批用不了的工具(见 prompt/mcp.ts)
      mcpServers: mcp.statuses().filter((one) => one.state === "ready").map((one) => one.name),
      // 开着才给。见 prompt/agentflow.ts —— 关着的时候那一段一个字都不该在
      ...(flow !== false ? { agentflow: flow } : {}),
      // ★ **现取**,不是启动时算一次。信任会在一场会话中途翻过来:「先看一眼」
      //   那条路上,子 agent 读完说没问题,下一步这个仓库的 AGENTS.md 就该开始
      //   生效 —— 而 system prompt 每一步都重建一次(见 agent/loop.ts),
      //   所以读一个活的变量就够了,不需要第二条通知链。
      //
      //   读变量而不是每次 loadConfig():那是每个 step 一次磁盘读,而且一份
      //   被手改坏的 config 会从这里抛出去,把正在跑的那一轮一起带走。
      trustProject: trust === "trusted",
    }).parts
  const systemPrompt = () => buildSystemParts(agentflow)

  /**
   * 子 agent 那一份工具表:少了 `task` 和 `ask`。
   *
   * 两条边界的理由写在 agent/subagent.ts 文件头。剔除动作放在这里而不是那边,
   * 是因为**只有这一层知道工具表长什么样** —— 那边只认一个 tools() 函数。
   */
  // ★ 从 enabledTools 起,**不是** activeTools:干活的人当然要有 write/edit/bash,
  //   被拿掉那三个的只有领班(见 activeTools)。这里接错一层,整个 flow 模式下
  //   就没有任何人能改文件了
  const subagentTools = () => enabledTools().filter((tool) => tool.id !== "task" && tool.id !== "ask")
  /**
   * 子 agent 的 system:同一份,末尾多一段"你是被派出来的"。见 prompt/subagent.ts
   *
   * ★ agentflow 那一段**故意不给**(传 false)。它讲的是怎么派人、谁等谁,而子 agent
   *   手上根本没有 `task` —— 给了它只会去调一个不存在的工具,拿到报错再试一次。
   *   顺带还省掉一件事:开关一切,子 agent 那份 prompt cache 不用跟着作废。
   */
  const subagentSystem = () => [...buildSystemParts(false), subagentBlock()]

  // ── 后台任务的留痕 ──
  //
  // 后台进程是这个程序里唯一跨轮活着的东西。它起来和倒下都不属于任何一次工具
  // 调用的结果,所以只能从这里说 —— 不说的话,一个悄悄死掉的 dev server 会让
  // 用户对着一个连不上的端口查半天,而屏幕上什么线索都没有。
  setJobObserver((event) => {
    // ★ 子 agent 起的进程**不写进对话**。用户没让谁起它,而这段对话讲的是
    //   另一件事 —— 一条凭空出现的 `▸ dev started` 只会让人以为自己漏看了什么。
    //   面板上照旧有它(那是状态,不是内容),`job list` 里也照旧看得见
    if (event.job.owner !== undefined) return
    if (event.kind === "started") {
      const line = t.jobStarted(event.job.id, event.job.command)
      receipt(theme.dim(`  ▸ ${line}`), "info", line)
      return
    }
    const how = exitLabel(event.job.exit, event.job.signal)
    const line = t.jobEnded(event.job.id, how)
    // 非 0 退出画成红的:一个后台构建失败了,和它跑完了,完全是两件事
    const bad = event.job.exit !== 0
    receipt(bad ? theme.red(`  ✗ ${line}`) : theme.dim(`  · ${line}`), bad ? "bad" : "good", line)
  })

  // ── 收口前的自动检查 ──
  //
  // 见 agent/check.ts。这里只管三件事:认不认得出检查器、跑不跑得动、
  // 结果怎么变成用户看得见的一行和模型收得到的一段话。
  let checker = detectChecker(root, config.check)
  /**
   * 这一场不再检查了。
   *
   * 两条路会走到这:用户拒了那次授权,或者检查器根本跑不起来(二进制不在)。
   * 两种情况下继续每轮都试一次,就是每轮都弹一次框 / 每轮都白等一次超时。
   */
  let checkOff = false
  /**
   * 上一次的失败原文。
   *
   * ★ 拿来认「这个错本来就在」。一个本来就编译不过的仓库(这恰恰是很多人打开
   *   agent 的原因)会让每一轮都被打回去修一堆跟这次任务无关的东西。原文一模
   *   一样 = 这次改动既没修好它也没弄坏别的,那就别拦它,收据照写。
   */
  let lastFailure: string | undefined
  /** 手动 `/check` 那一次的中断句柄。esc 要能停它 */
  let manualCheck: AbortController | undefined

  /** 跑一次检查,把结果写成收据。返回要塞给模型的话(没有就 undefined)。 */
  const runProjectCheck = async (
    signal: AbortSignal | undefined,
    options: { manual?: boolean } = {},
  ): Promise<string | undefined> => {
    if (!checker) return undefined
    const current = checker
    try {
      // 照旧过门卫。检测到的那个二进制在一个刚 clone 回来的仓库里仍然是别人写的
      await gate.ask({ permission: "bash", patterns: [current.command], metadata: { workdir: root } })
    } catch {
      checkOff = true
      receipt(theme.dim(`  · ${t.checkSkipped}`), "info", t.checkSkipped)
      return undefined
    }

    const outcome = await runCheck(current, { root, ...(signal ? { signal } : {}) })
    if (outcome.status === "unavailable") {
      const why = outcome.reason ?? "failed to run"
      // 中断是暂时的(用户按了 esc),别为它把整场的检查关掉
      if (why !== "interrupted") checkOff = true
      const line = t.checkUnavailable(current.id, why)
      receipt(theme.yellow(`  ⌁ ${line}`), "warn", line)
      return undefined
    }
    if (outcome.status === "ok") {
      lastFailure = undefined
      const line = t.checkPassed(current.id)
      receipt(theme.dim(`  ✓ ${line}`), "good", line)
      return undefined
    }

    const first = firstLine(outcome.output) || `exit ${outcome.code ?? "?"}`
    const unchanged = outcome.output === lastFailure
    lastFailure = outcome.output
    const line = unchanged ? t.checkStill(current.id) : t.checkFailed(current.id, first)
    receipt(theme[unchanged ? "yellow" : "red"](`  ${unchanged ? "⌁" : "✗"} ${line}`), unchanged ? "warn" : "bad", line)
    // 手动跑的那次不塞回给模型:用户是自己想看一眼,不是在指挥它去修
    if (options.manual || unchanged) return undefined
    return checkReminder(current, outcome.output)
  }

  /**
   * 一次工具调用的上下文。**主 agent 和子 agent 共用这一份。**
   *
   * 差别只有三处,而且每一处都有理由:
   *   ① 子 agent 没有 inquire、没有 agents —— 它问不了用户,也不能再派人(见
   *      agent/subagent.ts 文件头)。少给一个能力比给了再拦好:模型看不见的
   *      工具不会被调用,而被拦下来的调用要花一整轮才知道白跑了
   *   ② 进度不往右栏推 —— 那一栏跟的是**你正在看的**这一轮,后台的工具输出
   *      挤进去只会让人以为主 agent 跑偏了
   *   ③ 上下文报告按各自那场会话算 —— 子 agent 问"我还剩多少"时,答案当然
   *      是它自己那个窗口
   *
   * 门卫是**同一个**:同一张规则表、同一份"以后不再问"。后台不是绕开授权的
   * 后门,它只是不站着等。
   */
  const makeToolContext = (
    sessionID: string,
    call: { messageID: string; callID: string; abortSignal: AbortSignal },
    options: { subagent?: string } = {},
  ) =>
    createToolContext(
      {
        cwd,
        root,
        sessionID,
        // 后台来的请求要写清是谁要的:一个框在用户正跟主 agent 说话时弹出来,
        // 不说是哪个子 agent 的话,他看到的是一条自己没让谁干的事在请求授权
        ask: (input) =>
          gate.ask(
            options.subagent
              ? {
                  ...input,
                  metadata: { ...input.metadata, job: options.subagent },
                  // 它死了,这个框就该收掉。见 AskInput.signal
                  signal: call.abortSignal,
                }
              : input,
          ),
        ...(options.subagent
          ? { owner: options.subagent }
          : { inquire: (question: Question) => inquire(question), agents: subagents }),
        onProgress: options.subagent
          ? () => {}
          : (callID, text) => ui.preview(toolNames.get(callID) ?? "running", text),
        onMetadata: () => {},
        // 和 system 里那份目录是同一个对象,见上面那颗星
        skills: () => visibleSkills(),
        // 模型看自己上下文的那个工具(见 tool/context-window.ts)。现算 ——
        // 它是在一轮的**中间**问的,而那一轮已经往窗口里塞了不少东西了。
        // ★ 主会话这一份和界面上那条量表走同一个 measure(),两边各算一遍的话,
        //   迟早出现「它说还很空,而状态行是红的」
        context: () =>
          options.subagent
            ? toContextView(
                contextReport({
                  history: store.listAll(sessionID),
                  system: subagentSystem(),
                  tools: subagentTools(),
                  skills: skillCatalogue(visibleSkills()),
                  info: model.info,
                }),
              )
            : toContextView(measure()),
      },
      call,
    )

  /**
   * 后台的子 agent。
   *
   * 它拿到的 stream / model / memory / gitContext 和主循环**是同一份** ——
   * 换句话说,派出去的那个和你正在说话的这个是同一个模型、同一套记忆、同一个
   * 仓库现状。不同的只有工具表(少两个)、system(多一段)和它自己那场会话。
   */
  const subagents = new SubagentJobs({
    store,
    stream: (request) => streamWithRetry(registry, request),
    model: () => model.ref,
    info: () => model.info,
    tools: subagentTools,
    system: subagentSystem,
    makeToolContext: (job, call) => makeToolContext(job.sessionID, call, { subagent: job.id }),
    memory: (sessionID) => {
      // ★ 不信任的文件夹**一条便条都不给**。见 buildSystemParts 里 trustProject
      //   那颗星,以及下面 memory 那一处同名的说明 —— 两处必须一起判,漏一处
      //   等于这道门只关了一半
      if (trust !== "trusted") return undefined
      const set = discoverMemories(root, sessionID)
      const text = renderMemories(set)
      return text.length === 0 ? undefined : { text, notes: set.memos.length }
    },
    gitContext: () => gitContextBlock(root),
    directory: cwd,
    // 现取:一个子 agent 属于**派它出去的那一场**(见 deliverReport)
    session: () => session.id,
    // 子 agent 花掉的记进这一场的总账。走 bill() 而不是 observe() —— 后者会把
    // 主对话的上下文占用改成这个子 agent 的占用(见 ContextMeter.bill)
    bill: (tokens) => meter.bill(tokens),
    // 起落留痕。和后台进程同一条理由 —— 一个在后台花着钱的东西,至少要在
    // 它起来和结束的时候各留一行
    observer: (event) => {
      if (event.kind === "started") {
        const line = t.agentStarted(event.job.id, event.job.command)
        receipt(theme.dim(`  ▸ ${line}`), "info", line)
        return
      }
      // 被停掉的(exit 为 null)不算失败:那是用户自己按的,画成红 ✗ 只会
      // 让人以为出事了
      const bad = event.job.signal === undefined && event.job.exit !== 0
      const how = event.job.signal
        ? t.agentStopped
        : bad
          ? t.agentFailed(t.jobExitCode(String(event.job.exit ?? "?")))
          : `${t.agentDone(event.job.steps ?? 0)} · ${t.ctxSpentShort(
              compactNumber(event.job.tokensIn ?? 0),
              compactNumber(event.job.tokensOut ?? 0),
            )}`
      const line = t.agentEnded(event.job.id, how)
      receipt(bad ? theme.red(`  ✗ ${line}`) : theme.dim(`  · ${line}`), bad ? "bad" : "good", line)
      // ★ 报告是**推**给主 agent 的,不是它去捞的。见 deliverReport
      deliverReport(event.job)
    },
    onChange: () => ui.jobsChanged(),
    // 子 agent 也会改文件,而它的事件流不经过上面那条 emitter —— 不接这一声,
    // 它写出来的文件在树里要等到用户自己去动一下才出现(见 SubagentDeps)
    onFilesChanged: () => ui.filesMayHaveChanged(),
    // 现取。`/agentflow` 改的是**下一个** task 的调度,已经跑起来的那些不动
    flow: () => agentflow,
  })

  /**
   * 子 agent 干完了,把报告送进主对话。
   *
   * ★ **这是这一套东西的关键一环**,所以它是可变的:观察者建得比 deps 早,
   *   而真正的实现要用到"现在这一场是哪一场""主 agent 忙不忙"。默认是空的 ——
   *   `-p` 里也会被换成一个只塞消息、由外面那圈循环消化的版本。
   */
  let deliverReport: (job: JobSnapshot) => void = () => {}

  /**
   * 正在跑的那次「先看一眼」。
   *
   * ★ 它的报告**不进主对话**。这份东西是给用户看的一句结论(以及有话说时的
   *   那几行),不是给模型的材料 —— 塞进对话就等于把一份"这个仓库里有可疑
   *   指令"的清单交给模型自己去读,而那正是我们不想让它读的东西。
   *   deliverReport 会先认出这个 id 并截走它,见那边。
   */
  let trustJob: string | undefined

  /**
   * 派人去读一遍这个文件夹的说明文件。
   *
   * 后台跑。挡在启动前面的话,用户开一个陌生仓库要先干等一次模型调用 ——
   * 而在结论回来之前,那些文件本来就一个字都没进 system prompt(trust
   * 现在是 checking,fail closed),等它没有任何好处。
   */
  const startTrustReview = async (): Promise<string | undefined> => {
    if (trustJob !== undefined) return t.trustCheckBusy
    try {
      const job = await subagents.start({ name: TRUST_AGENT_NAME, prompt: trustReviewPrompt(root) })
      trustJob = job.id
      return undefined
    } catch (error) {
      // 派不出去(没配模型、并发满了)也要说一句。默默失败的后果是一个
      // 永远停在 checking 的文件夹 —— 而 checking 按不信任走,于是用户的
      // AGENTS.md 从此不生效,却没有任何一行字解释为什么
      return t.trustCheckNoModel(error instanceof Error ? error.message : String(error))
    }
  }

  /** 报告到了。落盘、说一句、把活的那个变量翻过来 */
  const finishTrustReview = (report: string): void => {
    trustJob = undefined
    const outcome = settleTrustReview(root, report)
    trust = outcome.trust
    if (outcome.verdict === "clean") {
      receipt(theme.green(`  ✓ ${t.trustClean}`), "good", t.trustClean)
      return
    }
    const head = outcome.verdict === "concerns" ? t.trustConcerns : t.trustUnreadable
    receipt(theme.yellow(`  ! ${head}`), "warn", head)
    // 有话说的时候**原样给用户看**。总结一遍等于让我们替他判断哪几条重要,
    // 而这几行正是他要自己过目的东西
    if (outcome.detail.length > 0) reply(theme.dim(outcome.detail))
  }

  /**
   * 界面上那两块的数据源。**分开**,不是一块。
   *
   * 一个 dev server 和一个正在翻仓库的子 agent,对**模型**是同一类东西
   * (都用 `job` 看/等/停,所以那个工具照旧一起管),但对**用户**不是:
   * 前者是"我起的那个进程还在不在",后者是"我派出去的那几个查得怎么样了、
   * 花了多少钱"。摆在一起的话,后者要写的东西(跑了多久、进出多少 token)
   * 会把前者那一行挤没。
   */
  const processJobs = (): readonly JobSnapshot[] => listJobs()
  const agentJobs = (): readonly JobSnapshot[] => subagents.list()

  const loop = new Loop({
    store,
    emitter,
    verify: async ({ touched, abortSignal }) => {
      if (!checker || checkOff) return undefined
      if (!worthChecking(checker, touched)) return undefined
      return runProjectCheck(abortSignal)
    },
    /**
     * 新会话的第一句话上挂一份项目记忆。现读磁盘 —— 上一场刚记下的东西,
     * 这一场开口就该在(见 prompt/memory.ts)。
     *
     * ── ★ 为什么这里也要看信任 ──
     * `.alfa/memory/` 是**跟着仓库走、进 git 的文件**。也就是说一个陌生仓库里
     * 那几个 md 是**它的作者写的**,而 renderMemories 交给模型时的措辞是
     * 「Notes **you** wrote about this project」—— 比 AGENTS.md 当初那句
     * 「follow them」还要狠:它不是"照着做",是"这是你自己想过的事"。
     *
     * 这个口子是做完信任那一格之后回头核代码才发现的:当时只堵了
     * AGENTS.md / CLAUDE.md 一条路,而项目能对模型说话的路不止一条。
     */
    memory: (sessionID) => {
      // ★ 不信任的文件夹**一条便条都不给**。见 buildSystemParts 里 trustProject
      //   那颗星,以及下面 memory 那一处同名的说明 —— 两处必须一起判,漏一处
      //   等于这道门只关了一半
      if (trust !== "trusted") return undefined
      const set = discoverMemories(root, sessionID)
      const text = renderMemories(set)
      return text.length === 0 ? undefined : { text, notes: set.memos.length }
    },
    // 同一句话上再挂一份仓库快照。现采 —— 上一场结束之后用户很可能切了分支、
    // 提交了东西,而 `/clear` 换一场正是"重新看一眼"最自然的入口(见 prompt/git.ts)
    gitContext: () => gitContextBlock(root),
    // 每轮重新问:被整体 deny 的工具不发给模型,省掉"调用→被拒→换个说法"的空转
    tools: activeTools,
    // 回答语言每轮现取:用户 /language reply ja 之后,下一轮就该是日文,
    // 而不是等他重启
    system: systemPrompt,
    // 现取 session.id —— /resume 换过之后,这一轮的工具要写进新的那场
    makeToolContext: (call) => makeToolContext(session.id, call),
    stream: (request) =>
      streamWithRetry(registry, request, {
        onRetry: (info) =>
          emitter.emit({
            type: "retry",
            attempt: info.attempt,
            maxAttempts: info.maxAttempts,
            delayMs: info.delayMs,
            message: info.error.message.split("\n")[0] ?? "request failed",
          }),
      }),
  })

  const runner = new Runner(loop)

  const summarizerOptions = {
    stream: (request: LLMRequest) => stream(registry, request),
    // 现取 —— `/model` 换过之后,这一版摘要要发给新模型
    model: () => model.ref,
    language: () => language.reply,
  }
  const summarize = createSummarizer(summarizerOptions)
  const catchUp = createCatchUp(summarizerOptions)
  /** 退出时把还在写的摘要一起收掉 —— 它写完要碰 store,而 store 马上就关了 */
  const summaryAbort = new AbortController()

  // ── 上下文占用 ──
  //
  // 真数从 step.finish 上捡(那是 provider 自己报的),估值在轮次边界重算一次。
  // 每帧现算是不行的:状态行一秒画二十次,而这个数一轮才变一次。
  const meter = new ContextMeter(model.info)
  emitter.on((event) => {
    if (event.type === "step.finish") meter.observe(event.part.tokens)
  })

  /** 现在占了多少、分别是谁占的。provider 报过的话以它为准 */
  const measure = (): ContextReport =>
    contextReport({
      history: store.listAll(session.id),
      system: systemPrompt(),
      tools: activeTools(),
      // 目录那一段是从 system 里**分出来**的,不是加上去的(见 agent/context.ts)
      skills: skillCatalogue(visibleSkills()),
      info: model.info,
      spent: meter.spent,
      ...(meter.real !== undefined ? { reported: meter.real } : {}),
    })

  /** 重新估一遍。压缩、清空、换会话之后 provider 报的那个数不再成立 */
  const remeasure = (): void => {
    meter.assume(
      contextReport({
        history: store.listAll(session.id),
        system: systemPrompt(),
        tools: activeTools(),
        skills: skillCatalogue(visibleSkills()),
        info: model.info,
      })
        .used,
    )
  }

  /** 快满了提醒过一次没有。压缩完/清空后掉回黄线以下会重新武装 */
  let warnedFull = false
  const settleContext = (): void => {
    remeasure()
    const ratio = meter.snapshot.ratio
    if (ratio < WARN_AT) {
      warnedFull = false
      return
    }
    if (warnedFull) return
    warnedFull = true
    // 提醒只发一次,而且是收据不是弹窗:它讲的是一件**还没坏**的事,
    // 打断用户手上的活儿不成比例
    const line = t.ctxNearlyFull(Math.round(ratio * 100))
    receipt(theme.yellow(`  ⌁ ${line}`), "warn", line)
  }

  /**
   * 正在跑的压缩。esc 要能停它 —— 它和一轮对话一样久,而卡住的时候用户手里
   * 除了 esc 什么都没有。
   */
  let compaction: AbortController | undefined
  const compactor: CompactFn = createCompactor({
    stream: (request: LLMRequest) => stream(registry, request),
    model: () => model.ref,
    language: () => language.reply,
    // 这次请求本身要装进同一个窗口,而它恰恰是在窗口快满时发出去的。
    // 一半留给材料,剩下的留给提示词和它自己的输出。现取:换模型会换窗口
    budgetTokens: () => Math.max(8_000, Math.floor(usable(model.info.limit) / 2)),
  })

  /**
   * @param text 用户这一轮说的话。**不给 = 接着答历史里那条没人答的**——
   *   子 agent 的报告就是这么进来的(见 deliverReport):它是一条合成消息,
   *   没有"用户说了什么"可言,所以活动区那格问题不能被它清掉
   */
  const runTurn = async (text?: string): Promise<TurnOutcome> => {
    if (text !== undefined) {
      lastUserText = text
      // 新起一轮:活动区清空、浓缩重新开始攒。放在这里而不是界面层,
      // 是因为三种运行形态都要它,而面板只有全屏才有
      chatModel?.beginTurn(text)
    }
    renderer.reset()
    const run = runner.start({
      sessionID: session.id,
      model: model.ref,
      ...(text !== undefined ? { text } : {}),
      ...(thinking ? { thinking: true } : {}),
    })
    turnSignal = run.controller.signal
    const outcome: TurnOutcome = {}
    try {
      const result = await run.promise
      if (result.interrupted) {
        outcome.interrupted = true
        receipt(theme.yellow(`  ⌁ ${t.interrupted}`), "warn", t.interrupted)
      }
      if (result.hitStepLimit) {
        outcome.hitStepLimit = true
        receipt(theme.yellow(`  ⌁ ${t.stepLimit}`), "warn", t.stepLimit)
      }
    } catch (error) {
      outcome.error = describe(error)
      receipt(theme.red(`  ✗ ${outcome.error}`), "bad", firstLine(outcome.error))
    } finally {
      turnSignal = undefined
    }
    return outcome
  }

  /**
   * 历史里有没有一条没人答的话。
   *
   * 判据和主循环**共用一份**(agent/loop.ts 的 isSettled)—— 各写一遍迟早出现
   * 「界面以为答完了,而循环还想再转一轮」。
   */
  const hasUnanswered = (): boolean => !isSettled(store.listAll(session.id))

  /**
   * 把一段话作为**合成 user 消息**塞进当前会话。
   *
   * 合成的含义见 session/schema.ts:模型看得见,而滚动记录、`so far` 摘要、
   * 接会话时那句"你说的话"都不会把它当成用户的原话 —— 一份子 agent 的报告
   * 当然不是用户说的。
   */
  const injectSynthetic = (text: string): void => {
    const now = Date.now()
    const id = newMessageID()
    store.upsertMessage({ id, sessionID: session.id, role: "user", timeCreated: now })
    store.upsertPart({
      id: newPartID(),
      sessionID: session.id,
      messageID: id,
      timeCreated: now,
      type: "text",
      text,
      synthetic: true,
    })
    store.touchSession(session.id)
  }

  /**
   * 用户**趁它还在跑**的时候插的一句话,当场塞进当前会话。
   *
   * ── 为什么不排队等这一轮结束 ──
   * 主循环每轮都从库里重读全量历史(见 agent/loop.ts),所以塞进去的这一句
   * 在**下一个轮次边界**就会被它看到 —— 它可能正读到第三个文件,而用户刚说
   * 「不用看那个了,先跑测试」。排队的话这句话要等它把整件事做完才生效,
   * 而那正是用户想拦住的东西。
   *
   * ★ 这条路和子 agent 的报告是**同一个机制**(见 injectSynthetic),差别只有
   *   一个 synthetic 标志:报告不是用户说的话,而这一句是 —— 它要出现在滚动
   *   记录里、要进摘要、接会话时也要认得出是用户的原话。
   *
   * ⚠ 斜杠命令不走这里(调用方拦掉)。`/clear` 换会话、`/compact` 折历史,
   *   跑到一半动它们就是把脚下的地抽掉 —— 那些照旧排队,等这一轮结束再执行。
   */
  const injectUser = (text: string): void => {
    const now = Date.now()
    const id = newMessageID()
    store.upsertMessage({ id, sessionID: session.id, role: "user", timeCreated: now })
    store.upsertPart({
      id: newPartID(),
      sessionID: session.id,
      messageID: id,
      timeCreated: now,
      type: "text",
      text,
    })
    store.touchSession(session.id)
    // 摘要 agent 要的是"用户最后要的是什么" —— 现在是这一句了
    lastUserText = text
    appendHistory(text)
  }

  /**
   * 一份报告写成给主 agent 看的一段话。
   *
   * 后面那句「还有几个在跑」是刻意的:模型据此决定是**现在就动**还是**再等等**。
   * 不写的话它只知道这一个回来了,于是拿着三分之一的材料就开始下结论 ——
   * 而用户派三个出去,要的是三个合在一起的答案。
   */
  const reportMessage = (job: JobSnapshot, report: string): string => {
    // 排队的也算"还没回来"。只数在跑的话,一条十六个的流水线会在每一批之间
    // 报一次"这是最后一个了" —— 而队里还躺着八个,模型于是提前收工去下结论
    const running = subagents.list().filter((each) => each.status !== "exited")
    const tail =
      running.length === 0
        ? `That was the last subagent. Carry on with what the user asked. It could not ask questions, so ` +
          `check any assumption it flagged before you act on it.`
        : `Still going: ${running.map((each) => `${each.id} (${each.status === "queued" ? "queued, " : ""}${each.command})`).join(", ")}. ` +
          `Each will reach you the same way. If your next step needs their answers too, say so in one line ` +
          `and stop — you will be woken up again.`
    // ★ 头一句写明"这不是用户说的"。它是一条 user 消息(只有那个角色能在轮次
    //   之间插进来),而模型读到 user 消息的第一反应是"人在跟我说话"——
    //   于是它会开始回答一个没人问过的问题。
    // ★ 花费**不写在这里**:模型拿它做不了任何决定,而用户那份账在收据上已经有了
    return [
      `Automated message, not from the user. Subagent "${job.id}" has finished. It was asked to: ${job.command}`,
      "",
      report,
      "",
      tail,
    ].join("\n")
  }

  /**
   * 主 agent 空着的时候,把它叫醒去消化刚进来的报告。
   *
   * ── 为什么不是"等在那儿" ──
   * 主 agent 站着等子 agent 的那一版把整轮 turn 占住了,用户一句话都插不进来
   * (见 tool/task.ts 文件头那三版的来回)。现在它派完就收工,对话还给用户;
   * 报告到了再把它叫起来。用户在这中间说的话照常是一轮正常对话。
   *
   * ── 忙着的时候什么都不用做 ──
   * 消息已经在库里了,而主循环每一轮都从库里重读全量历史(见 agent/loop.ts):
   * 它自己会在下一个轮次边界上看见这条,并接着转一轮。这也正是"拿第一个子 agent
   * 的结果再派一个"能成立的原因。
   */
  let wake: () => void = () => {}

  /**
   * `-p` 里等所有子 agent 回来,并把它们的报告一轮一轮消化掉。
   *
   * 交互模式不用这个 —— 那边由 deliverReport 叫醒主 agent(见它上面那段)。
   * 上限是保命的:一个卡在网络上的子 agent 不该让一条 `-p` 命令永远不返回。
   */
  const drainAgents = async (): Promise<void> => {
    const until = Date.now() + ONE_SHOT_AGENT_LIMIT_MS
    /** 连着几轮没好下场。历史一直"没答完"的话,这里会一直重跑同一轮 */
    let failures = 0
    while (Date.now() < until) {
      if (hasUnanswered()) {
        if (failures >= 3) return
        const outcome = await runTurn()
        failures = outcome.error || outcome.interrupted ? failures + 1 : 0
        continue
      }
      // 排队的也要等:`-p` 里"它派了三个人调查然后立刻退出"和"队里还躺着三个
      // 就退出"是同一种没写完的答案
      if (!subagents.list().some((job) => job.status !== "exited")) return
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 200)
        timer.unref?.()
      })
    }
  }

  /** 已经在收摊了。见 shutdown:关库之后任何一次写都是往一个死句柄上写 */
  let closing = false

  const shutdown = async (): Promise<void> => {
    closing = true
    keyboard?.close()
    summaryAbort.abort()
    await runner.cancelAll()
    await runner.drain()
    // ★ 后台任务不跟着一轮结束,所以只能在这里收。不杀的话,起在独立进程组里的
    //   dev server 会被 init 收养继续跑 —— 用户以为自己退出了,实际留了一地进程,
    //   端口还占着,下次启动报「address in use」而完全看不出是谁占的
    await killAllJobs()
    // ★ 子 agent 必须在 store.close() **之前**收干净:它还活着的话,下一次
    //   工具结果落库会撞上一个已经关掉的 SQLite 句柄 —— 那不是留一地进程,
    //   是一条抛在没人接的地方的异常
    await subagents.killAll()
    // ★ MCP server 是我们起的子进程,和后台任务同一条理由:不收的话它们被 init
    //   收养接着跑,而用户以为自己退出了。killGroup 走的是 bash 那套(见
    //   mcp/transport.ts)—— `npx …` 真正干活的是它孙子那一层
    await mcp.close()
    store.close()
    region.close()
    // ★ `/reset` 的删除**只能发生在这里** —— store.close() 之前删的话,SQLite
    //   关库时的 WAL checkpoint 会把 sessions.db 原地写回来,而用户以为自己
    //   已经重置干净了(见 cli/reset.ts)
    if (pendingReset.length > 0) {
      const outcome = performReset(pendingReset)
      for (const path of outcome.removed) process.stdout.write(theme.dim(`  · removed ${path}\n`))
      for (const problem of outcome.failed) {
        process.stderr.write(theme.red(`  ✗ ${t.resetFailed(problem.path, problem.why)}\n`))
      }
      process.stdout.write(theme.green(`  ✓ ${t.resetDone}\n`))
    }
  }

  /**
   * `/reset` 挑好的那几个目录。空 = 没人按过。
   *
   * 之所以是"记下来、退出时才删",见 shutdown() 里那颗星
   */
  let pendingReset: ResetTarget[] = []

  /**
   * ★ 子 agent 干完 → 报告进主会话 → 该叫醒就叫醒。
   *
   * **被我们自己停掉的那些不送**(`/clear`、`/resume`、`job kill`):那时候
   * 用户已经不要这个答案了,而 `/clear` 之后那一场根本不是它出发时的那一场 ——
   * 把上一场的活儿倒进新对话里是最让人莫名其妙的一种"智能"。
   */
  deliverReport = (job) => {
    // 收摊路上来的报告一律丢掉:store 马上就关(或者已经关了),而这条路
    // 会一路写到库里去 —— 抛在这儿的异常没有任何人接
    if (closing) return
    // ★ 「先看一眼」那一份先截走。它不进主对话 —— 见 trustJob 上那颗星。
    //   这一条必须排在 signal 判断**前面**:被停掉的检查同样要把 trustJob
    //   清掉,否则之后 `/trust check` 会一直说"已经有一次在跑了"
    if (job.id === trustJob) {
      const report = subagents.claimReport(job.id) ?? ""
      if (job.signal !== undefined) trustJob = undefined
      else finishTrustReview(report)
      return
    }
    if (job.signal !== undefined) return
    // ★ 有人在等这份报告的话,它已经拼进那个人的交代里了(见 subagent.ts 的
    //   briefFor)。再往主对话里塞一份,派子 agent 想省下的上下文就又还回来了 ——
    //   十二个侦察兵各交一份,主对话当场就满。要看照旧 `job output` 读得到
    if ((job.feeds?.length ?? 0) > 0) return
    // ★ 只交给**派它出去的那一场**。`/clear` 之后 session.id 已经换了,而一个
    //   刚好在那一刻结束的子 agent(它的 abort 来晚了一步,signal 还是空的)
    //   会把上一场的活儿倒进一场全新的对话里 —— 用户看到的是一段没头没尾的报告
    if (subagents.parentOf(job.id) !== session.id) return
    // 一次且仅一次:`task` 那次调用可能已经当场把它交了(400ms 内就跑完的)
    const report = subagents.claimReport(job.id)
    if (!report || report.length === 0) return
    injectSynthetic(reportMessage(job, report))
    // 忙着的话什么都不用做:主循环下一个轮次边界会从库里读到它(见 wake 上面那段)
    if (!runner.isBusy(session.id)) wake()
  }

  // ── 一次性模式 ──
  if (oneShot) {
    const onSigint = () => void runner.cancel(session.id)
    process.on("SIGINT", onSigint)
    await runTurn(expandOneShot(flags.prompt!, { root, receipt, reply }))
    // ★ 派出去的子 agent 要等回来。-p 这条路上没有界面可以叫醒谁,而
    //   「它派了三个人调查然后立刻退出」交给脚本的是一份没写完的答案
    await drainAgents()
    process.off("SIGINT", onSigint)
    await shutdown()
    return 0
  }

  // ── 交互模式 ──
  keyboard = new Keyboard()
  // ★ 终端没了就得走。界面没人看、按键永远不会再来,而留下不走的代价是一个
  //   满转的孤儿进程(见 keyboard.ts 的 watchHangup)。
  //
  //   收摊照常走 shutdown() —— 后台 job 和子 agent 更得杀,不然它们比这个进程
  //   活得还久。但**必须限时**:这条路上 store 可能正被一轮没写完的落库占着,
  //   在这儿干等下去,省掉的空转就又变成一个挂死的孤儿。
  keyboard.onHangup = () => {
    const forced = new Promise<void>((resolve) => setTimeout(resolve, HANGUP_SHUTDOWN_MS).unref?.())
    void Promise.race([shutdown(), forced]).finally(() => process.exit(0))
  }
  const deps: InteractiveDeps = {
    runner, runTurn, renderer, region, session, cwd, root, ui,
    spec: () => model.spec,
    workspace: workspaceLabel(root, cwd),
    store, summarize, catchUp, summaryAbort, language,
    meter, measure, remeasure, settleContext,
    compact: (history, focus) => {
      const controller = new AbortController()
      compaction = controller
      return compactor(history, { signal: controller.signal, ...(focus ? { focus } : {}) }).finally(() => {
        compaction = undefined
      })
    },
    interrupt: () => {
      void runner.cancel(session.id)
      compaction?.abort()
      manualCheck?.abort()
    },
    setBusy: () => {},
    ...(chatModel ? { model: chatModel } : {}),
    // 文件夹自己的 > 全局的 > session。见 config/folders.ts 的 viewFor
    view: viewFor(root, config),
    turnSignal: () => turnSignal,
    onResize: (handler) => {
      onResize = handler
    },
    jobs: processJobs,
    agents: agentJobs,
    submitWhileBusy: (text) => {
      // 斜杠命令是对**这一场会话**动手的(换会话、折历史、换模型),而不是
      // 说给模型听的话。跑到一半执行它们就是把脚下的地抽掉 —— 照旧排队
      if (text.trim().startsWith("/")) return false
      injectUser(text)
      return true
    },
    hasUnanswered,
    drainAgents,
    stopAgents: () => subagents.abort(),
    onWake: (handler) => {
      wake = handler
    },
    onAsk: (handler) => {
      askPermission = handler
    },
    onInquire: (handler) => {
      inquire = handler
    },
    onReceipt: (handler) => {
      receipt = handler
    },
    onTrustReceipt: (handler) => {
      trustReceipt = handler
    },
    onReply: (handler) => {
      reply = handler
    },
    gate,
    setMode: (mode) => {
      gate.setMode(mode)
      // 记住它。安全边界落盘的代价在启动横幅上还(见 banner)
      rememberPermission(mode)
    },
    reset: (targets) => {
      pendingReset = targets
    },
    thinking: () => thinking,
    setThinking: (value) => {
      thinking = value
      rememberThinking(value)
    },
    autoCompact: () => autoCompact,
    setAutoCompact: (value) => {
      autoCompact = value
      rememberAutoCompact(value)
    },
    agentflow: () => agentflow,
    setAgentflow: (value) => {
      agentflow = value
      rememberAgentflow(value)
    },
    models: {
      choices: () => registry.catalog(),
      supportsThinking: () => model.info.supportsThinking,
      // 记不住的唯一理由。环境变量在启动时压过配置(见 llm/setup.ts 的
      // defaultModelSpec)—— 悄悄写一份存不住的配置,下次启动会莫名其妙换回去
      rememberBlockedBy: () => envNameInUse("MODEL"),
      switch: (next) => {
        let info: ModelInfo
        try {
          // ★ 先解析再换。解析失败(不认识这个 provider、这家没有 key)时
          //   一个字段都不能动 —— 换到一半的模型比不换糟得多:spec 显示成新的,
          //   而每一轮请求还发给旧的,或者干脆每一轮都报同一个凭据错误
          info = registry.resolve(next).info
        } catch (error) {
          if (error instanceof NoCredentialsError || error instanceof UnknownModelError) return error.message
          throw error
        }
        model = { spec: next, ref: parseModelRef(next), info }
        // 窗口和缓存口径全跟着变,报上来的那个数是上一个模型数出来的
        meter.retarget(info)
        remeasure()
        if (!envNameInUse("MODEL")) setDefaultModel(next)
        return undefined
      },
    },
    check: {
      command: () => checker?.command,
      enabled: () => checker !== undefined && !checkOff,
      setEnabled: (value) => {
        checkOff = !value
        // 开 = 把配置里那个 false 删掉,回到自动认;顺带把这一场的检测重跑一遍
        // (用户可能刚 npm install 完,上次启动时 tsc 还不在)
        rememberCheck(value ? undefined : false)
        checker = value ? detectChecker(root) : detectChecker(root, config.check)
      },
      run: async () => {
        // 自己的 controller,和压缩同一条理由:esc 要能停它。一个跑在大仓库上的
        // tsc 是几十秒的事,而卡住的时候用户手里除了 esc 什么都没有
        const controller = new AbortController()
        manualCheck = controller
        try {
          await runProjectCheck(controller.signal, { manual: true })
        } finally {
          manualCheck = undefined
        }
      },
    },
    ...(restoredMode ? { restoredMode } : {}),
    receipt: (line, tone, text) => receipt(line, tone, text),
    reply: (text) => reply(text),
    skillSet: () => visibleSkills(),
    mcpStatuses: () => mcp.statuses(),
    // 货架上这次没被点名的。见 mcp/config.ts 的 shelf —— 翻不到的货架等于没有
    mcpShelf: () => mcpConfig.shelf,
    mcpProblems: () => mcpConfig.problems,
    trust: {
      state: () => trust,
      at: () => {
        // 配置在会话中途被手改坏是可能的,而这个日期只是给人看的一行字 ——
        // 为它抛一个异常会把启动横幅或者 /trust 的回答整条带走
        try {
          return folderConfig(root, loadConfig())?.trustedAt
        } catch {
          return undefined
        }
      },
      set: (next) => {
        trust = next
        markTrust(root, next)
      },
      check: async () => {
        trust = "checking"
        markTrust(root, "checking")
        return await startTrustReview()
      },
      running: () => trustJob !== undefined,
    },
    mcpApprove: (name) => {
      if (!mcp.approve(name)) return false
      // ★ 落盘由这一层负责(src/mcp 不该知道许可存在哪个文件里)。走的是
      //   「以后不再问」那套:按工作区分开、只存 allow
      rememberApprovals(root, [{ permission: MCP_SERVER_PERMISSION, pattern: name, action: "allow" }])
      return true
    },
    ...(continued ? { continued } : {}),
    wantContinue: flags.continue === true,
    askResume: flags.resume === true,
    openResume: () => reply(theme.dim(`  ${t.resumeEmpty}`)),
  }
  /**
   * 左右两栏这一趟开不开。
   *
   * 没记录过的文件夹保持老样子(开着)—— 这个功能上线之前所有人的界面都是
   * 三栏的,而「装了个新版本,文件树没了」是一次没人要过的改动。第一次进来
   * 那张卡片会问一次,问过之后就按他自己说的算。
   */
  let panels = panelsFor(root, config)

  try {
    // ★ 终端在我们起来之前就没了(自动化把进程 setsid 出去、然后关掉 pty)。
    //   这种情况**不能**退回逐行读:那条路会去读一个死掉的 fd 0,读一次 EIO
    //   一次、立刻再读 —— 又是一个满转的孤儿,而且这次连界面都没有。
    //   没有终端也没有管道 = 没有人会再送进来任何东西,直接走。
    if (terminalGone()) return 0

    /**
     * ★ 第一次在这个文件夹里跑,先问两句(见 cli/folder-setup.ts)。
     *
     * 位置很讲究:
     *   · 在 `keyboard.open()` **之前** —— 那张卡片走的是 readLine,它自己要
     *     接管一次 stdin,而 keyboard 一旦接管就是两个人抢同一个流。
     *   · 在进全屏**之前** —— 问的正是全屏界面长什么样,进去之后再问就得先画
     *     一遍旧样子、再当着用户的面重排一次。
     *
     * 只在全屏这条路上问,而且要 keyboard 用得上:--plain 里没有"侧栏"这回事,
     * -p 和管道里没有人可以问,而问一个没人会答的问题就是挂在那儿不动了。
     */
    if (fullscreen && keyboard.usable && isFirstVisit(root, config)) {
      const choice = await folderSetup({ root, config })
      // 按了 Ctrl-C 就什么都不存,下次再问 —— 见 folderSetup 的返回值说明
      if (choice) {
        rememberFolder(root, choice)
        deps.view = choice.view
        panels = choice.panels
        trust = choice.trust
      }
    }

    // open() 才是真判断:isTTY 为真但 raw 模式拿不到时(某些 CI 的伪终端),
    // 画出来的界面永远收不到按键 —— 那种情况必须退回逐行读
    if (!keyboard.usable || !keyboard.open()) return await piped(deps)
    if (transcript && chatModel) {
      // 抓鼠标默认开。它和终端原生的拖选是互斥的,但**多数终端按住 Shift
      // 就能绕过去**做原生选择 —— 有那条现成的路,就不值得为了复制而默认
      // 关掉点击。终端不吃 Shift 那一套就用 `--no-mouse`。
      return await fullscreen_(deps, keyboard, transcript, chatModel, {
        mouse: flags["no-mouse"] !== true,
        panels,
      })
    }
    return await boxed(deps, keyboard)
  } finally {
    await shutdown()
  }
}

/**
 * 一步进度写成一行字。
 *
 * 措辞归界面所有,不归 update/upgrade.ts —— 同一段升级代码,命令行那条路上
 * 界面语言还没解析出来(一律英文目录),会话里那条路上用户可能开着中文界面。
 * 事件在那边发,字在这边翻,两条路才不会一条中文一条英文。
 */
function upgradeLine(event: UpgradeEvent): string | undefined {
  switch (event.phase) {
    case "checking":
      return t.upgradeChecking
    case "downloading":
      return t.upgradeDownloading(event.tag, event.asset)
    case "verifying":
      return t.upgradeVerifying
    case "installing":
      return t.upgradeInstalling
    // 逐行输出的那条路上没有进度条可画,而每 120ms 写一行是在刷屏。
    // 交给 quarters() 挑几档报一次
    case "progress":
      return undefined
  }
}

/**
 * 没有浮层时的下载进度:每过四分之一报一行。
 *
 * 一行一行的输出里画不了进度条,但**完全不报**又回到了用户抱怨的那个问题
 * (「我不仔细看还不知道在 downloading」)。四档是能看出在动、又不至于刷屏的
 * 那个量。拿不到总大小就一行都不报 —— 报一个没有分母的数字没有意义。
 */
function quarters(): (event: UpgradeEvent) => string | undefined {
  let reported = 0
  return (event) => {
    if (event.phase !== "progress" || !event.total) return undefined
    const step = Math.floor((event.received / event.total) * 4)
    if (step <= reported || step > 4) return undefined
    reported = step
    return `${step * 25}%`
  }
}

/**
 * `alfa upgrade [--force]`。
 *
 * 输出刻意啰嗦:它在改用户机器上的一个可执行文件,每一步都该看得见 ——
 * 查到哪个版本、下的哪个文件、校验过没有、最后落在哪。一条只说"done"的
 * 自更新,出问题时没有任何可查的东西。
 *
 * 会话里的 `/upgrade` 是同一件事的另一个入口(见 upgradeCommand)。
 */
async function upgradeSubcommand(argv: string[]): Promise<number> {
  const force = argv.includes("--force") || argv.includes("-f")
  const out = process.stdout
  out.write(theme.dim(`  current ${VERSION}\n`))

  const progress = quarters()
  const outcome = await upgrade({
    force,
    onProgress: (event) => {
      const line = upgradeLine(event) ?? progress(event)
      if (line) out.write(theme.dim(`  ${line}\n`))
    },
  })

  switch (outcome.status) {
    case "current":
      out.write(theme.green(`  ✓ ${t.upgradeCurrent(outcome.version)}\n`))
      return 0
    case "updated":
      out.write(theme.green(`  ✓ ${outcome.from} → ${outcome.to}\n`))
      out.write(theme.dim(`    ${outcome.path}\n`))
      return 0
    case "blocked":
      process.stderr.write(theme.red(`  ✗ ${outcome.why}\n`))
      return 1
    // 命令行这条路没人能取消(没有浮层,也没传 signal)。写在这儿是为了
    // 让编译器盯着这个 switch —— 以后加一档状态,这里会立刻报错
    case "cancelled":
      process.stderr.write(theme.yellow(`  ${t.upgradeCancelled}\n`))
      return 1
  }
}

/**
 * `alfa uninstall [confirm]` —— 把 alfa 从这台机器上删干净,二进制也算。
 *
 * 两段式和 `/reset` 一模一样:不带 confirm 只列清单。为什么是重打一条命令而不是
 * y/N,见 cli/reset.ts 的文件头 —— 一个 y/N 提示给不了"等等,那里面还有我不想丢的
 * 东西"这个机会。
 *
 * 这里**不碰 sessions.db 的 WAL 问题**:这条路径根本没开过库(它在任何会话装配
 * 之前就分流走了),所以直接删就是干净的。会话里那条路不行,那也正是不做
 * `/uninstall` 的原因之一。
 */
async function uninstallSubcommand(argv: string[]): Promise<number> {
  const confirmed = argv.includes("confirm")
  const out = process.stdout
  const scope = uninstallScope(process.cwd())

  if (scope.targets.length === 0) {
    out.write(theme.dim(`  ${t.uninstallNothing}\n`))
    return 0
  }

  if (!confirmed) {
    out.write(theme.bold(`  ${t.uninstallTitle}\n`))
    for (const target of scope.targets) {
      out.write(`    ${theme.bold(target.path)}  ${theme.dim(`${compactNumber(target.bytes)}B`)}\n`)
      out.write(theme.dim(`      ${target.what}\n`))
    }
    // 三句最重的话单独成行,不混进上面那张表 —— 表是扫过去的,这几句要被读到
    if (scope.targets.some((target) => target.hasCredentials)) out.write(theme.yellow(`  ! ${t.resetHasKeys}\n`))
    out.write(theme.yellow(`  ! ${t.resetSessions}\n`))
    if (runningFromSource()) out.write(theme.yellow(`  ! ${t.uninstallFromSource}\n`))
    out.write("\n")
    // 散在各仓库里的 .alfa/:给命令,不替他扫。见 cli/uninstall.ts 头注释第 1 条
    out.write(theme.dim(`  ${t.uninstallProjectDirs}\n`))
    out.write(theme.dim(`    ${findProjectDirsCommand(homedir())}\n`))
    if (scope.binaryDir) out.write(theme.dim(`  ${t.uninstallPathNote(scope.binaryDir)}\n`))
    out.write("\n")
    out.write(theme.bold(`  ${t.uninstallConfirm("alfa uninstall confirm")}\n`))
    return 0
  }

  const result = performUninstall(scope.targets)
  for (const path of result.removed) out.write(theme.dim(`  removed ${path}\n`))
  for (const failure of result.failed) {
    process.stderr.write(theme.red(`  ✗ ${t.uninstallFailed(failure.path, failure.why)}\n`))
  }
  if (result.parked) out.write(theme.yellow(`  ! ${t.uninstallParked(result.parked)}\n`))
  out.write(theme.green(`  ✓ ${t.uninstallDone}\n`))
  return result.failed.length > 0 ? 1 : 0
}

async function authSubcommand(argv: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        provider: { type: "string" },
        type: { type: "string" },
        "base-url": { type: "string" },
        model: { type: "string" },
        // 同上:必须显式声明,parseArgs 不认 --no-verify 的取反语义
        "no-verify": { type: "boolean", default: false },
        "no-color": { type: "boolean", default: false },
      },
      allowPositionals: true,
    })
  } catch (error) {
    process.stderr.write(theme.red(`${(error as Error).message}\n\n`) + authUsage() + "\n")
    return 2
  }
  const values = parsed.values
  if (values["no-color"] === true) setColorEnabled(false)
  return authCommand(parsed.positionals, {
    ...(values.provider ? { provider: values.provider } : {}),
    ...(values.type ? { type: values.type } : {}),
    ...(values["base-url"] ? { baseURL: values["base-url"] } : {}),
    ...(values.model ? { model: values.model } : {}),
    verify: values["no-verify"] !== true,
  })
}

/** 一轮跑完之后的结局。摘要 agent 要知道这个 —— 半途被打断也是「走到哪了」的一部分。 */
interface TurnOutcome {
  interrupted?: boolean
  hitStepLimit?: boolean
  error?: string
}

interface InteractiveDeps {
  runner: Runner
  /** 不带话 = 接着答历史里那条没人答的(子 agent 的报告走这条) */
  runTurn(text?: string): Promise<TurnOutcome>
  renderer: Renderer
  region: LiveRegion
  /** 当前会话的可变盒子。**别把 id 抠出来存住** —— /resume 会换掉它 */
  session: { id: string }
  cwd: string
  root: string
  /** cwd / root 给用户看的样子。界面上常驻的那份「我在哪」 */
  workspace: WorkspaceLabel
  /** 当前模型那串字。**现取** —— `/model` 会换掉它,存一份下来的地方就永远停在旧的 */
  spec(): string
  store: Store
  summarize: SummarizeFn
  /** 接了一场没有摘要的旧会话时,照着历史补一份 */
  catchUp: CatchUpFn
  /**
   * 摘要那条队。装配时由宿主挂上 —— 只有有面板的形态才有。
   * restore() 靠它补摘要,所以它必须在第一次 restore 之前挂好。
   */
  summaries?: Summaries
  /** 退出时中止还在写的摘要 */
  summaryAbort: AbortController
  /** 上下文仪表。状态行每帧读它,所以它必须是**缓存住的**,不是现算的 */
  meter: ContextMeter
  /** 现在占了多少、分别是谁占的。`/context` 用 */
  measure(): ContextReport
  /** 重新估一遍占用。压缩、清空、换会话之后必须调 —— 报上来的那个数不再成立 */
  remeasure(): void
  /** 一轮跑完:重估 + 快满了提醒一次 */
  settleContext(): void
  /** 派压缩 agent 去写交接说明。中断由 interrupt() 管 */
  compact(history: MessageWithParts[], focus?: string): Promise<CompactResult>
  /**
   * 用户要停手上这件事。
   *
   * 不只是停这一轮:压缩也是一件**要等好几十秒的事**,而用户按 esc 时并不
   * 知道自己在等的是哪一种。两件事共用一个入口,才不会出现「按了没反应」。
   */
  interrupt(): void
  /**
   * 界面的忙碌指示。压缩要用它 —— 那几十秒里键盘照常收,但新消息该排队,
   * 而不是插进一场正在被折叠的历史里。
   */
  setBusy(busy: boolean): void
  /** session 视图的状态。-p 模式下没有 */
  model?: ChatModel
  /** 界面 / 回答语言。可以被 /language 改,所以是活的对象不是快照 */
  language: Required<LanguageConfig>
  /** 当前视图。全屏下 ChatPane 才是真值源,这里跟着它走 —— --plain 下只有它 */
  view: ViewMode
  /** 当前 turn 的中断信号。中断时挂着的权限问题要跟着一起收掉。 */
  turnSignal(): AbortSignal | undefined
  ui: {
    preview(label: string, text: string): void
    clearPreview(): void
    detail(detail: Detail): void
    filesMayHaveChanged(): void
    jobsChanged(): void
  }
  /** bash 起的后台进程 */
  jobs(): readonly JobSnapshot[]
  /** task 派出去的子 agent。和进程**分两块画**,见 main() 里那两个数据源 */
  agents(): readonly JobSnapshot[]
  /**
   * 用户趁它还在跑的时候插的一句话,当场递进正在跑的这一轮。
   *
   * 返回 false = 这一句不能这么递(斜杠命令),按老规矩排队。
   */
  submitWhileBusy(text: string): boolean
  /** 历史里有没有一条没人答的话(子 agent 的报告就是这么进来的) */
  hasUnanswered(): boolean
  /** 等所有子 agent 回来并把报告消化掉。没有界面可以叫醒谁的那两条路要它 */
  drainAgents(): Promise<void>
  /**
   * 「有东西要答了,去转一轮」的入口。由宿主接上自己那条 pump —— 主循环之外
   * 还有排队的用户输入、摘要、上下文重算要跟着走,那些只有宿主知道
   */
  onWake(handler: () => void): void
  /**
   * 叫停所有子 agent,返回停掉了几个。
   *
   * `/clear` 和 `/resume` 用它:换一场对话之后,那些子 agent 交回来的结论
   * 已经没有地方可去了(派它出去的那场不在了),而它们还在烧钱。
   * **后台进程不在此列** —— 一个 dev server 和你聊哪一场没有关系。
   */
  stopAgents(): number
  onResize(handler: () => void): void
  /** 换掉"怎么问权限"。全屏模式用它把提问改成模态框。 */
  onAsk(handler: (request: PromptRequest) => Promise<AskDecision>): void
  /** 换掉"怎么问用户一句"。同上,全屏下是另一个模态框(见 tui/panes/question.ts) */
  onInquire(handler: (question: Question) => Promise<Answer>): void
  /** 换掉"收据往哪写"。全屏模式下要同时进瀑布流和看板。 */
  onReceipt(handler: (line: string, tone: NoteTone, text: string) => void): void
  /** trust 放行那条收据的去处。看板不另起一行,只给那次调用做记号 */
  onTrustReceipt(handler: (line: string, summary: string, callID?: string) => void): void
  /** 换掉「斜杠命令的回答往哪写」。全屏模式下要同时进瀑布流和活动区。 */
  onReply(handler: (text: string) => void): void
  /** 权限门卫。命令和界面都要读它的模式 —— 真值源只有一个。 */
  gate: PermissionGate
  setMode(mode: PermissionMode): void
  /**
   * `/reset` 选定了要删的目录。**登记而已** —— 真正的删除在收尾之后跑
   * (见 shutdown() 里那颗星)。登记完调用方负责退出
   */
  reset(targets: ResetTarget[]): void
  /** 扩展思考现在开着吗。`/think` 读它 */
  thinking(): boolean
  /** 开关扩展思考并记住。下一轮就生效 —— 不用重启 */
  setThinking(value: boolean): void
  /** agentflow:开着的话同时最多几个子 agent,false = 关。`/agentflow` 读写它 */
  agentflow(): number | false
  setAgentflow(value: number | false): void
  /** 窗口快满时自己压一次。`/compact auto` 读写它 */
  autoCompact(): boolean
  setAutoCompact(value: boolean): void
  /** `/model` 读写它 */
  models: {
    /** 按 tab 时列哪几个。空着不是坏了,是没人配过(见 llm/registry.ts 的 catalog) */
    choices(): string[]
    /** 当前这个认不认扩展思考。开着 /think 切到一个不认的,得当场说一声 */
    supportsThinking(): boolean
    /** 存不下来的理由(环境变量在启动时压过配置)。能存就 undefined */
    rememberBlockedBy(): string | undefined
    /**
     * 换过去。**要么全换,要么一个字段都不动** —— 返回一句话表示没换成,
     * 里面写着为什么(不认识这个 provider / 这家没有 key)。
     */
    switch(spec: string): string | undefined
  }
  /** 收口前的自动检查(见 agent/check.ts)。`/check` 读写它 */
  check: {
    /** 现在认得出的那条命令。undefined = 这个项目里没检测到 */
    command(): string | undefined
    enabled(): boolean
    setEnabled(value: boolean): void
    /** 立刻跑一次。返回时收据已经写完了 */
    run(): Promise<void>
  }
  /** 这次启动的权限模式是从配置里捡回来的。横幅要说一声 */
  restoredMode?: PermissionMode
  /** 收据的当前去处。onReceipt 换过之后这里跟着变 —— 别把它抠出来存住 */
  receipt(line: string, tone: NoteTone, text: string): void
  /**
   * 斜杠命令的回答往哪写。
   *
   * 默认只有瀑布流(--plain 和管道下就它一个),全屏会换成「瀑布流 + 活动区」——
   * session 视图下只写瀑布流的话,敲完命令屏幕上一个字都不动。
   */
  reply(text: string): void
  /** 这一场装着哪些 skill。见 prompt/skills.ts */
  skillSet(): SkillSet
  /** MCP 的状态与放行。见 mcp/manager.ts */
  mcpStatuses(): McpStatus[]
  mcpShelf(): string[]
  /** 读不出来的那几条配置。**必须有人把它们说出来** —— 见 mcpCommand 那颗星 */
  mcpProblems(): McpProblem[]
  /** 这个文件夹的信任那一格。见 cli/trust.ts */
  trust: {
    state(): TrustState
    /** 打上信任标记那天。没有(或者现在不信任)就是 undefined */
    at(): string | undefined
    set(next: TrustState): void
    /** 派人去读一遍。返回一句话 = 没派出去,那句话就是原因 */
    check(): Promise<string | undefined>
    running(): boolean
  }
  mcpApprove(name: string): boolean
  /** 启动时 `--continue` 接上的那一场。没有就是新开的 */
  continued?: SessionInfo
  /** 用户要了 `--continue`。和 continued 分开:要了但这儿没有,得说一声 */
  wantContinue: boolean
  /** `--resume`:装配完先问接哪一场 */
  askResume: boolean
  /**
   * 打开会话挑选界面。装配时由宿主换掉 —— 全屏是浮层,--plain 是底部活动区,
   * 管道里没有界面可开。默认实现说清"这里问不了",而不是静悄悄什么都不做。
   */
  openResume(): void
  /**
   * 升级用的独占浮层。**只有全屏那套装得出来** —— --plain 和管道下是
   * undefined,那两条路照旧一行一行地写(见 upgradeCommand)。
   *
   * 为什么升级值一个浮层而别的命令不值:它要下九十多兆、要几分钟,中途还会
   * 把用户手上这个程序换掉。写成几行滚动的回执,用户的原话是「我不仔细看
   * 还不知道在 downloading」。
   */
  upgradeUI?: {
    open(state: UpgradeState, onCancel: () => void): void
    update(patch: Partial<UpgradeState>): void
    finish(patch: Partial<UpgradeState>): void
  }
}

/**
 * 有新版就在横幅后面补一行。
 *
 * ★ 故意**不 await**:横幅是启动时最先该出现的东西,而这是一次网络请求。
 *   等回来时横幅早画完了,所以它是补在后面的一条收据 —— 一个为了报喜而让
 *   每次启动多花两秒的功能,净值是负的。
 *
 * 一天最多问一次(缓存在数据目录),而且只说不装:什么时候换由用户自己定。
 * 见 update/check.ts。
 *
 * ★ 这条提醒指的是 `/upgrade` 而不是 `alfa upgrade`:它只在交互会话里出现,
 *   而那一刻用户手里就是这个窗口 —— 让他为了升级去另开一个终端,多数人当场
 *   就把这件事放下了。命令行那个名字照旧能用,help 里写着。
 */
function noticeUpdate(deps: InteractiveDeps): void {
  void checkForUpdate()
    .then((version) => {
      if (!version) return
      const line = t.updateAvailable(version, "/upgrade")
      deps.receipt(theme.yellow(`  ⌁ ${line}`), "warn", line)
    })
    .catch(() => {
      // 检查更新自己坏掉,不该在用户屏幕上留下任何痕迹
    })
}

function banner(deps: InteractiveDeps): void {
  const { renderer } = deps
  const label = (text: string) => theme.dim(`  ${text.padEnd(6)} `)
  /**
   * ★ 横幅上那几条**警告**走 receipt,不走 renderer.line。
   *
   * ── 这是一次真的踩到的空 ──
   * renderer.line 写进的是**瀑布流缓冲**,而缺省视图是 session —— 那一栏根本
   * 不画瀑布流。也就是说这几条"必须让用户看见"的警告,在默认视图下从第一帧起
   * 就一个字都没出现过:捡回来的 auto 模式、开着的 agentflow、没放行的 MCP、
   * 不信任的文件夹,全都只在 `/view stream` 下看得见。
   *
   * 而它们每一条上面都写着同一句话:「存下来的东西可以忘,屏幕上写着的忘不了」。
   * 那句话原来只对一半用户成立。receipt 两个视图都进(见 fullscreen_ 里
   * onReceipt 那一行),--plain 和管道下它就是 renderer.line —— 同一个调用,
   * 三种宿主各自落到该落的地方。
   *
   * 上面那几条**事实**(版本、模型、窗口、cwd、rules)照旧走 renderer.line:
   * 它们是开场的一段介绍,不是"你得知道这件事正在生效"。
   */
  const warn = (line: string, text: string) => deps.receipt(theme.yellow(`  ${line}`), "warn", text)
  renderer.line(theme.bold(`alfa ${VERSION}`))
  renderer.line(label(t.bannerModel) + theme.dim(deps.spec()))
  // 窗口多大是开工前就该知道的事:它决定了这一场能聊多久,而聊到一半才发现
  // 只有 12 万,已经晚了
  const snapshot = deps.meter.snapshot
  renderer.line(
    label(t.bannerWindow) + theme.dim(t.bannerWindowValue(compactNumber(snapshot.limit), compactNumber(snapshot.budget))),
  )
  renderer.line(label(t.bannerCwd) + theme.dim(deps.cwd))
  if (deps.root !== deps.cwd) renderer.line(label(t.bannerRoot) + theme.dim(deps.root))
  renderer.line(label(t.bannerRules) + rulesLine(deps))
  // 退化到 PowerShell / cmd 是**看不见的输入**:它决定了模型该写什么语法、
  // 每条命令要不要单独问,而屏幕上一个字都不写的话,用户只会觉得"它今天很啰嗦"
  const shell = resolveShell()
  if (!shell.posix) warn(t.bannerShellFallback(shell.label), t.bannerShellFallback(shell.label))
  // 项目里定义、还没放行的 MCP server 要在开机时说一声 —— 缺省不起,而一件
  // 「配了却没生效」的事如果屏幕上一个字都不写,用户只会以为配置写错了,
  // 然后去改一份根本没问题的文件
  const waiting = deps.mcpStatuses().filter((one) => one.state === "needs-approval").length
  if (waiting > 0) warn(t.mcpBanner(waiting), t.mcpBanner(waiting))
  // ★ 同一条规矩,更硬的版本:一条**读不出来**的 server 定义连"没放行"都算不上,
  //   它压根没进过名单。屏幕上不说的话,用户看到的是"我明明配了它却没有" ——
  //   而 `/mcp` 当时会回一句"没有配置 MCP server",把他推去改一份没问题的文件。
  const broken = deps.mcpProblems().length
  if (broken > 0) warn(t.mcpBannerProblems(broken), t.mcpBannerProblems(broken))
  // ★ 同一条规矩的第三次:这个文件夹的 AGENTS.md **没有生效**,而那是用户
  //   会花半小时怀疑自己写错了格式的那种事。存下来的东西可以忘,屏幕上写着的忘不了
  const trustState = deps.trust.state()
  if (trustState !== "trusted") {
    const line = trustState === "checking" ? t.trustBannerChecking : t.trustBanner
    warn(line, line)
  }
  // 记住的放行要在启动时说一声。它们会让一部分工具调用**不再问你**,而那正是
  // 「看不见的自动化」——上一次是谁批的、批了什么,隔一周就想不起来了
  // ★ 从配置里捡回来的模式**一定要写出来**。存一个安全边界的代价就在这一行:
  //   「上周开的 auto 这周还开着」必须是看得见的,而不是等它自己放行完才发现
  if (deps.restoredMode && deps.restoredMode !== "default") {
    warn(t.modeRestored(deps.restoredMode), t.modeRestored(deps.restoredMode))
  }
  // ★ 同一条规矩,同一个理由:agentflow 也是**存下来的**。一个不记得自己开过它的人,
  //   看到的是"它怎么突然派了十六个人",而那十六个是要花钱的
  const flow = deps.agentflow()
  if (flow !== false) {
    warn(t.agentflowBanner(flow, MAX_FLOW_ALIVE_JOBS), t.agentflowBanner(flow, MAX_FLOW_ALIVE_JOBS))
  }
  const remembered = deps.gate.listApproved().length
  if (remembered > 0) {
    renderer.line(theme.dim(`  ${t.bannerRemembered(remembered)} · /permission`))
  }
  renderer.line("")
}

/** 横幅上最多点名几份约定文件。再多就报个数 —— 这一行是扫一眼的东西 */
const RULES_SHOWN = 2

/**
 * 「这一场带着哪些约定开工」。
 *
 * ── 为什么值一行 ──
 * AGENTS.md 是**看不见的输入**:它进 system prompt、改的是每一句回答,而屏幕上
 * 一个字都不写。同时开着两个仓库的时候,「它怎么突然要我用 tab 缩进」这类问题
 * 只有这一行答得了。
 *
 * ── 没有的时候更要说 ──
 * 空着的话,「这个项目还没有约定文件」和「有,只是没告诉你」长得一模一样。而
 * 前者是当场就能解决的,所以这是整条横幅上唯一一句「你可以做点什么」。
 */
function rulesLine(deps: InteractiveDeps): string {
  const files = discoverInstructions({ cwd: deps.cwd, root: deps.root })
  const names = files.slice(0, RULES_SHOWN).map((file) => shortPath(file.path, deps.root))
  if (files.length > RULES_SHOWN) names.push(t.rulesMore(files.length - RULES_SHOWN))
  // 便条和约定文件是同一件事的两半(见 prompt/memory.ts),所以报在同一行上。
  // 它们是模型自己写的,更该让用户知道有几条正跟着每一句回答走
  const memos = discoverMemories(deps.root).memos.length
  if (memos > 0) names.push(t.rulesMemos(memos))
  const body = names.length === 0 ? t.rulesNone : names.join(", ")
  // 只看项目自己那份在不在。全局那份(~/.config 里的)每个仓库都带着,它回答
  // 不了「这个仓库怎么干活」—— 拿它把提示压掉,提示就永远不出现了
  const project = files.some((file) => file.scope === "project")
  return theme.dim(project ? body : `${body} ${t.rulesInitHint}`)
}

/** 工作区里面的写相对路径,外面的把 home 折成 `~`。横幅一行装不下绝对路径 */
function shortPath(path: string, root: string): string {
  const rel = relative(root, path)
  return rel.length > 0 && !rel.startsWith("..") ? rel : homePath(path)
}

/**
 * 一条斜杠命令跑完之后的去向。
 *
 *   true    —— 就此打住,别发给模型
 *   false   —— 这压根不是命令,照原样当成一句话发出去
 *   字符串  —— 命令**展开成了一段提问**,发这一段(`/init` 是目前唯一一条)
 *
 * 第三种是后加的。它存在的理由是:`/init` 那件事的一半只有模型做得了(把仓库
 * 读一遍),而命令自己没有 runTurn —— 硬要在这里跑一轮的话,忙碌指示、摘要、
 * 排队的下一句全都得在三个宿主里各写一遍。返回一段文本,这些就还是宿主原来
 * 那条路。
 */
type SlashOutcome = boolean | string

/**
 * 斜杠命令。返回值见 SlashOutcome。
 * 故意做得很少 —— 每加一条都是一次「用户以为它是消息」的机会。
 *
 * ── 为什么是 async ──
 * 绝大多数命令是同步的一句回答,但 `/compact` 要派一个 agent 去读完整场会话,
 * 那是几十秒的事。让调用方 await 它,排在后面的消息才会**老老实实等它做完** ——
 * fire-and-forget 的话,压缩写到一半用户发了新消息,那条消息会被折进一段
 * 不含它的摘要后面,然后凭空消失。
 */
async function slashCommand(
  raw: string,
  deps: InteractiveDeps,
  exit: () => void,
  chat?: ChatPane,
): Promise<SlashOutcome> {
  // ★ 按去掉首尾空白之后的文本匹配。命令是单独一行的东西,末尾那个空格不该
  //   决定它是不是一条命令 —— 而补全补完命令名之后正好会留一个(见 cli/commands.ts
  //   的 bareHint),`/help ` 这种手打出来的更是随处可见。不 trim 的话它们
  //   一条都匹配不上,会被当成一句话发给模型
  const text = raw.trim()
  // 带参数的几条不能走下面那个全等的 switch
  const arg = (name: string) => text.slice(name.length).trim()
  if (text === "/permission" || text.startsWith("/permission ")) {
    permissionCommand(arg("/permission"), deps)
    return true
  }
  if (text === "/view" || text.startsWith("/view ")) {
    viewCommand(arg("/view"), deps, chat)
    return true
  }
  if (text === "/think" || text.startsWith("/think ")) {
    thinkCommand(arg("/think"), deps)
    return true
  }
  if (text === "/agentflow" || text.startsWith("/agentflow ")) {
    agentflowCommand(arg("/agentflow"), deps)
    return true
  }
  if (text === "/mcp" || text.startsWith("/mcp ")) {
    mcpCommand(arg("/mcp"), deps)
    return true
  }
  if (text === "/trust" || text.startsWith("/trust ")) {
    await trustCommand(arg("/trust"), deps)
    return true
  }
  if (text === "/language" || text.startsWith("/language ")) {
    languageCommand(arg("/language"), deps)
    return true
  }
  if (text === "/model" || text.startsWith("/model ")) {
    modelCommand(arg("/model"), deps)
    return true
  }
  if (text === "/models" || text.startsWith("/models ")) {
    modelCommand(arg("/models"), deps)
    return true
  }
  if (text === "/history-clean" || text.startsWith("/history-clean ")) {
    cleanHistoryCommand(arg("/history-clean"), deps)
    return true
  }
  // 旧名字。补全里不列(见 cli/commands.ts 的 aliases),但打得出来就得认 ——
  // 一条删东西的命令回一句「未知命令」,用户下一步是去猜它现在叫什么
  if (text === "/clean-history" || text.startsWith("/clean-history ")) {
    cleanHistoryCommand(arg("/clean-history"), deps)
    return true
  }
  if (text === "/reset" || text.startsWith("/reset ")) {
    resetCommand(arg("/reset"), deps, exit)
    return true
  }
  if (text === "/compact" || text.startsWith("/compact ")) {
    await compactCommand(arg("/compact"), deps)
    return true
  }
  if (text === "/check" || text.startsWith("/check ")) {
    await checkCommand(arg("/check"), deps)
    return true
  }
  if (text === "/upgrade" || text.startsWith("/upgrade ")) {
    await upgradeCommand(arg("/upgrade"), deps)
    return true
  }
  // 唯一一条展开成提问的:文件夹这里建,AGENTS.md 交给模型
  if (text === "/init" || text.startsWith("/init ")) return initCommand(arg("/init"), deps)
  switch (text) {
    case "/exit":
    case "/quit":
      exit()
      return true
    case "/resume":
      resumeCommand(deps)
      return true
    case "/help":
      // 全屏那套键位多得多,两边不能共用一份帮助
      deps.reply(theme.dim(chat ? t.helpTui : t.helpPlain))
      return true
    case "/summary":
      summaryCommand(deps)
      return true
    case "/skills":
      skillsCommand(deps)
      return true
    case "/context":
    case "/content":
      contextCommand(deps)
      return true
    case "/clear":
      clearCommand(deps, chat)
      return true
    default:
      return false
  }
}

/**
 * `/clear`:开一场新的。
 *
 * ── 它一度只是「擦屏幕」,那是错的 ──
 * 理由当时写的是「会话在 SQLite 里,清掉的话模型会突然失忆,而用户以为自己只是
 * 擦了下屏幕」。但屏幕擦完之后,上面还挂着一句「到目前为止」——它讲的是一场
 * 用户以为已经不在了的会话。于是这条命令同时给出两个相反的信号:记录没了,
 * 但摘要还在。而**别的每一个 coding agent 里 `/clear` 都是「重新开始」**,
 * 用户按下去要的就是那个。
 *
 * 所以现在它换会话。旧的那场**一个字都不删** —— 它照旧在 `/resume` 里躺着,
 * 想接回去随时可以。这也是这条命令能安全地改语义的前提:代价只是多敲一次
 * `/resume`,而不是丢东西。
 *
 * ── 为什么开新的而不是把当前这场清空 ──
 * 清空要 DELETE 掉一整场的消息。而「我按 clear 是想换个话题」和「我按 clear 是
 * 想把刚才那半小时销毁」完全是两件事,后者从来没人要过。
 */
function clearCommand(deps: InteractiveDeps, chat?: ChatPane): void {
  // ★ 先停子 agent,再换会话。它们是**上一场**派出去的,答案交回哪儿都没有了;
  //   而屏幕马上要被擦干净,一个还在后台跑的东西在一块空白的屏幕上是彻底看不见的
  const stopped = deps.stopAgents()
  const id = newSessionID()
  deps.store.createSession(id, deps.cwd)
  deps.session.id = id
  // ★ 先 reset 再清,和 restore() 同一条理由:渲染器手里可能攒着上一场没收口
  //   的半行 markdown,反过来的话那半行会落进新会话的记录里
  deps.renderer.reset()
  if (chat) chat.clear()
  else {
    deps.region.passthrough(`\u001b[2J\u001b[3J\u001b[H`)
    deps.model?.clear()
  }
  // 新的一场,上下文回到只剩 system + 工具定义那么大,花费也从头算。不清的话
  // 状态行会挂着上一场的数,而那正是这条命令要收拾掉的东西
  deps.meter.drop()
  deps.meter.resetSpend()
  // 上一场读过的文件不算数了 —— 新的一场里它手上一个字节的文件内容都没有
  forgetReads()
  deps.settleContext()
  // 屏幕刚被擦干净,这一行是「刚才那下有反应」的**唯一**证据
  deps.reply(theme.dim(`  ${t.cleared}`))
  // 停掉了几个也要说。不说的话用户只会看到后台那一栏里几行字凭空消失
  if (stopped > 0) deps.reply(theme.dim(`  ${t.agentsStopped(stopped)}`))
}

/**
 * `/think [on|off]`:开关扩展思考,**记在配置里**。
 *
 * 不带参数就是切换 —— 这是个二值开关,而每次都要想「参数叫什么」的开关没人用。
 * 落盘是因为它不是一次性选择:想看模型怎么想的人每一轮都想看,而
 * `--thinking` 每次启动都要重敲。
 *
 * 下一轮就生效,不用重启:它每轮现取(见 runTurn)。
 */
function thinkCommand(arg: string, deps: InteractiveDeps): void {
  let next: boolean
  if (arg.length === 0) next = !deps.thinking()
  else if (arg === "on") next = true
  else if (arg === "off") next = false
  else {
    deps.reply(theme.red(`  ${t.unknownThink(arg)}`) + theme.dim(`\n  ${t.thinkingUsage}`))
    return
  }
  deps.setThinking(next)
  const line = theme.dim("  ") + theme.bold(next ? t.thinkingOn : t.thinkingOff)
  deps.reply(`${line}\n${theme.dim(`  ${next ? t.thinkingHint : t.thinkingRemembered}`)}`)
}

/**
 * `/agentflow [on|off|N]`:让它同时派很多子 agent,并且排成流水线。**记在配置里**。
 *
 * 开着之后变的是三样:并发窗口(4 → N)、总量上限(8 → 24)、以及 system 里多
 * 一段讲怎么拆活儿的话(见 prompt/agentflow.ts)。`task` 的 `after` 参数**两边
 * 都在** —— 编排能力不该跟着一个显示开关走,开关调的只是规模。
 *
 * ── 为什么 confirm 模式下只警告,不拦 ──
 * 十几个子 agent 会在用户面前排出十几个授权框,这确实难受。但权限模式是他
 * 明确设过的东西,替他改掉是拿走一个安全决定 —— 那比难受严重得多。说清楚,
 * 然后照他说的做。
 */
function agentflowCommand(arg: string, deps: InteractiveDeps): void {
  const current = deps.agentflow()
  let next: number | false
  if (arg.length === 0) next = current === false ? FLOW_WINDOW : false
  else if (arg === "on") next = current === false ? FLOW_WINDOW : current
  else if (arg === "off") next = false
  else {
    const width = Number(arg)
    if (!isFlowWindow(width)) {
      deps.reply(
        theme.red(`  ${t.agentflowBadWidth(arg, FLOW_WINDOW_MIN, FLOW_WINDOW_MAX)}`) +
          theme.dim(`\n  ${t.agentflowUsage(FLOW_WINDOW_MIN, FLOW_WINDOW_MAX)}`),
      )
      return
    }
    next = width
  }

  deps.setAgentflow(next)
  const head = theme.dim("  ") + theme.bold(next === false ? t.agentflowOff : t.agentflowOn(next, MAX_FLOW_ALIVE_JOBS))
  const hint = theme.dim(`  ${next === false ? t.agentflowOffHint : t.agentflowHint}`)
  // ★ 那句警告要在**开的时候**说,不是在第十个框弹出来的时候
  const warn =
    next !== false && deps.gate.permissionMode === "confirm"
      ? `\n${theme.yellow(`  ⚠ ${t.agentflowConfirmWarning}`)}`
      : ""
  deps.reply(`${head}\n${hint}${warn}`)
}

/** `/history-clean` 不写天数时清多久以前的。一周 —— 见 cleanHistoryCommand */
const CLEAN_HISTORY_DAYS = 7

/** 目录清单最多列几行。再多就只报个数 —— 那张表是用来认"哪个项目占的",不是账本 */
const CLEAN_DIR_LINES = 5

/**
 * `/history-clean [天数] [confirm]`:删掉躺在本机的老会话。
 *
 * ── 为什么要有这条 ──
 * 会话是**只进不出**的:每次启动一场、每次 `/clear` 又一场,而 `/resume` 只列
 * 最近 50 条。跑了半年之后,库里躺着的绝大部分是谁也不会再打开的东西,连同
 * 它们的全文 —— 里面有代码、有路径、有 diff。删不掉的历史既是一块一直在长的
 * 磁盘,也是一份没人管的留痕。
 *
 * ── 两段,和 `/reset` 同一条理由 ──
 * 不带 confirm 只**列**要删什么:几场、多少条消息、最老那场是什么时候、分布在
 * 哪几个目录。这份清单是唯一能让人在按下去之前发现"等等,那里面有我还想要的
 * 东西"的机会。所以 `confirm` 也照旧**不进补全候选**(见 cli/commands.ts)。
 *
 * ── 手上这一场永远不动 ──
 * 接回一场三周前的会话、接着顺手清理一下,清掉的正是脚下这块地。所以当前会话
 * (连同它派出去的那几个子 agent)是硬留的,由 store 那边保证(见 staleHistory)。
 */
function cleanHistoryCommand(arg: string, deps: InteractiveDeps): void {
  const words = arg.split(/\s+/).filter(Boolean)
  const confirmed = words.includes("confirm")
  const rest = words.filter((word) => word !== "confirm")
  const days = rest.length === 0 ? CLEAN_HISTORY_DAYS : Number(rest[0])
  if (rest.length > 1 || !Number.isFinite(days) || days < 0) {
    deps.reply(theme.red(`  ${t.cleanBadDays(rest.join(" "))}`) + theme.dim(`\n  ${t.cleanUsage}`))
    return
  }

  const now = Date.now()
  const sweep = deps.store.staleHistory(now - days * 86_400_000, [deps.session.id])
  if (sweep.ids.length === 0) {
    deps.reply(theme.dim(`  ${t.cleanNothing(days)}`))
    return
  }

  if (!confirmed) {
    const lines = [theme.bold(`  ${t.cleanTitle(days)}`)]
    lines.push(`    ${theme.bold(t.cleanCounts(sweep.sessions, sweep.messages))}`)
    if (sweep.agents > 0) lines.push(theme.dim(`    ${t.cleanAgents(sweep.agents)}`))
    if (sweep.oldest !== undefined && sweep.newest !== undefined) {
      lines.push(
        theme.dim(`    ${t.cleanRange(relativeTime(sweep.oldest, now), relativeTime(sweep.newest, now))}`),
      )
    }
    // 哪个目录占的。**按显示宽度对齐** —— 路径里可以有中文,按字符数算那一列会歪
    const shown = sweep.directories.slice(0, CLEAN_DIR_LINES)
    const pad = Math.max(0, ...shown.map((entry) => displayWidth(entry.directory)))
    for (const entry of shown) {
      lines.push(theme.dim(`    ${padToWidth(entry.directory, pad)}  ${entry.sessions}`))
    }
    if (sweep.directories.length > shown.length) {
      lines.push(theme.dim(`    ${t.cleanMoreDirs(sweep.directories.length - shown.length)}`))
    }
    // 两句最重的话单独成行,不混进上面那张表 —— 表是扫的,这两句要被读到
    lines.push(theme.yellow(`  ! ${t.cleanWarn}`))
    lines.push(theme.dim(`  ${t.cleanKeeps}`))
    lines.push("")
    lines.push(theme.bold(`  ${t.cleanConfirm(`/history-clean ${days === CLEAN_HISTORY_DAYS ? "" : `${days} `}confirm`)}`))
    deps.reply(lines.join("\n"))
    return
  }

  const was = fileBytes(deps.store.file)
  deps.store.deleteSessions(sweep.ids)
  // 删完必须 VACUUM,否则文件一个字节都不会变小(见 store.vacuum)。拿不到
  // 独占锁不算失败 —— 东西已经删了,只是这次没能把文件缩回去
  const blocked = deps.store.vacuum()
  const freed = was - fileBytes(deps.store.file)
  const done = [theme.dim(`  ${t.cleanDone(sweep.sessions + sweep.agents, sweep.messages)}`)]
  if (blocked !== undefined) done.push(theme.dim(`  ${t.cleanNotShrunk}`))
  else if (freed > 0) done.push(theme.dim(`  ${t.cleanFreed(`${compactNumber(freed)}B`)}`))
  deps.reply(done.join("\n"))
}

/**
 * 库占了多少盘。
 *
 * ★ **三个文件一起数**:库开着 WAL,刚删掉的那几百 KB 这时候多半还在
 *   `sessions.db-wal` 里,只数主文件的话会报出个「腾出 0」——而 `du` 那边
 *   明明少了一半。读不到就当 0:这个数只用来报"腾出多少",不值得为它中断清理。
 */
function fileBytes(path: string): number {
  let total = 0
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += statSync(path + suffix).size
    } catch {
      // 没有这个文件很正常(没开 WAL、或者刚 checkpoint 完)
    }
  }
  return total
}

/**
 * `/reset [all] confirm`:把这台机器上属于 alfa 的东西删干净。
 *
 * ── 两段,不是一段 ──
 * 不带 confirm 就只**列出**要删什么:哪几个目录、多大、里面有什么。这份清单
 * 是唯一能让人在按下去之前发现"等等,那里面还有我不想丢的东西"的机会 ——
 * 一个 y/N 提示给不了这个机会,因为它没写出要删的是什么。
 *
 * ── confirm 必须一个字一个字打全 ──
 * 所以它**不进补全候选**(见 cli/commands.ts):这条命令唯一的安全边界就是
 * "打全它要花几秒钟",而 tab 一下就能补出来的确认等于没有确认。
 *
 * ── 删完退出 ──
 * 进程手里攥着解析好的模型、打开的 sessions.db。文件没了而这些还在,程序会进入
 * 一个"看起来正常、其实每一步都对着不存在的东西操作"的状态。真正的删除发生在
 * 收尾之后(见 shutdown),否则 SQLite 关库时会把库文件写回来。
 */
function resetCommand(arg: string, deps: InteractiveDeps, exit: () => void): void {
  const words = arg.split(/\s+/).filter(Boolean)
  const all = words.includes("all")
  const confirmed = words.includes("confirm")

  const scope = resetScope(deps.root)
  const targets = all ? [...scope.global, ...scope.project] : scope.global
  if (targets.length === 0) {
    deps.reply(theme.dim(`  ${t.resetNothing}`))
    return
  }

  if (!confirmed) {
    const lines = [theme.bold(`  ${t.resetTitle}`)]
    for (const target of targets) {
      lines.push(`    ${theme.bold(target.path)}  ${theme.dim(`${compactNumber(target.bytes)}B`)}`)
      lines.push(theme.dim(`      ${target.what}`))
    }
    // 两句最重的话单独成行,不混在上面那张表里 —— 表是扫的,这两句要被读到
    if (targets.some((target) => target.hasCredentials)) lines.push(theme.yellow(`  ! ${t.resetHasKeys}`))
    lines.push(theme.yellow(`  ! ${t.resetSessions}`))
    // 项目目录**默认不删**,但必须说一声它在那儿 —— 否则"彻底重置"之后
    // 模型还记得上一轮的便条,而用户完全不知道那是哪来的
    if (!all && scope.project.length > 0) {
      lines.push(theme.dim(`  ${t.resetProjectNote(scope.project[0]!.path)}`))
    }
    lines.push("")
    lines.push(theme.bold(`  ${t.resetConfirm(`/reset ${all ? "all " : ""}confirm`)}`))
    deps.reply(lines.join("\n"))
    return
  }

  deps.reset(targets)
  deps.reply(theme.dim(`  ${t.resetExiting}`))
  exit()
}

/**
 * `/model [provider/model]`:看现在用的是哪个,或者当场换一个。
 *
 * ── 为什么换模型不清历史 ──
 * 换的是"接下来谁来答",不是"重新开始"。整段对话原样带过去 —— 这条命令最常
 * 用的时刻恰恰是「便宜的那个卡住了,换个强的接着弄」,而那时候历史正是全部
 * 价值所在。真想重新开始的人手里有 `/clear`。
 *
 * 唯一带不过去的是**思考块**:它有签名、只有原厂认,换一家就必须丢(这件事
 * agent/to-model-messages.ts 早就在做了,按 providerID+modelID 逐条比)。所以
 * 回执里要写这一句 —— 不写的话,用户只会发现"换完之后它好像忘了自己刚想过什么"。
 *
 * ── 为什么不带参数时要把候选列出来 ──
 * 和 `/permission` 同一条理由:一个只能靠猜参数的命令等于没有。而这里更狠 ——
 * 参数是一串谁也记不住的模型名。
 */
function modelCommand(arg: string, deps: InteractiveDeps): void {
  const snapshot = deps.meter.snapshot
  const window = t.modelWindow(compactNumber(snapshot.limit), compactNumber(snapshot.budget))

  if (arg.length === 0) {
    const current = deps.spec()
    const lines = [theme.dim("  ") + t.modelCurrent(theme.bold(current)) + theme.dim(` · ${window}`)]
    const choices = deps.models.choices()
    if (choices.length === 0) lines.push(theme.dim(`  ${t.modelNoChoices}`))
    else {
      lines.push(theme.dim(`  ${t.modelChoicesTitle}`))
      for (const spec of choices) {
        // 当前这个也留在列表里,只是打上记号 —— 一张把"你在哪"抠掉的清单,
        // 看的人得先数一遍才知道自己在不在上面
        lines.push(spec === current ? theme.green("  ● ") + theme.bold(spec) : `    ${theme.dim(spec)}`)
      }
    }
    lines.push(theme.dim(`  ${t.modelUsage}`))
    deps.reply(lines.join("\n"))
    return
  }

  if (arg === deps.spec()) {
    deps.reply(theme.dim(`  ${t.modelAlready(arg)}`))
    return
  }

  const failure = deps.models.switch(arg)
  if (failure) {
    deps.reply(theme.red(`  ${failure}`) + theme.dim(`\n  ${t.modelUsage}`))
    return
  }

  // ★ 窗口现取:上面那个是**换之前**的。20 万换成 3 万时,回执上写着旧窗口
  //   等于当场说了一句假话,而这一行正是用户要拿来判断"还能聊多久"的
  const after = deps.meter.snapshot
  const lines = [
    theme.dim("  ") +
      theme.bold(t.modelSwitched(arg)) +
      theme.dim(` · ${t.modelWindow(compactNumber(after.limit), compactNumber(after.budget))}`),
    theme.dim(`  ${t.modelKeepsHistory}`),
  ]
  // 开着 /think 切到一个不认它的模型:那个开关会从此静悄悄地不起作用
  if (deps.thinking() && !deps.models.supportsThinking()) {
    lines.push(theme.yellow(`  ${t.modelNoThinking(arg)}`))
  }
  const blocked = deps.models.rememberBlockedBy()
  lines.push(blocked ? theme.yellow(`  ${t.modelEnvWins(blocked)}`) : theme.dim(`  ${t.modelRemembered}`))
  deps.reply(lines.join("\n"))
  // ★ 20 万换 3 万时,刚才还宽裕的一场会话可能当场就装不下了。这一句必须在
  //   下一轮**之前**说 —— 等到发出去才发现超限,用户手里已经只剩一条报错了
  deps.settleContext()
}

/**
 * `/permission [mode|forget]`。
 *
 * 不带参数就报告现状并把可选项列出来 —— 一个只能靠猜参数的命令等于没有。
 * 现状里**包含记住的那几条放行**:它们和模式一起决定了「这次调用会不会问你」,
 * 而一条存下来却查不到的规则,和一条看不见的自动放行是同一种东西。
 */
function permissionCommand(arg: string, deps: InteractiveDeps): void {
  if (arg === "forget") {
    forgetCommand(deps)
    return
  }
  if (arg.length === 0) {
    const current = deps.gate.permissionMode
    const lines = [theme.dim("  ") + t.currentMode(theme.bold(current), modeInfo(current).hint)]
    for (const mode of MODES) {
      const marker = mode === current ? theme.green("  ● ") : "    "
      lines.push(marker + theme.bold(mode.padEnd(8)) + theme.dim(modeInfo(mode).hint))
    }
    lines.push(...rememberedLines(deps))
    lines.push(theme.dim(`  ${t.modeHowTo}`))
    deps.reply(lines.join("\n"))
    return
  }
  const mode = normalizeMode(arg)
  if (!mode) {
    deps.reply(theme.red(`  ${t.unknownMode(arg, [...MODES, "forget"].join(", "))}`))
    return
  }
  deps.setMode(mode)
  deps.reply(theme.dim("  ") + t.currentMode(theme.bold(mode), modeInfo(mode).hint))
}

/** 记住的放行,列最多这么多条。再多就该去看那个 json 了 */
const REMEMBERED_SHOWN = 8

function rememberedLines(deps: InteractiveDeps): string[] {
  const rules = deps.gate.listApproved()
  if (rules.length === 0) return []
  const out = ["", theme.dim("  ") + t.rememberedTitle(rules.length)]
  for (const rule of rules.slice(0, REMEMBERED_SHOWN)) {
    out.push(theme.cyan("  · ") + theme.dim(rule.permission.padEnd(6)) + rule.pattern)
  }
  if (rules.length > REMEMBERED_SHOWN) out.push(theme.dim(`    ${t.rememberedMore(rules.length - REMEMBERED_SHOWN)}`))
  out.push(theme.dim(`  ${t.rememberedHowTo}`))
  return out
}

/**
 * `/permission forget`:清掉这个工作区记住的全部放行。
 *
 * 内存和磁盘一起清。只清一边的话:只清内存 → 下次启动它们又回来了;
 * 只清磁盘 → 这一次会话里它们还在生效,而用户以为已经撤销了。
 */
function forgetCommand(deps: InteractiveDeps): void {
  const count = deps.gate.forgetApproved()
  forgetApprovals(deps.root)
  deps.reply(theme.dim("  ") + (count === 0 ? t.forgotNothing : t.forgotApprovals(count)))
}

/**
 * `/resume`:换一场会话接着聊。
 *
 * 只负责"有没有得挑"和"把界面叫出来"。真正挑哪一场由宿主问,换过去由
 * restore() 做 —— 这三件事分开,`--resume`(启动时)和 `/resume`(跑起来之后)
 * 才能走同一条路。
 */
function resumeCommand(deps: InteractiveDeps): void {
  if (sessionChoices(deps).length === 0) {
    deps.reply(theme.dim(`  ${t.resumeEmpty}`))
    return
  }
  deps.openResume()
}

/** 这个目录下能接的会话。上限 50:再往前的靠日期已经认不出来了。 */
function sessionChoices(deps: InteractiveDeps): SessionInfo[] {
  return deps.store.listSessions({ directory: deps.cwd, limit: 50 })
}

/**
 * 接上一场旧会话。
 *
 * 四件事一起做,少一件都不行:
 *   ① 换掉当前会话 —— 不换的话新说的话写进另一场,而且不报错
 *   ② 把历史重放进滚动记录 —— 否则"它记得,你看不见",人会开始重复说过的话
 *   ③ 把**最后一轮**装回 session 视图 —— 默认看到的是那三段,不是滚动记录。
 *      只填滚动记录的话,接回来之后默认屏幕上一个字都没变。
 *   ④ 摘要:库里有就装回去,**没有就现补一份**(见 catchUp)
 *
 * `clear` 是给跑起来之后换会话用的:上一场的滚动记录和看板必须先消失,
 * 两场的内容叠在一起比什么都不显示更糟。
 */
function restore(
  deps: InteractiveDeps,
  info: SessionInfo,
  options: { replay?: boolean; clear?: () => void } = {},
): void {
  // 和 `/clear` 同一条理由:接上另一场之后,上一场派出去的那些子 agent
  // 交回来的结论没有地方可去了。见 InteractiveDeps.stopAgents
  const stopped = deps.stopAgents()
  deps.session.id = info.id
  deps.store.touchSession(info.id)
  // ★ 先 reset 再 clear。渲染器手里可能攒着上一场没收口的半行 markdown ——
  //   反过来的话,那半行会在清空之后**落进新会话的记录里**
  deps.renderer.reset()
  options.clear?.()

  const history = deps.store.listAll(info.id)
  let restored = info.messages
  if (options.replay !== false) {
    restored = replay(history, {
      line: (text) => deps.renderer.line(text),
      handle: (event) => deps.renderer.handle(event),
    })
    // 重放完把 markdown 手里攒着的半行定稿,别粘到用户接下来说的第一句上
    deps.renderer.reset()
    if (deps.model) restoreLastTurn(history, deps.model)
  }
  deps.model?.setSummary(info.summary)
  deps.receipt(theme.dim(`  ⏎ ${t.resumed(restored)}`), "good", t.resumed(restored))
  if (stopped > 0) deps.receipt(theme.dim(`  · ${t.agentsStopped(stopped)}`), "info", t.agentsStopped(stopped))
  // 换了一场,占用当然也换了一份 —— provider 报的那个数是**上一场**的,
  // 花费同理(它数的是「这一趟在这一场上花了多少」)。
  // 排在「接上了」后面:接回来一场快满的会话时,那句提醒才不会跑到
  // 「恢复了 N 条」前面去,读起来像是在说别的会话
  deps.meter.drop()
  // ★ 花费**接着上一场算**,不是从零起。这一场之前花掉的 token 是真花掉了,
  //   进程重开一次不会退款 —— 显示成 0 的话,`--continue` 接回一场跑了半天的
  //   会话,账面永远只有「本次打开」那一小截,而用户读它是想知道这一场的账
  deps.meter.resetSpend(billedFromHistory(history))
  // 换了一场,读过什么也跟着换。历史里那些 read 的输出确实还在上下文里,但它们
  // 可能是三天前读的 —— 而「进程重开之后接上」本来就得重读,同一条命令在
  // 「重启接上」和「跑着接上」之间给出不同的安全级别才是真的会咬人
  forgetReads()
  deps.settleContext()
  // 库里没有摘要(这场比摘要 agent 还老,或者每轮都在写出来之前就断了):
  // 照着历史现补一份。不补的话,「到目前为止」会写着「第一次回答之后才有」——
  // 而历史明明就在库里躺着
  if (options.replay !== false && info.summary.length === 0) deps.summaries?.catchUp(digests(history, deps.root))
}

/**
 * `/summary`:摘要的全文。
 *
 * 从**库里**读而不是从界面读:--plain 和管道模式下根本没有那个面板,而摘要
 * 照样在库里。同一条命令在三种形态下给出不同答案,是最容易被当成 bug 的设计。
 */
function summaryCommand(deps: InteractiveDeps): void {
  const summary = deps.store.getSummary(deps.session.id)
  if (summary.length === 0) {
    deps.reply(theme.dim(`  ${t.summaryEmpty}`))
    return
  }
  deps.reply(theme.dim(`  ${t.summaryTitle}`) + "\n" + `  ${summary}`)
}

/**
 * `/context`(别名 `/content`):窗口里现在装着什么。
 *
 * ── 为什么要有这条命令 ──
 * 状态行上那格只回答「还剩多少」,而人在窗口快满时真正要做的决定是「砍哪一块」。
 * 那个决定要看构成:八成是 tool results 的话,答案是压缩;八成是 system prompt
 * 的话,答案是别再往 AGENTS.md 里堆东西了。一个只报总数的仪表盘会让人反复
 * 猜错。
 */
function contextCommand(deps: InteractiveDeps): void {
  deps.reply(renderContextReport(deps.measure(), deps.spec()))
}

/**
 * `/check [on|off]`:收口前那道自动检查。
 *
 * 不带参数 = **立刻跑一次**,而不是打印一句"它是开着的"。这条命令十次里有九次
 * 是在「我想知道现在到底红不红」的时候敲的,而那个问题只有真跑一次才答得了。
 *
 * 手动这一次的结果不塞回给模型:用户是自己想看一眼,不是在指挥它去修 ——
 * 想让它修,说一句就行,而那句话才是真的指令。
 */
async function checkCommand(arg: string, deps: InteractiveDeps): Promise<void> {
  if (arg === "on" || arg === "off") {
    const on = arg === "on"
    deps.check.setEnabled(on)
    const command = deps.check.command()
    if (on && !command) {
      deps.reply(theme.dim(`  ${t.checkNone}`))
      return
    }
    deps.reply(theme.dim(`  ${on ? t.checkOnNow(command ?? "") : t.checkOffNow}`))
    return
  }
  if (arg.length > 0) {
    deps.reply(theme.dim(`  ${t.unknownThink(arg)}`))
    return
  }

  const command = deps.check.command()
  if (!command) {
    deps.reply(theme.dim(`  ${t.checkNone}`))
    return
  }
  if (!deps.check.enabled()) {
    deps.reply(theme.dim(`  ${t.checkOffNow}`))
    return
  }

  // 跑起来可能是好几秒。忙碌指示要亮,否则界面看着像死了
  deps.setBusy(true)
  deps.reply(theme.dim(`  ${t.checkRunning(command)}`))
  try {
    await deps.check.run()
  } finally {
    deps.setBusy(false)
  }
}

/**
 * `/upgrade [check|force]`:不用离开会话就能换掉这个二进制。
 *
 * ── 为什么值得在会话里也有一个入口 ──
 * 「有新版了」这句话出现在启动横幅上(见 noticeUpdate),而那一刻用户手里只有
 * 这个窗口。让他为了升级去另开一个终端、把正聊到一半的这场丢在这儿,多数人
 * 当场就把这件事放下了 —— 于是那句提醒每天照说,版本一个月都不动。
 *
 * ── 三档 ──
 *   /upgrade         有新版就装
 *   /upgrade check   只查,什么都不装(想知道有没有 ≠ 现在就要换)
 *   /upgrade force   已经是最新的也重下重装(装坏了的时候唯一的自救手段)
 *
 * `--force` / `-f` 也认:命令行那边就是这么写的,而"同一件事在两个地方要用
 * 两种写法"是纯粹的记忆负担。
 *
 * ── 换完不重启 ──
 * 换掉的是磁盘上那个文件,正在跑的进程照旧是老的(POSIX 上它握着的是 inode)。
 * 所以这条命令**不结束会话** —— 聊到一半被踢出去,比晚几分钟用上新版糟得多。
 * 代价是回执里那句"重启才生效"必须写出来,否则用户会以为新功能当场就有了。
 */
async function upgradeCommand(arg: string, deps: InteractiveDeps): Promise<void> {
  const word = arg.trim().replace(/^--?/, "").toLowerCase()
  const force = word === "force" || word === "f"
  // `check` 照收,但它**就是** /upgrade。
  //
  // 它一度是"只查不装":想知道有没有新版,不等于现在就要换。但那条路把一件
  // 本来只有一个动作的事拆成了两个入口 —— 用户按习惯敲了 check,得到的是一句
  // "已经是最新",然后还要再敲一次不带参数的才真的升。而"查"这一步本来就是
  // 升级的第一步:不带参数跑一次,已经是最新的话它同样只会告诉你一句话,
  // 什么都不会装
  if (word.length > 0 && !force && word !== "check") {
    deps.reply(theme.red(`  ${t.upgradeUnknown(arg.trim())}`) + theme.dim(`\n  ${t.upgradeUsage}`))
    return
  }

  // ── 真的要下要装 ──
  // 有全屏界面就开独占浮层;--plain 和管道下退回一行一行地写(见 quarters)
  const ui = deps.upgradeUI
  const controller = new AbortController()
  const progress = quarters()
  if (ui) ui.open({ from: VERSION, phase: "checking" }, () => controller.abort())
  else deps.reply(theme.dim(`  ${t.upgradeChecking}`))

  deps.setBusy(true)
  let outcome
  try {
    outcome = await upgrade({
      force,
      signal: controller.signal,
      onProgress: (event) => {
        if (ui) return ui.update(modalPatch(event))
        // 浮层不在的时候才写行:两边都写的话,浮层关掉之后对话里会多出一段
        // 谁也没在看的进度流水
        const line = upgradeLine(event) ?? progress(event)
        if (line) deps.reply(theme.dim(`  ${line}`))
      },
    })
  } finally {
    deps.setBusy(false)
  }

  // 浮层会被关掉,而"这台机器上的 alfa 被换过一次"必须在对话里留痕 ——
  // 和权限收据同一条规矩(见 App.decide)
  switch (outcome.status) {
    case "current":
      ui?.finish({ phase: "current" })
      deps.reply(theme.dim(`  ${t.upgradeCurrent(outcome.version)}`))
      return
    case "updated": {
      ui?.finish({ phase: "done", to: outcome.to, detail: outcome.to })
      const line = t.upgradeDone(outcome.from, outcome.to)
      deps.receipt(theme.green(`  ✓ ${line}`), "good", line)
      deps.reply(theme.dim(`    ${outcome.path}`))
      return
    }
    case "cancelled":
      ui?.finish({ phase: "cancelled" })
      deps.reply(theme.yellow(`  ${t.upgradeCancelled}`))
      return
    case "blocked": {
      // 「根本没问到」和「出事了」是两句话:前者不是失败,是"这件事现在答不了"。
      // 报成失败的话用户会去查一个不存在的错误(见 update/upgrade.ts 的 reason)
      const line = outcome.reason === "unreachable" ? t.upgradeUnreachable : t.upgradeFailed(outcome.why)
      ui?.finish({ phase: "failed", detail: line })
      deps.receipt(theme.red(`  ✗ ${line}`), "bad", line)
      return
    }
  }
}

/** 一条进度事件对浮层状态的改动。措辞归浮层(见 tui/panes/upgrade.ts) */
function modalPatch(event: UpgradeEvent): Partial<UpgradeState> {
  switch (event.phase) {
    case "checking":
      return { phase: "checking" }
    case "downloading":
      // tag 是 v0.4.2,浮层里那一行写的是版本号
      return { phase: "downloading", to: event.tag.replace(/^v/, ""), received: 0 }
    case "progress":
      return event.total === undefined
        ? { received: event.received }
        : { received: event.received, total: event.total }
    case "verifying":
      return { phase: "verifying" }
    case "installing":
      return { phase: "installing" }
  }
}

/**
 * `/init`:让这个项目从下一场开始就不用重新认识一遍。
 *
 * 见 prompt/init.ts 里那段长注释。这里只管三件事:文件夹当场建出来、建了什么
 * 说一声、然后把剩下那一半展开成一句提问交回给宿主(见 SlashOutcome)。
 *
 * ── 文件夹建不出来也照走 ──
 * `.alfa/` 今天还没人读,而 AGENTS.md 是这条命令真正要的东西。为一个只读挂载
 * 把整件事拦下来,是拿次要的失败去毁掉主要的成功。
 *
 * ── `/init 重点看后端` ──
 * 后面跟的话原样带进提问里。这是用户第一次按这条命令时会本能试的写法,而
 * 「未知命令」在这个位置是最没道理的一种回答。
 */
function initCommand(note: string, host: InitHost): string {
  const scaffold = initScaffold(host.root)
  if (scaffold.created.length > 0) {
    const line = t.initCreated(scaffold.created.join(", "))
    host.receipt(theme.dim(`  + ${line}`), "good", line)
  }
  if (scaffold.failed) {
    const line = t.initScaffoldFailed(scaffold.failed)
    host.receipt(theme.yellow(`  ⌁ ${line}`), "warn", line)
  }
  host.reply(theme.dim(`  ${t.initWriting}`))
  return initPrompt({
    root: host.root,
    existing: existsSync(join(host.root, AGENTS_FILE)),
    ...(note.length > 0 ? { note } : {}),
  })
}

/**
 * `/init` 要的那三样。写成一个窄接口而不是收 InteractiveDeps,是为了
 * `--prompt "/init"` 也能用 —— 那条路上 InteractiveDeps 还没装出来。
 */
interface InitHost {
  root: string
  receipt(line: string, tone: NoteTone, text: string): void
  reply(text: string): void
}

/**
 * `--prompt` 那一次里认一条斜杠命令。
 *
 * 只认 `/init`,而且这不是「先支持一条,以后慢慢加」——一次性模式里 `/view`、
 * `/permission` 这些改的都是**下一场**的事,在一个跑完就退的进程里等于没做。
 * `/init` 不一样:它改的是磁盘,退出之后还在。
 */
function expandOneShot(text: string, host: InitHost): string {
  if (text === "/init" || text.startsWith("/init ")) return initCommand(text.slice("/init".length).trim(), host)
  return text
}

/**
 * 报告 → 工具那边看得懂的那份形状(见 tool/types.ts 的 ContextView)。
 *
 * 工具层不认识 ContextReport,也不该认识 —— 它是主循环的账本,里面还有
 * ratio / limitSource 这类只有界面用得上的东西。
 */
function toContextView(report: ContextReport): {
  used: number
  budget: number
  limit: number
  estimated: boolean
  messages: number
  folded: number
  slices: Array<{ key: string; tokens: number }>
} {
  return {
    used: report.used,
    budget: report.budget,
    limit: report.limit,
    estimated: report.estimated,
    messages: report.messages,
    folded: report.folded,
    slices: report.slices,
  }
}

/** 退出方式的一句话。被信号杀掉和 exit 1 是两件事,别都写成「失败」 */
function exitLabel(exit: number | null | undefined, signal: string | undefined): string {
  if (signal) return t.jobExitKilled(signal)
  return t.jobExitCode(exit === null || exit === undefined ? "?" : String(exit))
}

/** 少于这么多条消息就没什么可压的 —— 压缩本身也要花一次请求 */
const COMPACT_MIN_MESSAGES = 4

/**
 * 到几成自己动手。
 *
 * 比黄线(WARN_AT = 0.8)高一点是刻意的:那条线先说一句「快满了」,用户还有
 * 一段自己决定的余地 —— 想现在压、想先把手上这件事说完、想干脆换个会话。
 * 到了这条线才不再等他,因为再往上就是撞墙,而撞墙的形状是"每一轮都失败",
 * 那时候他手里唯一的招正是压缩,却多半正卡在一件干到一半的事情中间。
 */
const AUTO_COMPACT_AT = 0.9

/**
 * 一轮跑完了,看看要不要自己压一次。
 *
 * ── 为什么在**轮次之间**,而不是在快满的那一刻 ──
 * 压缩会把这一轮的历史整个换掉。跑到一半换,模型手上那趟工具循环的前半段就
 * 没了 —— 而带 tool_use 的消息缺了配对的结果,两家 provider 都是直接 400。
 * 轮次边界是唯一一个"历史是完整的、而且没有人正在读它"的时刻。
 *
 * ── 中断之后不压 ──
 * 用户刚按了 esc,他要的是**停下来**。这时候自动跑一件几十秒的事,正好是他
 * 按那一下想避免的东西。
 */
async function maybeAutoCompact(deps: InteractiveDeps, outcome?: { interrupted?: boolean }): Promise<void> {
  if (!deps.autoCompact() || outcome?.interrupted === true) return
  if (deps.meter.snapshot.ratio < AUTO_COMPACT_AT) return
  await runCompaction(deps, { auto: true })
}

/**
 * `/compact [auto on|off] [要保住什么]`:把历史折成一段交接说明。
 *
 * ── 它折的是**发给模型的那一份**,不是库里那一份 ──
 * 见 session/schema.ts 的 CompactPart:原文一个字都不删,`/view stream` 和
 * `/resume` 里照旧全在。所以这条命令是安全的 —— 最坏情况是摘要写得不好,
 * 而那时候原文还在,`/resume` 能接回去。
 *
 * ── 参数是自由文本,不是子命令 ──
 * 除了 `auto` 那一支,后面跟的一整段都当成"这次要特别保住什么"原样交给压缩
 * agent(见 CompactRequest.focus)。压缩是有损的,而哪一部分损不起只有用户
 * 知道 —— 模型看着一整场会话,判断不出"那三行报错是这两天的全部意义"。
 */
async function compactCommand(arg: string, deps: InteractiveDeps): Promise<void> {
  const words = arg.split(/\s+/).filter(Boolean)
  if (words[0]?.toLowerCase() === "auto") {
    autoCompactCommand(words.slice(1).join(" ").toLowerCase(), deps)
    return
  }
  await runCompaction(deps, { focus: arg })
}

/** `/compact auto [on|off]`:自动压缩的开关,记在配置里 */
/**
 * `/mcp` —— 看这一场接了哪些 server,以及放行来自项目的那些。
 *
 * ── 为什么放行是一条命令,而不是开机弹一个框 ──
 * 开机弹窗会被闭着眼睛按掉:那一刻用户想的是"我要开始干活了",而不是"我要审一份
 * 别人写的进程清单"。而这件事的风险恰恰要看清了才判得了 —— 项目里的
 * `.alfa/mcp.json` 能指定**要跑的命令**,clone 一个陌生仓库就多一条执行路径。
 * 所以缺省是**不起**,横幅上写着有几个在等,`/mcp` 里连命令行一起摆出来给他看。
 */
/**
 * `/skills` —— 手边有哪些打法,以及哪一份没读进来。
 *
 * 「读坏的那些」必须写出来:一份 skill 缺了描述、名字带空格,现象是它**根本不出现**,
 * 而用户手里只有"我明明写了一份"。报错要说得出是哪个文件、哪儿不对。
 */
function skillsCommand(deps: InteractiveDeps): void {
  const set = deps.skillSet()
  const lines: string[] = []

  if (set.skills.length === 0) {
    lines.push(theme.dim(`  ${t.skillsEmpty}`))
  } else {
    lines.push(theme.dim(`  ${t.skillsCount(set.skills.length)}`))
    for (const one of set.skills) {
      lines.push(`  ${theme.bold(one.name)} ${theme.dim(one.origin)}`)
      lines.push(`      ${theme.dim(one.description)}`)
    }
  }

  if (set.library.length > 0) {
    lines.push("", theme.dim(`  ${t.skillsShelf(set.library.length)}`))
    for (const one of set.library) {
      lines.push(`  ${theme.dim(one.name)} ${theme.dim(one.description)}`)
    }
  }

  if (set.problems.length > 0) {
    lines.push("", theme.yellow(`  ${t.skillsProblems(set.problems.length)}`))
    for (const one of set.problems) lines.push(`      ${theme.dim(one.source)} — ${theme.yellow(one.why)}`)
  }
  deps.reply(lines.join("\n"))
}

function mcpCommand(arg: string, deps: InteractiveDeps): void {
  const words = arg.split(/\s+/).filter((one) => one.length > 0)
  const statuses = deps.mcpStatuses()

  if (words[0] === "trust" || words[0] === "allow") {
    const name = words.slice(1).join(" ")
    if (name.length === 0) {
      deps.reply(theme.dim(`  ${t.mcpUsage}`))
      return
    }
    if (!deps.mcpApprove(name)) {
      deps.reply(theme.red(`  ${t.mcpUnknown(name)}`))
      return
    }
    deps.reply(theme.green(`  ${t.mcpApproved(name)}`))
    return
  }

  if (words.length > 0) {
    deps.reply(theme.dim(`  ${t.mcpUsage}`))
    return
  }

  const shelf = deps.mcpShelf()
  const problems = deps.mcpProblems()
  /**
   * ★ 写坏了的那几条。**它们比"一个都没配"更该被说出来。**
   *
   * 这几条读不出来的定义原本一个字都不会露面:loadMcpConfig 刻意不抛
   * (一份坏配置不该让程序起不来),然后调用方把 problems 接过来就扔了。
   * 于是一个 `.alfa/mcp.json` 里少了个逗号的人,`/mcp` 回他的是
   * 「没有配置 MCP server —— 写在 config.json 的 "mcp" 里」——
   * 一句把他指向别处的话。他改的是那份没问题的文件,而真正坏的那份连提都没被提。
   */
  const problemLines = problems.map(
    (one) => `  ${theme.yellow("●")} ${theme.bold(one.name ?? "?")} ${theme.dim(one.source)}\n      ${theme.yellow(one.why)}`,
  )

  if (statuses.length === 0) {
    const empty = problems.length > 0 ? [...problemLines] : [theme.dim(`  ${t.mcpEmpty}`)]
    // 一个 server 都没连、但货架上有东西:这正是最该说一句的场合 ——
    // 用户多半是换了个项目,忘了这儿要 `use` 一下
    if (shelf.length > 0) empty.push(theme.dim(`  ${t.mcpShelf(shelf.length, shelf.join(", "))}`))
    deps.reply(empty.join("\n"))
    return
  }

  const lines = statuses.map((one) => {
    const mark =
      one.state === "ready"
        ? theme.green("●")
        : one.state === "failed"
          ? theme.red("●")
          : one.state === "needs-approval"
            ? theme.yellow("●")
            : theme.dim("○")
    const head = `  ${mark} ${theme.bold(one.name)} ${theme.dim(one.origin)}`
    if (one.state === "ready") return `${head}  ${theme.dim(t.mcpTools(one.tools))}`
    if (one.state === "failed") return `${head}\n      ${theme.red(one.why ?? "failed")}`
    if (one.state === "needs-approval") return `${head}\n      ${theme.yellow(t.mcpPending(one.source))}`
    if (one.state === "connecting") return `${head}  ${theme.dim(t.mcpConnecting)}`
    return `${head}  ${theme.dim(t.mcpOff)}`
  })
  if (problemLines.length > 0) lines.push(...problemLines)
  if (shelf.length > 0) lines.push("", theme.dim(`  ${t.mcpShelf(shelf.length, shelf.join(", "))}`))
  const pending = statuses.filter((one) => one.state === "needs-approval").length
  if (pending > 0) lines.push("", theme.dim(`  ${t.mcpUsage}`))
  deps.reply(lines.join("\n"))
}

/**
 * `/trust [on | off | check]`。
 *
 * ── 为什么这条命令必须存在 ──
 * 「先看一眼」那条路是**一次性**的:检查跑完就定了。而人对一个仓库的判断会变 ——
 * 昨天 clone 下来只是看看,今天开始往里提交了。没有这条命令的话,改主意的唯一
 * 办法是去手改 config.json 里一个他多半不知道存在的键。
 *
 * ★ `off` 是当场生效的:下一步的 system prompt 就不再带那些文件了(见
 *   buildSystemParts 里 trustProject 那颗星)。不是"下次启动"—— 一个安全开关
 *   如果要重启才生效,按下去的那一刻它就还没保护你。
 */
async function trustCommand(arg: string, deps: InteractiveDeps): Promise<void> {
  const summary = trustSummary(deps.root, deps.trust.state(), deps.trust.at())

  if (arg.length === 0) {
    const lines = [theme.dim("  ") + summary]
    // 不信任的时候把「这意味着什么」也写出来。光说一个状态词,用户没法判断
    // 自己要不要改它
    if (deps.trust.state() !== "trusted") lines.push(theme.dim(`  ${t.trustNowUntrusted}`))
    lines.push(theme.dim(`  ${t.trustUsage}`))
    deps.reply(lines.join("\n"))
    return
  }

  if (arg === "on") {
    deps.trust.set("trusted")
    deps.receipt(theme.green(`  ✓ ${t.trustNowTrusted}`), "good", t.trustNowTrusted)
    return
  }
  if (arg === "off") {
    deps.trust.set("untrusted")
    deps.receipt(theme.yellow(`  ! ${t.trustNowUntrusted}`), "warn", t.trustNowUntrusted)
    return
  }
  if (arg === "check") {
    const why = await deps.trust.check()
    if (why) deps.reply(theme.yellow(`  ${why}`))
    else deps.reply(theme.dim(`  ${t.trustChecking}`))
    return
  }

  deps.reply(theme.red(`  ${t.unknownThink(arg)}`) + theme.dim(`\n  ${t.trustUsage}`))
}

function autoCompactCommand(arg: string, deps: InteractiveDeps): void {
  let next: boolean
  if (arg.length === 0) next = !deps.autoCompact()
  else if (arg === "on") next = true
  else if (arg === "off") next = false
  else {
    deps.reply(theme.red(`  ${t.unknownThink(arg)}`) + theme.dim(`\n  ${t.autoCompactUsage}`))
    return
  }
  deps.setAutoCompact(next)
  const line = theme.dim("  ") + theme.bold(next ? t.autoCompactOn : t.autoCompactOff)
  deps.reply(`${line}\n${theme.dim(`  ${next ? t.autoCompactOnHint(Math.round(AUTO_COMPACT_AT * 100)) : t.autoCompactOffHint}`)}`)
}

/**
 * 真正跑一次压缩。`/compact` 和自动触发走的是同一条 —— 两条各写一遍的话,
 * 迟早出现"手动压完清了账本,自动压完没清"这种只在长会话里才现形的错。
 */
async function runCompaction(deps: InteractiveDeps, options: { focus?: string; auto?: boolean } = {}): Promise<void> {
  const history = deps.store.listAll(deps.session.id)
  const foldable = history.length - compactionIndex(history)
  if (foldable < COMPACT_MIN_MESSAGES) {
    // 自动那条路上不吭声:用户没按任何键,而"没什么可压的"不是他要知道的事
    if (!options.auto) deps.reply(theme.dim(`  ${t.compactNothing}`))
    return
  }

  const before = deps.meter.snapshot.used
  deps.setBusy(true)
  deps.reply(theme.dim(`  ${options.auto ? t.compactingAuto : t.compacting}`))
  let result: CompactResult
  try {
    result = await deps.compact(history, options.focus)
  } finally {
    deps.setBusy(false)
  }

  if (result.failed || result.text.length === 0) {
    const why = t.compactFailed(result.failed ?? "empty summary")
    deps.receipt(theme.red(`  ✗ ${why}`), "bad", why)
    return
  }

  applyCompaction(deps.store, deps.session.id, result.text, {
    folded: result.folded,
    tokensBefore: before,
    ...(result.keptFrom ? { keptFrom: result.keptFrom } : {}),
  })
  // 报上来的那个数是压缩**之前**那次请求的,现在不作数了。不清的话仪表盘
  // 会停在原地 —— 而这一刻正是用户盯着它看的时候
  deps.meter.drop()
  // 折掉的历史里就有那些 read 的输出。交接说明里常常写着「下一步:把 foo.ts 的
  // X 改成 Y」,不清账本的话它会照着那句直接下手 —— 而手里已经没有 foo.ts 了
  forgetReads()
  deps.remeasure()
  const freed = Math.max(0, before - deps.meter.snapshot.used)
  // 留了几条原文也要写出来。不写的话「折了 40 条」读起来像"刚才那几轮也没了",
  // 而用户下一句话往往正是接着那几轮说的
  const line =
    t.compacted(result.folded, compactNumber(freed)) + (result.kept > 0 ? ` · ${t.compactKept(result.kept)}` : "")
  deps.receipt(theme.green(`  ⌦ ${line}`), "good", line)
  // 把「快满了」那句提醒重新武装。压完还在黄线以上的话(一场堆了几十兆输出的
  // 会话是可能的),它会当场再说一次 —— 那正是用户需要知道的
  deps.settleContext()
}

/**
 * `/view [session|stream]`。
 *
 * --plain 下也能设:它改的是配置,下次启动生效。做成「这条命令在这里没用」的话,
 * 用户得先知道自己现在处在哪种形态里才敢按 —— 而那正是他想搞清楚的事。
 */
function viewCommand(arg: string, deps: InteractiveDeps, chat?: ChatPane): void {
  const hint = (view: ViewMode) => (view === "session" ? t.viewSessionHint : t.viewStreamHint)
  const current = chat?.view ?? deps.view
  if (arg.length === 0) {
    const lines = [theme.dim("  ") + t.currentView(theme.bold(current), hint(current))]
    for (const view of VIEW_MODES) {
      const marker = view === current ? theme.green("  ● ") : "    "
      lines.push(marker + theme.bold(view.padEnd(8)) + theme.dim(hint(view)))
    }
    deps.reply(lines.join("\n"))
    return
  }
  if (!isViewMode(arg)) {
    deps.reply(theme.red(`  ${t.unknownView(arg, VIEW_MODES.join(", "))}`))
    return
  }
  chat?.setView(arg)
  deps.view = arg
  // 两处都写:全局那份是"我一般要什么",文件夹那份是"这个仓库要什么"。
  // ★ 只写全局的话,一个在 A 仓库按了 stream 的人回到 B 仓库会发现 B 也变了 ——
  //   而他刚刚做的决定明明是关于 A 的。只写文件夹那份也不行:那样这个人
  //   在每一个新仓库里都要重按一遍,而"我一般要 stream"是一句他说得出的话
  rememberView(arg)
  rememberFolderView(deps.root, arg)
  deps.reply(theme.dim("  ") + t.currentView(theme.bold(arg), hint(arg)))
}

/**
 * `/language [interface|reply] [auto|en|zh|ja]`。
 *
 * 两个设置分开是因为它们真的不一样:界面语言是这个程序自己的文案,回答语言是
 * 模型说话用的。在日本上班的中文母语者要英文界面配中文回答 —— 绑在一起的话
 * 总有一半人要将就。
 */
function languageCommand(arg: string, deps: InteractiveDeps): void {
  const parts = arg.split(/\s+/).filter((part) => part.length > 0)
  const kind = parts[0]
  const value = parts[1]

  if (kind === undefined) {
    deps.reply(
      theme.dim("  ") +
        t.currentLanguage(languageLabel(deps.language.interface), languageLabel(deps.language.reply)) +
        "\n" +
        theme.dim(`  ${t.languageUsage}`),
    )
    return
  }
  if (kind !== "interface" && kind !== "reply") {
    deps.reply(theme.red(`  ${t.unknownLanguageKind(kind)}`) + "\n" + theme.dim(`  ${t.languageUsage}`))
    return
  }
  const label = kind === "interface" ? t.languageInterface : t.languageReply
  if (value === undefined) {
    deps.reply(
      theme.dim("  ") +
        t.languageSwitched(label, languageLabel(deps.language[kind])) +
        "\n" +
        theme.dim(`  ${t.languageUsage}`),
    )
    return
  }
  if (!isLanguageChoice(value)) {
    deps.reply(theme.red(`  ${t.unknownLanguage(value, LANGUAGE_CHOICES.join(", "))}`))
    return
  }

  deps.language[kind] = value
  // 界面语言立刻换掉;回答语言下一轮才生效 —— 它是塞进 system prompt 的,
  // 正在跑的那一轮早就发出去了
  if (kind === "interface") setInterfaceLanguage(value)
  rememberLanguage(kind, value)
  // ★ 标签要在切完语言之后**重新取**:切到日文之后还写着「界面语言」的话,
  //   第一行反馈本身就是旧语言的,看着像是没生效
  const settled = kind === "interface" ? t.languageInterface : t.languageReply
  deps.reply(theme.dim("  ") + t.languageSwitched(settled, languageLabel(value)))
}

/**
 * trust 模式没问就放行时,在对话里留的那一行。
 *
 * 它不是日志,是**收据**:用户翻回去要能看出「这台机器在我没看着的时候替我
 * 同意了什么」。但收据要补的是**卡片上没有的那半句**,不是把卡片再抄一遍。
 *
 * ★ 所以这里**不重复命令**。它上面紧挨着就是那次工具调用,命令原文完整地写在
 *   那儿;这一行再写一遍,得到的是一条截断过的副本 —— 两行说同一件事,而短
 *   的那行还更不准。卡片答的是「它干了什么」,这一行答的是「这次本来要问你,
 *   因为什么」——后半句(风险标记)卡片上没有,而那才是这行存在的理由。
 *
 * ★ 也不上绿色。绿色在别处是「成功了」,而「没人看着就过了」不是一件成功的事。
 *   ⚡ 留一点黄(和授权框同一个颜色),其余压暗:trust 模式下这行每次调用都
 *   会出现,一直喊等于没喊。
 */
/**
 * 工具调用 → 右栏该显示什么。
 *
 * 一条规则:**永远显示最后发生的那件事**。不做"猜用户现在想看什么"——
 * 那种东西会在你读到一半时自己跳走,而你不知道为什么。
 */
function toDetail(part: ToolPart, root: string): Detail | undefined {
  const input = ("input" in part.state ? part.state.input : undefined) as Record<string, unknown> | undefined
  const filePath = typeof input?.["filePath"] === "string" ? (input["filePath"] as string) : undefined

  if (part.state.status === "error") {
    return { kind: "text", title: part.tool, body: part.state.error, tone: "error" }
  }
  if (part.state.status === "running") {
    // 读文件可以立刻开始显示,不用等它读完 —— 文件本来就在磁盘上
    return filePath ? { kind: "file", path: filePath } : undefined
  }
  if (part.state.status !== "completed") return undefined

  const diff = part.state.metadata["diff"]
  if (typeof diff === "string" && diff.length > 0) {
    return { kind: "diff", path: filePath ?? part.tool, patch: diff }
  }
  // ★ 派出去的那份交代要**看得见**。子 agent 收到的就是这段话原文,而它此后
  //   只存在于那一场自己的会话里 —— 不摆出来的话,用户没有任何地方能判断
  //   「它到底跟人家说清楚了没有」,而这正是子 agent 跑偏时第一个该看的东西
  if (part.tool === "task") {
    const prompt = input?.["prompt"]
    if (typeof prompt === "string" && prompt.length > 0) {
      const job = part.state.metadata["job"]
      return { kind: "text", title: `task ${typeof job === "string" ? job : ""}`.trim(), body: prompt }
    }
  }
  if (filePath && part.tool === "read") return { kind: "file", path: filePath }
  const body = part.state.output.trim()
  if (body.length === 0) return undefined
  return { kind: "text", title: `${part.tool}  ${relativeLabel(input, root)}`.trim(), body }
}

function relativeLabel(input: Record<string, unknown> | undefined, root: string): string {
  for (const key of ["command", "pattern", "filePath", "path"]) {
    const value = input?.[key]
    if (typeof value === "string" && value.length > 0) return shortenPaths(value, root).slice(0, 40)
  }
  return ""
}

/**
 * 摘要那条线。两种写法(逐轮滚动、接会话时补一份)排在**同一条队**上。
 *
 * ── 为什么串起来跑 ──
 * 用户可以在摘要还没写完的时候就发下一句。两次摘要并发的话,后写完的那份会
 * 盖掉先写完的,而它们各自看到的「上一版」是同一份 —— 于是有一轮的内容永久
 * 丢了。补摘要和逐轮摘要并发更糟:补出来的那份不含新说的这一轮,却会把它盖掉。
 * 串行的代价只是慢一点,而这个面板本来就不是实时的。
 *
 * ── 为什么 --plain 也要 ──
 * 那边没有摘要面板,但 `/summary` 在。一条命令在不同运行形态下给出不同答案,
 * 是最容易被当成 bug 的设计。
 */
interface Summaries {
  /** 这一轮结束了,滚动重写 */
  turn(digest: TurnDigest): void
  /** 接了一场没有摘要的旧会话,照着历史补一份 */
  catchUp(turns: TurnDigest[]): void
}

function makeSummaries(deps: InteractiveDeps, model: ChatModel, onChange: () => void = () => {}): Summaries {
  let chain: Promise<void> = Promise.resolve()

  /**
   * 排一件摘要活。
   *
   * ★ 会话 id 在**入队时**定下来,不在异步链里现取:写到一半用户 /resume 换了
   *   会话的话,现取会把这一份写进另一场 —— 而且两边都不报错。
   */
  const queue = (write: (previous: string, signal: AbortSignal) => Promise<SummaryResult>): void => {
    const sessionID = deps.session.id
    model.summaryWriting()
    onChange()
    chain = chain.then(async () => {
      if (deps.summaryAbort.signal.aborted) return
      const result = await write(deps.store.getSummary(sessionID), deps.summaryAbort.signal)
      // 正在退出:store 马上要关,这时候写库会炸在一个没人看得见的地方
      if (deps.summaryAbort.signal.aborted) return
      if (!result.failed) deps.store.setSummary(sessionID, result.text)
      // 面板只属于**当前**这一场。已经换走了就只落库,不要把上一场的摘要
      // 贴到新面板上
      if (deps.session.id !== sessionID) return
      if (result.failed) model.setSummaryFailed(result.failed)
      else model.setSummary(result.text)
      onChange()
    })
  }

  return {
    turn: (digest) => queue((previous, signal) => deps.summarize(previous, digest, signal)),
    catchUp: (turns) =>
      queue(async (previous, signal) => {
        // 排队期间已经有摘要了(接完立刻说了一句话,那一轮先写完了)——
        // 补的这份看不到那一轮,写进去等于把新的盖掉
        if (previous.length > 0) return { text: previous }
        return deps.catchUp(turns, signal)
      }),
  }
}

/** 全屏三栏。 */
interface FullscreenOptions {
  /** 抓鼠标。见调用点那段 */
  mouse: boolean
  /** 左右两栏这一趟开不开。按文件夹存,见 config/folders.ts */
  panels: boolean
}

async function fullscreen_(
  deps: InteractiveDeps,
  keyboard: Keyboard,
  transcript: Transcript,
  model: ChatModel,
  options: FullscreenOptions,
): Promise<number> {
  trimHistory()
  const editor = new Editor(loadHistory())
  const screen = new Screen()
  /**
   * `@` 引用的文件索引。现在就开扫,不等第一次敲 `@` ——
   * 扫一个中等仓库要几十毫秒,而那几十毫秒正好落在用户读横幅的时候。
   */
  const files = new FileIndex(deps.root)
  void files.refresh()

  let done = () => {}
  const exited = new Promise<void>((resolve) => {
    done = resolve
  })

  const chat = new ChatPane({
    model,
    transcript,
    view: deps.view,
    // 往瀑布流写一行必须走 Renderer —— 它手里可能攒着半行没收口的 markdown
    line: (text) => deps.renderer.line(text),
  })
  // 收据两边都要留:切了视图之后还能看见自己批准过什么
  deps.onReceipt((line, tone, text) => chat.note(line, tone, text))
  deps.onTrustReceipt((line, summary, callID) => chat.trusted(line, summary, callID))
  // 命令的回答两个视图都要有 —— 只写瀑布流的话,session 视图下按了没反应
  deps.onReply((text) => chat.answer(text))

  const app = new App({
    screen,
    keyboard,
    editor,
    chat,
    root: deps.root,
    workspace: deps.workspace,
    label: () => deps.spec(),
    mouse: options.mouse,
    panels: options.panels,
    onPanelsChanged: (visible) => rememberFolderPanels(deps.root, visible),
    // 单子从**库里**算,不是从屏幕上刮。屏幕上那份带着边框、折过行、还夹着
    // 旁边那栏的字 —— 而人要复制的是那段话本身(见 tui/panes/copy.ts)
    copyTargets: () => copyTargets(deps.store.listAll(deps.session.id)),
    files: (query) => files.search(query),
    reindex: () => void files.refresh(),
    onSubmit: (text) => void pump(text),
    // 跑着的时候插的一句:直接递进正在跑的这一轮,它下一个轮次边界就看得见。
    // 回显走 chat.said —— 和正常那条路同一句,不然滚动记录里会缺一句用户的话
    onSubmitBusy: (text) => {
      if (!deps.submitWhileBusy(text)) return false
      chat.said(text)
      return true
    },
    // esc 要能停的不只是这一轮:压缩也是一件要等几十秒的事
    onCancel: () => deps.interrupt(),
    onExit: done,
    context: () => deps.meter.snapshot,
    // 那两块的数据源。界面不自己去工具层捞,由这里递进去
    jobs: () => deps.jobs(),
    agents: () => deps.agents(),
    // 现取:`/agentflow` 一按,输入框上沿那块牌子当场就该出现/消失
    agentflow: () => deps.agentflow(),
    onPickSession: (info) => {
      // 挑中的就是现在这一场:什么都不用做,但要说一声 —— 不吭声看着像没反应
      if (info.id === deps.session.id) {
        chat.note(theme.dim(`  ⏎ ${t.resumeCurrent}`), "good", t.resumeCurrent)
      } else {
        restore(deps, info, { clear: () => chat.clear() })
      }
      app.requestFrame()
    },
    mode: () => deps.gate.permissionMode,
    setMode: (mode) => deps.setMode(mode),
  })

  // 压缩期间也要转圈:那几十秒里什么都不动的话,和卡死没有区别
  deps.setBusy = (busy) => app.setBusy(busy)
  deps.ui.detail = (detail) => app.showDetail(detail)
  deps.ui.preview = (label, text) => {
    app.detail.stream(label, text)
    app.requestFrame()
  }
  deps.ui.clearPreview = () => app.requestFrame()
  deps.ui.filesMayHaveChanged = () => app.scheduleTreeRefresh()
  deps.ui.jobsChanged = () => app.requestFrame()
  deps.onResize(() => app.onResize())
  // turnSignal 是 main 里的 let,这里读到的永远是当前那一轮的信号
  // 请求自带的信号优先 —— 子 agent 的问题跟着它自己死(见 AskInput.signal)
  deps.onAsk((request) => app.askPermission(request, request.signal ?? deps.turnSignal()))
  deps.onInquire((question) => app.askQuestion(question, deps.turnSignal()))
  deps.openResume = () => app.openSessionPicker(sessionChoices(deps), deps.session.id)
  deps.upgradeUI = {
    open: (state, onCancel) => app.openUpgrade(state, onCancel),
    update: (patch) => app.updateUpgrade(patch),
    finish: (patch) => app.finishUpgrade(patch),
  }

  /**
   * 渲染器往 transcript 里写、事件流喂进 session 视图 —— 写完要通知重画,
   * 不然流式文本要等下一次按键才出现。
   *
   * ★ 这两行**替掉的是一个 `setInterval(() => app.requestFrame(), 50)`**。
   *   那个心跳不看有没有东西变过,一秒二十次全量合成三栏画面(200×50 是
   *   一万个单元格),于是一个开着没人碰的窗口稳定吃掉五分之一个核。
   *   它当年存在的唯一理由就是这里缺一声通知。
   *
   * ⚠ 删掉心跳之后,**任何不经过这两条路的界面状态变化都必须自己 requestFrame**。
   *   漏一处的现象是"那块东西要等我按一下键才更新"。兜底不再有了 —— 换来的是
   *   ctrl-l 重画(见 tui/app.ts),一条用户自己按得到的路,而不是一个替所有人
   *   永远开着的定时器。
   */
  transcript.onChange = () => app.requestFrame()
  model.onChange = () => app.requestFrame()

  const summaries = makeSummaries(deps, model, () => app.requestFrame())
  deps.summaries = summaries

  /**
   * 一条一条地答。
   *
   * ── 它现在有两个入口 ──
   * 用户敲回车(带一句话),和**子 agent 的报告到了**(不带话,历史里已经有一条
   * 没人答的合成消息,见 main() 的 deliverReport)。所以 first 是可选的,而
   * 循环的退出条件从"队列空了"变成"队列空了**而且**没有没答的话"。
   *
   * ── 为什么要一把锁 ──
   * 两个入口可能同时来:用户正好在两轮之间敲了回车,而一个子 agent 也刚好回来。
   * 不锁的话会有两条 pump 同时往同一场会话里发 turn。锁住之后后来的那句话进
   * pending —— **不能直接扔掉**,那是用户打过的字。
   *
   * ── 被中断之后不许自作主张接着转 ──
   * esc 之后历史里常常是"没答完"的状态(工具跑了一半),而那正是 hasUnanswered
   * 会说 true 的形状。照着它接着转,就是用户按了停、它却又开了一轮。
   */
  const pending: string[] = []
  let pumping = false
  /**
   * 跑着的时候被叫醒过。
   *
   * ★ 不记这一笔的话有个洞:报告在 runTurn 返回之后、循环判完之前落地,那一声
   *   wake 被 pumping 锁挡掉,而这一轮如果是被 esc 中断的(mayResume 为假),
   *   循环直接收工 —— 报告就躺在库里等用户开口,而屏幕上写着"会叫醒你"。
   *   一份新到的报告是**新的输入**,不是"中断之后接着跑"。
   */
  let wokenWhilePumping = false
  const pump = async (first?: string): Promise<void> => {
    if (first !== undefined) pending.push(first)
    if (pumping) {
      if (first === undefined) wokenWhilePumping = true
      return
    }
    pumping = true
    /** 上一轮是正常收尾的吗。不是的话就别顺着 hasUnanswered 往下转 */
    let mayResume = true
    try {
      while (true) {
        const next = pending.shift() ?? app.takeQueued()
        const woken = wokenWhilePumping
        wokenWhilePumping = false
        if (next === undefined && (!(mayResume || woken) || !deps.hasUnanswered())) break

        let send: string | undefined
        if (next !== undefined) {
          appendHistory(next)
          const expanded = await slashCommand(next, deps, done, chat)
          if (expanded === true) continue
          // 展开过的命令(`/init`)发出去的是展开后那一段,但**回显的还是用户
          // 打的那几个字** —— 屏幕上写着 `/init` 才对得上他刚按下去的键
          chat.said(next)
          send = expanded === false ? next : expanded
        }

        app.setBusy(true)
        const outcome = await deps.runTurn(send)
        app.setBusy(false)
        mayResume = !outcome.interrupted && !outcome.hitStepLimit && outcome.error === undefined
        // ★ 浓缩必须**同步**取走:下一句话一进来 beginTurn 就把这一轮的
        //   工具行清了,那时候再取就是一份空的
        summaries.turn(model.endTurn(outcome))
        deps.settleContext()
        // 快满了就自己压一次。放在轮次之间,见 maybeAutoCompact
        await maybeAutoCompact(deps, outcome)
      }
    } finally {
      pumping = false
    }
  }
  // 子 agent 的报告到了,而主 agent 正闲着 —— 叫它起来接着干
  deps.onWake(() => void pump())

  // 终端被外力破坏(未捕获异常、SIGTERM)时也要还原,否则 shell 变花屏
  const rescue = () => app.dispose()
  process.on("exit", rescue)
  // ★ 还原完**必须自己退**。挂上 SIGTERM 监听这个动作本身就顶掉了默认的"终止",
  //   只还原不退的话,`kill` 打过来只会让它把终端收拾干净然后**接着跑** ——
  //   于是唯一杀得死它的办法是 `kill -9`。128+15 是 shell 对被 TERM 杀死的
  //   进程的约定退出码,保持一致,别让脚本看出区别
  const onTerm = () => {
    rescue()
    process.exit(143)
  }
  process.on("SIGTERM", onTerm)

  // 开局先估一次:状态行上那格从第一帧起就该是真的,而不是等第一轮跑完
  deps.settleContext()
  banner(deps)
  noticeUpdate(deps)
  // 「先看一眼」还没看完 —— 刚在开场卡片上选的,或者上一次跑到一半被关掉的。
  // 后台补上,结论回来时会自己说一句(见 finishTrustReview)
  if (deps.trust.state() === "checking" && !deps.trust.running()) void deps.trust.check()
  app.start()
  // 恢复要在 app.start() 之后:重放走的是渲染器,而它现在写进 transcript,
  // 得有画面才看得见。--resume 则是把挑选浮层直接摆在用户面前
  if (deps.continued) restore(deps, deps.continued)
  else if (deps.wantContinue) deps.renderer.line(theme.dim(`  ${t.continueNone}`))
  if (deps.askResume) resumeCommand(deps)
  try {
    await exited
  } finally {
    process.off("exit", rescue)
    process.off("SIGTERM", onTerm)
    app.dispose()
  }
  return 0
}

/** --plain:底部钉输入框,保留终端滚动缓冲。 */
async function boxed(deps: InteractiveDeps, keyboard: Keyboard): Promise<number> {
  deps.settleContext()
  banner(deps)
  noticeUpdate(deps)
  // 「先看一眼」还没看完 —— 刚在开场卡片上选的,或者上一次跑到一半被关掉的。
  // 后台补上,结论回来时会自己说一句(见 finishTrustReview)
  if (deps.trust.state() === "checking" && !deps.trust.running()) void deps.trust.check()
  trimHistory()
  const editor = new Editor(loadHistory())

  let done = () => {}
  const exited = new Promise<void>((resolve) => {
    done = resolve
  })

  const shell = new Shell({
    region: deps.region,
    keyboard,
    editor,
    label: () => deps.spec(),
    workspace: deps.workspace.path,
    onSubmit: (text) => void pump(text),
    onSubmitBusy: (text) => {
      if (!deps.submitWhileBusy(text)) return false
      for (const line of userLines(text)) deps.renderer.line(line)
      return true
    },
    onCancel: () => deps.interrupt(),
    onExit: done,
    mode: () => deps.gate.permissionMode,
    setMode: (mode) => deps.setMode(mode),
    context: () => deps.meter.snapshot,
  })

  deps.setBusy = (busy) => shell.setBusy(busy)
  deps.ui.preview = (label, text) => shell.setPreview(label, text)
  deps.ui.clearPreview = () => shell.clearPreview()
  deps.onResize(() => shell.paint())
  /**
   * --plain 的挑选界面画在活动区里,而输入框也画在那儿 —— 挑完必须让输入框
   * 重画一遍把它盖回去。
   *
   * 这里不 await:斜杠命令是同步的,而挑选是个要等人按键的过程。挂起整条
   * pump 去等它,排在后面的消息就都卡住了。
   */
  deps.openResume = () => {
    void pickSession({ sessions: sessionChoices(deps), keyboard, region: deps.region, currentID: deps.session.id }).then(
      (info) => {
        if (info && info.id !== deps.session.id) restore(deps, info)
        else if (info) deps.renderer.line(theme.dim(`  ⏎ ${t.resumeCurrent}`))
        shell.paint()
      },
    )
  }

  /**
   * 跑一句,跑完再看队列里有没有攒下的。
   *
   * 跑着的时候敲回车不打断,而是排队 —— 想到一半的补充说明不该逼用户等到
   * 上一轮结束才能打字。
   */
  const summaries = deps.model ? makeSummaries(deps, deps.model) : undefined
  if (summaries) deps.summaries = summaries

  /** 和全屏那条一样的两个入口、一把锁、一条中断之后不再自己往下转的规矩 */
  const pending: string[] = []
  let pumping = false
  /**
   * 跑着的时候被叫醒过。
   *
   * ★ 不记这一笔的话有个洞:报告在 runTurn 返回之后、循环判完之前落地,那一声
   *   wake 被 pumping 锁挡掉,而这一轮如果是被 esc 中断的(mayResume 为假),
   *   循环直接收工 —— 报告就躺在库里等用户开口,而屏幕上写着"会叫醒你"。
   *   一份新到的报告是**新的输入**,不是"中断之后接着跑"。
   */
  let wokenWhilePumping = false
  const pump = async (first?: string): Promise<void> => {
    if (first !== undefined) pending.push(first)
    if (pumping) {
      if (first === undefined) wokenWhilePumping = true
      return
    }
    pumping = true
    let mayResume = true
    try {
      while (true) {
        const next = pending.shift() ?? shell.takeQueued()
        const woken = wokenWhilePumping
        wokenWhilePumping = false
        if (next === undefined && (!(mayResume || woken) || !deps.hasUnanswered())) break

        let send: string | undefined
        if (next !== undefined) {
          appendHistory(next)
          const expanded = await slashCommand(next, deps, done)
          if (expanded === true) continue
          for (const line of userLines(next)) deps.renderer.line(line)
          send = expanded === false ? next : expanded
        }

        shell.setBusy(true)
        const outcome = await deps.runTurn(send)
        shell.setBusy(false)
        deps.renderer.line("")
        mayResume = !outcome.interrupted && !outcome.hitStepLimit && outcome.error === undefined
        // 浓缩要同步取走:下一句一进来,beginTurn 就把这一轮的工具行清了
        if (deps.model && summaries) summaries.turn(deps.model.endTurn(outcome))
        deps.settleContext()
        await maybeAutoCompact(deps, outcome)
      }
    } finally {
      pumping = false
    }
  }
  deps.onWake(() => void pump())

  shell.start()
  if (deps.continued) restore(deps, deps.continued)
  else if (deps.wantContinue) deps.renderer.line(theme.dim(`  ${t.continueNone}`))
  // 挑选界面和输入框抢的是同一块活动区,所以先让 shell 画出来再叫它 ——
  // 反过来的话输入框会立刻把列表盖掉
  if (deps.askResume) resumeCommand(deps)
  await exited
  shell.stop()
  return 0
}

/**
 * 没有终端(管道 / CI):逐行读,一行一轮。
 *
 * 这条路径必须留着。`echo "fix the test" | alfa` 和把它塞进脚本里
 * 是真实用法,而输入框那一套在没有 TTY 时一个字都画不出来。
 */
async function piped(deps: InteractiveDeps): Promise<number> {
  banner(deps)
  noticeUpdate(deps)
  // ★ 这条路上**不**自动补跑信任复查。它是"键盘拿不到"时的兜底(CI 的伪终端、
  //   管道),而在一个没人看着的进程里自己发起一次模型调用,正是这个程序到处
  //   在躲的那种看不见的自动化。等他下次开交互界面,或者自己敲 `/trust check`
  // 管道里没人可以挑,但"接着上次"这个意图是明确的 —— 退回最近那一场,
  // 并把这件事说出来。默默开一场新的会让脚本作者以为历史丢了。
  const resumed = deps.continued ?? (deps.askResume ? deps.store.latestSession(deps.cwd) : undefined)
  // 不重放:这一路的输出多半要进管道或日志,把整段历史再吐一遍是污染
  if (resumed) restore(deps, resumed, { replay: false })
  else if (deps.askResume || deps.wantContinue) deps.renderer.line(theme.dim(`  ${t.continueNone}`))
  let stop = false
  const exit = () => {
    stop = true
  }
  for await (const line of readLines(process.stdin)) {
    const text = line.trim()
    if (text.length === 0) continue
    // 管道没有回显,自己把问题打出来,否则输出里只有答案、看不出在答什么
    for (const line of userLines(text)) deps.renderer.line(line)
    const expanded = await slashCommand(text, deps, exit)
    if (expanded !== true) {
      const outcome = await deps.runTurn(expanded === false ? text : expanded)
      // ★ 派出去的子 agent 要等回来。管道这条路上没有界面可以叫醒谁,而
      //   「它派了三个人调查然后立刻退出」交给下游的是一份没写完的答案
      await deps.drainAgents()
      deps.renderer.line("")
      deps.settleContext()
      // 管道里更需要它:一条 while 循环喂进来的几十句话,撞满窗口之后
      // 剩下的每一句都会失败,而那边没有人看得见
      await maybeAutoCompact(deps, outcome)
    }
    if (stop) break
  }
  return 0
}

async function* readLines(input: NodeJS.ReadStream): AsyncGenerator<string> {
  input.setEncoding("utf8")
  let buffer = ""
  for await (const chunk of input as AsyncIterable<string>) {
    buffer += chunk
    let at = buffer.indexOf("\n")
    while (at !== -1) {
      yield buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      at = buffer.indexOf("\n")
    }
  }
  if (buffer.length > 0) yield buffer
}

/** anthropic 系用它自己的模板,其余用通用模板。 */
function modelInfoTemplate(spec: string): "anthropic" | "default" {
  return spec.startsWith("anthropic/") ? "anthropic" : "default"
}

function describe(error: unknown): string {
  if (error instanceof HardDenyError) return error.message
  return error instanceof Error ? error.message : String(error)
}

/**
 * 未捕获异常只打一行,不把 SDK 的堆栈甩给用户 —— 那既吓人又没有信息量。
 * 真堆栈开 ALFA_DEBUG=1 去日志里看。
 */
export async function run(argv?: string[]): Promise<number> {
  try {
    return await main(argv)
  } catch (error) {
    process.stderr.write(theme.red(`${programName()}: ${describe(error)}\n`))
    return 1
  }
}

// 既是库也是可执行入口。
// import.meta.main 只在**它自己就是入口**时为真 —— 被 bin/ 的 shim import 时
// 为假,所以不会跑两遍。bun build --compile 也认这个判断。
if (import.meta.main) {
  process.exitCode = await run()
}
