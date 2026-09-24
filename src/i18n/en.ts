/**
 * The English catalog — **the source of truth for UI text**.
 *
 * The `Catalog` type is inferred from this object, and every other language must
 * implement the same interface, so a missing translation is a **compile error** rather
 * than a stray English sentence at runtime. That is the only guarantee this i18n setup
 * gives; don't route around it with Record<string, string> or the like.
 *
 * ── What belongs here and what doesn't ──
 * In: words the user reads — titles, hints, status, descriptions.
 * Out: key names (`ctrl-b`), tool names (`bash`), mode names (`auto`), paths, commands.
 * Those are **identifiers**; translated, the user can't press them, can't search for
 * them, and they don't match the docs.
 *
 * ── Anything with parameters is a function ──
 * No `"{n} queued"`-style template strings: word order differs between languages, and
 * with more than a few placeholders you get "translated right but in the wrong place".
 * A function signature forces each language to decide its own arrangement.
 */

export const en = {
  // ─────────────────────────────────────────── Panel titles
  paneFiles: "files",
  paneSession: "session",
  paneStream: "conversation",
  paneDetail: "detail",

  promptTitle: "user",

  // ─────────────────────────────────────────── Plan
  planTitle: "plan",
  /** Hangs to the right of the `plan ───` rule. `2/5` is enough — it's for a glance */
  planProgress: (done: number, total: number) => `${done}/${total}`,
  planClipped: (done: number, total: number, hidden: number) => `${done}/${total} · +${hidden}`,

  // ─────────────────────────────────────────── Live area
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

  // ─────────────────────────────────────────── Permission receipts
  allowedOnce: "allowed once",
  /**
   * "Don't ask again" now really is remembered across restarts, so this line has to say
   * so — see permission/approvals.ts
   */
  allowedAlways: "always — remembered",
  rejected: "rejected",

  // ─────────────────────────────────────────── Status line
  queuedStatus: (n: number) => `${n} queued`,
  queuedNow: (n: number) => `queued (${n})`,
  /**
   * Delivered into the turn that is already running (not queued until it ends). See
   * onSubmitBusy: cli/shell.ts calls it, cli/main.ts wires it
   */
  queuedLive: "sent — it will see it at its next step",
  /** The last line when the queued lines don't all fit */
  queuedMore: (n: number) => `+${n} more queued`,
  recallFiles: "ctrl-b files",
  recallDetail: "ctrl-] detail",
  recallPlan: "ctrl-p plan",
  pressCtrlCAgain: "press ctrl-c again to exit",
  detailLocked: "detail locked",
  /**
   * ctrl-l. What you press after the screen gets garbled — say something, or it looks
   * like nothing happened
   */
  screenRepainted: "screen repainted",
  detailFollows: "detail follows tools",
  morePermissionRequests: (n: number) => (n === 1 ? "1 more permission request" : `${n} more permission requests`),
  languageSwitched: (kind: string, label: string) => `${kind} language: ${label}`,
  placeholder: "Type / for commands, @ to add a file",

  // ─────────────────────────────────────────── Right column
  detailNothing: "nothing to show yet.",
  detailFollowsWhat: "it follows the latest tool call:",
  detailMapRead: "read   -> file",
  detailMapEdit: "edit   -> diff",
  detailMapBash: "bash   -> output",
  detailPickFile: "or pick a file on the left.",
  detailBinary: "binary file",
  detailTooLarge: (name: string, mb: string) => `${name} is ${mb}MB — too large to preview`,

  // ─────────────────────────────────────────── Permission modes
  modeConfirm: "confirm",
  modeDefault: "default",
  modeAuto: "auto",
  modeConfirmHint: "asks before every gated operation, including routine reads and edits",
  modeDefaultHint: "ordinary workspace edits allowed; diffs recorded",
  modeAutoHint: "auto — works on its own; reads and workspace edits run, everything else is risk-checked first",
  unknownMode: (value: string, known: string) => `unknown mode "${value}" — try: ${known}`,
  currentMode: (label: string, hint: string) => `permission mode: ${label} — ${hint}`,
  modeHowTo: "/permission <mode>, or shift-tab to cycle",

  // ─────────────────────────────────────────── Extended thinking
  thinkingOn: "extended thinking: on",
  thinkingOff: "extended thinking: off",
  thinkingHint: "you see what it is working out before it answers, when the model supports it",
  thinkingRemembered: "remembered — /think switches it",
  thinkingUsage: "/think, or /think on | off",
  unknownThink: (value: string) => `"${value}" is not "on" or "off"`,

  // ─────────────────────────────────────────── Reasoning effort
  effortNow: (level: string) => `effort: ${level}`,
  effortProviderDefault: "provider default",
  effortHint: "from the next request — a model that lacks this level gets the nearest one below it",
  effortDefaultHint: "nothing is sent; each model runs at its provider's default",
  effortRemembered: "remembered — /effort changes it",
  effortUsage: "/effort, or /effort low | medium | high | xhigh | max | default",
  unknownEffort: (value: string) => `"${value}" is not an effort level`,
  effortLow: "quick and cheap — lookups, small edits",
  effortMedium: "a balance for routine work",
  effortHigh: "thorough — the default on most models",
  effortXhigh: "deeper still — hard coding work",
  effortMax: "most thorough, most expensive",
  effortDefault: "send nothing — the provider's default",

  // ─────────────────────────────────────────── Images
  imageAttached: (name: string, size: string, shrunk: boolean) => `image attached: ${name} (${shrunk ? `shrunk to ${size}` : size})`,
  imageNotImage: (name: string) => `${name} is not a PNG, JPEG, GIF or WebP image — not attached`,
  imageTooLarge: (name: string, size: string) => `${name} is ${size}, over the 3.75 MB image limit — not attached`,
  imageTooMany: (limit: number) => `only the first ${limit} images were attached`,
  imageTextOnly: (spec: string) => `${spec} is set to "images": false — it gets a note instead of the image`,
  imageRejectedHint: (spec: string) => `this conversation has images — if ${spec} can't take them, set "images": false for it in config.json and they'll be sent as a note`,
  clipboardReading: "reading the clipboard…",
  clipboardNoImage: "no image on the clipboard",
  clipboardUnsupported: (tool: string) => `can't read images from the clipboard here — needs ${tool}`,


  // ─────────────────────────────────────────── Model
  modelCurrent: (spec: string) => `model: ${spec}`,
  modelWindow: (limit: string, budget: string) => `${limit} window · ${budget} usable`,
  modelSwitched: (spec: string) => `switched to ${spec}`,
  modelAlready: (spec: string) => `already on ${spec}`,
  modelRemembered: "remembered as the default for next time",
  /**
   * Not saved: the environment variable overrides config at startup, so a saved default
   * would be quietly ignored — without saying so, the next launch would inexplicably
   * switch back
   */
  modelEnvWins: (variable: string) =>
    `not remembered: $${variable} is set and wins at startup — unset it, or change it there too`,
  modelUsage: "/model <provider>/<model>",
  modelChoicesTitle: "known here:",
  /** A provider with no candidates to list isn't broken — nobody told us what it accepts */
  modelNoChoices: "no candidates configured — any provider/model still works, and providers.<id>.models fills this list",
  modelKeepsHistory: "the conversation carries over; earlier reasoning is dropped (it does not transfer between models)",
  modelNoThinking: (spec: string) => `${spec} has no extended thinking — /think stays on but does nothing here`,
  // ─────────────────────────────────────────── Remembered allows
  modeForgetHint: "forget everything you allowed with [a] here",
  rememberedTitle: (n: number) => (n === 1 ? "1 rule remembered here" : `${n} rules remembered here`),
  rememberedMore: (n: number) => `+${n} more`,
  rememberedHowTo: "/permission forget clears them",
  forgotNothing: "nothing was remembered here.",
  forgotApprovals: (n: number) => (n === 1 ? "forgot 1 remembered rule." : `forgot ${n} remembered rules.`),
  bannerRemembered: (n: number) => (n === 1 ? "1 remembered rule" : `${n} remembered rules`),

  // ─────────────────────────────────────────── View
  unknownView: (value: string, known: string) => `unknown view "${value}" — try: ${known}`,
  currentView: (label: string, hint: string) => `view: ${label} — ${hint}`,

  // ─────────────────────────────────────────── Language
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

  // ─────────────────────────────────────────── Context usage
  ctxTitle: "context",
  ctxSystem: "system prompt",
  ctxTools: "tool definitions",
  ctxMcpTools: "MCP tools",
  ctxSkills: "skills",
  ctxSummary: "compacted summary",
  ctxMemory: "project memory",
  ctxUser: "your messages",
  /**
   * The repo snapshot attached at the start. See prompt/git.ts — in the store it looks
   * just like what you said
   */
  ctxEnv: "repo snapshot",
  /**
   * ★ Reports handed back by subagents + receipts from the wrap-up check. See SLICE_KEYS
   * in agent/context.ts
   */
  ctxHandoff: "reports handed back",
  ctxReply: "replies",
  ctxThinking: "thinking",
  ctxCall: "tool calls",
  ctxResult: "tool results",
  ctxFree: "free",
  ctxWindow: (window: string, full: string) =>
    `window ${window} — ${full} counts as full; the rest is held back for the reply and for compacting`,
  ctxWindowGuessed: "this model did not report a window size, so 256k is used — change it in /setting → Context & output limits",
  ctxMessages: (n: number) => (n === 1 ? "1 message in context" : `${n} messages in context`),
  ctxFolded: (n: number) => `${n} already folded away`,
  /**
   * This line is the report's statement of honesty; don't delete it — see the top of
   * agent/context.ts
   */
  ctxSplitEstimated: "Current context occupancy uses provider measurement; its breakdown is estimated locally",
  ctxAllEstimated: "Current context occupancy is estimated locally; no applicable provider measurement is available",
  ctxCompactHint: "/compact folds the history into a handoff summary and frees most of it",
  /** The tail of a subagent's "done" receipt. */
  ctxSpentShort: (input: string, output: string) => `${input} in · ${output} out`,
  /**
   * "This session" is not "since this launch" — when resuming an old session, what it
   * spent before counts too (see the seed in ContextMeter.resetSpend), and it **includes
   * the subagents sent out**.
   */
  ctxSpent: (total: string, input: string, output: string) =>
    `this session has spent ${total} tokens — ${input} in, ${output} out`,
  ctxSpentCached: (cached: string) => `${cached} of that came from cache`,
  /** Why this number is much bigger than the window. Unexplained, it looks like a bug */
  ctxSpentScope: "Cumulative usage can combine models, subagents and classifiers; restored auxiliary usage may be incomplete. Reference only, not a billing total.",
  ctxSpentWhy: "every turn re-sends the whole history, so this grows far past the window",
  ctxNearlyFull: (percent: number) => `context ${percent}% full — /compact frees most of it`,

  // ─────────────────────────────────────────── Compaction
  compacting: "compacting — reading the session and writing a handoff…",
  /**
   * The automatically triggered one. Must make clear it acted **on its own** — the user
   * didn't press anything
   */
  compactingAuto: "context nearly full — compacting on its own, reading the session…",
  /**
   * The last few turns are kept as they were. Without this line, "40 messages folded"
   * reads like "the last few turns are gone too"
   */
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
  /** When replaying an old session, the line a compaction point leaves in the scrollback */
  compactedMarker: (n: number) => `context compacted here — ${n} messages folded into a summary`,

  // ─────────────────────────────────────────── Check before wrapping up
  checkRunning: (id: string) => `${id} — checking your edits…`,
  checkPassed: (id: string) => `${id} passed`,
  /** Failed. The first output line follows — a "failed" with no content says nothing */
  checkFailed: (id: string, first: string) => `${id} failed — ${first}`,
  /** It was already this error last turn; these edits didn't cause it */
  checkStill: (id: string) => `${id} still failing (unchanged since before these edits)`,
  checkUnavailable: (id: string, why: string) => `${id} did not run (${why})`,
  checkSkipped: "automatic checks are off for this session",
  checkNone: "no project check found here (looked for tsconfig.json + a local tsc, Cargo.toml, go.mod)",
  checkOffNow: "automatic checks off — turn them back on with /check on",
  checkOnNow: (command: string) => `automatic checks on — ${command}`,
  checkNothing: "nothing to check — no files were edited",
  checkOnHint: "run it automatically before it answers",
  checkOffHint: "only when you ask with /check",
  // ─────────────────────────────────────────── Background jobs
  /**
   * Both start and end leave a line. An invisible background process is invisible
   * automation
   */
  jobStarted: (id: string, command: string) => `${id} started in the background — ${command}`,
  jobEnded: (id: string, how: string) => `${id} finished — ${how}`,
  /** Top line when it doesn't fit. Plain truncation would leave no trace of what was cut */
  jobsMore: (n: number) => `${n} more running`,
  jobExitKilled: (signal: string) => `killed by ${signal}`,
  jobExitCode: (code: string) => `exit ${code}`,
  /**
   * The subagent receipts (observer in cli/main.ts). They must show at a glance that this
   * one isn't a process — it burns tokens, not CPU
   */
  agentStarted: (id: string, task: string) => `${id} — subagent working on ${task}`,
  agentEnded: (id: string, how: string) => `${id} — subagent ${how}`,
  agentDone: (steps: number) => (steps === 1 ? "done in 1 step" : `done in ${steps} steps`),
  agentFailed: (why: string) => `stopped: ${why}`,
  agentStopped: "stopped by you",
  agentThinking: "thinking",
  /** Stopping them when switching to a new session. See clearCommand in cli/main.ts */
  agentsStopped: (n: number) => (n === 1 ? "stopped 1 subagent from the previous session" : `stopped ${n} subagents from the previous session`),

  // ─────────────────────────────────────────── agentflow (see agentflowCommand in cli/main.ts)
  // ★ Two numbers, not one. "At most 6 at once" used to be the only number written here,
  //   and what the user read was "this mode sends out at most 6 people" — exactly the
  //   impression it's meant to break. 6 is how many **work at the same time**; up to 100
  //   can be lined up in total
  agentflowOn: (running: number, total: number) => `agentflow: on — up to ${total} subagents, ${running} working at once`,
  agentflowOff: "agentflow: off",
  agentflowHint: "it fans work out by default: many subagents at once, chained — it still edits and runs things itself",
  agentflowOffHint: (window: number) => `back to one thing at a time, with the occasional subagent (${window} at a time)`,
  agentflowRemembered: "remembered — /agentflow switches it",
  agentflowUsage: (min: number, max: number) => `/agentflow, or /agentflow on | off | ${min}-${max}`,
  agentflowBadWidth: (value: string, min: number, max: number) =>
    `"${value}" is not a number of subagents between ${min} and ${max}`,
  /**
   * ★ The warning when turning flow on in confirm mode. See the option picked in
   * AskUserQuestion: warn, don't force
   */
  agentflowConfirmWarning:
    "permission mode is confirm — a dozen subagents will queue up a dozen prompts in front of you. /permission auto first, unless that is what you want",
  /** Startup banner. You can forget what was saved, you can't forget what's on screen */
  agentflowBanner: (running: number, total: number) => `agentflow on — up to ${total} subagents, ${running} at once`,

  // ─────────────────────────────────────────── It asks you something (see tool/ask.ts)
  askSomethingElse: "something else…",
  askPlainHintSingle: "press 1-9 to pick · o to type your own · ⏎ = 1 · esc dismiss",
  askPlainHintMultiple: "press 1-9 to toggle · o to type your own · ⏎ confirm · esc dismiss",
  /** Only shown when there is an earlier question to go back to. See canBack in cli/ask.ts */
  askPlainHintBack: "← previous question",
  /** The live question card (AskCard in cli/ask.ts). Keys stay keys, see the header */
  askCardHintSingle: (options: number) => `⏎ select · ↑↓ move · 1-${options} pick · or just type · esc dismiss`,
  askCardHintMultiple: "⏎ / space toggle · ↑↓ move · esc dismiss",
  askCardHintTyping: "⏎ send · ↑↓ back to the options · esc dismiss",
  /** Only when revisiting a question that already has an answer */
  askCardHintKeep: "→ keep this answer",
  /** The row that submits a multiple-choice card */
  askDone: "Done",
  askDismissed: "dismissed",
  /**
   * What to say when there's no TTY. "Nobody to ask" and "nobody answered" are two
   * different things, see tool/ask.ts
   */
  askNobody: "nobody to ask",
  moreQuestions: (n: number) => (n === 1 ? "1 more question" : `${n} more questions`),

  // ─────────────────────────────────────────── Resuming a session
  resumeTitle: "resume a session",
  resumeEmpty: "nothing to resume in this directory yet.",
  resumeKeys: "↑↓ pick · enter resume · esc cancel",
  resumeBusy: "still running — stop it with esc first",
  resumeCurrent: "already in this one",
  resumed: (messages: number) => `resumed — ${messages} messages restored`,
  continueNone: "no earlier session here — starting a new one.",
  sessionMessages: (n: number) => `${n} msgs`,
  sessionUntitled: "(untitled)",
  agoNow: "just now",
  agoMinutes: (n: number) => `${n}m ago`,
  agoHours: (n: number) => `${n}h ago`,
  agoDays: (n: number) => `${n}d ago`,

  // ─────────────────────────────────────────── Command descriptions
  /** ── Hints for the "add nothing" candidate. See bareHint in cli/commands.ts ── */
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
  /** ── Two steps, the same rule as /reset: without confirm, only list what would go ── */
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
  /**
   * ★ We don't go scanning for the .alfa/ dirs scattered across repos; we hand the user
   * the command. See the header comment in cli/uninstall.ts
   */
  uninstallProjectDirs: "Project notes live in each repository you ran /init in. This lists them:",
  uninstallPathNote: (dir: string) =>
    `${dir} is left alone — other tools live there. If you added it to PATH just for alfa, remove that line yourself.`,

  // ─────────────────────────────────────────── /history-clean
  /** ── Two steps: without confirm, only list. See cleanHistoryCommand in cli/main.ts ── */
  cmdCleanHistory: "delete old sessions from the local history (a week and older by default)",
  cleanDaysWeek: "a week",
  cleanDaysMonth: "a month",
  cleanDaysQuarter: "three months",
  cleanTitle: (days: number) => `Sessions with nothing new for more than ${days} days:`,
  cleanCounts: (sessions: number, messages: number) => `${sessions} sessions · ${messages} messages`,
  /**
   * The subagent sessions go along with them. The user never opened those, so say
   * separately what they are
   */
  cleanAgents: (n: number) => `${n} subagent sessions belonging to them go too`,
  cleanRange: (oldest: string, newest: string) => `oldest ${oldest}, newest ${newest}`,
  cleanMoreDirs: (n: number) => `and ${n} more directories`,
  cleanWarn: "cannot be undone — these leave /resume for good",
  cleanKeeps: "the session you are in now is kept, however old it is",
  cleanConfirm: (command: string) => `Type ${command} to go ahead.`,
  cleanNothing: (days: number) => `nothing older than ${days} days — the history is already tidy`,
  cleanDone: (sessions: number, messages: number) => `deleted ${sessions} sessions and ${messages} messages`,
  cleanFreed: (size: string) => `freed ${size}`,
  /**
   * Another instance has the database open, so the file couldn't be shrunk this time.
   * The data is already deleted, so this isn't an error
   */
  cleanNotShrunk: "the database file could not be shrunk right now — the sessions are gone all the same",
  cleanBadDays: (value: string) => `"${value}" is not a number of days`,
  cleanUsage: "/history-clean, /history-clean 30, or /history-clean 30 confirm",

  cmdThink: "turn extended thinking on or off (remembered)",
  cmdEffort: "how hard the model thinks, low … max (remembered)",
  cmdAgentflow: "let it run many subagents at once, in a pipeline (remembered)",
  cmdResume: "pick an earlier session and keep going",
  cmdSetting: "every setting on one screen — model, providers, permissions, trust, language, …",
  cmdView: "kept for old habits — the transcript is the only view now",
  cmdLanguage: "set the interface language, or the language the model replies in",
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
  // ── /trust. See cli/trust.ts ──
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
  trustClean: "nothing steering, so this folder is trusted from now on. AGENTS.md / CLAUDE.md reach the main agent on its next step; /clear starts a new session that also loads project memory and a fresh repository snapshot from the first message",
  trustConcerns: "potential prompt injection found. This project's content remains isolated.",
  trustUnreadable: "the review came back without a verdict. This folder stays untrusted.",
  /**
   * ★ Meaning first, and **not one character** of the path. This line lands in the
   *   middle column (often only 36 columns wide), and if the path came first, what gets
   *   cut off is exactly the "not loaded" half — the user sees a yellow warning with
   *   their own path in it and no idea what it's saying. Which workspace it is, the
   *   status line always shows.
   */
  trustBanner: "this folder is not trusted — its AGENTS.md / CLAUDE.md are not loaded · /trust",
  trustBannerChecking: "looking this folder over — its AGENTS.md / CLAUDE.md stay out until then · /trust",
  trustBannerConcerns: "potential danger found in this folder — project content remains isolated · /trust",
  trustConcernAction: "Confirm the source with /trust on, or ask the main agent to remove the harmful content and then run /trust check.",
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
  /**
   * The banner line: how many server definitions **couldn't be read**. See the star on
   * mcpCommand
   */
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
  /**
   * What was created. Things that already existed aren't listed — reporting an action
   * that didn't happen makes people think the file was overwritten
   */
  initCreated: (paths: string) => `created ${paths}`,
  /**
   * The folder couldn't be created (read-only mount, no permission). The conventions-file
   * half is still written
   */
  initScaffoldFailed: (why: string) => `could not create .alfa/ (${why})`,
  initWriting: "reading the project — AGENTS.md will land at the repo root",

  // ─────────────────────────────────────────── /upgrade
  /**
   * Argument hints. check is "just look", force is "reinstall even if already on the
   * latest"
   */
  upgradeForceHint: "download and install again even if this is already the latest",
  upgradeUsage: "/upgrade, or /upgrade force",
  upgradeUnknown: (value: string) => `"${value}" is not "force"`,
  /**
   * The three below are progress events from update/upgrade.ts; the wording belongs to
   * the UI
   */
  upgradeChecking: "checking for a newer release…",
  /** ── The ones used by the exclusive overlay ── */
  upgradeTitle: "upgrade",
  upgradeFrom: (version: string) => `on ${version}`,
  upgradeDownloadingNow: "downloading…",
  upgradeVerifying: "verifying the download…",
  upgradeInstalling: "installing…",
  upgradeCancelled: "cancelled — nothing was replaced",
  /**
   * While downloading, esc means "stop downloading". This box takes all keys, so it must
   * spell out the only way out
   */
  upgradeCancelHint: "esc cancel — everything else waits until this finishes",
  upgradeClose: "enter / esc to close",
  upgradeDownloading: (tag: string, asset: string) => `downloading ${tag} (${asset})…`,
  upgradeCurrent: (version: string) => `already on the latest release (${version})`,
  /** ★ If we can't find out, say so. Reporting "already the latest" is confidently wrong */
  upgradeUnreachable: "could not reach the release feed — no idea whether a newer version exists",
  /**
   * Replaced. **The "restart" half can't be left out** — what got replaced is the file on
   * disk; the process running right now is still the old one, and without saying so the
   * user would think the new features are there immediately
   */
  upgradeDone: (from: string, to: string) => `${from} → ${to} — restart alfa to run the new one`,
  upgradeFailed: (why: string) => `upgrade failed: ${why}`,

  // ─────────────────────────────────────────── Startup banner
  bannerModel: "model",
  bannerCwd: "cwd",
  bannerRoot: "root",
  bannerWindow: "window",
  /**
   * Conventions files loaded into the prompt. Invisible input must be stated; it changes
   * every answer
   */
  bannerRules: "rules",
  rulesNone: "none",
  rulesMore: (n: number) => `+${n} more`,
  /**
   * Notes the model wrote itself. They go along with every answer, so say how many there
   * are
   */
  rulesMemos: (n: number) => `${n} note${n === 1 ? "" : "s"}`,
  /**
   * This project doesn't have its own yet. The only "here's something you can do" line
   * in the whole banner
   */
  rulesInitHint: "— /init writes one for this project",
  /** Banner notice when falling back to PowerShell / cmd */
  bannerShellFallback: (label: string) =>
    `commands run through ${label} — install Git for Windows for a real bash, or point ALFA_SHELL at one`,
  /**
   * That banner line: `1m · 900k usable`. How big the window is should be known before
   * work starts
   */
  bannerWindowValue: (window: string, budget: string) => `${window} · ${budget} usable`,

  // ─────────────────────────────────────────── Copy (ctrl-y; unbound, copy* unused)
  // ── The spots that used to hard-code text, bypassing t.* ──
  // ★ Key names (Y/a/n, ctrl-c) are never translated
  /** The permission box line, see cli/confirm.ts */
  promptAllowOnce: "allow once",
  promptAlways: "always",
  promptReject: "reject",
  /**
   * ★ What the box says after a keypress it couldn't recognize. **The way out goes
   * first, the reason after.**
   *
   * The box can be as narrow as 30 columns, and truncation always starts at the tail —
   * so the tail must be the half that "can be lost without stopping them from getting
   * the job done". It used to be the other way round: at 80 columns it got cut to
   * "…before they get here…", and what got eaten was exactly "⏎ allows".
   */
  promptImeHint: "⏎ allows, esc rejects — your input method is taking the letter keys",
  promptKeyHint: "⏎ allows, esc rejects — that key does nothing here",
  promptParseUnsure: "could not parse this command reliably — review the full text above",
  promptNoKeyboard: "cannot read a key",
  /** The status line while idle (statusLine in cli/shell.ts) */
  plainExitHint: "ctrl-c ×2 to exit",
  treeEmpty: "(empty)",
  resetConfigWhat: "settings, and the global AGENTS.md if you wrote one",
  resetDataWhat: "API keys, every session, input history, saved tool output",
  resetProjectWhat: "notes this agent wrote about this project",

  // ─────────────────────────────────────────── /setting (see cli/settings.ts)
  settingNoScreen: "Settings require interactive input. Use /model /permission /access /trust /language /check in pipes.",
  settingsTitle: "settings",
  /**
   * Section names say **where it's stored**: this section is per folder, the ones below
   * are global
   */
  settingsFolderSection: "this folder",
  settingsAgentSection: "the agent",
  settingsModelSection: "model",
  settingsLanguageSection: "language",
  settingsOn: "on",
  settingsOff: "off",
  settingsView: "view",
  settingsViewSession: "conversation",
  settingsViewStream: "stream",
  settingsTrust: "trust",
  settingsTrustHint: "whether this folder's AGENTS.md, .alfa/memory and .alfa/skills reach the model",
  settingsTrustedAt: (day: string) => `trusted on ${day}`,
  settingsTrustYes: "trusted",
  settingsTrustNo: "untrusted",
  settingsTrustCheck: "look it over",
  settingsPermission: "permission",
  settingsThinking: "extended thinking",
  settingsAgentflow: "agentflow",
  settingsAutoCompact: "auto-compact",
  settingsAutoCompactHint: "fold the session into a handoff summary when the context window fills",
  settingsCheck: "check before handing back",
  settingsCheckNone: "no type-check or build was detected in this project",
  settingsCheckCommand: (command: string) => `runs: ${command}`,
  settingsModel: "model",
  settingsModelHint: "switching keeps the whole conversation — only thinking blocks are dropped",
  settingsModelTitle: "model",
  settingsModelCurrent: "this is the one in use",
  settingsModelSwitch: "⏎ switch to this one",
  settingsKeysRow: "API keys",
  settingsKeysHint: "stored 0600 in your home directory, never in the project",
  settingsKeysCount: (n: number) => (n === 1 ? "1 provider" : `${n} providers`),
  settingsKeysTitle: "API keys",
  settingsKeysEmpty: "no providers configured — add one with: alfa auth login",
  settingsKeyMissing: "no key",
  settingsKeySourceEnv: "from the environment",
  settingsKeySourceFile: "stored",
  settingsKeyHint: "⏎ open to replace or remove this key",
  settingsKeyFromEnv: (id: string) => `an environment variable is set for ${id} — it wins over anything stored here`,
  settingsKeyPaste: "paste a new key",
  settingsKeyPasteHint: "⏎ then paste. It is never echoed and never shown again.",
  settingsKeySaved: (id: string) => `saved the key for ${id}`,
  settingsKeyEmpty: "nothing was pasted",
  settingsKeyWhitespace: "the key contains whitespace — check for a stray copy/paste artifact",
  settingsKeyRemove: "remove the stored key",
  settingsKeyRemoveHint: "deletes it from auth.json. Environment variables are not touched.",
  settingsKeyRemoved: (id: string) => `removed the stored key for ${id}`,
  settingsLanguageInterface: "interface",
  settingsLanguageReply: "replies",
  settingsLanguageAuto: "auto",
  settingsChanged: (what: string, value: string) => `${what}: ${value}`,
  settingsKeys: "↑↓ pick · ←→ change · ⏎ open · esc back",
  settingsPickKeys: "↑↓ pick · ⏎ choose · esc back",
  settingsSecretKeys: "paste it, then ⏎ · esc cancel",
  settingsSecretHint: "the key is not echoed — paste and press enter",

  // ─────────────────────────────────────────── First time in a folder
  /**
   * See cli/folder-setup.ts. The point of the wording: this is a preference of **this
   * machine**, not a property of the repo
   */
  folderSetupTitle: (path: string) => `First time here — ${path}`,
  folderSetupWhere: "Saved for this folder in your config. Nothing is written into the repo.",
  folderSetupTrust: "Trust this folder?",
  folderSetupTrustWhy: [
    "Its AGENTS.md / CLAUDE.md go into the system prompt, and .alfa/mcp.json",
    "can start processes. That is fine for your own code, less so for a repo",
    "you just cloned.",
  ],
  folderSetupTrustYes: "yes, get going",
  /**
   * The default option needs a hint too. If only the other one had one, it would read as
   * "there's nothing to say about the default"
   */
  folderSetupTrustYesHint: "its AGENTS.md and .alfa/ take effect from the first message",
  folderSetupTrustCheck: "look it over first",
  folderSetupTrustCheckHint: "read those files, then trust it if nothing looks off",
  /**
   * The "step N" at the right end of the title. The user should know how many steps
   * there are before pressing enter the first time
   */
  setupStep: (at: number, total: number) => `step ${at} of ${total}`,
  setupKeys: "↑↓ pick · ⏎ next · ⌫ back · esc take the defaults",

  // ─────────────────────────────────────────── Help
  promptSession: "session",
  helpPlain: [
    "  enter          send (queues while running)",
    "  ctrl-j         newline          esc      interrupt",
    "  ctrl-c         clear / exit     ctrl-d   exit",
    "  up/down        history",
    "  /setting /context /cache-hit /debugger /compact /check /detail /access /language /permission /trust",
    "  /think /agentflow /model /resume /clear /upgrade",
    "  /jobs /agents /history-clean /reset /help /exit",
  ].join("\n"),
}

export type Catalog = typeof en
