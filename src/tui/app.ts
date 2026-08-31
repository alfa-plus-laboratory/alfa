/**
 * 全屏界面的组装与按键路由。
 *
 * ── 焦点规则 ──
 * Tab 在四块之间转,但**打字永远回输入框**。这条是刻意的:焦点在文件树上时
 * 顺手敲了一句话,字不该掉进虚空 —— 它会把焦点弹回输入框并原样插进去。
 * 全屏界面里最气人的就是"我打的字去哪了",这条规则让它不可能发生。
 *
 * ── 一帧从哪来 ──
 * 任何状态变化都只做一件事:标脏。真正的绘制统一在 draw() 里做一次,由
 * requestFrame 合并到下一个 tick。流式输出一秒来几十个 token,每个都立刻
 * 重绘的话,光是算折行就能把 CPU 吃满。
 *
 * ── 退出必须还原终端 ──
 * alternate screen、raw 模式、鼠标上报、括号粘贴,四样东西进去了都得出来。
 * 漏一样用户回到 shell 就是花屏或者打字不回显。所以 dispose() 挂在所有退出
 * 路径上,包括未捕获异常和 SIGTERM。
 */
import type { ContextSnapshot } from "../agent/context.ts"
import { apply, complete, type Completion, type FileSource } from "../cli/commands.ts"
import { contextRule, spentChip } from "../cli/context.ts"
import { Editor, renderBox } from "../cli/editor.ts"
import type { Keyboard } from "../cli/keyboard.ts"
import type { Key, MouseEvent } from "../cli/keys.ts"
import { color256, theme } from "../cli/theme.ts"
import { pickKey, renderList } from "../cli/sessions.ts"
import { displayWidth, elideLeft, pathBudget, truncateToWidth } from "../cli/width.ts"
import type { WorkspaceLabel } from "../fs/workspace.ts"
import type { SessionInfo } from "../session/store.ts"
import type { JobSnapshot } from "../tool/background.ts"
import {
  bodyRow,
  bottomBorder,
  inputDivider,
  statusDivider,
  statusFrame,
  overlayFrame,
  panelDivider,
  railBody,
  recallChip,
  topBorder,
} from "./chrome.ts"
import {
  computeLayout,
  LAYOUT_LIMITS,
  overlayRect,
  type Layout,
  type PaneName,
  type PanelName,
  type SideName,
} from "./layout.ts"
import { completionKey, completionRows, renderCompletion } from "./panes/complete.ts"
import { DetailPane, type Detail } from "./panes/detail.ts"
import { AgentsPane } from "./panes/agents.ts"
import { JobsPane } from "./panes/jobs.ts"
import { PlanPane } from "./panes/plan.ts"
import { ChatPane } from "./panes/chat.ts"
import { askSummary, decisionLine, decisionSummary, promptKey, renderPrompt } from "./panes/prompt.ts"
import { answerLine, answerSummary, askingSummary, renderQuestion } from "./panes/question.ts"
import { renderUpgrade, type UpgradeState } from "./panes/upgrade.ts"
import { copyKey, copyRow, copyTargets, humanBytes, type CopyTarget } from "./panes/copy.ts"
import {
  cycleValue,
  flatRows,
  renderSettings,
  settingsKey,
  type SettingsSource,
} from "./panes/settings.ts"
import { writeClipboard } from "../cli/clipboard.ts"
import type { PromptRequest } from "../permission/gate.ts"
import { modeInfo, nextMode, type PermissionMode } from "../permission/mode.ts"
import { t } from "../i18n/index.ts"
import { QuestionState } from "../cli/ask.ts"
import type { Answer, AskDecision, Question } from "../tool/types.ts"
import { TreePane } from "./panes/tree.ts"
import { Screen } from "./screen.ts"

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const SPINNER_MS = 100

/**
 * 两帧之间至少隔这么久 —— 16 毫秒,60fps 封顶。
 *
 * 挑 16 不挑 33 是拿按键换的:限速的下限就是按键回显最坏要等多久,而没有人
 * 打字快到一秒 60 下,所以实际上每一次按键都是当场画的,只有流式输出那种
 * "一秒几十个宏任务"的场面才真的被并起来。
 */
const FRAME_MS = 16

/** 按下 /agentflow 之后彩虹转多久。够看清是什么,又不至于变成一个停不下来的界面 */
const FLOW_GLOW_MS = 6_000

/** 收起来之后要在状态行上写「怎么叫回来」的那几块 */
const RECALL: PanelName[] = ["tree", "plan", "detail"]

/**
 * 状态行上的一段。带 hit 的那些是**能点的**,画成 `[ctrl-b files]`。
 *
 * hit 一度就是 PanelName(那时候能点的只有"把某一栏叫回来")。加进 "copy"
 * 之后它成了「点这一片要干什么」,而不是「这一片是哪一栏」—— 名字跟着含义改。
 */
type StatusAction = PanelName | "copy"

interface Bit {
  text: string
  hit?: StatusAction
}

/** 竖着写在轨上的那个词。和面板标题用同一批词 —— 展开之后看到的就是它 */
function railLabel(panel: PanelName): string {
  return panel === "tree" ? t.paneFiles : panel === "detail" ? t.paneDetail : panel
}

function recallLabel(panel: PanelName): string {
  if (panel === "tree") return t.recallFiles
  if (panel === "detail") return t.recallDetail
  return t.recallPlan
}

export interface AppDeps {
  screen: Screen
  keyboard: Keyboard
  editor: Editor
  chat: ChatPane
  root: string
  /** 工作区怎么显示:名字进文件树标题,路径进状态行 */
  workspace: WorkspaceLabel
  /** 当前模型那串字。**现取** —— `/model` 会在跑着的时候换掉它 */
  label(): string
  mouse: boolean
  /**
   * 左右两栏开着进来吗。缺省 true(老样子)。
   *
   * false 是这个文件夹自己说过的(见 config/folders.ts)—— 不是全局默认,
   * 因为答案真的按文件夹不同:天天写的那个仓要文件树,顺手 clone 下来看两眼
   * 的那个不要。
   */
  panels?: boolean
  /** 用户在界面上把侧栏开关过。宿主拿去记在这个文件夹名下 */
  onPanelsChanged?(visible: boolean): void
  /**
   * ctrl-y 那张单子上列什么。**现算** —— 真值源是会话库,不是屏幕上的字。
   *
   * 界面自己不去碰 store:那样这一层就得认识会话的存储格式,而它现在只认识
   * 「一行行带颜色的字符串」。不接就是没有复制单子(--plain 那条路)。
   */
  copyTargets?(): CopyTarget[]
  /** `@` 引用的候选。不给就只有斜杠命令能补 */
  files?: FileSource
  /** 盘上可能变了,让文件索引重扫。ctrl-r 和每轮跑完时调 */
  reindex?(): void
  onSubmit(text: string): void
  /**
   * 跑着的时候提交的那一句。
   *
   *   true      —— 宿主已经把它递进正在跑的这一轮了(见 cli/main.ts 的 injectUser),
   *                界面只管把它显示出来
   *   false     —— 还得等这一轮结束(改历史的那几条斜杠命令走这条)
   *   "handled" —— 宿主当场就办完了,回执也已经写过了(`/agentflow` 这类
   *                只改设置的命令)。★ 这一条**既不回显也不入队** —— 它不是
   *                一句要说给模型听的话,而队列里多一条已经执行完的命令,
   *                会在这一轮结束之后被再执行一遍
   *
   * 没接就是老规矩:全部排队。
   */
  onSubmitBusy?(text: string): boolean | "handled"
  onCancel(): void
  onExit(): void
  /** 用户在挑选浮层里选定了一场会话。取消的话这个回调不会被调用。 */
  onPickSession(session: SessionInfo): void
  /** 当前权限模式。真值源在 PermissionGate 上 —— 界面只是它的显示器 */
  mode(): PermissionMode
  setMode(mode: PermissionMode): void
  /**
   * 上下文占用。**必须是缓存好的一个快照** —— 这个函数每帧都会被调用,
   * 而算一次占用要扫全量历史(见 agent/context.ts 的 ContextMeter)。
   */
  context?(): ContextSnapshot
  /**
   * 后台任务快照。**由 CLI 层注入,不从这里去 import 工具层** ——
   * 界面读的是给它的数据,不是自己伸手去别的层里捞。
   */
  jobs?(): readonly JobSnapshot[]
  /**
   * 派出去的子 agent。和后台进程**分两块画** —— 对用户它们不是一类东西,
   * 见 tui/panes/agents.ts 文件头
   */
  agents?(): readonly JobSnapshot[]
  /**
   * `/setting` 那一屏的内容。**不接就是没有这一屏** —— --plain 和管道下
   * 那套上下左右的界面根本画不出来(见 cli/settings.ts)。
   */
  settings?: SettingsSource
  /**
   * agentflow 开着吗,开着的话同时几个。false = 关。
   *
   * 界面要它只为一件事:**把"它开着"钉在你打字的地方正上方**(见 flowChip)。
   * 这个开关改变的是模型接下来每一件事的做法,而开机横幅说过一次就滚走了 ——
   * 一个看不见的、会改变行为的模式,和没开是同一种体验。
   */
  agentflow?(): number | false
}

export class App {
  private readonly deps: AppDeps
  readonly tree: TreePane
  readonly detail: DetailPane
  readonly plan = new PlanPane()
  readonly jobs = new JobsPane()
  readonly agents = new AgentsPane()

  private layout: Layout
  private focus: PaneName = "input"
  private hidden = new Set<PanelName>()
  /** 被折叠的栏临时召回时盖在对话上 */
  private overlay: SideName | undefined

  private release: (() => void) | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  /** 「该消失了」那一次性的重绘。见 scheduleRetire */
  private retireTimer: ReturnType<typeof setTimeout> | undefined
  private treeTimer: ReturnType<typeof setTimeout> | undefined
  private frameQueued = false
  /** 限速用的那个。见 requestFrame */
  private frameTimer: ReturnType<typeof setTimeout> | undefined
  private lastDraw = 0
  private disposed = false

  private busy = false
  /** 动画的计时格子,100ms 一格。转圈和小人各自按自己的周期从它取帧 */
  private tick = 0
  /**
   * 上一次看到的 agentflow 值。用来认出"开关刚被按过"—— 见 flowGlowUntil。
   * undefined = 还没看过任何一次(第一帧不该被当成一次切换)
   */
  private flowSeen: number | false | undefined
  /** 按下开关之后彩虹再转几秒。0 = 不在这个窗口里 */
  private flowGlowUntil = 0
  private note = ""
  private armed = false
  /**
   * 跑着的时候插的那几句。
   *
   * `sent` = 已经递进正在跑的这一轮了(见 ShellDeps.onSubmitBusy)。它照旧
   * **留在这张表里**,因为这张表同时是「你说的话」底下那几行 `↳` 的数据源 ——
   * 递出去就从屏幕上消失的话,用户的第一反应是"我刚才那句去哪了"。只是轮到
   * takeQueued 的时候不能再发一遍。
   */
  private queued: Array<{ text: string; sent: boolean }> = []
  /** 正在问的那条权限。有它的时候所有按键都归它。 */
  private prompt: Pending | undefined
  /**
   * 排队的权限请求。
   *
   * 模型可以一次并行发起两条 bash —— gate.ask() 没有串行化,两个请求会同时到。
   * 不排队的话后来的直接把前一个的 resolve 覆盖掉,那条工具就永远挂在那里。
   */
  private promptQueue: Pending[] = []
  private promptScroll = 0
  /**
   * 模态框上那句「你刚才那一下没被认出来」。
   *
   * 有它才会写,换成别的问题时清掉。最常见的来源是**输入法** —— 中日韩输入态下
   * `y` 根本到不了这儿,而上屏的那几个汉字过来时,原来是静悄悄地无视。
   * 见 panes/prompt.ts 的 promptKey。
   */
  private promptHint: string | undefined
  /** 补全浮层里选中第几条 */
  private completeIndex = 0
  /** 候选集变了就把选中项拨回第一条,不然会莫名其妙停在一个不相干的候选上 */
  private completeSignature = ""
  /** esc 关掉浮层之后记住当时的文本;一改动就重新弹 */
  private completeDismissed: string | undefined
  /** 会话挑选浮层。开着的时候所有按键都归它 —— 见 onKey */
  private picker: Picker | undefined
  /**
   * 复制单子(ctrl-y)。开着的时候所有按键都归它。
   *
   * 和会话浮层同一档,不是模态框:它是**用户自己开的窗**,不是别人在等他答复。
   */
  private copy: { targets: CopyTarget[]; selected: number } | undefined
  /**
   * 设置那一屏(`/setting`)。开着的时候所有按键都归它。
   *
   * ── 为什么是一摞而不是一页 ──
   * 换模型、改密钥各自是一整页,而从它们退回来时要回到**刚才那一行**上 ——
   * 只记一个"当前页"的话,每次返回光标都跳回第一条,连着改两样东西就得
   * 重新找一遍位置。一摞里每一层各记各的。
   *
   * `typed` 有值 = 正在往密钥那一格里打字。那时候按键是另一套(见 settingsKey):
   * 一屏里只要存在一个会收字符的格子,任何"某个字母 = 命令"的约定都会咬人。
   */
  private settings: { stack: Array<{ id: string; selected: number }>; typed?: string } | undefined
  /**
   * 升级浮层。开着的时候**所有按键都归它,而且它拦在最前面**。
   *
   * 比权限模态框还要靠前:那一个是"别人在等你答复",这一个是"你机器上那个
   * 可执行文件正在被换掉"。这几分钟里发一句话给模型、切个模型、开始一轮新的
   * 工具循环 —— 每一件都建立在"程序马上要被替换"这个前提上,让它们发生反而
   * 是在坑用户。见 panes/upgrade.ts 文件头
   */
  private upgrade: UpgradeState | undefined
  /** 取消正在跑的那次下载。浮层里按 esc 走它 */
  private cancelUpgrade: (() => void) | undefined
  /** 正在拖哪一栏的滚动条。抓住了就一直归它,直到松开 */
  private dragging: ScrollablePane | undefined
  /**
   * 上一帧那些**能点的东西**画在哪儿。
   *
   * 界面是每帧重算的,而鼠标事件永远发生在**已经画出来的那一帧**上 —— 所以
   * 位置要在画的时候记下来,不能在收到点击时重算(那时候布局可能已经变了)。
   */
  private titleHits: Array<{ x: number; width: number; panel: PanelName }> = []
  /** 状态行上「把它叫回来」的那几个片 */
  private statusHits: Array<{ x: number; width: number; action: StatusAction }> = []
  /**
   * 复制那块牌子这一帧画在**屏幕**的哪儿。
   *
   * session 视图下它挂在活动区那条横线右端(见 panes/chat.ts 的 copyChip);
   * undefined = 这一帧对话栏没接手,牌子还在状态行上。这一个字段同时是那边
   * 「要不要画」的判据 —— 两处同时出现的话,用户会以为它们是两件事。
   */
  private copyHit: { x: number; y: number; width: number } | undefined

  constructor(deps: AppDeps) {
    this.deps = deps
    this.tree = new TreePane(deps.root)
    this.detail = new DetailPane(deps.root)
    // 这个文件夹上次说的是"不要侧栏"。**两栏一起收**,而不是留一栏 ——
    // 只收一半的话,屏幕上剩下的那一栏看起来像个 bug
    if (deps.panels === false) this.hidden = new Set<PanelName>(["tree", "detail"])
    this.layout = this.measure()
  }

  start(): void {
    this.deps.screen.enter()
    this.deps.keyboard.setMouse(this.deps.mouse)
    this.release = this.deps.keyboard.push(this.onKey)
    void this.tree.refreshGit().then(() => this.requestFrame())
    this.requestFrame()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // 挂着的问题一律按拒绝收掉。不收的话对应的工具会一直 await,
    // runner.drain() 等不到它,程序退不出去。
    for (const pending of [this.prompt, ...this.promptQueue]) {
      if (!pending) continue
      if (pending.kind === "permission") {
        pending.finish?.("reject")
        this.deps.chat.resolved(pending.note, decisionSummary(pending.request, "reject"))
        continue
      }
      const answer: Answer = { kind: "cancelled" }
      pending.finish?.(answer)
      this.deps.chat.resolved(pending.note, answerSummary(pending.state.question, answer))
    }
    this.prompt = undefined
    this.promptQueue = []
    this.stopTimer()
    if (this.frameTimer) clearTimeout(this.frameTimer)
    this.frameTimer = undefined
    if (this.retireTimer) clearTimeout(this.retireTimer)
    if (this.treeTimer) clearTimeout(this.treeTimer)
    this.treeTimer = undefined
    this.release?.()
    this.deps.keyboard.setMouse(false)
    this.deps.screen.leave()
  }

  // ───────────────────────────────────────────── 外部状态

  setBusy(busy: boolean): void {
    if (this.busy === busy) return
    this.busy = busy
    this.armed = false
    this.note = ""
    if (busy) {
      this.startTimer()
    } else {
      // ★ 不是无条件 stopTimer:开着 flow 的时候彩虹可能还该转(子 agent 还在跑,
      //   或者开关刚按过)。这一轮结束不等于屏幕上没有东西在动了
      this.syncTimer()
      // 一轮跑完才重扫索引,不是每次工具调用之后 —— 那是一次 rg 全量扫描,
      // 挂在防抖后面也扛不住一轮十几个工具。跑完这一次足够:用户下一句话
      // 里的 `@` 才需要它是新的
      this.deps.reindex?.()
      void this.tree.refreshGit().then(() => this.requestFrame())
    }
    this.requestFrame()
  }

  /**
   * 盘上可能变了,重扫文件树。
   *
   * 挂在每次工具调用结束上,而不是等一轮跑完 —— agent 写完一个文件应该当场
   * 在树里看到,而不是等它把话说完。防抖是因为并行工具会连着触发好几次,
   * 而每次都要 readdir 所有展开着的目录。
   */
  scheduleTreeRefresh(): void {
    if (this.treeTimer || this.disposed) return
    this.treeTimer = setTimeout(() => {
      this.treeTimer = undefined
      this.tree.refresh()
      this.requestFrame()
    }, 120)
    this.treeTimer.unref?.()
  }

  showDetail(detail: Detail): void {
    this.detail.follow(detail)
    this.requestFrame()
  }

  /**
   * 问一条权限。返回的 promise 由用户按键或中断信号来结。
   *
   * 这是全屏模式下**唯一**的提问通道 —— confirm.ts 那条往 stdout 写的路在
   * alternate screen 里会盖穿合成器画好的画面,并让差分的基准永久失准。
   */
  askPermission(request: PromptRequest, signal?: AbortSignal): Promise<AskDecision> {
    return new Promise<AskDecision>((resolve) => {
      // 排队的请求也要**立刻**在看板上占一行。模态框一次只能显示一条,
      // 而被挡在后面的那几条同样是「它停在那里等你」——看不见的话,
      // 用户看到的就是一个莫名其妙不动了的 agent
      const pending: PermissionPending = {
        kind: "permission",
        request,
        settled: false,
        note: this.deps.chat.asked(askSummary(request)),
      }

      const finish = (decision: AskDecision) => {
        if (pending.settled) return
        pending.settled = true
        signal?.removeEventListener("abort", onAbort)
        resolve(decision)
      }
      pending.finish = finish

      // 中断当前 turn 时挂着的问题要一起收掉,否则那条工具永远等下去
      const onAbort = () => {
        finish("reject")
        this.deps.chat.resolved(pending.note, decisionSummary(request, "reject"))
        this.dropPending(pending)
      }
      if (signal?.aborted) return finish("reject")
      signal?.addEventListener("abort", onAbort, { once: true })

      this.queuePrompt(pending)
    })
  }

  /**
   * 它想问你一句(见 tool/ask.ts)。和权限走同一个队列、同一套收据。
   *
   * 中断这一轮时挂着的问题按「没答」收掉,而不是按拒绝 —— 用户按 esc 是
   * "别问了往下走",模型收到的那句话也该是这个意思。
   */
  askQuestion(question: Question, signal?: AbortSignal): Promise<Answer> {
    return new Promise<Answer>((resolve) => {
      const pending: QuestionPending = {
        kind: "question",
        state: new QuestionState(question),
        settled: false,
        note: this.deps.chat.asked(askingSummary(question)),
      }

      const finish = (answer: Answer) => {
        if (pending.settled) return
        pending.settled = true
        signal?.removeEventListener("abort", onAbort)
        resolve(answer)
      }
      pending.finish = finish

      const onAbort = () => {
        const answer: Answer = { kind: "cancelled" }
        finish(answer)
        this.deps.chat.resolved(pending.note, answerSummary(question, answer))
        this.dropPending(pending)
      }
      if (signal?.aborted) return finish({ kind: "cancelled" })
      signal?.addEventListener("abort", onAbort, { once: true })

      this.queuePrompt(pending)
    })
  }

  private queuePrompt(pending: Pending): void {
    if (this.prompt) this.promptQueue.push(pending)
    else this.openPrompt(pending)
    this.requestFrame()
  }

  /** 这一条不问了(被中断收掉的那条):在前台就换下一个,在队里就抽走 */
  private dropPending(pending: Pending): void {
    if (this.prompt === pending) this.closePrompt()
    else this.promptQueue = this.promptQueue.filter((p) => p !== pending)
    this.requestFrame()
  }

  private openPrompt(pending: Pending): void {
    this.prompt = pending
    this.promptScroll = 0
    // ★ 换了一条问题就清掉。留着的话,上一条上按错的那一下会挂在下一条的框上,
    //   而下一条问的是另一件事 —— 那句话在那儿是无中生有
    this.promptHint = undefined
  }

  private closePrompt(): void {
    this.prompt = undefined
    this.promptScroll = 0
    this.promptHint = undefined
    const next = this.promptQueue.shift()
    if (next) this.openPrompt(next)
  }

  private decide(decision: AskDecision): void {
    const pending = this.prompt
    if (!pending || pending.kind !== "permission") return
    // 模态框会消失,但"我批准过什么"必须在对话里留痕 —— 两个视图都要有
    this.deps.chat.decided(pending.note, decisionLine(pending.request, decision), decisionSummary(pending.request, decision))
    pending.finish?.(decision)
    this.closePrompt()
  }

  /** 答完了。和批准同一条路:框消失,但"我当时选了什么"留在对话里 */
  private answered(answer: Answer): void {
    const pending = this.prompt
    if (!pending || pending.kind !== "question") return
    const question = pending.state.question
    // ★ 「回上一题」不是一个答案,**不往对话里追一行**:用户还没决定什么,
    //   而这道题马上会被重新问一遍。看板上那一行必须收掉 —— 它写着"等你确认",
    //   而现在没人在等它了(见 chat.resolved 上那段)
    if (answer.kind === "back") {
      this.deps.chat.resolved(pending.note, answerSummary(question, answer))
      pending.finish?.(answer)
      this.closePrompt()
      return
    }
    this.deps.chat.decided(pending.note, answerLine(question, answer), answerSummary(question, answer))
    pending.finish?.(answer)
    this.closePrompt()
  }

  /**
   * 打开会话挑选浮层。真正的切换由 onPickSession 那一头做 ——
   * 界面不该知道"接上一场会话"是怎么回事,它只负责问用户挑哪个。
   */
  openSessionPicker(sessions: SessionInfo[], currentID: string): void {
    // 跑着的时候不给换。换会话要清掉看板和滚动记录,而这一轮的工具还在往里写 ——
    // 换完之后那些输出会落在一场它们根本不属于的会话里
    if (this.busy) {
      this.note = t.resumeBusy
      return this.requestFrame()
    }
    this.picker = { sessions, selected: 0, now: Date.now(), currentID }
    this.requestFrame()
  }

  /**
   * 开升级浮层。onCancel 是"用户按了 esc"—— 真正的中止由调用方做(它手里
   * 才有那个 AbortController),这里只负责把这件事报上去。
   */
  openUpgrade(state: UpgradeState, onCancel: () => void): void {
    this.upgrade = state
    this.cancelUpgrade = onCancel
    this.requestFrame()
  }

  /** 进度。浮层已经关掉(用户按了 esc)之后来的事件一律丢掉 */
  updateUpgrade(patch: Partial<UpgradeState>): void {
    if (!this.upgrade) return
    this.upgrade = { ...this.upgrade, ...patch }
    this.requestFrame()
  }

  /**
   * 收尾。**不自动关** —— 结果(换好了 / 失败了 / 已经是最新)是用户唯一
   * 一次看到它的机会,自己按一下再关掉。
   */
  finishUpgrade(patch: Partial<UpgradeState>): void {
    if (!this.upgrade) return
    this.cancelUpgrade = undefined
    this.upgrade = { ...this.upgrade, ...patch }
    this.requestFrame()
  }

  upgradeOpen(): boolean {
    return this.upgrade !== undefined
  }

  /**
   * 取走**全部**排队的话,拼成一条。
   *
   * ★ 不是一次取一条。一轮跑完的时候,排在后面的那几句是用户在**同一段时间里**
   *   补出来的同一件事的三个补充("顺便把测试跑一下"、"还有 README")——
   *   一条一条当成独立的轮次去答,它每答一句都不知道后面还有话,于是先按第一句
   *   改完、再按第二句改一遍、第三句再回头改前两句。用户看到的是它在原地打转。
   *
   * 拼成一条之后它一次看全,该怎么排顺序由它自己决定 —— 那本来就是它该做的判断。
   */
  takeQueued(): string | undefined {
    if (this.queued.length === 0) return undefined
    // 已经递进去的那几句**不再发一遍** —— 它们在上一轮里就被答过了
    const waiting = this.queued.filter((item) => !item.sent).map((item) => item.text)
    this.queued = []
    // 轮到它们了:排队那几行清空。紧接着 beginTurn 会把这一条扶正成 `▌` 那一行
    this.deps.chat.setQueued([])
    this.note = ""
    this.requestFrame()
    return waiting.length > 0 ? waiting.join("\n") : undefined
  }

  onResize(): void {
    this.deps.screen.resize()
    this.layout = this.measure()
    this.requestFrame()
  }

  /**
   * 要一帧。合并、限速,**空闲时一帧都不画**。
   *
   * ── 为什么要限速 ──
   * 原来是 queueMicrotask:同一个宏任务里的一串状态变化合成一帧,不同宏任务
   * 之间不合并。流式输出里每个 token 都是**自己的一个宏任务**,于是"合并"实际
   * 一次都没发生过 —— 一秒来 60 个 token 就是一秒 60 次全量合成。
   *
   * ★ 距上一帧还不到 FRAME_MS 就挂个定时器等到点,而不是当场画。少了这一下,
   *   限速形同虚设:每次都当场画,只是多绕了一层。
   *
   * 上一帧过去够久(打字、滚动、点一下,都是这一档)就走微任务当场画 ——
   * 按键回显不该为了省 CPU 而多等一个心跳。
   */
  requestFrame(): void {
    if (this.frameQueued || this.disposed) return
    this.frameQueued = true
    const wait = this.lastDraw + FRAME_MS - Date.now()
    if (wait <= 0) {
      queueMicrotask(() => this.runFrame())
      return
    }
    this.frameTimer = setTimeout(() => this.runFrame(), wait)
    // 一帧画面不值得让进程活着。退出时 dispose() 会把它清掉
    this.frameTimer.unref?.()
  }

  private runFrame(): void {
    this.frameQueued = false
    this.frameTimer = undefined
    if (this.disposed) return
    this.lastDraw = Date.now()
    this.draw()
  }

  // ───────────────────────────────────────────── 按键

  private readonly onKey = (key: Key): void => {
    if (key.name === "mouse") {
      // 模态框 / 挑选浮层开着时鼠标不做事:点一下就切走焦点会让人以为问题被忽略了
      if (!this.prompt && !this.picker && !this.upgrade && !this.copy && !this.settings) this.onMouse(key.mouse!)
      return this.requestFrame()
    }

    // ★ 升级浮层排在**所有**按键处理之前,包括 vitalKey(ctrl-c)。它是这个
    //   程序里唯一一段"正在替换自己"的时间,而 ctrl-c 在这里的原义(中断这一轮/
    //   退出)两件事都不该发生 —— 退出会留下一个下到一半的临时文件,而中断
    //   没有任何东西可中断。要停就按 esc,那条路会真的把下载 abort 掉
    if (this.upgrade) {
      const running = !this.finishedUpgrade()
      if (key.name === "escape") {
        if (running) this.cancelUpgrade?.()
        else this.closeUpgrade()
      } else if (!running && (key.name === "return" || key.name === "enter" || key.name === "space")) {
        this.closeUpgrade()
      }
      return this.requestFrame()
    }

    // 挑选浮层开着时它独占按键。也在 vitalKey 之前 —— esc 在这里是「不挑了」,
    // 而不是「清空输入框」;那两件事同时发生的话,取消一次会顺手把草稿删了。
    // 排在权限之后:权限是别人在等你答复,挑会话是你自己开的窗。
    if (this.picker && !this.prompt) {
      const result = pickKey(key)
      switch (result.kind) {
        case "move":
          this.picker.selected = Math.max(
            0,
            Math.min(this.picker.sessions.length - 1, this.picker.selected + result.delta),
          )
          break
        case "accept": {
          const chosen = this.picker.sessions[this.picker.selected]
          this.picker = undefined
          if (chosen) this.deps.onPickSession(chosen)
          break
        }
        case "cancel":
          this.picker = undefined
          break
        case "pass":
          break
      }
      return this.requestFrame()
    }

    // 复制单子。和挑会话同一档、同一条理由
    if (this.copy && !this.prompt) {
      const result = copyKey(key)
      switch (result.kind) {
        case "move":
          this.copy.selected = Math.max(0, Math.min(this.copy.targets.length - 1, this.copy.selected + result.delta))
          break
        case "accept": {
          const chosen = this.copy.targets[this.copy.selected]
          this.copy = undefined
          if (chosen) this.send(chosen)
          break
        }
        case "cancel":
          this.copy = undefined
          break
        case "pass":
          break
      }
      return this.requestFrame()
    }

    // 设置那一屏。和复制单子同一档 —— 用户自己开的窗,不是别人在等他答复。
    // ★ 排在 vitalKey 前面:esc 在这里是"退回上一层",而不是"清空输入框";
    //   正在往密钥格子里打字的时候更是如此,那一下 esc 是"这个 key 不粘了"
    if (this.settings && !this.prompt) {
      this.settingsKey(key)
      return this.requestFrame()
    }

    // 有模态框时它独占按键。**必须在 vitalKey 之前** —— 否则 Ctrl-C 会去
    // 中断 turn,而这条问题还挂着没人回答,那条工具就卡死了。
    if (this.prompt) {
      if (this.prompt.kind === "permission") {
        const result = promptKey(key, this.prompt.request.forbidAlways)
        if (result.kind === "decide") this.decide(result.decision)
        else if (result.kind === "scroll") this.promptScroll = Math.max(0, this.promptScroll + result.delta)
        else if (result.kind === "hint") this.promptHint = result.ime ? t.promptImeHint : t.promptKeyHint
        return this.requestFrame()
      }
      // 提问框:翻页归框外的这一层,别的键全归状态机(见 cli/ask.ts)。
      // pgup/pgdn 不能交给它 —— 那两个键在打字那一档要能翻内容,而状态机
      // 不知道框有多高
      if (key.name === "pageup" || key.name === "pagedown") {
        this.promptScroll = Math.max(0, this.promptScroll + (key.name === "pageup" ? -5 : 5))
        return this.requestFrame()
      }
      const result = this.prompt.state.key(key)
      if (result.kind === "answer") this.answered(result.answer)
      return this.requestFrame()
    }

    this.note = ""
    // 中断/退出永远先走,和焦点在哪无关。
    // 之前是按焦点分派的 —— 焦点落在文件树上时 Ctrl-C 直接被吞掉,
    // 一条跑飞的命令就再也停不下来。这类键不能有"当前不归我管"这种状态。
    if (this.vitalKey(key)) return this.requestFrame()
    this.armed = false
    // 补全要抢在 globalKey 前面:tab 在浮层开着时是「选中它」,不是「换面板」
    if (this.completionKey(key)) return this.requestFrame()
    if (this.globalKey(key)) return this.requestFrame()
    if (this.focus !== "input" && this.paneKey(key)) return this.requestFrame()

    // 焦点不在输入框时打了可见字符 —— 弹回输入框,字照收。
    // 「我打的字去哪了」是全屏界面最气人的事,这里堵死它。
    if (this.focus !== "input" && isTypable(key)) this.focus = "input"
    if (this.focus !== "input") return this.requestFrame()

    const action = this.deps.editor.handle(key, this.inputWidth())
    switch (action?.type) {
      case "submit": {
        // 尾部空白去掉。补全里那条「什么都不加」会让输入框停在 `/upgrade `
        // 上(命令名后面那个空格是补全补的),发出去连回显都带着它;而对
        // 没有参数的命令来说,`/help ` 这种更糟 —— 它匹配不上任何一条命令,
        // 会被当成一句话发给模型
        const text = action.text.replace(/\s+$/, "")
        if (text.length === 0) break
        if (this.busy) {
          // 先试着直接递进正在跑的这一轮。递进去的话它下一个轮次边界就看得见,
          // 不用等整件事做完(见 cli/main.ts 的 injectUser)
          const outcome = this.deps.onSubmitBusy?.(text)
          // 宿主当场办完了(只改设置的那几条命令):回执已经写过,这里什么都
          // 不用做 —— 入队的话它会在这一轮结束之后再执行一遍
          if (outcome === "handled") break
          const sent = outcome === true
          this.queued.push({ text, sent })
          // 状态行上那一格是「有几句在排」,而话本身要出现在「你说的话」那一段
          // 底下 —— 敲完就没了痕迹的话,用户第一反应是"我刚才那句去哪了"
          this.deps.chat.setQueued(this.queued.map((item) => item.text))
          const waiting = this.queued.filter((item) => !item.sent).length
          this.note = sent ? t.queuedLive : t.queuedNow(waiting)
        } else {
          this.deps.onSubmit(text)
        }
        break
      }
      case "interrupt":
      case "escape":
      case "eof":
        // 到不了这里 —— vitalKey 已经在前面截走了。留着这几个 case 是为了让
        // switch 穷尽所有分支,将来 EditorAction 加成员时编译器会提醒。
        break
    }
    this.requestFrame()
  }

  /**
   * 中断类按键。任何焦点下都生效,而且**优先于一切**。
   *
   * 返回 false 表示"这次不该我管",让它继续往下走 —— 唯一的例子是输入框里
   * 有内容时的 Ctrl-D:那是右删,不是退出。
   */
  private vitalKey(key: Key): boolean {
    const interrupt = key.ctrl && key.name === "c"
    const escape = key.name === "escape"
    const eof = key.ctrl && key.name === "d"
    if (!interrupt && !escape && !eof) return false

    if (this.busy && (interrupt || escape)) {
      this.deps.onCancel()
      this.armed = false
      return true
    }

    if (escape) {
      // 由近及远地退:补全浮层 → 侧栏浮层 → 回输入框 → 清输入
      if (this.completion()) {
        this.completeDismissed = this.deps.editor.text
        return true
      }
      if (this.overlay) {
        this.overlay = undefined
        this.focus = "input"
      } else if (this.focus !== "input") {
        this.focus = "input"
      } else {
        this.deps.editor.clear()
      }
      return true
    }

    if (eof) {
      if (this.focus === "input" && this.deps.editor.text.length > 0) return false // 右删
      this.deps.onExit()
      return true
    }

    // Ctrl-C
    if (this.deps.editor.text.length > 0) {
      this.deps.editor.clear()
      this.focus = "input"
      this.armed = false
      return true
    }
    if (this.armed) {
      this.deps.onExit()
      return true
    }
    this.armed = true
    this.note = t.pressCtrlCAgain
    return true
  }

  /**
   * 打开设置那一屏。`/setting` 和 `/model`(不带参数)都走它。
   *
   * @param page 直接落在哪一页。`/model` 传 "model" —— 让人先看一屏设置再自己
   *   找到模型那一行,是拿他的时间换我们少写一个参数。
   */
  openSettings(page = "root"): void {
    if (!this.deps.settings) return
    // 一摞从 root 起。直接落在子页时 root 也压在底下 —— esc 退回来看到的
    // 是整屏设置,而不是当场关掉。那一下 esc 的原义是"上一层"
    const stack = page === "root" ? [this.pageEntry("root")] : [this.pageEntry("root"), this.pageEntry(page)]
    this.settings = { stack }
    this.requestFrame()
  }

  /** 新翻开一页时光标落在哪。页自己说得出来(换模型那页要落在当前那个上) */
  private pageEntry(id: string): { id: string; selected: number } {
    return { id, selected: Math.max(0, this.deps.settings?.page(id)?.selected ?? 0) }
  }

  /** 设置那一屏的按键。开着的时候所有按键都归它 —— 见 onKey */
  private settingsKey(key: Key): void {
    const state = this.settings!
    const top = state.stack[state.stack.length - 1]!
    const page = this.deps.settings?.page(top.id)
    // 页没了(provider 被删掉了之类)就退一层。停在一页画不出来的东西上,
    // 用户看到的是一片空白加一个不响应的界面
    if (!page) {
      this.popSettings()
      return
    }
    const rows = flatRows(page)
    const result = settingsKey(key, { editing: state.typed !== undefined })
    const row = rows[top.selected]

    switch (result.kind) {
      case "move":
        top.selected = Math.max(0, Math.min(rows.length - 1, top.selected + result.delta))
        return
      case "cycle":
        // ★ 方向要传下去。丢了的话 ← 和 → 都往前转 —— 两个值的开关上看不出来,
        //   而信任(三个)、权限(三个)、语言(四个)上就是"倒不回去"
        if (row?.kind === "choice") this.changeSetting(page.id, row, result.delta)
        return
      case "enter":
        if (!row) return
        // 灰掉的那几行:说清为什么动不了。什么都不做的话,用户会一直按
        if (row.locked) {
          this.note = row.hint
          return
        }
        if (row.kind === "page") {
          state.stack.push(this.pageEntry(row.id))
          return
        }
        if (row.kind === "secret") {
          state.typed = ""
          return
        }
        // choice 行的回车 = 往前转一格。左右键改一样东西,而回车是这一屏上
        // 最顺手的那个键,不该在一半的行上没反应
        if (row.kind === "choice") this.changeSetting(page.id, row, 1)
        else this.applySetting(page.id, row.id, row.id)
        return
      case "back":
        // 打字的时候 esc 只取消这一格。整屏一起关掉的话,粘错一个字符
        // 的代价是从头再点一遍
        if (state.typed !== undefined) {
          state.typed = undefined
          return
        }
        this.popSettings()
        return
      case "close":
        this.settings = undefined
        return
      case "type":
        state.typed = (state.typed ?? "") + result.text
        return
      case "erase":
        state.typed = (state.typed ?? "").slice(0, -1)
        return
      case "submit": {
        const typed = state.typed ?? ""
        state.typed = undefined
        if (row) this.applySetting(page.id, row.id, typed)
        return
      }
      case "pass":
        return
    }
  }

  private changeSetting(pageID: string, row: Parameters<typeof cycleValue>[0], delta = 1): void {
    const next = cycleValue(row, delta)
    if (next !== undefined && next !== row.value) this.applySetting(pageID, row.id, next)
  }

  private applySetting(pageID: string, rowID: string, value: string): void {
    const result = this.deps.settings?.choose(pageID, rowID, value)
    if (!result) return
    // 出错也留在原地:一句在状态行上的红字 + 那一行还在,用户改得动;
    // 关掉这一屏的话他得从头再点一遍才知道自己错在哪
    this.note = result.error ?? result.note ?? ""
    if (result.back) this.popSettings()
    // 改完可能连布局都变了(侧栏、视图),重量一次
    this.layout = this.measure()
  }

  private popSettings(): void {
    const state = this.settings
    if (!state) return
    if (state.stack.length > 1) state.stack.pop()
    else this.settings = undefined
  }

  /**
   * 打开复制单子。
   *
   * 单子是**开的时候现算**的,不留在状态里:回答还在流式往外冒的时候按下去,
   * 算出来的就是"到这一刻为止"的那一段 —— 而那正是用户按这个键时看着的东西。
   */
  private openCopy(): void {
    const targets = this.deps.copyTargets?.() ?? []
    if (targets.length === 0) {
      this.note = t.copyEmpty
      return
    }
    this.copy = { targets, selected: 0 }
  }

  /**
   * 发出去。
   *
   * 序列走 Screen.passthrough:它不画任何东西,但 stdout 归合成器管。
   * 按键处理是同步的,所以这一下必然落在两帧之间。
   */
  private send(target: CopyTarget): void {
    // ★ 走 Screen.passthrough,**不是**裸的 stdout。合成器是 stdout 的持有者,
    //   绕过它直接写会让前台缓冲和真实屏幕分叉,之后每一帧的差分都对着错的
    //   基准算(README「四条规矩」第 2 条)。OSC 52 不产出任何可见字符,
    //   所以它是那扇门今天唯一的用户
    const result = writeClipboard(target.text, { write: (seq) => this.deps.screen.passthrough(seq) })
    this.note = t.copySent(target.label, humanBytes(target.text))
    // 夹断过就必须说。默认它成功了、结果只拿到半段,是最坏的一种"成功"
    if (result.clipped) this.note = `${this.note} · ${t.copyClipped(`${Math.round(result.bytes / 1024)} kB`)}`
  }

  /**
   * 画面花了,从头来过。
   *
   * 两件事一起做:屏幕缓冲作废重画(Screen.resync),终端模式重新宣告
   * (Keyboard.reassert)—— 用户按这个键时说的是"整个不对劲",而不是
   * "只有像素不对劲"。
   */
  private repaint(): void {
    this.deps.screen.resync()
    this.deps.keyboard.reassert()
    this.note = t.screenRepainted
  }

  private cycleMode(): void {
    const mode = nextMode(this.deps.mode())
    this.deps.setMode(mode)
    this.note = t.permissionSwitched(modeInfo(mode).label, modeInfo(mode).hint)
  }

  /**
   * 当前该显示的补全。**每次都重算**,因为它只取决于输入框的内容和光标。
   *
   * 顺带维护选中项:候选集变了就拨回第一条 —— 不然从 `/p` 打到 `/pe` 时,
   * 选中项会停在一个已经不在列表里的位置上。
   */
  private completion(): Completion | undefined {
    if (this.focus !== "input" || this.prompt || this.overlay) return undefined
    const editor = this.deps.editor
    if (this.completeDismissed === editor.text) return undefined
    const found = complete(editor.text, editor.cursor, this.deps.files)
    if (!found) {
      this.completeSignature = ""
      return undefined
    }
    const signature = found.items.map((item) => item.value).join("|")
    if (signature !== this.completeSignature) {
      this.completeSignature = signature
      this.completeIndex = 0
    }
    if (this.completeIndex >= found.items.length) this.completeIndex = 0
    return found
  }

  /** 浮层开着时它先挑走几个键。挑不走的照常落到编辑器。 */
  private completionKey(key: Key): boolean {
    const found = this.completion()
    if (!found) return false
    // 「输入框里那一段」和高亮那条一模一样时,回车不再是补全 —— 见 completionKey
    const typed = this.deps.editor.text.slice(found.from, found.to)
    const result = completionKey(key, { exact: typed === found.items[this.completeIndex]?.value })
    switch (result.kind) {
      case "move": {
        const total = found.items.length
        this.completeIndex = (this.completeIndex + result.delta + total) % total
        return true
      }
      case "accept": {
        const item = found.items[this.completeIndex]
        if (!item) return false
        this.deps.editor.setText(apply(this.deps.editor.text, found, item))
        return true
      }
      case "dismiss":
        // 到不了这里 —— esc 已经被 vitalKey 截走了。留着是因为 completionKey
        // 是个纯函数,它的契约里就有这一条,换个宿主(--plain)照样用
        this.completeDismissed = this.deps.editor.text
        return true
      case "pass":
        return false
    }
  }

  /** 不管焦点在哪都生效的键。 */
  private globalKey(key: Key): boolean {
    if (key.name === "tab") {
      // shift-tab 从「上一个面板」改成「换权限模式」:面板只有三四个,tab
      // 转一圈很快;而权限模式是每天要动好几次、又必须一眼看得见的东西
      if (key.shift) {
        this.cycleMode()
        return true
      }
      this.focus = nextPane(this.focus, this.layout)
      return true
    }
    if (!key.ctrl) return false
    switch (key.name) {
      case "b":
        this.toggleSide("tree")
        return true
      case "]":
        this.toggleSide("detail")
        return true
      case "p":
        this.togglePanel("plan")
        return true
      case "l":
        // ★ ctrl-l 是**重画**,不是别的。在终端里这个键的含义几十年没变过
        //   (readline、vim、less、tmux 全是它),而一个画面已经花了的人会
        //   反射性地按它 —— 那一下按下去要是切换了「锁住右栏」,他得到的是
        //   一个更花的画面加一个他没打算改的状态。
        //
        //   这也是删掉那个 20Hz 兜底心跳的前提:不再有一个替所有人永远开着
        //   的定时器,换成一条用户自己按得到的路。见 cli/main.ts 那颗星。
        this.repaint()
        return true
      case "o":
        this.detail.toggleLock()
        this.note = this.detail.lockedToContent ? t.detailLocked : t.detailFollows
        return true
      case "y":
        this.openCopy()
        return true
      case "r":
        this.tree.reload()
        // 文件索引跟着一起重扫:ctrl-r 的意思是「盘上变了,重新看一遍」,
        // 而补全候选和文件树看的是同一个盘
        this.deps.reindex?.()
        void this.tree.refreshGit().then(() => this.requestFrame())
        return true
      default:
        return false
    }
  }

  /** 焦点在某一栏时的浏览键。 */
  private paneKey(key: Key): boolean {
    const target = this.overlay ?? this.focus
    if (target === "tree") {
      switch (key.name) {
        case "up":
          this.tree.move(-1)
          return true
        case "down":
          this.tree.move(1)
          return true
        case "pageup":
          this.tree.move(-10)
          return true
        case "pagedown":
          this.tree.move(10)
          return true
        case "left":
          this.tree.collapse()
          return true
        case "right":
        case "enter": {
          const path = this.tree.activate()
          if (path) this.detail.set({ kind: "file", path })
          return true
        }
        default:
          return false
      }
    }
    if (target === "chat") {
      switch (key.name) {
        case "up":
          this.deps.chat.scrollBy(1)
          return true
        case "down":
          this.deps.chat.scrollBy(-1)
          return true
        case "pageup":
          this.deps.chat.scrollPage(1)
          return true
        case "pagedown":
          this.deps.chat.scrollPage(-1)
          return true
        case "home":
          this.deps.chat.scrollToTop()
          return true
        case "end":
          this.deps.chat.scrollToBottom()
          return true
        default:
          return false
      }
    }
    if (target === "plan") {
      switch (key.name) {
        case "up":
          this.plan.scrollBy(-1)
          return true
        case "down":
          this.plan.scrollBy(1)
          return true
        case "pageup":
          this.plan.scrollBy(-5)
          return true
        case "pagedown":
          this.plan.scrollBy(5)
          return true
        default:
          return false
      }
    }
    if (target === "detail") {
      switch (key.name) {
        case "up":
          this.detail.scrollBy(-1)
          return true
        case "down":
          this.detail.scrollBy(1)
          return true
        case "pageup":
          this.detail.scrollBy(-10)
          return true
        case "pagedown":
          this.detail.scrollBy(10)
          return true
        case "home":
          this.detail.scrollToTop()
          return true
        default:
          return false
      }
    }
    return false
  }

  private onMouse(event: MouseEvent): void {
    const inside = (rect: { x: number; y: number; width: number; height: number } | undefined) =>
      rect !== undefined &&
      event.x >= rect.x &&
      event.x < rect.x + rect.width &&
      event.y >= rect.y &&
      event.y < rect.y + rect.height

    if (event.button === "wheel-up" || event.button === "wheel-down") {
      const amount = event.button === "wheel-up" ? 3 : -3
      if (inside(this.layout.tree)) this.tree.scrollBy(-amount)
      else if (inside(this.layout.plan)) this.plan.scrollBy(-amount)
      else if (inside(this.layout.detail)) this.detail.scrollBy(-amount)
      else this.deps.chat.scrollBy(amount)
      return
    }

    // 松开就结束拖动。**必须先于别的判断** —— 松开时鼠标可能已经离开面板了
    if (event.action === "release") {
      this.dragging = undefined
      return
    }
    // 按住不放地拖:滚动条一旦抓住,后面的移动就归它,哪怕指针跑出了面板。
    // 不这么做的话,手稍微抖出去一列,拖动就断了
    if (this.dragging && (event.action === "drag" || event.action === "press")) {
      return this.scrub(this.dragging, event.y)
    }
    if (event.action !== "press" || event.button !== "left") return

    // 收起来那几栏留在原地的轨:点它(或者顶上那个 `[+]`)展开回来
    for (const rail of this.layout.rails) {
      const onTop = event.y === this.layout.rowTop && event.x >= rail.x && event.x < rail.x + rail.width
      if (onTop || inside(rail)) return this.togglePanel(rail.panel)
    }
    // 活动区那条横线右端的复制牌子。排在对话栏的滚动/聚焦判断**前面** ——
    // 它画在那一栏里,后面那些判断会先把这一下当成"点了对话栏"
    const chip = this.copyHit
    if (chip && event.y === chip.y && event.x >= chip.x && event.x < chip.x + chip.width) {
      return this.openCopy()
    }
    // 状态行上的 `[ctrl-b files]` 片:点一下把那一栏叫回来
    if (event.y === this.layout.statusRow) {
      for (const hit of this.statusHits) {
        if (event.x < hit.x || event.x >= hit.x + hit.width) continue
        return hit.action === "copy" ? this.openCopy() : this.togglePanel(hit.action)
      }
      return
    }
    // 标题栏右端那个 `[-]`,以及整条标题。按钮是画出来的、看得见的那个入口;
    // 整条标题也认,是因为点得准不准不该决定功能能不能用
    if (event.y === this.layout.rowTop) {
      for (const hit of this.titleHits) {
        if (event.x < hit.x || event.x >= hit.x + hit.width) continue
        return this.togglePanel(hit.panel)
      }
      return
    }
    // 同理:计划那条横线(按钮在右端)。
    // ★ 范围按**它自己那一栏**算。它一度是按左栏算的(`event.x <= width + 1`),
    //   搬进中间栏之后那个范围就错到隔壁去了 —— 现象是右端那个 `[+]` 点了完全
    //   没反应,而点文件树反倒会把计划收掉。收起来时面板没了,范围要退回它
    //   所在的那一栏(chat),不能退回 0
    if (this.layout.planRule >= 0 && event.y === this.layout.planRule) {
      const rect = this.layout.plan ?? this.layout.chat
      if (event.x >= rect.x - 1 && event.x <= rect.x + rect.width) return this.togglePanel("plan")
    }

    // 点在滚动条那一列上:抓住它。要排在面板命中判断**前面** ——
    // 否则点右边框内侧那一格会被当成"点了文件树的某一行"
    for (const pane of SCROLLABLE) {
      const rect = this.rectOf(pane)
      if (!inside(rect) || event.x !== rect!.x + rect!.width - 1) continue
      this.focus = pane
      this.dragging = pane
      return this.scrub(pane, event.y)
    }

    if (inside(this.layout.plan)) {
      this.focus = "plan"
      return
    }
    if (inside(this.layout.tree)) {
      this.focus = "tree"
      if (this.tree.clickAt(event.y - this.layout.tree!.y)) {
        const node = this.tree.selectedNode
        if (node?.dir) this.tree.toggle(node)
        else if (node) this.detail.set({ kind: "file", path: node.path })
      }
      return
    }
    if (inside(this.layout.detail)) {
      this.focus = "detail"
      return
    }
    if (inside(this.layout.chat)) {
      this.focus = "chat"
      return
    }
    if (event.y >= this.layout.input.y && event.y < this.layout.input.y + this.layout.input.height) {
      this.focus = "input"
    }
  }

  /**
   * 把「鼠标在屏幕第几行」翻译成「那一栏滚到哪」。
   *
   * 行号夹在面板里:拖着拖着指针滑出上下边是常态,那时候该停在两头,
   * 而不是把滚动量算成负数或者越过末尾。
   */
  private scrub(pane: ScrollablePane, screenRow: number): void {
    const rect = this.rectOf(pane)
    if (!rect) return
    const row = Math.max(0, Math.min(rect.height - 1, screenRow - rect.y))
    if (pane === "tree") this.tree.scrubTo(row, rect.height)
    else if (pane === "plan") this.plan.scrubTo(row, rect.width, rect.height)
    else if (pane === "detail") this.detail.scrubTo(row, rect.width, rect.height)
    else this.deps.chat.scrubTo(row, rect.width, rect.height)
  }

  private rectOf(pane: ScrollablePane) {
    if (pane === "chat") return this.layout.chat
    if (pane === "tree") return this.layout.tree
    if (pane === "plan") return this.layout.plan
    return this.layout.detail
  }

  /**
   * 收起 / 展开一块面板。
   *
   * 左右两栏走 toggleSide(它们可能已经被窄屏自动折叠,那时候按键的含义是
   * 「临时叫回来盖一下」而不是「打开」);计划只是左栏里的一块,没有那套浮层
   * 语义,直接开关。
   */
  private togglePanel(which: PanelName): void {
    if (which === "plan") {
      if (this.hidden.has(which)) this.hidden.delete(which)
      else {
        this.hidden.add(which)
        if (this.focus === which) this.focus = "input"
      }
      this.layout = this.measure()
      return
    }
    this.toggleSide(which)
  }

  private toggleSide(which: SideName): void {
    // 被布局折叠掉的栏:按键是"临时叫回来盖一下",不是"打开"
    if (this.layout.collapsed.includes(which)) {
      this.overlay = this.overlay === which ? undefined : which
      this.focus = this.overlay ? which : "input"
      return
    }
    if (this.hidden.has(which)) this.hidden.delete(which)
    else {
      this.hidden.add(which)
      if (this.focus === which) this.focus = "input"
    }
    this.layout = this.measure()
    // 记在这个文件夹名下。开场那张卡片问的就是这一件事,而在界面上按出来的
    // 答案和在卡片上选的答案是同一件事 —— 只有一边被记住的话,用户会觉得
    // "我明明关掉了它下次又回来了"
    this.deps.onPanelsChanged?.(this.panelsVisible)
  }

  /**
   * 侧栏这一格该存 true 还是 false。
   *
   * ★ 两栏一个键。卡片上问的是一个问题("要不要侧栏"),而界面上是两个开关 ——
   *   落盘时的规则是**留下任意一栏就算开着**。这条规则说得出口:"下次进来,
   *   只要你走的时候还留着一栏,侧栏就还在。"
   */
  get panelsVisible(): boolean {
    return !this.hidden.has("tree") || !this.hidden.has("detail")
  }

  /**
   * 两栏一起开 / 一起关。`/setting` 那一行走它。
   *
   * ★ 和 ctrl-b / ctrl-] 是**同一个真值源**:那两个键改的也是这个 hidden 集合,
   *   而落盘那一下由 toggleSide 那边统一做。分成两套状态的话,在设置里关掉
   *   之后按 ctrl-b,第一下会没反应
   */
  setPanels(visible: boolean): void {
    if (visible) this.hidden.delete("tree"), this.hidden.delete("detail")
    else {
      this.hidden.add("tree")
      this.hidden.add("detail")
      if (this.focus === "tree" || this.focus === "detail") this.focus = "input"
    }
    this.overlay = undefined
    this.layout = this.measure()
    this.deps.onPanelsChanged?.(this.panelsVisible)
    this.requestFrame()
  }

  // ───────────────────────────────────────────── 画

  private measure(): Layout {
    const screen = this.deps.screen
    const rows = renderBox({
      text: this.deps.editor.text,
      cursor: this.deps.editor.cursor,
      width: Math.max(20, screen.width - 2),
      style: plainBoxStyle,
      maxRows: Math.max(1, Math.floor(screen.height / 3)),
    }).lines.length
    // 计划的真值源在 ChatModel 上(它是事件流的投影)。面板每次量之前同步一次,
    // 因为「要几行」是布局的输入 —— 晚一帧同步,那一帧的左栏就按旧清单分高度
    this.plan.set(this.deps.chat.plan)
    // 后台任务同理:要几行是布局的输入,晚一帧同步那一帧就按旧的分高度
    this.jobs.set(this.deps.jobs?.() ?? [])
    this.agents.set(this.deps.agents?.() ?? [])
    this.noticeFlow()
    const base = {
      width: screen.width,
      height: screen.height,
      // renderBox 自带上下边框,而输入区已经在大框里了,所以减掉那两行
      inputHeight: Math.max(1, rows - 2),
      // 留的行数要和真会画出来的对上,见 completionRows 上那颗星
      completionHeight: completionRows(this.completion()?.items.length ?? 0),
      // 计划现在长在中间栏里,所以按**中间栏**的宽度量要几行 —— 按左栏量的话,
      // 宽屏上会多要出好几行(同一条目在宽栏里折得更少)
      planRows: this.plan.empty ? 0 : this.plan.rowsNeeded(Math.max(8, chatInner(screen.width))),
      // 和计划那一栏同一条理由:它长在中间栏里,所以要按**中间栏**的宽度量 ——
      // 方格模式下宽度直接决定分几列,也就直接决定要几行(见 panes/agents.ts)
      agentRows: this.agents.rowsNeeded(Math.max(8, chatInner(screen.width))),
      jobRows: this.jobs.rowsNeeded(),
      hidden: this.hidden,
    }
    return computeLayout(base)
  }



  private inputWidth(): number {
    return Math.max(8, this.layout.input.width - 4)
  }

  private draw(): void {
    const screen = this.deps.screen
    if (screen.resize()) this.layout = this.measure()
    else this.layout = this.measure()
    const layout = this.layout
    screen.begin()

    // 外框
    const titles: Array<{ x: number; width: number; text: string; pane: PaneName; collapsible?: boolean }> = []
    this.titleHits = []
    if (layout.tree) {
      titles.push({ x: layout.tree.x, width: layout.tree.width, text: this.treeTitle(), pane: "tree", collapsible: true })
      this.titleHits.push({ x: layout.tree.x, width: layout.tree.width, panel: "tree" })
    }
    titles.push({ x: layout.chat.x, width: layout.chat.width, text: this.deps.chat.title, pane: "chat" })
    if (layout.detail) {
      titles.push({
        x: layout.detail.x,
        width: layout.detail.width,
        text: (this.detail.lockedToContent ? "🔒 " : "") + this.detail.title,
        pane: "detail",
        collapsible: true,
      })
      this.titleHits.push({ x: layout.detail.x, width: layout.detail.width, panel: "detail" })
    }
    const chromeInput = { layout, titles, focus: this.focus }
    /** 上下框之间一共多少行。各栏可能被横着切开,所以谁的 height 都不能当它用 */
    const bodyHeight = layout.rowBottom - layout.rowTop - 1
    screen.blit({ x: 0, y: layout.rowTop, width: layout.width, height: 1 }, [topBorder(chromeInput)])
    screen.blit(
      // ★ 高度用的是**整片 body**(现在一直到下框),不是 chat.height。
      //   中间栏被工具看板和输入切短之后两者不再相等,拿 chat.height 画的话,
      //   下半截的竖线一根都不会出现 —— 现象是"面板底下的边框断了"
      { x: 0, y: layout.rowTop + 1, width: layout.width, height: bodyHeight },
      Array.from({ length: bodyHeight }, () => bodyRow(layout)),
    )
    screen.blit({ x: 0, y: layout.rowBottom, width: layout.width, height: 1 }, [bottomBorder(layout)])

    // 面板内容
    if (layout.tree) {
      screen.blit(layout.tree, this.tree.render(layout.tree.width, layout.tree.height, this.focus === "tree"))
    }
    if (layout.planRule >= 0) {
      // 和看板那条一样:跨中间栏,两端各多画一列盖住竖线 —— 它要顶到两边
      // 才读得出是"换了一块面板",见 chrome.panelDivider
      const width = (layout.plan?.width ?? layout.chat.width) + 2
      const at = (layout.plan?.x ?? layout.chat.x) - 1
      screen.blit({ x: at, y: layout.planRule, width, height: 1 }, [
        panelDivider(width, t.planTitle, this.plan.progress, this.focus === "plan", layout.plan === undefined),
      ])
      if (layout.plan) screen.blit(layout.plan, this.plan.render(layout.plan.width, layout.plan.height))
    }
    if (layout.agents) {
      const width = layout.agents.width + 2
      const at = layout.agents.x - 1
      screen.blit({ x: at, y: layout.agentRule, width, height: 1 }, [
        // 和后台那一块同一条规矩:不给收起按钮,它自己会消失
        panelDivider(width, t.agentsTitle, this.agents.note, false, false, false),
      ])
      screen.blit(layout.agents, this.agents.render(layout.agents.width, layout.agents.height))
    }
    if (layout.jobs) {
      const width = layout.jobs.width + 2
      const at = layout.jobs.x - 1
      screen.blit({ x: at, y: layout.jobRule, width, height: 1 }, [
        // ★ 不给收起按钮:这一块**自己会消失**(最后一个任务跑完、再过几秒就没了),
        //   不需要一个手动开关。而一个点了没反应的 `[-]` 比没有按钮糟得多
        panelDivider(width, t.jobsTitle, this.jobs.note, false, false, false),
      ])
      screen.blit(layout.jobs, this.jobs.render(layout.jobs.width, layout.jobs.height))
    }
    screen.blit(layout.chat, this.chatLines(layout))
    // ★ 必须在**画完对话栏之后、画状态行之前**取。这一帧对话栏接没接手那块
    //   牌子,只有它自己知道(stream 视图没有那条横线,窄了也会放不下),而
    //   状态行要按这个结果决定自己画不画 —— 顺序错了就是两处各画一块
    const chipAt = this.deps.chat.copyHit
    this.copyHit = chipAt
      ? { x: layout.chat.x + chipAt.x, y: layout.chat.y + chipAt.row, width: chipAt.width }
      : undefined
    // 输入区上沿那条线,只跨中间栏 —— 两端各多画一列盖住竖线,才读得出
    // "这一栏底下又切了一刀"。线上挂着上下文量表:那是**打字之前**要知道的事
    const ruleWidth = layout.input.width + 2
    const context = this.deps.context?.()
    screen.blit({ x: layout.input.x - 1, y: layout.inputRule, width: ruleWidth, height: 1 }, [
      inputDivider(
        ruleWidth,
        context ? contextRule(context, Math.max(0, ruleWidth - 8)) : "",
        this.flowChip(),
      ),
    ])
    if (layout.detail) {
      screen.blit(layout.detail, this.detail.render(layout.detail.width, layout.detail.height))
    }

    // 输入框(不画自己的边框,大框已经有了)
    const box = renderBox({
      text: this.deps.editor.text,
      cursor: this.deps.editor.cursor,
      width: layout.input.width + 2,
      style: plainBoxStyle,
      placeholder: t.placeholder,
      maxRows: layout.input.height,
    })
    const body = box.lines.slice(1, -1).map((line) => line.slice(1, -1))
    screen.blit(layout.input, body)
    this.drawCompletion(layout)

    if (layout.statusRow >= 0) {
      // 一条横穿全宽的线 + 框里那一行字。竖线在线上收口成 ┴,底下不再分栏
      screen.blit({ x: 0, y: layout.statusRule, width: layout.width, height: 1 }, [statusDivider(layout)])
      screen.blit({ x: 0, y: layout.statusRow, width: layout.width, height: 1 }, [
        statusFrame(layout.width, this.statusLine(layout)),
      ])
    }

    // 收起来那几栏的轨:竖着写栏名(三个 [+] 长得一模一样,不写就只能靠位置猜),
    // 整条都能点,不必去够顶上那三格
    for (const rail of layout.rails) {
      screen.blit(rail, railBody(rail.width, rail.height, railLabel(rail.panel)))
    }

    // overlay 盖在最上面
    if (this.overlay) this.drawOverlay(layout)
    if (this.picker) this.drawPicker(layout)
    if (this.copy) this.drawCopy(layout)
    if (this.settings) this.drawSettings(layout)
    // 模态框比什么都上面
    if (this.prompt) this.drawPrompt(layout)
    // 升级框画在最后 = 盖在最上面,和它独占按键是同一件事的两半
    if (this.upgrade) this.drawUpgrade(layout)

    // 模态框开着的时候不显示输入光标 —— 光标在别处闪会让人以为可以打字
    if (!this.prompt && this.focus === "input") {
      screen.setCursor(layout.input.x + box.cursor.col - 1, layout.input.y + box.cursor.row - 1)
    }
    screen.end()
    this.scheduleRetire()
  }

  /**
   * 会自己消失的那几块:到点了叫一次重绘。
   *
   * ★ 空闲时界面是**完全不重绘**的(见 startTimer:那个 100ms 的表只在忙的时候
   *   转)。所以「跑完六秒后消失」「计划做完十五秒后消失」这种事,不安排一次
   *   一次性的重绘就永远不会发生 —— 现象是那一块一直挂在那儿,直到用户随便
   *   按个键才突然不见,看着像个 bug。
   */
  private scheduleRetire(): void {
    if (this.retireTimer) {
      clearTimeout(this.retireTimer)
      this.retireTimer = undefined
    }
    // 子 agent 那一块还要它走秒表:每秒一次(见 panes/agents.ts 的 retireAt)
    const times = [this.deps.chat.planRetireAt, this.jobs.retireAt(), this.agents.retireAt()].filter(
      (at) => at > 0,
    )
    if (times.length === 0) return
    // 多 50ms 再画,免得算在边界上又画一帧什么都没变
    const delay = Math.max(50, Math.min(...times) - Date.now() + 50)
    this.retireTimer = setTimeout(() => {
      this.retireTimer = undefined
      this.requestFrame()
    }, delay)
    this.retireTimer.unref?.()
  }

  /**
   * 候选区。**它不是浮层** —— 布局给它留了行,就在输入框正上方。
   *
   * 一度是盖在对话上的浮层,那是错的位置:它讲的是输入框里那半句话,和对话、
   * 和文件树都没关系。挡住的内容跟它毫无关联,眼睛还得在两个地方之间跳。
   */
  private drawCompletion(layout: Layout): void {
    const rect = layout.completion
    if (!rect) return
    const found = this.completion()
    if (!found) return
    const view = renderCompletion(found, this.completeIndex, rect.width)
    this.deps.screen.blit(rect, view.lines.slice(0, rect.height))
  }

  private drawPrompt(layout: Layout): void {
    const pending = this.prompt!
    const bodyHeight = layout.rowBottom - layout.rowTop - 1
    const view =
      pending.kind === "permission"
        ? renderPrompt(pending.request, this.promptScroll, layout.width, bodyHeight, this.promptHint)
        : renderQuestion(pending.state, this.promptScroll, layout.width, bodyHeight)
    // 居中。靠上一点点 —— 正中间会盖住对话里刚打出来的那几行上下文
    const x = Math.max(0, Math.floor((layout.width - view.width) / 2))
    const y = Math.max(layout.rowTop + 1, layout.rowTop + 1 + Math.floor((bodyHeight - view.height) / 3))
    this.deps.screen.blit({ x, y, width: view.width, height: view.height }, view.lines)
  }

  /**
   * 文件树的标题写**工作区的名字**,不写「files」。
   *
   * 那一栏画的就是这个目录,而"files"是句废话 —— 底下摆着一棵文件树,没人会
   * 以为那是别的东西。换成名字之后,这一栏顺带回答了"我开在哪个仓库上"。
   * 根目录是 `/`(basename 为空)时才退回通用词。
   */
  private treeTitle(): string {
    return this.deps.workspace.name || t.paneFiles
  }

  /**
   * 会话挑选浮层。盖在对话上,居中偏上。
   *
   * 宽度尽量给足:这里每一行都是一句话的开头,截短了就分不出哪场是哪场 ——
   * 而"分得出"正是这个界面存在的唯一理由。
   */
  private drawPicker(layout: Layout): void {
    const picker = this.picker!
    const width = Math.max(24, Math.min(layout.width - 4, 88))
    const bodyHeight = layout.rowBottom - layout.rowTop - 1
    // 边框 2 行 + 键位提示 1 行 +(截断时的)+N 一行
    const rows = Math.max(1, Math.min(picker.sessions.length + 2, bodyHeight - 3))
    const lines = renderList(picker.sessions, {
      selected: picker.selected,
      width: width - 2,
      height: rows,
      now: picker.now,
      currentID: picker.currentID,
      title: false,
    })
    const height = Math.min(bodyHeight, lines.length + 2)
    const x = Math.max(0, Math.floor((layout.width - width) / 2))
    const y = Math.max(layout.rowTop + 1, layout.rowTop + 1 + Math.floor((bodyHeight - height) / 3))
    this.deps.screen.blit({ x, y, width, height }, overlayFrame(width, height, t.resumeTitle))
    this.deps.screen.blit(
      { x: x + 1, y: y + 1, width: width - 2, height: height - 2 },
      lines.slice(0, Math.max(0, height - 2)),
    )
  }

  /**
   * 复制单子。和会话浮层同一个壳,但**窄一些**:这里每行右边那个字节数才是
   * 要对齐的东西,拉到 88 列的话中间会空出一大片,反而不好扫。
   */
  private drawCopy(layout: Layout): void {
    const copy = this.copy!
    const width = Math.max(28, Math.min(layout.width - 4, 68))
    const bodyHeight = layout.rowBottom - layout.rowTop - 1
    const listRows = Math.max(1, Math.min(copy.targets.length, bodyHeight - 4))
    // 保证选中项在窗口里 —— 六个代码块加三条,窄终端上装不下
    const from = Math.max(0, Math.min(copy.selected - listRows + 1, copy.targets.length - listRows))
    const lines = copy.targets
      .slice(from, from + listRows)
      .map((target, index) => copyRow(target, { width: width - 2, selected: from + index === copy.selected }))
    lines.push("", theme.dim(` ${t.copyKeys}`))

    const height = Math.min(bodyHeight, lines.length + 2)
    const x = Math.max(0, Math.floor((layout.width - width) / 2))
    const y = Math.max(layout.rowTop + 1, layout.rowTop + 1 + Math.floor((bodyHeight - height) / 3))
    this.deps.screen.blit({ x, y, width, height }, overlayFrame(width, height, t.copyTitle))
    this.deps.screen.blit(
      { x: x + 1, y: y + 1, width: width - 2, height: height - 2 },
      lines.slice(0, Math.max(0, height - 2)),
    )
  }

  /**
   * 设置那一屏。**比别的浮层都大** —— 它要一次摊开十几项,而"一次看得全"
   * 正是它存在的理由;做成一个要上下翻的小窗,就退回了逐条敲命令那种体验。
   */
  private drawSettings(layout: Layout): void {
    const state = this.settings!
    const top = state.stack[state.stack.length - 1]!
    const page = this.deps.settings?.page(top.id)
    if (!page) return
    const width = Math.max(36, Math.min(layout.width - 4, 80))
    const bodyHeight = layout.rowBottom - layout.rowTop - 1
    const height = Math.max(8, Math.min(bodyHeight, 26))
    const x = Math.max(0, Math.floor((layout.width - width) / 2))
    const y = Math.max(layout.rowTop + 1, layout.rowTop + 1 + Math.floor((bodyHeight - height) / 3))
    this.deps.screen.blit({ x, y, width, height }, overlayFrame(width, height, page.title))
    this.deps.screen.blit(
      { x: x + 1, y: y + 1, width: width - 2, height: height - 2 },
      renderSettings(page, {
        selected: top.selected,
        width: width - 2,
        height: height - 2,
        ...(state.typed !== undefined ? { typed: state.typed } : {}),
      }),
    )
  }

  private finishedUpgrade(): boolean {
    const phase = this.upgrade?.phase
    return phase === "done" || phase === "failed" || phase === "cancelled" || phase === "current"
  }

  private closeUpgrade(): void {
    this.upgrade = undefined
    this.cancelUpgrade = undefined
    this.requestFrame()
  }

  /**
   * 升级浮层。居中,比会话挑选窄 —— 它只有几行字和一条进度条,给足宽度
   * 反而让那条进度条横跨整个屏幕,看着像在装什么了不得的东西。
   */
  private drawUpgrade(layout: Layout): void {
    const width = Math.max(32, Math.min(layout.width - 4, 64))
    const lines = renderUpgrade(this.upgrade!, width - 2)
    const height = Math.min(layout.rowBottom - layout.rowTop - 1, lines.length + 2)
    const x = Math.max(0, Math.floor((layout.width - width) / 2))
    const bodyHeight = layout.rowBottom - layout.rowTop - 1
    const y = Math.max(layout.rowTop + 1, layout.rowTop + 1 + Math.floor((bodyHeight - height) / 3))
    this.deps.screen.blit({ x, y, width, height }, overlayFrame(width, height, t.upgradeTitle))
    this.deps.screen.blit(
      { x: x + 1, y: y + 1, width: width - 2, height: height - 2 },
      lines.slice(0, Math.max(0, height - 2)),
    )
  }

  private drawOverlay(layout: Layout): void {
    const rect = overlayRect(this.overlay!, layout)
    const title = this.overlay === "tree" ? this.treeTitle() : this.detail.title
    this.deps.screen.blit(rect, overlayFrame(rect.width, rect.height, title))
    const inner = { x: rect.x + 1, y: rect.y + 1, width: rect.width - 2, height: rect.height - 2 }
    this.deps.screen.blit(
      inner,
      this.overlay === "tree"
        ? this.tree.render(inner.width, inner.height, true)
        : this.detail.render(inner.width, inner.height),
    )
  }

  /** 工具行上那个转圈。一行一个,小人只在活动区和状态行上出现 */
  private get spinner(): string {
    return SPINNER[this.tick % SPINNER.length] ?? ""
  }

  private chatLines(layout: Layout): string[] {
    return this.deps.chat.render({
      width: layout.chat.width,
      height: layout.chat.height,
      busy: this.busy,
      spinner: this.spinner,
      tick: this.tick,
      // 模态框可能盖不住这一栏的底部,而"卡在你身上了"这件事必须在**动的那个
      // 东西**上说出来 —— 用户的眼睛在等待期间就盯着它
      waiting: this.prompt !== undefined,
      // 被浮层盖住的右栏不算「看得见」—— 那时候 diff 得由看板自己就地展开
      detailVisible: layout.detail !== undefined && this.overlay === undefined,
      // 计划已经有地方待了:要么画在左下角,要么用户自己把它收了。
      // 后者不能漏 —— 按 ctrl-p 收掉之后它跑到中间栏去,那不叫收起来
      planElsewhere: layout.plan !== undefined || this.hidden.has("plan"),
      // 牌子在这里就上好色 —— 面板只管把它摆在横线右端,不认识这套配色。
      // 和状态行上那几个片同一个画法(方括号 = 可以点),所以它们看起来是
      // 同一类东西,而它们确实是
      ...(this.deps.copyTargets ? { copyChip: recallChip(t.copyChip) } : {}),
    })
  }

  /**
   * 状态行。
   *
   * ── 收起来的那几块在这里变成**能点的片** ──
   * `[ctrl-b files]` 同时说了两件事:按这个键,或者直接点这里。方括号是终端里
   * 「可以点」的通用暗号,而键名留着是因为 `--no-mouse` 和不吃鼠标的终端下
   * 它是唯一的出路 —— 一个只能点的按钮在那些环境里等于没有。
   */
  /**
   * 输入框上沿那条线左端那块牌子:agentflow 开着的话它一直在。
   *
   * ── 为什么非得有这块牌子 ──
   * 开机横幅说过一次就滚走了,而这个开关改变的是它接下来**每一件事**的做法。
   * 一个看不见的、会改变行为的模式,和没开是同一种体验 —— 用户按完 /agentflow
   * 之后屏幕上什么都没变,他只能靠记忆知道自己开着。所以它钉在打字的地方正上方。
   *
   * ── 闲着和忙着写的不是同一件事 ──
   * 闲着写 `agentflow ×6`:它开着,而且下一件活儿会同时派出去几个。一有子 agent
   * 在跑就换成 `agentflow 9/16` —— 这时候那个数比"能派几个"有用得多,而且它每秒
   * 都在变。**动的那个数本身就是最好的动效**:一圈会闪的边只说明界面在动,
   * 这个数说明活儿在动。
   *
   * ── 那三个箭头 ──
   * `▸▸▸` 是这一整套界面已经在用的字符(面板上"在跑"就是 `▸`),宽度确定是 1。
   * ⚡ 这类 emoji 一律不用:它们在不同终端里是一列还是两列没有定论,而这一行
   * 要和右边那根竖线对齐 —— 差一列,整个下半框看着就是歪的。
   * 有人在跑时三个箭头轮流点亮,像东西在管道里往前走;没人在跑就是静止的,
   * 一帧都不多要(和方格那边同一条规矩,见 panes/agents.ts 的 BREATH_MS)。
   */
  private flowChip(now = Date.now()): string {
    const flow = this.deps.agentflow?.()
    if (flow === undefined || flow === false) return ""
    const agents = this.agents.counts
    // 转不转,和"有没有事情正在发生"是同一个问题的两种问法。见 wantsTimer
    const word = flowWord(this.flowMoving(now) ? Math.floor(now / FLOW_STEP_MS) : undefined)
    // 数字只在真有活儿的时候写。`×6` 曾经一直挂在这儿,而它回答的是一个没人
    // 问过的问题(能同时派几个)—— 那个数 /agentflow 和启动横幅上都说过,
    // 挂在这儿只是一串看不懂的字符
    return agents.total > 0 ? word + " " + theme.yellow(`${agents.done}/${agents.total}`) : word
  }

  /**
   * 彩虹现在该不该转。
   *
   * 三种情况转:这一轮正在跑、有子 agent 还没交差、以及**刚开开关那几秒**。
   * 最后那条是给"按下 /agentflow 的那一刻"用的 —— 那正是用户要看到反应的时候,
   * 而那时候什么都还没开始跑。几秒之后它自己定住,界面回到静止。
   *
   * 其余时候一帧都不多要。一个永远在重绘的终端不只是费电,它还让整个进程
   * 永远闲不下来 —— 而这块牌子静止时照旧是一道彩虹,该说的话一个字没少。
   */
  private flowMoving(now: number): boolean {
    if (this.busy || now < this.flowGlowUntil) return true
    const agents = this.agents.counts
    return agents.total > 0 && agents.done < agents.total
  }

  private statusLine(layout: Layout): string {
    this.statusHits = []
    // 工作区路径排**最前面**:它是这一行里唯一一条"我在哪"的信息,而右边那些
    // 键位提示丢了还能按 /help 找回来。位置靠前也意味着挤的时候最后才被截掉。
    const bits: Bit[] = [
      { text: elideLeft(this.deps.workspace.path, pathBudget(layout.width - 2)) },
      { text: this.deps.label() },
    ]
    // ★ 复制那块牌子**常驻**。它是这一行里唯一一个不讲状态、只提供动作的片,
    //   而它存在的理由正是:全屏界面抓着鼠标,终端原生的拖选被顶掉了 ——
    //   一个用户看不见的复制功能,和没有这个功能是同一种体验。
    //   八列换一个随时看得见、点得到的入口,值。
    if (this.deps.copyTargets && !this.copyHit) bits.push({ text: t.copyChip, hit: "copy" })
    // ★ 这里**不写上下文占用** —— 它挂在输入框上沿那条线上(见 draw)。同一个数
    //   写两处,用户第一反应永远是「这两个是不是不一样」。
    //   写的是**花费**:那是另一个数(一共发出去过多少,只增不减),而且它没有
    //   别的地方可待 —— 量表那条线讲的是「还剩多少」,塞不进第二种口径
    const context = this.deps.context?.()
    const spent = context ? spentChip(context) : ""
    if (spent.length > 0) bits.push({ text: spent })
    const mode = this.deps.mode()
    // default 之外的模式必须一眼看见。trust 尤其 —— 用户任何时候都不该
    // 「不知道自己开着自动放行」
    if (mode !== "default") bits.push({ text: modeInfo(mode).label })
    // 排队的两种分开数:「还有 3 条权限请求」和「还有 3 个问题」要用户做的事
    // 完全不同,合成一个数只会让他先愣一下
    const waitingPermissions = this.promptQueue.filter((pending) => pending.kind === "permission").length
    const waitingQuestions = this.promptQueue.length - waitingPermissions
    if (waitingPermissions > 0) bits.push({ text: t.morePermissionRequests(waitingPermissions) })
    if (waitingQuestions > 0) bits.push({ text: t.moreQuestions(waitingQuestions) })
    if (!this.deps.chat.following) bits.push({ text: t.scrolledHint })
    // 状态行上数的是**还在等**的那几句。已经递进去的不算 —— 那句话已经在路上了
    const waiting = this.queued.filter((item) => !item.sent).length
    if (waiting > 0) bits.push({ text: t.queuedStatus(waiting) })
    // 自动折叠的**和自己收起来的**都要写。只写前者的话,ctrl-b 按完文件树消失,
    // 而屏幕上没有任何一处告诉你它去哪了、怎么回来 —— 那不是"收起来了",
    // 那是"没了"
    for (const panel of RECALL) {
      if (!layout.collapsed.includes(panel as SideName) && !this.hidden.has(panel)) continue
      // 本来就没有内容的那几块不提示 —— 它们不是被收起来的
      if (panel === "plan" && this.plan.empty) continue
      // 原地已经留下 `[+]` 了(轨,或者那条只剩标题的横线)就不必在这儿再说一遍。
      // 状态行是**没地方留把手**时的兜底 —— 窄屏自动折叠的那几块
      if (layout.rails.some((rail) => rail.panel === panel)) continue
      if (panel === "plan" && layout.planRule >= 0) continue
      bits.push({ text: recallLabel(panel), hit: panel })
    }

    const painted = mode === "trust" ? theme.yellow : mode === "confirm" ? theme.cyan : theme.dim
    // 现在这一行画在框里,左右各让出一列给竖线;文字自己再留一个空格的边距
    const room = Math.max(0, layout.width - 2)
    const compose = (list: Bit[]) => {
      // 位置要在**上色之前**按纯文本算 —— 带 ANSI 的字符串长度和列数没关系。
      // 起点是 2:一列竖线 + 一列边距(命中判断认的是**屏幕坐标**)
      let x = 2
      const parts: string[] = []
      for (const bit of list) {
        if (bit.hit) this.statusHits.push({ x, width: displayWidth(bit.text) + 2, action: bit.hit })
        parts.push(bit.hit ? recallChip(bit.text) : painted(bit.text))
        x += displayWidth(bit.text) + (bit.hit ? 2 : 0) + 3
      }
      const left = painted(" ") + parts.join(painted(" · "))
      return this.note.length > 0 ? left + theme.yellow(`   ${this.note}`) : left
    }
    // 键位提示是这一行里唯一可以牺牲的东西。塞不下时先整条丢掉,而不是让
    // 尾巴被截成 `ctrl-c ×2 ex…` —— 半句提示既没用又看着像坏了
    if (!this.busy) {
      const full = compose([...bits, { text: t.keysHint }])
      if (displayWidth(full) <= room) return full
    }
    const line = compose(bits)
    if (displayWidth(line) <= room) return line
    // 截了就没法保证片还在原地,命中区一并作废 —— 一个点了没反应的按钮
    // 比没有按钮更糟
    this.statusHits = []
    return truncateToWidth(line, room)
  }

  /**
   * agentflow 的开关刚被按过吗。按过就让彩虹转几秒。
   *
   * ── 为什么这几秒值得单开一个计时窗口 ──
   * 用户按下 /agentflow 的那一刻,一个子 agent 都还没有,而**那正是他要看到
   * 反应的时候** —— 前两版就栽在这儿:开关按完屏幕上什么都没变。转几秒之后
   * 自己定住,不会留下一个永远在重绘的界面。
   */
  private noticeFlow(now = Date.now()): void {
    const flow = this.deps.agentflow?.() ?? false
    const first = this.flowSeen === undefined
    if (flow !== this.flowSeen) {
      this.flowSeen = flow
      // 第一帧不算切换(那是"启动时就开着"),关掉也不用庆祝
      if (!first && flow !== false) this.flowGlowUntil = now + FLOW_GLOW_MS
    }
    this.syncTimer()
  }

  /**
   * 该不该有那个 100 毫秒的计时器。
   *
   * 一处判完,`setBusy` 和彩虹都走它 —— 两边各自 start/stop 的话,一轮跑完时
   * setBusy(false) 会把正转着的彩虹一起停掉,而那种 bug 只在"开着 flow 的时候
   * 恰好跑完一轮"才现形。
   */
  private wantsTimer(now = Date.now()): boolean {
    if (this.busy) return true
    if (this.deps.agentflow?.() === false || this.deps.agentflow === undefined) return false
    return this.flowMoving(now)
  }

  private syncTimer(): void {
    if (this.wantsTimer()) this.startTimer()
    else this.stopTimer()
  }

  private startTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      // 一直往上加,**不按转圈的帧数取模** —— 小人的一套动作和转圈不一样长,
      // 取过模的计数轮到他这儿就会在中间跳一下(见 chat/mascot.ts)
      this.tick++
      this.requestFrame()
      // 转完那几秒自己停下来。不停的话,一个开着 flow 的界面会永远 10fps 重绘
      if (!this.wantsTimer()) this.stopTimer()
    }, SPINNER_MS)
    this.timer.unref?.()
  }

  private stopTimer(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }
}

/** 输入框上沿那块牌子上的字。九个字母,正好一个字母一档颜色 */
const FLOW_WORD = "agentflow"

/**
 * 彩虹。256 色的一圈色相 —— 红 → 橙 → 黄 → 绿 → 青 → 蓝 → 紫 → 品红,首尾接得上,
 * 所以整条可以**转**起来而不会在接缝处跳一下。
 *
 * 用 256 色而不是基本 16 色,理由和上下文量表那条一样(见 cli/theme.ts 的
 * color256):16 色里没有中间色,拿黄色顶替出来的是三段跳,不是彩虹。
 */
const FLOW_RAINBOW = [196, 202, 208, 214, 226, 46, 51, 39, 21, 93, 129, 201]

/** 转一格多久。10 fps 上下,和转圈同一个数量级 —— 再慢就看不出是在流动 */
const FLOW_STEP_MS = 110

/**
 * 那个词,染成彩虹。
 *
 * @param phase 转到第几格。**不给就是静止的** —— 没有活儿在跑的时候它是一道
 *   定住的彩虹:照旧一眼看得出模式开着,但一帧都不多要(见 App.wantsTimer)。
 */
function flowWord(phase?: number): string {
  const at = phase ?? 0
  return [...FLOW_WORD]
    .map((ch, i) => color256(FLOW_RAINBOW[(i + at) % FLOW_RAINBOW.length]!)(ch))
    .join("")
}

/** 输入框在大框里面,自己那圈边框只用来量高度,不上色。 */
const plainBoxStyle = {
  border: (text: string) => text,
  marker: theme.green,
  placeholder: theme.dim,
}

function isTypable(key: Key): boolean {
  if (key.ctrl || key.meta) return false
  if (key.name === "paste") return true
  return [...key.name].length === 1
}

/** 能滚的那几块。滚动条、拖动、点击命中都按这个顺序试 */
const SCROLLABLE = ["tree", "plan", "chat", "detail"] as const
type ScrollablePane = (typeof SCROLLABLE)[number]

const ORDER: PaneName[] = ["input", "tree", "plan", "chat", "detail"]

function available(layout: Layout): PaneName[] {
  return ORDER.filter((pane) => {
    if (pane === "tree") return layout.tree !== undefined
    if (pane === "plan") return layout.plan !== undefined
    if (pane === "detail") return layout.detail !== undefined
    return true
  })
}

/**
 * 中间栏画内容的宽度,**估一个**。
 *
 * measure() 要在布局算出来之前先问「计划要几行」,而那取决于中间栏多宽 ——
 * 一条鸡生蛋:宽度是布局的输出,计划行数是布局的输入。这里按「屏宽减掉两侧
 * 理想宽度」估,估偏一两列只会让某条目多折/少折一行,而那一行由 splitRows
 * 那边的上限兜着,不会撑破布局。
 */
function chatInner(screenWidth: number): number {
  const sides = LAYOUT_LIMITS.TREE.ideal + LAYOUT_LIMITS.DETAIL.ideal + 4
  return Math.max(LAYOUT_LIMITS.CHAT_MIN, screenWidth - sides)
}

function nextPane(current: PaneName, layout: Layout): PaneName {
  const list = available(layout)
  const at = list.indexOf(current)
  return list[(at + 1) % list.length] ?? "input"
}

/** 挑选浮层的状态。`now` 存下来是为了一屏之内所有行是同一个「现在」 */
interface Picker {
  sessions: SessionInfo[]
  selected: number
  now: number
  currentID: string
}

/**
 * 一个挂在那里等人的模态框。
 *
 * ── 为什么权限和提问共用一个队列 ──
 * 它们是两件不同的事(一件是安全边界,一件是对话),但在**界面**上是同一件事:
 * 屏幕中间一个框,所有按键归它,别的都得等。分成两套状态的话,一次并行的
 * 工具调用就能让两个框同时画在同一片格子上 —— 而那时候按下去的键属于谁,
 * 谁也说不清。
 */
type Pending = PermissionPending | QuestionPending

interface PermissionPending {
  kind: "permission"
  request: PromptRequest
  settled: boolean
  finish?(decision: AskDecision): void
  /** 看板上占位的那行收据。按完键原地换成结果 */
  note: string
}

interface QuestionPending {
  kind: "question"
  state: QuestionState
  settled: boolean
  finish?(answer: Answer): void
  note: string
}
