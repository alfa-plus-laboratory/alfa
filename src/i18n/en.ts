/**
 * 英文目录 —— **界面文案的真值源**。
 *
 * `Catalog` 的类型是从这个对象推出来的,别的语言必须实现同一份接口,所以漏译
 * 一个键是**编译错误**而不是运行时冒出一句英文。这条是这套 i18n 唯一的保证,
 * 别用 Record<string, string> 之类把它绕过去。
 *
 * ── 什么该进来,什么不该 ──
 * 进来:用户读的话 —— 标题、提示、状态、说明。
 * 不进来:按键名(`ctrl-b`)、工具名(`bash`)、模式名(`auto`)、路径、命令。
 * 那些是**标识符**,翻译过去用户反而按不出来、搜不到、跟文档对不上。
 *
 * ── 带参数的写成函数 ──
 * 不做 `"{n} queued"` 这种模板串:各语言的语序不一样,占位符一多就会出现
 * 「翻译对了但位置错了」。函数签名逼着每种语言自己决定怎么摆。
 */

export const en = {
  // ─────────────────────────────────────────── 面板标题
  paneFiles: "files",
  paneSession: "session",
  paneStream: "conversation",
  paneDetail: "detail",

  // ─────────────────────────────────────────── 摘要区
  summaryTitle: "so far",
  promptTitle: "user",
  summaryEmpty: "what this session is about will appear here after the first reply.",
  summaryWorking: "writing the summary…",
  summaryClipped: (n: number) => `+${n} more · /summary`,
  summaryFailed: (why: string) => `summary not updated (${why})`,

  // ─────────────────────────────────────────── 当前提问

  // ─────────────────────────────────────────── 计划
  planTitle: "plan",
  /** 挂在 `plan ───` 那条横线右边。`2/5` 就够了 —— 它是扫一眼的东西 */
  planProgress: (done: number, total: number) => `${done}/${total}`,
  planClipped: (done: number, total: number, hidden: number) => `${done}/${total} · +${hidden}`,

  // ─────────────────────────────────────────── 活动区
  /**
   * 思考中的措辞,按已经想了多久往下挑。
   *
   * 一个只写「thinking」的转圈,在第 40 秒和第 2 秒长得一模一样 —— 用户没法
   * 分辨「它在想」和「它卡住了」。措辞随时间变,这个区别就不用去数秒表。
   */
  /**
   * 想得越久,措辞越往下走。**一直换**是刻意的:一个从第 2 秒写到第 4 分钟都
   * 是同一个词的指示器,和一张静图没区别 —— 而这几十秒里用户唯一想知道的就是
   * 「它是还在走,还是卡住了」。换词是这个问题最省地方的答案。
   */
  thinkingPhases: [
    "Thinking",
    "Still thinking",
    "Thinking some more",
    "Still at it",
    "Deep in thought",
    "Turning it over",
    "Still turning it over",
    "Taking its time",
  ],
  working: "working",
  interruptHint: "esc to interrupt",
  toolsEarlier: (n: number) => `${n} earlier`,
  noOutput: "(no output)",
  interrupted: "interrupted",
  stepLimit: "stopped at the step limit",
  retrying: (message: string, seconds: string, attempt: number, max: number) =>
    `${message} — retrying in ${seconds} (attempt ${attempt}/${max})`,
  waitingForYou: "waiting for you",
  liveEmpty: "waiting for your first message.",

  // ─────────────────────────────────────────── 权限收据
  allowedOnce: "allowed once",
  /** 「以后不再问」现在真的会跨重启记住,所以这一行必须说出来 —— 见 permission/approvals.ts */
  allowedAlways: "always — remembered",
  rejected: "rejected",
  /**
   * trust 模式的收据。
   *
   * 刻意不写「auto」也不写模式名:这一行要说的是**发生了什么**(没人被问),
   * 不是**哪个开关导致的** —— 那个状态行上一直写着。见 main.ts 的 trustLine。
   */
  trustAllowed: "allowed without asking",

  // ─────────────────────────────────────────── 状态行
  scrolledHint: "scrolled — end to follow",
  /** 面板标题上那一小格,没位置写整句 */
  scrolledShort: "scrolled",
  queuedStatus: (n: number) => `${n} queued`,
  queuedNow: (n: number) => `queued (${n})`,
  /** 递进正在跑的这一轮了(不是排队等它结束)。见 tui/app.ts 的 onSubmitBusy */
  queuedLive: "sent — it will see it at its next step",
  /** 排队那几行装不下时的最后一行 */
  queuedMore: (n: number) => `+${n} more queued`,
  recallFiles: "ctrl-b files",
  recallDetail: "ctrl-] detail",
  recallPlan: "ctrl-p plan",
  keysHint: "tab panes · shift-tab mode · ctrl-c ×2 exit",
  pressCtrlCAgain: "press ctrl-c again to exit",
  detailLocked: "detail locked",
  /** ctrl-l。花屏之后按的那一下 —— 说一声,不然它看起来什么都没发生 */
  screenRepainted: "screen repainted",
  detailFollows: "detail follows tools",
  morePermissionRequests: (n: number) => (n === 1 ? "1 more permission request" : `${n} more permission requests`),
  permissionSwitched: (label: string, hint: string) => `permission: ${label} — ${hint}`,
  languageSwitched: (kind: string, label: string) => `${kind} language: ${label}`,
  placeholder: "Ask anything, or /help",

  // ─────────────────────────────────────────── 右栏
  detailNothing: "nothing to show yet.",
  detailFollowsWhat: "it follows the latest tool call:",
  detailMapRead: "read   -> file",
  detailMapEdit: "edit   -> diff",
  detailMapBash: "bash   -> output",
  detailPickFile: "or pick a file on the left.",
  detailBinary: "binary file",
  detailTooLarge: (name: string, mb: string) => `${name} is ${mb}MB — too large to preview`,

  // ─────────────────────────────────────────── 权限模式
  modeConfirm: "confirm",
  modeDefault: "default",
  modeTrust: "trust",
  modeConfirmHint: "asks before every tool call",
  modeDefaultHint: "built-in rules decide",
  modeTrustHint: "you vouch for it — anything the rules would ask about just runs",
  unknownMode: (value: string, known: string) => `unknown mode "${value}" — try: ${known}`,
  currentMode: (label: string, hint: string) => `permission mode: ${label} — ${hint}`,
  modeHowTo: "/permission <mode>, or shift-tab to cycle",
  /** 模式是记住的,所以启动时必须说出来 —— 见 config.ts 上那颗星 */
  modeRestored: (label: string) => `permission: ${label} — remembered from last time`,

  // ─────────────────────────────────────────── 扩展思考
  thinkingOn: "extended thinking: on",
  thinkingOff: "extended thinking: off",
  thinkingHint: "you see what it is working out before it answers, when the model supports it",
  thinkingRemembered: "remembered — /think switches it",
  thinkingUsage: "/think, or /think on | off",
  unknownThink: (value: string) => `"${value}" is not "on" or "off"`,


  // ─────────────────────────────────────────── 模型
  modelCurrent: (spec: string) => `model: ${spec}`,
  modelWindow: (limit: string, budget: string) => `${limit} window · ${budget} usable`,
  modelSwitched: (spec: string) => `switched to ${spec}`,
  modelAlready: (spec: string) => `already on ${spec}`,
  modelRemembered: "remembered as the default for next time",
  /** 记下了,但环境变量会把它盖掉 —— 不说的话下次启动会莫名其妙换回去 */
  modelEnvWins: (variable: string) =>
    `not remembered: $${variable} is set and wins at startup — unset it, or change it there too`,
  modelUsage: "/model <provider>/<model>",
  modelChoicesTitle: "known here:",
  /** 一个列不出候选的 provider 不是坏了 —— 只是没人告诉过我们它认什么 */
  modelNoChoices: "no candidates configured — any provider/model still works, and providers.<id>.models fills this list",
  modelKeepsHistory: "the conversation carries over; earlier reasoning is dropped (it does not transfer between models)",
  modelNoThinking: (spec: string) => `${spec} has no extended thinking — /think stays on but does nothing here`,
  // ─────────────────────────────────────────── 记住的放行
  modeForgetHint: "forget everything you allowed with [a] here",
  rememberedTitle: (n: number) => (n === 1 ? "1 rule remembered here" : `${n} rules remembered here`),
  rememberedMore: (n: number) => `+${n} more`,
  rememberedHowTo: "/permission forget clears them",
  forgotNothing: "nothing was remembered here.",
  forgotApprovals: (n: number) => (n === 1 ? "forgot 1 remembered rule." : `forgot ${n} remembered rules.`),
  bannerRemembered: (n: number) => (n === 1 ? "1 remembered rule" : `${n} remembered rules`),

  // ─────────────────────────────────────────── 视图
  viewSession: "session",
  viewStream: "stream",
  viewSessionHint: "summary, your question, and what it is doing now",
  viewStreamHint: "the classic scrolling transcript",
  unknownView: (value: string, known: string) => `unknown view "${value}" — try: ${known}`,
  currentView: (label: string, hint: string) => `view: ${label} — ${hint}`,

  // ─────────────────────────────────────────── 语言
  languageInterface: "interface",
  languageReply: "reply",
  languageInterfaceHint: "the language of this program's own text",
  languageReplyHint: "the language the model answers in",
  languageAuto: "auto",
  languageAutoInterfaceHint: "follow the terminal's locale",
  languageAutoReplyHint: "follow the language you write in",
  languageEnglish: "English",
  languageChinese: "Chinese",
  languageJapanese: "Japanese",
  languageUsage: "/language interface <lang>, or /language reply <lang>",
  currentLanguage: (interfaceLabel: string, replyLabel: string) =>
    `interface: ${interfaceLabel} · reply: ${replyLabel}`,
  unknownLanguage: (value: string, known: string) => `unknown language "${value}" — try: ${known}`,
  unknownLanguageKind: (value: string) => `"${value}" is not "interface" or "reply"`,

  // ─────────────────────────────────────────── 上下文占用
  /** 状态行上那一格的前缀。缩写是刻意的 —— 那一行按列算,不按词算 */
  ctxShort: "ctx",
  ctxTitle: "context",
  ctxSystem: "system prompt",
  ctxTools: "tool definitions",
  ctxMcpTools: "MCP tools",
  ctxSkills: "skills",
  ctxSummary: "compacted summary",
  ctxMemory: "project memory",
  ctxUser: "your messages",
  /** 开场挂上去的仓库快照。见 prompt/git.ts —— 它在库里和你说的话长得一样 */
  ctxEnv: "repo snapshot",
  /** ★ 子 agent 交回来的报告 + 收口检查的回执。见 agent/context.ts 的 SLICE_KEYS */
  ctxHandoff: "reports handed back",
  ctxReply: "replies",
  ctxThinking: "thinking",
  ctxCall: "tool calls",
  ctxResult: "tool results",
  ctxFree: "free",
  ctxWindow: (window: string, full: string) =>
    `window ${window} — ${full} counts as full; the rest is held back for the reply and for compacting`,
  ctxWindowGuessed: "this model did not report a window size, so that is a default — set providers.<name>.limit in config.json to correct it",
  ctxMessages: (n: number) => (n === 1 ? "1 message in context" : `${n} messages in context`),
  ctxFolded: (n: number) => `${n} already folded away`,
  /** 这一句是这份报告的诚信声明,别删 —— 见 agent/context.ts 顶部 */
  ctxSplitEstimated: "the total is what the provider reported; the split between rows is estimated locally",
  ctxAllEstimated: "estimated locally — no request has reported its usage yet",
  ctxCompactHint: "/compact folds the history into a handoff summary and frees most of it",
  /** 状态行上那一格。in / out 不译 —— 它们在这里是标识符,而且那一行按列算 */
  ctxSpentShort: (input: string, output: string) => `${input} in · ${output} out`,
  /**
   * 「这一场」不是「这次打开」—— 接上一场旧会话时,它之前花掉的也算在内
   * (见 ContextMeter.resetSpend 的 seed),而且**含派出去的子 agent**。
   */
  ctxSpent: (total: string, input: string, output: string) =>
    `this session has spent ${total} tokens — ${input} in, ${output} out`,
  ctxSpentCached: (cached: string) => `${cached} of that came from cache`,
  /** 为什么这个数比窗口大得多。不解释的话它看着像个 bug */
  ctxSpentWhy: "every turn re-sends the whole history, so this grows far past the window",
  ctxNearlyFull: (percent: number) => `context ${percent}% full — /compact frees most of it`,

  // ─────────────────────────────────────────── 压缩
  compacting: "compacting — reading the session and writing a handoff…",
  /** 自动触发那一次。必须说明白是**自己**动的手 —— 用户没按任何键 */
  compactingAuto: "context nearly full — compacting on its own, reading the session…",
  /** 最近几轮原样留着。不写的话「折了 40 条」读起来像"刚才那几轮也没了" */
  compactKept: (n: number) => `last ${n} messages kept as they were`,
  autoCompactOn: "auto-compact: on",
  autoCompactOff: "auto-compact: off",
  autoCompactOnHint: (percent: number) =>
    `at ${percent}% full it folds the history on its own, so a long session does not hit the wall`,
  autoCompactOffHint: "it will warn you when the window fills up, and wait for you to run /compact",
  autoCompactUsage: "/compact auto, or /compact auto on | off",
  autoCompactHint: "turn compacting-by-itself on or off",
  compacted: (folded: number, freed: string) => `compacted — ${folded} messages folded into a summary, ${freed} freed`,
  compactFailed: (why: string) => `not compacted (${why})`,
  compactNothing: "nothing to compact yet — the history is still short.",
  compactBusy: "still running — stop it with esc first",
  /** 重放旧会话时,压缩点在滚动记录里留下的那一行 */
  compactedMarker: (n: number) => `context compacted here — ${n} messages folded into a summary`,

  // ─────────────────────────────────────────── 收口前的检查
  checkRunning: (id: string) => `${id} — checking your edits…`,
  checkPassed: (id: string) => `${id} passed`,
  /** 没过。第一行原文跟在后面 —— 一条没有内容的"失败了"等于没说 */
  checkFailed: (id: string, first: string) => `${id} failed — ${first}`,
  /** 上一轮就是这个错,不是这次改出来的 */
  checkStill: (id: string) => `${id} still failing (unchanged since before these edits)`,
  checkUnavailable: (id: string, why: string) => `${id} did not run (${why})`,
  checkSkipped: "automatic checks are off for this session",
  checkNone: "no project check found here (looked for tsconfig.json + a local tsc, Cargo.toml, go.mod)",
  checkOffNow: "automatic checks off — turn them back on with /check on",
  checkOnNow: (command: string) => `automatic checks on — ${command}`,
  checkNothing: "nothing to check — no files were edited",
  checkOnHint: "run it automatically before it answers",
  checkOffHint: "only when you ask with /check",
  // ─────────────────────────────────────────── 后台任务
  /** 起落都要留一行。看不见的后台进程就是看不见的自动化 */
  jobStarted: (id: string, command: string) => `${id} started in the background — ${command}`,
  jobEnded: (id: string, how: string) => `${id} finished — ${how}`,
  jobsTitle: "background",
  /** 装不下时顶上那一行。截断的话被截掉的彻底没有痕迹 */
  jobsMore: (n: number) => `${n} more running`,
  jobExitKilled: (signal: string) => `killed by ${signal}`,
  jobExitCode: (code: string) => `exit ${code}`,
  /** 子 agent 那几行。面板上要一眼看出这一条不是进程 —— 它烧的是 token 不是 CPU */
  agentStarted: (id: string, task: string) => `${id} — subagent working on ${task}`,
  agentEnded: (id: string, how: string) => `${id} — subagent ${how}`,
  agentDone: (steps: number) => (steps === 1 ? "done in 1 step" : `done in ${steps} steps`),
  agentFailed: (why: string) => `stopped: ${why}`,
  agentStopped: "stopped by you",
  agentThinking: "thinking",
  /** 子 agent 自己那一块的标题。见 tui/panes/agents.ts */
  agentsTitle: "subagents",
  agentsMore: (n: number) => `${n} more`,
  /** 方格模式那一行总进度。见 tui/panes/agents.ts 的 progress */
  agentsDone: "done",
  agentsRunning: (n: number) => `${n} running`,
  agentsRunningQueued: (running: number, queued: number) => `${running} running · ${queued} queued`,
  /** 换一场对话时把它们叫停。见 cli/main.ts 的 clearCommand */
  agentsStopped: (n: number) => (n === 1 ? "stopped 1 subagent from the previous session" : `stopped ${n} subagents from the previous session`),

  // ─────────────────────────────────────────── agentflow(见 cli/main.ts 的 agentflowCommand)
  // ★ 两个数,不是一个。「同时最多 6 个」曾经是这里唯一写出来的数字,而用户读到的
  //   是「这个模式最多派 6 个人」—— 那正好是它要打破的那个印象。6 是**同时开工**的,
  //   总共可以排到 100
  agentflowOn: (running: number, total: number) => `agentflow: on — up to ${total} subagents, ${running} working at once`,
  agentflowOff: "agentflow: off",
  agentflowHint: "it splits the work up by default: many subagents, chained, most of the job handed out rather than done here",
  agentflowOffHint: "back to doing the work here, with the occasional subagent (4 at a time)",
  agentflowRemembered: "remembered — /agentflow switches it",
  agentflowUsage: (min: number, max: number) => `/agentflow, or /agentflow on | off | ${min}-${max}`,
  agentflowBadWidth: (value: string, min: number, max: number) =>
    `"${value}" is not a number of subagents between ${min} and ${max}`,
  /** ★ confirm 模式下开 flow 的那句警告。见 AskUserQuestion 里选的那条:警告,不强制 */
  agentflowConfirmWarning:
    "permission mode is confirm — a dozen subagents will queue up a dozen prompts in front of you. /permission default first, unless that is what you want",
  /** 启动横幅。存下来的东西可以忘,屏幕上写着的忘不了 */
  agentflowBanner: (running: number, total: number) => `agentflow on — up to ${total} subagents, ${running} at once`,

  // ─────────────────────────────────────────── 它问你一句(见 tool/ask.ts)
  askSomethingElse: "something else…",
  askHintSingle: "↑↓ move · 1-9 pick · ⏎ choose · esc dismiss",
  askHintMultiple: "↑↓ move · space toggle · ⏎ confirm · esc dismiss",
  askHintTyping: "⏎ send · esc back to the options",
  askPlainHintSingle: "press 1-9 to pick · o to type your own · ⏎ = 1 · esc dismiss",
  askPlainHintMultiple: "press 1-9 to toggle · o to type your own · ⏎ confirm · esc dismiss",
  /** 一次问好几个时才出现。见 cli/ask.ts 的 canGoBack */
  askHintBack: "← previous question",
  askPlainHintBack: "← previous question",
  askDismissed: "dismissed",
  /** 没有 TTY 时的说法。「没人可问」和「没人回答」是两句话,见 tool/ask.ts */
  askNobody: "nobody to ask",
  moreQuestions: (n: number) => (n === 1 ? "1 more question" : `${n} more questions`),

  // ─────────────────────────────────────────── 会话恢复
  resumeTitle: "resume a session",
  resumeEmpty: "nothing to resume in this directory yet.",
  resumeKeys: "↑↓ pick · enter resume · esc cancel",
  resumeBusy: "still running — stop it with esc first",
  resumeCurrent: "already in this one",
  resumed: (messages: number) => `resumed — ${messages} messages restored`,
  continueNone: "no earlier session here — starting a new one.",
  sessionMessages: (n: number) => `${n} msgs`,
  sessionUntitled: "(no summary yet)",
  agoNow: "just now",
  agoMinutes: (n: number) => `${n}m ago`,
  agoHours: (n: number) => `${n}h ago`,
  agoDays: (n: number) => `${n}d ago`,

  // ─────────────────────────────────────────── 命令说明
  /** ── 「什么都不加」那条候选的说明。见 cli/commands.ts 的 bareHint ── */
  bareCurrent: "leave it as is — just show what it is now",
  bareToggle: "leave it as is — flip it",
  bareRunNow: "leave it as is — run it now",
  bareListFirst: "leave it as is — list what would go, delete nothing",
  bareCompactNow: "leave it as is — compact now (or add what to keep in full)",
  cmdPermission: "switch how tool calls are approved",
  cmdModel: "show the current model, or switch to another one",
  cmdReset: "delete everything alfa stored on this machine and start over",
  updateAvailable: (version: string, command: string) => `${version} is out — run ${command}`,
  resetTitle: "This deletes everything alfa has on this machine:",
  resetHasKeys: "including your API keys — they cannot be recovered, you will have to paste them again",
  resetSessions: "every session goes with it: /resume will have nothing to offer",
  resetProjectNote: (path: string) => `${path} is left alone — add "all" to delete it too`,
  resetNothing: "nothing stored yet — there is nothing to reset",
  resetConfirm: (command: string) => `Cannot be undone. Type ${command} to go ahead.`,
  resetDone: "reset — everything above is gone",
  resetFailed: (path: string, why: string) => `could not delete ${path}: ${why}`,
  resetExiting: "exiting; start alfa again to set it up from scratch",

  // ─────────────────────────────────────────── alfa uninstall
  /** ── 两段式,和 /reset 同一条规矩:不带 confirm 只列清单 ── */
  uninstallTitle: "This removes alfa from this machine:",
  uninstallBinary: "the alfa binary itself",
  uninstallConfirm: (command: string) => `Cannot be undone. Run ${command} to go ahead.`,
  uninstallNothing: "nothing to remove — alfa has nothing stored and is not installed as a binary",
  uninstallFromSource:
    "running from source, so there is no installed binary to remove — this only deletes what alfa stored. Delete the checkout yourself.",
  uninstallDone: "uninstalled — everything above is gone",
  uninstallFailed: (path: string, why: string) => `could not delete ${path}: ${why}`,
  uninstallParked: (path: string) =>
    `Windows will not let a running program delete itself. It has been moved to ${path} — delete that file once this command exits.`,
  /** ★ 散在各仓库里的 .alfa/ 我们不去扫,把命令交给用户。见 cli/uninstall.ts 头注释 */
  uninstallProjectDirs: "Project notes live in each repository you ran /init in. This lists them:",
  uninstallPathNote: (dir: string) =>
    `${dir} is left alone — other tools live there. If you added it to PATH just for alfa, remove that line yourself.`,

  // ─────────────────────────────────────────── /history-clean
  /** ── 两段式:不带 confirm 只列清单。见 cli/main.ts 的 cleanHistoryCommand ── */
  cmdCleanHistory: "delete old sessions from the local history (a week and older by default)",
  cleanDaysWeek: "a week",
  cleanDaysMonth: "a month",
  cleanDaysQuarter: "three months",
  cleanTitle: (days: number) => `Sessions with nothing new for more than ${days} days:`,
  cleanCounts: (sessions: number, messages: number) => `${sessions} sessions · ${messages} messages`,
  /** 子 agent 那几场跟着走。用户没开过它们,所以要单独说一句它们是什么 */
  cleanAgents: (n: number) => `${n} subagent sessions belonging to them go too`,
  cleanRange: (oldest: string, newest: string) => `oldest ${oldest}, newest ${newest}`,
  cleanMoreDirs: (n: number) => `and ${n} more directories`,
  cleanWarn: "cannot be undone — these leave /resume for good",
  cleanKeeps: "the session you are in now is kept, however old it is",
  cleanConfirm: (command: string) => `Type ${command} to go ahead.`,
  cleanNothing: (days: number) => `nothing older than ${days} days — the history is already tidy`,
  cleanDone: (sessions: number, messages: number) => `deleted ${sessions} sessions and ${messages} messages`,
  cleanFreed: (size: string) => `freed ${size}`,
  /** 别的实例正开着库,这次没能把文件缩回去。东西已经删了,所以这不是错误 */
  cleanNotShrunk: "the database file could not be shrunk right now — the sessions are gone all the same",
  cleanBadDays: (value: string) => `"${value}" is not a number of days`,
  cleanUsage: "/history-clean, /history-clean 30, or /history-clean 30 confirm",

  cmdThink: "turn extended thinking on or off (remembered)",
  cmdAgentflow: "let it run many subagents at once, in a pipeline (remembered)",
  cmdResume: "pick an earlier session and keep going",
  cmdView: "switch between the summary view and the scrolling transcript",
  cmdLanguage: "set the interface language, or the language the model replies in",
  cmdSummary: "show the session summary in full",
  cmdContext: "show what is filling the context window",
  cmdCompact: "fold the history into a summary and free up context — add what must survive in full",
  cmdCheck: "run the project check now, or turn the automatic one on/off",
  cmdInit: "write an AGENTS.md for this project, and create .alfa/",
  cmdSkills: "skills: which playbooks are loaded, and where they come from",
  skillsEmpty: "no skills yet — put one in .alfa/skills/<name>.md with a one-line description",
  skillsShelf: (count: number) => `${count} on the shelf (not loaded here — ask to install one):`,
  skillsProblems: (count: number) => `${count} could not be loaded:`,
  skillsCount: (count: number) => `${count} skill${count === 1 ? "" : "s"}`,
  cmdMcp: "MCP servers: what is connected, and allow the ones this project defines",
  // ── /trust。见 cli/trust.ts ──
  cmdTrust: "whether this folder's AGENTS.md / CLAUDE.md may reach the model",
  trustShowHint: "show the current state",
  trustOnHint: "trust it from now on",
  trustOffHint: "stop loading this folder's instruction files",
  trustCheckHint: "have a subagent read them and decide",
  trustNowTrusted: "trusted. This folder's instruction files load from the next step.",
  trustNowUntrusted: "not trusted. This folder's instruction files stay out of the system prompt.",
  trustChecking: "reading this folder's instruction files — the verdict lands here",
  trustCheckBusy: "a review is already running",
  trustCheckNoModel: (why: string) => `could not start the review — ${why}`,
  trustClean: "nothing steering, so this folder is trusted from now on",
  trustConcerns: "the review has something to say. This folder stays untrusted.",
  trustUnreadable: "the review came back without a verdict. This folder stays untrusted.",
  /**
   * ★ 意思在前,路径**一个字都不要**。这一行落在中间那一栏里(常常只有 36 列),
   *   而路径打头的话被截掉的正好是"没有加载"那半句 —— 用户看到的是一条
   *   写着自己路径的黄色警告,不知道它在说什么。哪个工作区状态行上一直写着。
   */
  trustBanner: "this folder is not trusted — its AGENTS.md / CLAUDE.md are not loaded · /trust",
  trustBannerChecking: "looking this folder over — its AGENTS.md / CLAUDE.md stay out until then · /trust",
  trustUsage: "/trust [on | off | check]",
  mcpEmpty: "no MCP servers configured — add them under \"mcp\" in config.json, or in .alfa/mcp.json",
  mcpUsage: "/mcp to list, /mcp trust <name> to allow a server this project defines",
  mcpShelf: (count: number, names: string) =>
    `${count} on the shelf, not connected here: ${names} — add "use": ["<name>"] to .alfa/mcp.json`,
  mcpTools: (count: number) => `${count} tool${count === 1 ? "" : "s"}`,
  mcpConnecting: "connecting…",
  mcpOff: "disabled in the config",
  mcpPending: (source: string) => `defined by this project (${source}) — not started. /mcp trust to allow it.`,
  mcpApproved: (name: string) => `${name} is allowed in this workspace — connecting now`,
  mcpUnknown: (name: string) => `no server called "${name}" is waiting for approval`,
  /** 横幅上那一句:有几条 server 定义**读不出来**。见 mcpCommand 那颗星 */
  mcpBannerProblems: (count: number) =>
    count === 1
      ? "1 MCP server definition could not be read — /mcp for details"
      : `${count} MCP server definitions could not be read — /mcp for details`,
  mcpBanner: (count: number) =>
    `${count} MCP server${count === 1 ? "" : "s"} defined by this project ${count === 1 ? "is" : "are"} waiting for you — /mcp`,
  cmdUpgrade: "check for a newer release and install it over this binary",
  cmdHelp: "keys and commands",
  cmdClear: "start a fresh session (the old one stays in /resume)",
  cleared: "new session — the old one is still in /resume",
  cmdExit: "quit",

  // ─────────────────────────────────────────── /init
  /** 建好了什么。已经在的不列 —— 报一个没发生的动作会让人以为文件被盖了 */
  initCreated: (paths: string) => `created ${paths}`,
  /** 文件夹建不出来(只读挂载、没权限)。约定文件那一半照写 */
  initScaffoldFailed: (why: string) => `could not create .alfa/ (${why})`,
  initWriting: "reading the project — AGENTS.md will land at the repo root",

  // ─────────────────────────────────────────── /upgrade
  /** 参数说明。check 是「只看」,force 是「已经最新了也重装一遍」 */
  upgradeForceHint: "download and install again even if this is already the latest",
  upgradeUsage: "/upgrade, or /upgrade force",
  upgradeUnknown: (value: string) => `"${value}" is not "force"`,
  /** 下面三条是 update/upgrade.ts 的进度事件,措辞归界面所有 */
  upgradeChecking: "checking for a newer release…",
  /** ── 独占浮层用的那几条 ── */
  upgradeTitle: "upgrade",
  upgradeFrom: (version: string) => `on ${version}`,
  upgradeDownloadingNow: "downloading…",
  upgradeVerifying: "verifying the download…",
  upgradeInstalling: "installing…",
  upgradeCancelled: "cancelled — nothing was replaced",
  /** 下载中,esc 是"别下了"。这个框独占按键,所以必须写出唯一的出口 */
  upgradeCancelHint: "esc cancel — everything else waits until this finishes",
  upgradeClose: "enter / esc to close",
  upgradeDownloading: (tag: string, asset: string) => `downloading ${tag} (${asset})…`,
  upgradeCurrent: (version: string) => `already on the latest release (${version})`,
  /** ★ 查不到就说查不到。报成"已经是最新"是一句自信的错话 */
  upgradeUnreachable: "could not reach the release feed — no idea whether a newer version exists",
  /**
   * 换完了。**"重启"这半句不能省** —— 换掉的是磁盘上那个文件,正在跑的这个
   * 进程照旧是老的,不说的话用户会以为新功能当场就有了
   */
  upgradeDone: (from: string, to: string) => `${from} → ${to} — restart alfa to run the new one`,
  upgradeFailed: (why: string) => `upgrade failed: ${why}`,

  // ─────────────────────────────────────────── 启动横幅
  bannerModel: "model",
  bannerCwd: "cwd",
  bannerRoot: "root",
  bannerWindow: "window",
  /** 装进 prompt 的约定文件。看不见的输入要说出来,它改的是每一句回答 */
  bannerRules: "rules",
  rulesNone: "none",
  rulesMore: (n: number) => `+${n} more`,
  /** 模型自己写的便条。它们跟着每一句回答走,所以有几条要说出来 */
  rulesMemos: (n: number) => `${n} note${n === 1 ? "" : "s"}`,
  /** 这个项目还没有自己的那份。整条横幅上唯一一句「你可以做点什么」 */
  rulesInitHint: "— /init writes one for this project",
  /** 退化到 PowerShell / cmd 时的横幅提醒 */
  bannerShellFallback: (label: string) =>
    `commands run through ${label} — install Git for Windows for a real bash, or point ALFA_SHELL at one`,
  /** 横幅上那一行:`1m · 900k usable`。窗口多大是开工前就该知道的事 */
  bannerWindowValue: (window: string, budget: string) => `${window} · ${budget} usable`,

  // ─────────────────────────────────────────── 复制(ctrl-y)。见 tui/panes/copy.ts
  // ── 绕过 t.* 写死过的那几处。★ 键名(Y/a/n、ctrl-c)一律不译 ──
  /** 权限框那一行。**两个宿主共用**(--plain 和全屏),见 cli/confirm.ts */
  promptAllowOnce: "allow once",
  promptAlways: "always",
  promptReject: "reject",
  promptParseUnsure: "could not parse this command reliably — review the full text above",
  promptNoKeyboard: "cannot read a key",
  /** --plain 状态行。全屏那边走 keysHint,同一句话两处写法一度不一样 */
  plainExitHint: "ctrl-c ×2 to exit",
  treeEmpty: "(empty)",
  resetConfigWhat: "settings, and the global AGENTS.md if you wrote one",
  resetDataWhat: "API keys, every session, input history, saved tool output",
  resetProjectWhat: "notes this agent wrote about this project",
  copyTitle: "copy",
  /** 状态行上那块常驻的牌子。八列,见 App.statusLine 那颗星 */
  copyChip: "⧉ copy",
  copyCode: "code",
  copyReply: "reply",
  copyPrompt: "you",
  copySession: "session",
  copySessionHint: "the whole conversation, as text",
  copyEmpty: "nothing to copy yet",
  copyKeys: "↑↓ pick   enter copy   esc close",
  /** ★ 说的是"发出去了",不是"已复制" —— OSC 52 收不到回执,见 cli/clipboard.ts */
  copySent: (what: string, size: string) => `sent ${what} (${size}) to the terminal's clipboard`,
  copyClipped: (size: string) => `only the first ${size} fit — terminals drop an oversized clipboard write whole`,

  // ─────────────────────────────────────────── 第一次进一个文件夹
  /** 见 cli/folder-setup.ts。措辞的重点:这是**这台机器**的偏好,不是仓库的属性 */
  folderSetupTitle: (path: string) => `First time here — ${path}`,
  folderSetupWhere: "Saved for this folder in your config. Nothing is written into the repo.",
  folderSetupLayout: "How should the screen look?",
  folderSetupLayoutOptions: [
    { name: "conversation", hint: "the current turn, front and centre" },
    { name: "conversation + panels", hint: "file tree on the left, preview on the right" },
    { name: "stream", hint: "the classic scrolling transcript" },
    { name: "stream + panels", hint: "the transcript, with the side panels" },
  ],
  folderSetupTrust: "Trust this folder?",
  folderSetupTrustWhy: [
    "Its AGENTS.md / CLAUDE.md go into the system prompt, and .alfa/mcp.json",
    "can start processes. That is fine for your own code, less so for a repo",
    "you just cloned.",
  ],
  folderSetupTrustYes: "yes, get going",
  folderSetupTrustCheck: "look it over first",
  folderSetupTrustCheckHint: "read those files, then trust it if nothing looks off",
  folderSetupChoose: "Choose",
  folderSetupDefault: "default",
  folderSetupSaved: "Change it any time: /view, ctrl-b, ctrl-], /trust.",

  // ─────────────────────────────────────────── 帮助
  helpTui: [
    "  enter          send (queues while running)",
    "  ctrl-j         newline          esc        interrupt",
    "  tab            next pane        shift-tab  permission mode",
    "  /              command palette  @          mention a file",
    "  ctrl-b files   ctrl-p plan      ctrl-] detail   or click [-]",
    "  ctrl-y         copy something   ctrl-l     repaint the screen",
    "  ctrl-o         lock detail      ctrl-r     refresh tree and index",
    "  ctrl-c         clear / exit     pgup/pgdn  scroll the live area",
    "  /context /compact /check /view /language /permission /trust",
    "  /think /agentflow /model /resume /summary /clear /upgrade",
    "  /history-clean /reset /help /exit",
  ].join("\n"),
  helpPlain: [
    "  enter          send (queues while running)",
    "  ctrl-j         newline          esc      interrupt",
    "  ctrl-c         clear / exit     ctrl-d   exit",
    "  up/down        history",
    "  /context /compact /check /view /language /permission /trust",
    "  /think /agentflow /model /resume /summary /clear /upgrade",
    "  /history-clean /reset /help /exit",
  ].join("\n"),
}

export type Catalog = typeof en
