/**
 * CLI entry point. Wires all the parts together.
 *
 * ── Three run modes, one shared assembly ──
 *   -p "…"                run once and exit. No live area; output clean enough to pipe.
 *   interactive + TTY     an input box pinned at the bottom (shell.ts), output flows
 *                         past above it.
 *   interactive + pipe    can't take over the terminal, falls back to reading line by
 *                         line. CI and `echo … | alfa` take this path.
 *
 * The only differences are "who supplies the next message" and "is there a live area";
 * below that, the loop, tools and permissions are identical across all three.
 *
 * ── Must drain before exiting ──
 * See agent/runner.ts. Exit without waiting for cleanup and the child processes bash
 * started get adopted by init and keep running.
 */
import { Diagnostics, type DiagnosticSnapshot } from "../llm/diagnostics.ts"
import { debuggerMenu, renderCacheOverview } from "./debugger.ts"
import { aggregateExecutionUsage } from "../llm/execution-usage.ts"
import { CACHE_ADAPTERS } from "../llm/cache/protocols.ts"
import { OPENAI_CACHE_RULES } from "../llm/cache/openai.ts"
import { observeUsage, type UsageRecord } from "../llm/usage.ts"
import { redact } from "../util/redact.ts"
import { createHash } from "node:crypto"
import { Extensions } from "../extension/api.ts"
import { settings } from "./settings.ts"
import { terminalForm, type Form } from "./form.ts"
import { InputCancelled } from "./secret-input.ts"
import { AccessManager } from "../security/access.ts"
import { runtimeSnapshot } from "../security/runtime.ts"
import { runSsh } from "../security/ssh.ts"
import { SshHostAccess } from "../security/ssh-access.ts"
import { bwrapBlocked, sandboxBackend, sandboxStatus } from "../security/sandbox.ts"
import { sandboxMessage, sandboxStartupMessage } from "./sandbox-message.ts"
import { existsSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, relative, resolve, isAbsolute } from "node:path"
import { parseArgs } from "node:util"
import { checkReminder, detectChecker, runCheck, worthChecking } from "../agent/check.ts"
import { applyCompaction, createCompactor, type CompactFn, type CompactResult } from "../agent/compact.ts"
import { ContextMeter, contextReport, type ContextReport, type ContextSnapshot } from "../agent/context.ts"
import { Emitter, type UIEvent } from "../agent/events.ts"
import { isSettled, Loop, type Attachment } from "../agent/loop.ts"
import { createSessionTitler } from "../agent/session-title.ts"
import { Runner } from "../agent/runner.ts"
import { compactionIndex, liveHistory } from "../agent/to-model-messages.ts"
import { billedFromHistory, usable } from "../agent/tokens.ts"
import { streamWithRetry } from "../llm/retry.ts"
import { stream } from "../llm/stream.ts"
import { buildRegistry, defaultModelSpec, resolveProviders } from "../llm/setup.ts"
import { resolveShell } from "../env/shell.ts"
import { setModelChoices } from "./commands.ts"
import { manualSetupHint, onboard, repairInvalidProviderType } from "./onboard.ts"
import { VERSION as ALFA_VERSION } from "../update/release.ts"
import { upgrade, sweepParkedBinary, type UpgradeEvent } from "../update/upgrade.ts"
import { checkForUpdate } from "../update/check.ts"
import { performReset, resetScope, type ResetTarget } from "./reset.ts"
import { envNameInUse } from "../env/vars.ts"
import {
  FLOW_WINDOW,
  FLOW_WINDOW_MAX,
  FLOW_WINDOW_MIN,
  isFlowWindow,
  MAX_AGENT_JOBS,
  MAX_FLOW_ALIVE_JOBS,
} from "../agent/flow.ts"
import {
  loadConfig,
  saveConfig,
  configPath,
  rememberAgentflow,
  rememberCheck,
  rememberLanguage,
  rememberPermission,
  rememberAutoCompact,
  rememberAutoOutsideReads,
  rememberThinking,
  rememberEffort,
  rememberClassifierModel,
  setDefaultModel,
  InvalidProviderTypeError,
  type LanguageConfig,
  type TrustState,
} from "../config/config.ts"
import {
  isLanguageChoice,
  LANGUAGE_CHOICES,
  languageLabel,
  setInterfaceLanguage,
  t,
  uiText,
} from "../i18n/index.ts"
import { loadAuth } from "../config/auth.ts"
import { authCommand, authUsage } from "./auth.ts"
import { parseModelRef, resolveTypedModel } from "../llm/registry.ts"
import { isReasoningEffort, NoCredentialsError, REASONING_EFFORTS, UnknownModelError, type LLMRequest, type ModelInfo, type ModelRef, type ReasoningEffort } from "../llm/types.ts"
import { buildSystem } from "../prompt/system.ts"
import { discoverInstructions } from "../prompt/instructions.ts"
import {
  isFirstVisit,
  isEmptyFolder,
  needsTrustChoice,
  markTrust,
  rememberFolder,
  trustFor,
  trustsProjectInstructions,
  folderConfig,
} from "../config/folders.ts"
import { firstFolderReview, settleTrustReview, TRUST_AGENT_NAME, trustConcernNote, trustReadyNote, trustReviewPrompt, trustSummary } from "./trust.ts"
import { discoverMemories, renderMemories } from "../prompt/memory.ts"
import { gitContextBlock } from "../prompt/git.ts"
import { AGENTS_FILE, initPrompt, initScaffold } from "../prompt/init.ts"
import { forgetApprovals, loadApprovals, rememberApprovals, toRuleset } from "../permission/approvals.ts"
import { PermissionGate, type PromptFn, type PromptRequest } from "../permission/gate.ts"
import { createAutoDecider } from "../permission/auto/index.ts"
import { delegatedTask, userVoice } from "../permission/auto/evidence.ts"
import { createLLMClassifier } from "../permission/auto/llm.ts"
import { modeInfo, MODES, normalizeMode, type PermissionMode } from "../permission/mode.ts"
import type { Answer, AskDecision, Question } from "../tool/types.ts"
import { newMessageID, newPartID, newSessionID } from "../session/id.ts"
import { Store, type SessionInfo } from "../session/store.ts"
import type { MessageWithParts, ToolPart } from "../session/schema.ts"
import { killAll as killAllJobs, list as listJobs, read as readJob, kill as killJob, setJobObserver } from "../tool/bash/jobs.ts"
import type { JobSnapshot } from "../tool/background.ts"
import { SubagentJobs } from "../agent/subagent.ts"
import { subagentBlock } from "../prompt/subagent.ts"
import { ask } from "./ask.ts"
import { createToolContext } from "../tool/context.ts"
import { registerBuiltins } from "../tool/builtin.ts"
import { ToolRegistry } from "../tool/registry.ts"
import { forgetReads } from "../fs/freshness.ts"
import { PRODUCT, programName } from "./program.ts"
import { findProjectDirsCommand, performUninstall, runningFromSource, uninstallScope } from "./uninstall.ts"
import { findWorkspaceRoot, homePath, workspaceLabel, type WorkspaceLabel } from "../fs/workspace.ts"
import { configDir, dataDir, startToolOutputGC } from "../util/xdg.ts"
import { loadMcpConfig, type McpProblem, type McpServerConfig } from "../mcp/config.ts"
import { discoverSkills, LIBRARY_DIR, skillCatalogue, type SkillSet } from "../prompt/skills.ts"
import { builtinSkills } from "../prompt/builtin-skills.ts"
import { McpManager, MCP_SERVER_PERMISSION, type McpStatus } from "../mcp/manager.ts"
import { captureWarnings } from "../util/warnings.ts"
import { confirm, type ApprovalDraft } from "./confirm.ts"
import { renderContextReport, renderCacheMetrics, WARN_AT } from "./context.ts"
import { Editor } from "./editor.ts"
import { appendHistory, loadHistory, trimHistory } from "./history.ts"
import { Keyboard, terminalGone } from "./keyboard.ts"
import { LiveRegion } from "./live.ts"
import { FileIndex } from "./mentions.ts"
import { collectImages, displayPath, hasDataImage, imageReferences, saveClipboardImage, saveDataImages, type ImageProblem } from "./attachments.ts"
import { pickSession } from "./picker.ts"
import { commandLines, compact as compactNumber, duration, firstLine, Renderer, shortenPaths, userLines, toolDetails } from "./render.ts"
import { replay } from "./replay.ts"
import { relativeTime } from "./sessions.ts"
import { Shell } from "./shell.ts"
import { Activity, turnReceipt } from "./activity.ts"
import { footerLines } from "./footer.ts"
import { pinnedRows } from "./pinned.ts"
import { latestPlan } from "./plan.ts"
import { Tips } from "./tips.ts"
import { parseTodos, type TodoItem } from "../tool/todo.ts"
import { aggregateCacheDiagnostics } from "../llm/cache/index.ts"
import { displayWidth, padToWidth } from "./width.ts"
import { brandMark, clearInteractiveViewport } from "./brand.ts"
type NoteTone = "info" | "good" | "warn" | "bad"
import { setColorEnabled, theme, setTheme, currentTheme, type ThemeName } from "./theme.ts"

/**
 * The version comes from package.json (bun inlines the JSON into the binary at compile
 * time).
 *
 * Write it down in three places and sooner or later you get "the banner says 0.3.0, the
 * release page says v0.4.0" — and before a release CI checks that the tag matches it
 * (see .github/workflows/release.yml)
 */
const VERSION = ALFA_VERSION

/**
 * How long `-p` waits for subagents at most.
 *
 * The cap isn't distrust of them (they have their own step limit); it's that this path
 * mostly runs in scripts or CI, and a command that never returns is much harder to debug
 * than an incomplete answer.
 */
const ONE_SHOT_AGENT_LIMIT_MS = 15 * 60_000

/**
 * How long to allow for shutdown once the terminal is gone.
 *
 * This isn't about "is it enough" — a normal shutdown finishes in a few hundred ms. It's
 * the fallback for the case where shutdown **can't finish**: with no terminal nobody can
 * see that it's stuck, so on timeout we leave anyway.
 */
const HANGUP_SHUTDOWN_MS = 3_000

/**
 * Help is built on the fly rather than hard-coded as a constant: the name in the command
 * examples has to match the one the user just typed. See cli/program.ts — it may be
 * invoked under another name.
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
      --report <path>   write machine-readable invocation metrics
      --thinking        enable extended thinking where supported
      --effort <level>  low | medium | high | xhigh | max (default: provider's)
      --reasoning       show the model's reasoning as it streams
      --no-color        disable ANSI colors
      --no-markdown     print the model's replies as raw text
      --plain           compatibility alias (scrollback is now the default)
      --no-mouse        compatibility alias; native selection is always enabled
      --permission <m>  confirm | default | auto (shift-tab switches it live)
  -h, --help            show this help
  -v, --version         print version

Interactive keys:
  enter                 send (queues while a turn is running)
  ctrl-j / alt-enter    newline
  ctrl-l                clear and redraw the viewport
  ctrl-v                paste an image from the clipboard (also: @image.png)
  esc                   interrupt the current turn
  /detail               retrieve full tool output from the session
  shift-tab             permission mode (confirm / default / auto)
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
  // ★ The very first thing. Once a warning is printed it can't be taken back, and which
  //   frame it lands on is random — so this channel must be rerouted before anything
  //   starts drawing (see util/warnings.ts)
  captureWarnings()
  // auth has its own set of arguments; split it off first, don't mix it with the main
  // command's parseArgs
  if (argv[0] === "auth") return authSubcommand(argv.slice(1))
  // Same for upgrade. It runs **before any config** — with a broken old install, the first
  // thing the user should be able to do is replace it, not go configure a provider first
  if (argv[0] === "upgrade") return upgradeSubcommand(argv.slice(1))
  // Same for uninstall, and even more so before config: someone who "doesn't want this
  // anymore" shouldn't be made to configure a provider before being allowed to leave. It
  // also has **only** this one entry point — see the header comment of cli/uninstall.ts
  if (argv[0] === "uninstall") return uninstallSubcommand(argv.slice(1))

  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        report: { type: "string" },
        prompt: { type: "string", short: "p" },
        model: { type: "string", short: "m" },
        cwd: { type: "string", short: "c" },
        thinking: { type: "boolean", default: false },
        effort: { type: "string" },
        reasoning: { type: "boolean", default: false },
        // ⚠ Node's parseArgs does **not support** automatic --no-xxx negation (with no hint
        //   whatsoever; it just reports "Unknown option"). To get --no-color you must
        //   declare a no-color explicitly. If help lists it but it isn't declared, a user
        //   typing it as shown gets an error — this project has been bitten once already.
        "no-color": { type: "boolean", default: false },
        // Same as above: every --no-xxx must be declared explicitly
        "no-mouse": { type: "boolean", default: false },
        "no-markdown": { type: "boolean", default: false },
        plain: { type: "boolean", default: false },
        // Both are long options only: -c is already --cwd, and making a -c mean --continue
        // would trade one letter for a whole class of "I thought it changed directory"
        // accidents
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

  // Color: an explicit --no-color wins; otherwise go with picocolors' NO_COLOR / TTY check
  if (flags["no-color"] === true) setColorEnabled(false)

  /** CLI flag > config. The config value is left by the last /permission or shift-tab */
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
  // Checked here, before any config is read, for the same reason as --permission: a typo
  // must stop the run, not quietly fall back to the provider default and leave the user
  // believing they asked for max
  if (flags.effort !== undefined && flags.effort !== "default" && !isReasoningEffort(flags.effort)) {
    process.stderr.write(theme.red(`Unknown effort level "${flags.effort}".\n`))
    process.stderr.write(theme.dim(`Try: ${REASONING_EFFORTS.join(", ")}, default\n`))
    return 2
  }

  const cwd = flags.cwd ? resolve(flags.cwd) : process.cwd()
  const root = findWorkspaceRoot(cwd)
  const invocationStarted = Date.now()
  const usageRecords: UsageRecord[] = []
  // The debugger needs observations from before it was opened. Its ring stays bounded;
  // only an explicit report keeps the complete invocation history.
  const diagnostics = new Diagnostics()
  const stopUsage = observeUsage(record => {
    diagnostics.add(record)
    if (flags.report) usageRecords.push(record)
  }, { cache: true })
  let approvalCount = 0
  let interruptions = 0
  const oneShot = flags.prompt !== undefined
  /**
   * Whether we can ask the user something right now.
   *
   * Both ends must be terminals: if stdin isn't, nobody can answer (the `echo … | alfa`
   * path); if stdout isn't, the question can't be seen (output is going to a pipe or a
   * log). Same for -p — its contract is "run once, print, exit", and popping a prompt
   * midway would leave the calling script hanging.
   */
  const canPrompt = (): boolean => !oneShot && process.stdin.isTTY === true && process.stdout.isTTY === true

  // ── Model ──
  let config: import("../config/config.ts").Config
  let auth
  for (;;) {
    try {
      config = loadConfig()
      auth = loadAuth()
      break
    } catch (error) {
      // ★ A malformed type still gets a safe repair path that doesn't depend on a model.
      // Other config errors don't carry enough information to guess from, so we exit as
      // before; a non-interactive call certainly must not suddenly wait for keyboard input.
      if (error instanceof InvalidProviderTypeError && canPrompt()) {
        if (await repairInvalidProviderType(error)) continue
        return 0
      }
      process.stderr.write(theme.red(`${(error as Error).message}\n`))
      return 1
    }
  }

  // If the command line didn't say, use the saved mode. Any active non-default mode is
  // shown on the startup banner together with the key that changes it.
  if (startMode === undefined && config.permission !== undefined) startMode = config.permission
  // auto is the product's main path. The choice lives in the CLI assembly layer, so a bare
  // construction of the low-level PermissionGate class doesn't also become full host
  // permission; tests and standalone callers that don't choose explicitly still safely
  // stay at default.
  if (startMode === undefined) startMode = "auto"

  // The language must be settled **before any line of copy appears** — including the
  // error messages below. Set the interface language first and then report "no model",
  // so the user doesn't see one line in English followed by one in Chinese
  const language: Required<LanguageConfig> = {
    interface: config.language?.interface ?? "auto",
    reply: config.language?.reply ?? "auto",
  }
  setInterfaceLanguage(language.interface)
  setTheme(config.appearance?.theme ?? "terminal")

  let registry = buildRegistry({ config, auth })
  let spec = flags.model ?? defaultModelSpec({ config, auth })
  /**
   * Extended thinking. **Mutable** — `/think` changes it on the spot, effective next turn.
   *
   * `--thinking` is only this run's initial value: if the command line says so, follow
   * it; otherwise use the value stored in config.
   */
  let thinking = flags.thinking === true || config.thinking === true
  /**
   * Reasoning effort. **Mutable** — `/effort` changes it, effective from the next request.
   * undefined = send nothing (each provider's default). Same precedence as thinking: the
   * command line for this run, otherwise what config remembers; `--effort default`
   * overrides a remembered level for one run without forgetting it.
   */
  let effort: ReasoningEffort | undefined = flags.effort === "default"
    ? undefined
    : isReasoningEffort(flags.effort) ? flags.effort : config.effort
  /** Self-compact when nearly full. **On by default** — see autoCompact in config.ts */
  let autoCompact = config.autoCompact !== false
  /**
   * This folder's trust state. **Mutable** — the "take a look first" path flips it
   * mid-session, and so does `/trust`. For who reads it, see the trustProject star in
   * buildSystemParts.
   */
  let trust = trustFor(root, config)
  let trustConcern = folderConfig(root, config)?.concern
  let needsTrustPrompt = needsTrustChoice(root, config)
  const emptyFolder = isFirstVisit(root, config) && isEmptyFolder(root)
  /**
   * agentflow: when on, the max number of concurrent subagents; false = off. **Mutable**,
   * `/agentflow` changes it on the spot.
   *
   * It is the single source of truth for three things at once: the scheduler's window
   * (SubagentDeps.flow), the section in the system prompt (prompt/agentflow.ts), and that
   * line on the banner. Keep a copy in each of the three and after a toggle, an error like
   * "the UI says it's on, the model doesn't know" takes a whole turn to surface
   */
  let agentflow: number | false = isFlowWindow(config.agentflow) ? config.agentflow : false
  /**
   * Nothing is configured.
   *
   * ★ With a terminal, **guide**; only without one, report an error. The first run is the
   *   only moment this program can assume "the user doesn't know anything yet", and
   *   spending it on printing an error is a waste (see cli/onboard.ts). The pipe and -p
   *   paths still exit with one line — there's nobody to ask there, and a script stuck
   *   on a prompt waiting for input is much harder to debug than an error message.
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
    // Onboarding just wrote a provider and key to disk, so both must be reloaded — the
    // copy in hand is a snapshot from process start, and a registry built from it
    // doesn't contain the provider we just saved
    spec = result.spec
    config = loadConfig()
    registry = buildRegistry({ config, auth: loadAuth() })
  }

  /**
   * The current model. **A mutable box**, not three variables — same reason as session:
   * `/model` swaps it while the program is running, and the system prompt, every turn's
   * request, the context gauge and compaction — four places — must all follow.
   * If each captured its own copy, only some of them would switch, which shows up as
   * "it says it switched, but the status line still shows the old model".
   *
   * All three must change together: spec is the string for humans (banner, status line,
   * `/context`), ref is what requests use, info is how big the window is and whether it
   * was guessed or looked up.
   */
  let model: { spec: string; ref: ModelRef; info: ModelInfo }
  try {
    // Resolve once up front: missing credentials must be spelled out before the user
    // types anything
    model = { spec, ref: parseModelRef(spec), info: registry.resolve(spec).info }
  } catch (error) {
    if (error instanceof NoCredentialsError || error instanceof UnknownModelError) {
      // A model is configured but there's no key for it — equally "not set up yet", equally
      // worth one round of onboarding. An unrecognized model name gets no onboarding:
      // that's not unconfigured, it's a typo, and the user should see the raw message
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

  // Which models `/model` lists on tab. Filled once per session — the registry doesn't
  // change for the lifetime of the process
  setModelChoices(registry.catalog())

  // ── Assembly ──
  const store = new Store()
  /**
   * The current session. **A mutable box**, not an id.
   *
   * `/resume` swaps it while the program is running, and the loop and tool context
   * must both follow. If each captured its own id, only one of
   * them would switch — which shows up as "resumed the old session, but new messages are
   * written next door to it", with no error.
   */
  const session = { id: newSessionID() }
  // --continue doesn't need to ask anyone, so it can be settled before assembly. --resume
  // needs a pick, which means waiting on the keyboard, so it happens in the interactive
  // section (see openResume)
  const continued = flags.continue === true ? store.latestSession(cwd) : undefined
  if (continued) session.id = continued.id
  else store.createSession(session.id, cwd)
  startToolOutputGC()
  // The .old left by the last self-update on Windows is no longer held by anyone (see
  // update/upgrade.ts)
  sweepParkedBinary()

  const isTTY = process.stdout.isTTY === true && process.stdin.isTTY === true
  // -p / pipe mode gets no live area: output mostly goes to a pipe or log, and cursor
  // control sequences would only pollute it
  /**
   * Filled in by Shell in interactive mode: a resize must re-lay-out the input box at the
   * new width, not redraw it as-is
   */
  let onResize = (): void => {}
  const region = new LiveRegion({
    enabled: !oneShot && isTTY,
    onResize: () => onResize(),
  })
  /**
   * Rendering writes straight into the terminal scrollback, redrawing only the unfinished
   * tail line.
   */
  const renderer = new Renderer({
    sink: region,
    width: () => region.width,
    toolOutput: config.appearance?.toolOutput ?? "compact",
    // --reasoning streams the thinking in full for this run; otherwise the saved choice,
    // and interactive defaults to the live tail + receipt. -p stays silent (see Renderer)
    reasoning: flags.reasoning === true ? "full" : oneShot || process.stdout.isTTY !== true ? "off" : (config.appearance?.reasoning ?? "preview"),
    root,
    // Same line of judgment as color: if output goes into a pipe, everything stays raw.
    // Bold and bullets are noise to downstream programs, and stuffing -p output into
    // scripts is a real use
    markdown: flags["no-markdown"] !== true && process.stdout.isTTY === true,
    // Speaker labels are for humans. Output from -p and pipes gets eaten by other
    // programs, and one more `◆ agent` line is one more line of noise downstream must
    // filter
    speakers: !oneShot && process.stdout.isTTY === true,
  })
  const emitter = new Emitter<UIEvent>()
  emitter.on((event) => renderer.handle(event))
  // What the main agent is doing, for the running line. Only the main emitter feeds it:
  // subagents have their own streams and their own row (cli/pinned.ts)
  const activity = new Activity()
  emitter.on((event) => activity.handle(event))
  /**
   * The main agent's current checklist, for the pinned plan row. Fed by its own todo
   * calls; on session switch and compaction it is recomputed by latestPlan so it always
   * equals the list the model is actually sent.
   */
  const plan: { items: TodoItem[] } = { items: [] }
  emitter.on((event) => {
    if (event.type !== "tool.state" || event.part.tool !== "todo" || event.part.state.status !== "completed") return
    if (event.part.state.metadata["cleared"] === true) { plan.items = []; return }
    const items = parseTodos(event.part.state.metadata["todos"])
    if (items.length > 0) plan.items = items
  })
  /**
   * Something the pinned rows show changed outside the main event stream (a subagent's
   * step, a background process starting or dying). The interactive shell installs the
   * repaint; everywhere else it stays a no-op.
   */
  let liveChanged = (): void => {}

  /**
   * The live-area end. Filled in by Shell in interactive mode; a no-op in the other modes
   * — so assembling the loop doesn't need to know which mode we're in.
   */
  const ui = {
    preview(_label: string, _text: string): void {},
    clearPreview(): void {},

  }

  // A tool's live output carries only the callID; the tool name has to be picked up from
  // the event stream
  const toolNames = new Map<string, string>()
  emitter.on((event) => {
    if (event.type !== "tool.state") return
    const part = event.part
    if (part.state.status === "running") {
      toolNames.set(part.callID, part.tool)
    } else if (part.state.status !== "pending") {
      toolNames.delete(part.callID)
      ui.clearPreview()
    }
  })

  /**
   * The current turn's abort signal, handed to the confirm box so Ctrl-C exits at once
   * even while waiting for a key
   */
  let turnSignal: AbortSignal | undefined
  /** Holder of stdin in interactive mode. Absent in -p and pipe modes. */
  let keyboard: Keyboard | undefined
  let approvalDraft: ApprovalDraft | undefined
  /**
   * Questions, approvals and settings share one queue; otherwise parallel subagents
   * would fight over the keyboard.
   */
  let modalTail: Promise<unknown> = Promise.resolve()
  const modal = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = modalTail.then(fn, fn)
    modalTail = next.catch(() => {})
    return next
  }
  let askPermission: PromptFn = (request) => { approvalCount++; return modal(() =>
    confirm(request, {
      draft: approvalDraft,
      // At a line start first: the receipt hangs under the tool's `●` line as its own row
      print: text => { renderer.newlineIfNeeded(); renderer.write(text) },
      ...(keyboard ? { keyboard } : {}),
      region,
      // The request's own signal wins: a background subagent's question dies with **it**,
      // not with the user's current turn
      ...(request.signal ?? turnSignal ? { signal: request.signal ?? turnSignal! } : {}),
    })) }
  /**
   * Questions get the live card when the live area can draw one, the scrollback otherwise
   * (see cli/ask.ts); the record left behind is the ask tool's own lines either way.
   *
   * Under -p / pipe, keyboard is undefined and ask returns unavailable — that means
   * "there's nobody here to ask", not "the user is ignoring me"; to the model the two mean
   * completely different things.
   */
  let inquire = (question: Question): Promise<Answer> =>
    modal(() => ask(question, {
      ...(keyboard ? { keyboard } : {}),
      region,
      ...(turnSignal ? { signal: turnSignal } : {}),
    }))
  const access = new AccessManager(root, request => askPermission(request), join(configDir(), `access-${createHash("sha256").update(root).digest("hex")}.json`), () => gate.permissionMode === "auto", {
    allowed: () => { try { return loadConfig().autoOutsideReads === true } catch { return false } },
    remember: () => { try { rememberAutoOutsideReads() } catch { /* not saved: the next session asks again */ } },
  })
  access.sandboxEnabled = config.sandbox === true
  const sshAccess = new SshHostAccess()
  /**
   * The model auto mode's classifier asks (Settings → Auto classifier). Unset = the
   * conversation's own model, followed through /model switches.
   */
  let classifierSpec = config.classifier?.model
  const classifierModel = (): { spec: string; ref: ModelRef } =>
    classifierSpec ? { spec: classifierSpec, ref: parseModelRef(classifierSpec) } : { spec: model.spec, ref: model.ref }
  const llmClassifier = createLLMClassifier({ stream: request => stream(registry, request), model: classifierModel, onUsage: tokens => meter.bill(tokens) })
  /**
   * Receipts for user actions go into the transcript; auto's silent allows don't get a
   * receipt of their own.
   */
  let receipt = (line: string, _tone: NoteTone, _text: string): void => renderer.line(line)
  /**
   * Replies go into the same timeline as the model's text. While an interactive slash
   * command runs (asCommand), they hang under its echo instead of as bare lines — see
   * commandLines in render.ts for why.
   */
  let command: { first: boolean } | undefined
  let reply = (text: string): void => {
    const lines = command ? commandLines(text, region.width, command.first) : text.split("\n")
    if (command && lines.length > 0) command.first = false
    for (const line of lines) renderer.line(line)
  }
  const gate = new PermissionGate((request) => askPermission(request), {
    auto: createAutoDecider({
      root,
      classifier: () => llmClassifier,
      execution: input => {
        const sessionId = input.sessionID ?? session.id
        const parent = typeof input.metadata?.job === "string" ? subagents.parentOf(input.metadata.job) : undefined
        return {
          sessionId, agentInstanceId: sessionId,
          ...(parent ? { rootSessionId: parent, parentAgentInstanceId: parent, depth: 1 } :
            sessionId === session.id ? { rootSessionId: sessionId, depth: 0 } : {}),
        }
      },
      // ★ Read from the session every time rather than kept in a variable: answers to the
      //   ask tool and a /resume'd conversation are both already there (see
      //   permission/auto/evidence.ts)
      context: input => ({
        user: userVoice(store.listAll(session.id)),
        // Its presence is also what tells the policy this is a subagent, so never undefined
        ...(input.sessionID && input.sessionID !== session.id ? { delegatedTask: delegatedTask(store.listAll(input.sessionID)) ?? "(brief unavailable)" } : {}),
      }),
    }),
    root,
    remember: (rules) => rememberApprovals(root, rules),
  })
  if (startMode) gate.setMode(startMode)
  // The "always" answers given in this workspace last time. Keyed by root, not cwd: paths
  // in the rules are relative to the workspace, and starting from a subdirectory must see
  // the same set
  const remembered = loadApprovals(root)
  gate.restoreApproved(toRuleset(remembered))

  const tools = registerBuiltins(new ToolRegistry())
  const extensions = new Extensions(tools, text => reply(text))
  await extensions.load(config.extensions ?? [])

  /**
   * MCP: the second tool source (the boundary design constraint #2 talks about only
   * really gets exercised here).
   *
   * Config is read from both places — the global one is "which servers this machine has",
   * the project one is "which of them this repo wants". The latter is **a file someone
   * else may have written**, and it can specify processes to run, so servers whose origin
   * is project connect only after the user nods (the permission is stored in the same
   * place as "don't ask again", separated per workspace). Connecting happens entirely in
   * the background; the cost of a server failing to connect is a few missing tools.
   */
  const mcpConfig = loadMcpConfig({
    ...(config.mcp?.servers ? { global: config.mcp.servers as Record<string, McpServerConfig> } : {}),
    // The shelf: defined in global config, but connected only when the project names it
    // in `use: [...]`
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
   * Skills: the catalogue goes into system (one line each); the body is fetched by name
   * through the `skill` tool.
   *
   * ★ Discover only once, here, then feed **the same copy** to both system and the tool.
   *   Scan separately on each side and sooner or later you get "listed in the catalogue,
   *   but opening it says it doesn't exist" — and that inconsistency is invisible from the
   *   model's point of view; it just assumes it mistyped the name and tries another one.
   */
  const skills = discoverSkills({
    root,
    program: programName(),
    userDir: join(configDir(), "skills"),
    // The shelf: stored but inactive. Not in the catalogue, not in context; costs money
    // only when named
    libraryDir: join(configDir(), LIBRARY_DIR),
    // The other vendor's user-level directory — shelf only, never the catalogue. The
    // project half is built from root inside discoverSkills (see CLAUDE_SKILLS_DIR)
    claudeUserDir: join(homedir(), ".claude", "skills"),
    builtin: builtinSkills(),
  })

  /**
   * The skills actually available this run.
   *
   * ── ★ The project-origin ones are governed by trust too ──
   * `.alfa/skills/` and `.claude/skills/` are **files that travel with the repo**, and
   * their "name + one-line description" is spliced into the system prompt unconditionally
   * (see skillCatalogue in prompt/skills.ts). The body only comes when named, but **that
   * one-line description is enough on its own** — "use this whenever the user asks about
   * deployment" is a whole sentence an attacker gets to write into the system prompt, and
   * it reads exactly like a legitimate catalogue entry.
   *
   * So when untrusted, none of it is given: not in the catalogue, and the `skill` tool
   * can't open it either (that part is required — remove it only from the catalogue and
   * the model reads the body in as soon as it guesses a name right).
   *
   * ⚠ **Computed live**, same reason as trustProject: trust can flip mid-session. The
   *   `skills` constant is a disk snapshot scanned at startup, trust is live; keep them
   *   separate.
   */
  const visibleSkills = (): SkillSet =>
    trust === "trusted" ? skills : { ...skills, skills: skills.skills.filter((one) => one.origin !== "project") }

  /**
   * The tools and system actually sent this turn.
   *
   * Split into two functions because **the context gauge must look at the very same
   * copy**: assemble it again on its own and the reported usage slowly drifts from what's
   * really sent, and the drift always goes the way of "reporting less than reality", until
   * one day it hits the limit without warning.
   */
  // MCP tools are appended after the built-ins. Order doesn't matter: adaptTools sorts by
  // id, and that sorting is exactly what the prompt cache relies on (see
  // llm/adapt-tools.ts). When a server connects midway, its tools appear from the **next
  // turn** on — that invalidates the cache prefix once, so it only changes when something
  // really changed
  const enabledTools = (info: ModelInfo = model.info) => [...tools.list(), ...mcp.tools()].filter((tool) => {
    if (gate.disabled(tool.id)) return false
    const patchProfile = info.promptProfile === "openai-codex"
    if (tool.id === "apply_patch") return patchProfile
    return !patchProfile || (tool.id !== "edit" && tool.id !== "write")
  })
  /**
   * Which tools the **main agent** has this turn. Same list when agentflow is on.
   *
   * ── The enforcement was torn out three times; each version cost more than the disease ──
   * Version one took write/edit/bash away from the foreman, version two kept write and
   * took the other two, version three became a quota of "five per user turn". All three
   * ran into the same thing: **an agentflow "turn" is absurdly long**. The user speaking
   * counts as one turn, and the dozens of continuations where a subagent's report wakes
   * the foreman are all still inside that same turn (see the text === undefined path in
   * runTurn). So the quota was spent while reading code at the start, and the moments
   * that really needed hands-on work — a service won't start, tests need a re-run, a stale
   * artifact needs deleting — all came later and were all refused.
   *
   * What the user saw was a foreman who starts saying "I can't" midway. And what it does
   * next is worse: after a hard refusal it looks for a workaround instead of honestly
   * dispatching someone.
   *
   * ★ So nothing is blocked here any more. "You are the foreman" is now carried entirely by
   *   the section in prompt/agentflow.ts, and it does still lose to "doing it myself is
   *   faster" — but losing costs one unnecessary bit of hands-on work, while blocking
   *   costs a refusal in front of the user. The latter is more expensive, and uglier.
   */
  const activeTools = () => enabledTools()
  /**
   * @param target Whose prompt this is. Defaults to the conversation's model; a subagent
   *   the task put on another model passes its own — the template and the `model:` line
   *   follow the model that will read them
   */
  const buildSystemParts = (flow: number | false, target: { spec: string; info: ModelInfo } = model) =>
    buildSystem({
      template: target.info.promptTemplate,
      profile: target.info.promptProfile,
      runtime: runtimeSnapshot(access, gate.permissionMode, sshAccess.list()),
      cwd,
      root,
      model: target.spec,
      replyLanguage: language.reply,
      // The name the user actually typed. The alfa-config built-in skill prints a
      // `<program name> auth login`; hard-code it and someone who installed under another
      // name copies it and gets command not found
      program: programName(),
      skills: visibleSkills(),
      // Report only the connected ones. Tools of servers still connecting / failed aren't
      // in the list yet; writing them in amounts to telling it about a batch of tools it
      // can't use (see prompt/mcp.ts)
      mcpServers: mcp.statuses().filter((one) => one.state === "ready").map((one) => one.name),
      // Only when on. See prompt/agentflow.ts — when off, not one word of that section
      // should be there
      ...(flow !== false ? { agentflow: flow } : {}),
      // ★ **Read live**, not computed once at startup. Trust can flip midway through a
      //   session: on the "take a look first" path, once the subagent finishes reading and
      //   says it's fine, this repo's AGENTS.md should take effect on the very next step
      //   — and the system prompt is rebuilt every step (see agent/loop.ts), so reading a
      //   live variable is enough; no second notification chain is needed.
      //
      //   Read the variable rather than loadConfig() each time: that would be a disk read
      //   per step, and a hand-broken config would throw from here and take the running
      //   turn down with it.
      trustProject: trust === "trusted",
    }).parts
  const systemPrompt = () => buildSystemParts(agentflow)

  /**
   * The subagent's tool list: minus `task` and `ask`.
   *
   * The reasons for both boundaries are in the agent/subagent.ts file header. The removal
   * happens here rather than there because **only this layer knows what the tool list
   * looks like** — that side only knows a tools() function.
   */
  // ★ Start from enabledTools, **not** activeTools: activeTools is the main agent's list
  //   (today the same one), and the workers are the ones who must keep write/edit/bash.
  //   Wire up the wrong layer and any future limit on the foreman (see activeTools) lands
  //   on them too — in flow mode nobody at all could edit files
  const subagentTools = (info?: ModelInfo) => enabledTools(info).filter((tool) => tool.id !== "task" && tool.id !== "ask")
  /**
   * The subagent's system: the same one, plus a trailing "you were dispatched" section.
   * See prompt/subagent.ts
   *
   * ★ The agentflow section is **deliberately withheld** (pass false). It's about how to
   *   dispatch and who waits for whom, and a subagent has no `task` at all — give it that
   *   and it just calls a nonexistent tool, gets an error, and tries again. It also saves
   *   one thing on the side: flipping the switch doesn't invalidate the subagent's
   *   prompt cache.
   */
  const subagentSystem = (target?: { spec: string; info: ModelInfo }) => [...buildSystemParts(false, target), subagentBlock()]

  /** A task's `model`. Read live: registry and model both change under /model and /setting */
  const resolveSubagentModel = (raw: string) => resolveTypedModel(registry, raw, model)

  // ── Trail of background jobs ──
  //
  // Background processes are the only thing in this program that lives across turns.
  // Their starting and dying aren't the result of any single tool call, so this is the
  // only place to report them — otherwise a dev server that quietly died leaves the user
  // debugging an unreachable port for ages with no clue on screen.
  setJobObserver((event) => {
    liveChanged()
    // ★ Processes started by subagents are **not written into the conversation**. The user
    //   didn't ask anyone to start them, and this conversation is about something else —
    //   a `▸ dev started` out of nowhere only makes people think they missed something.
    //   `/jobs` still shows it (that's state, not content), and `job list` still shows it
    //   too
    if (event.job.owner !== undefined) return
    if (event.kind === "started") {
      const line = t.jobStarted(event.job.id, event.job.command)
      receipt(theme.dim(`  ▸ ${line}`), "info", line)
      return
    }
    const how = exitLabel(event.job.exit, event.job.signal)
    const line = t.jobEnded(event.job.id, how)
    // A non-zero exit is drawn in red: a background build failing and it finishing are
    // two entirely different things
    const bad = event.job.exit !== 0
    receipt(bad ? theme.red(`  ✗ ${line}`) : theme.dim(`  · ${line}`), bad ? "bad" : "good", line)
  })

  // ── Automatic check before wrapping up ──
  //
  // See agent/check.ts. This part only handles three things: whether we recognize a
  // checker, whether it can run, and how the result becomes one line the user can see and
  // one paragraph the model receives.
  let checker = detectChecker(root, config.check)
  /**
   * No more checks this session.
   *
   * Two paths lead here: the user denied that authorization, or the checker can't run at
   * all (the binary isn't there). In both cases, keeping on trying every turn means a
   * prompt every turn / a wasted timeout every turn.
   */
  let checkOff = false
  /**
   * The raw text of the previous failure.
   *
   * ★ Used to recognize "this error was already there". A repo that didn't compile to
   *   begin with (which is exactly why many people open an agent) would get every turn
   *   bounced back to fix a pile of things unrelated to the task. Identical raw text = this
   *   change neither fixed it nor broke anything else, so don't block; the receipt is
   *   still written.
   */
  let lastFailure: string | undefined
  /** Abort handle for a manual `/check` run. esc must be able to stop it */
  let manualCheck: AbortController | undefined

  /**
   * Run one check and write the result as a receipt. Returns the text to feed the model
   * (undefined if none).
   */
  const runProjectCheck = async (
    signal: AbortSignal | undefined,
    options: { manual?: boolean } = {},
  ): Promise<string | undefined> => {
    if (!checker) return undefined
    const current = checker
    try {
      // Goes through the gatekeeper as usual. In a freshly cloned repo the detected binary
      // is still something someone else wrote
      await gate.ask({ permission: "bash", patterns: [current.command], metadata: { workdir: root }, signal })
    } catch {
      checkOff = true
      receipt(theme.dim(`  · ${t.checkSkipped}`), "info", t.checkSkipped)
      return undefined
    }

    const outcome = await runCheck(current, { root, access, ...(signal ? { signal } : {}) })
    if (outcome.status === "unavailable") {
      const why = outcome.reason ?? "failed to run"
      // An interruption is temporary (the user pressed esc); don't turn off checks for the
      // whole session over it
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
    // A manual run isn't fed back to the model: the user wanted to take a look
    // themselves, not direct it to go fix things
    if (options.manual || unchanged) return undefined
    return checkReminder(current, outcome.output)
  }

  /**
   * The context for one tool call. **Shared by the main agent and subagents.**
   *
   * There are only three differences, each for a reason:
   *   ① A subagent has no inquire and no agents — it can't ask the user, and can't
   *      dispatch anyone further (see the agent/subagent.ts file header). Withholding a
   *      capability beats granting it and then blocking: the model won't call a tool it
   *      can't see, while a blocked call takes a whole turn to find out it was wasted
   *   ② Progress isn't pushed to the live preview — that follows **the turn you're
   *      watching**, and background tool output squeezing in would only make it look
   *      like the main agent went off track
   *   ③ Context reports are computed per session — when a subagent asks "how much do I
   *      have left", the answer is of course its own window
   *
   * The gatekeeper is **the same one**: the same rule table, the same "don't ask again".
   * Background isn't a back door around authorization; it just doesn't stand there
   * waiting.
   */
  const makeToolContext = (
    sessionID: string,
    call: { messageID: string; callID: string; abortSignal: AbortSignal },
    options: { subagent?: string } = {},
  ) =>
    createToolContext(
      {
        access,
        runtime: () => runtimeSnapshot(access, gate.permissionMode, sshAccess.list()),
        ssh: async (input, signal, onProgress) => {
          if (gate.permissionMode === "auto") await gate.ask({ permission: "ssh", patterns: [input.host], metadata: { ...input, workdir: cwd, ...(options.subagent ? { job: options.subagent } : {}) }, signal, callID: call.callID, sessionID })
          return runSsh(input, { access: sshAccess, auto: () => gate.permissionMode === "auto", prompt: request => askPermission({ ...request, callID: call.callID }), signal, cwd, onProgress, ...(options.subagent ? { owner: options.subagent } : {}) })
        },
        cwd,
        root,
        sessionID,
        // A request from the background must say who wants it: a box pops up while the
        // user is talking to the main agent, and without naming which subagent it's from,
        // what they see is something they never asked anyone to do requesting permission
        ask: (input) =>
          gate.ask(
            options.subagent
              ? {
                  ...input,
                  metadata: { ...input.metadata, job: options.subagent },
                  // When it dies, this box should go away. See AskInput.signal
                  signal: call.abortSignal,
                  sessionID,
                }
              : { ...input, signal: call.abortSignal, sessionID },
          ),
        ...(options.subagent
          ? { owner: options.subagent }
          : { inquire: (question: Question) => inquire(question), agents: subagents }),
        onProgress: options.subagent
          ? () => {}
          : (callID, text) => ui.preview(toolNames.get(callID) ?? "running", text),
        onMetadata: () => {},
        // The same object as the catalogue in system; see the star above
        skills: () => visibleSkills(),
        // The tool the model uses to look at its own context (see tool/context-window.ts).
        // Computed live — it's asked **in the middle** of a turn, and that turn has already
        // stuffed quite a lot into the window.
        // ★ The main session's copy goes through the same measure() as the gauge in the
        //   UI; compute it separately on each side and sooner or later you get "it says
        //   there's plenty of room, while the status line is red"
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
   * Background subagents.
   *
   * The stream / model / memory / gitContext they get are **the same ones** as the main
   * loop's — in other words, the one sent out and the one you're talking to share the same
   * model, the same memory, the same repo state. The only differences are the tool list
   * (two fewer), system (one extra section) and its own session.
   */
  const subagents = new SubagentJobs({
    store,
    stream: (request) => streamWithRetry(registry, request),
    model: () => model.ref,
    info: () => model.info,
    tools: subagentTools,
    system: subagentSystem,
    resolveModel: resolveSubagentModel,
    // Read live, like model: a subagent started after /effort follows the new level
    effort: () => effort,
    makeToolContext: (job, call) => makeToolContext(job.sessionID, call, { subagent: job.id }),
    memory: (sessionID) => {
      // ★ An untrusted folder gets **not a single note**. See the trustProject star in
      //   buildSystemParts, and the same-named explanation at memory below — both places
      //   must check together; miss one and this door is only half shut
      if (trust !== "trusted") return undefined
      const set = discoverMemories(root, sessionID)
      const text = renderMemories(set)
      return text.length === 0 ? undefined : { text, notes: set.memos.length }
    },
    gitContext: () => gitContextBlock(root),
    directory: cwd,
    // Read live: a subagent belongs to **the session that dispatched it** (see
    // deliverReport)
    session: () => session.id,
    // What subagents spend goes into this session's total. Via bill(), not observe() —
    // the latter would overwrite the main conversation's context usage with this
    // subagent's (see ContextMeter.bill)
    bill: (tokens) => meter.bill(tokens),
    // Subagents edit files too, and their event stream doesn't pass through the emitter
    // above — without this hook the diffs they write never reach the transcript (see
    // SubagentDeps)
    onToolEvent: (job, event) => {
      if (event.type === "tool.state" && event.part.state.status === "completed" && event.part.state.metadata.diff) {
        renderer.line(uiText(`Subagent ${job}:`, `子代理 ${job}：`, `サブエージェント ${job}：`))
        renderer.handle(event)
      }
    },
    // Leave a trail on start and finish. Same reason as background processes — something
    // spending money in the background should at least leave one line when it starts and
    // one when it ends
    observer: (event) => {
      if (event.kind === "started") {
        const line = t.agentStarted(event.job.id, event.job.command)
        receipt(theme.dim(`  ▸ ${line}`), "info", line)
        return
      }
      // A stopped one (exit is null) doesn't count as a failure: the user pressed that
      // themselves, and a red ✗ would only make them think something went wrong
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
      // ★ Reports are **pushed** to the main agent, not fetched by it. See deliverReport
      deliverReport(event.job)
    },
    // Read live. `/agentflow` changes scheduling for the **next** task; ones already
    // running are left alone
    flow: () => agentflow,
    // The pinned agents row reads list() at paint time; this only says "paint again"
    onChange: () => liveChanged(),
  })

  /**
   * A subagent is done; deliver its report into the main conversation.
   *
   * ★ **This is the key link in the whole setup**, which is why it's mutable: the
   *   observer is built earlier than deps, and the real implementation needs "which
   *   session is this now" and "is the main agent busy". It's a no-op by default — in
   *   `-p` it also gets replaced, with a version that only queues the message for the
   *   outer loop to digest.
   */
  let deliverReport: (job: JobSnapshot) => void = () => {}

  /**
   * The "take a look first" run currently in progress.
   *
   * ★ The raw report must not pose as a user message and go straight into the main
   *   conversation. deliverReport recognizes this id first and intercepts it: a clean
   *   verdict only delivers the state change; a risk verdict is wrapped in an
   *   untrusted-content envelope before going to the main agent, so it can explain the
   *   findings and help clean up without injected content being promoted to instructions.
   */
  let trustJob: string | undefined
  /**
   * Hooked up to the synthetic-message channel once assembly is done; the review may build
   * its closure earlier, but it only finishes after interactive startup.
   */
  let notifyTrustOutcome: (note: string) => void = () => {}
  /**
   * concerns changes the input box's entire look; when the review finishes in the
   * background it must actively trigger a frame.
   */
  let repaintTrustInput: () => void = () => {}

  /**
   * Dispatch someone to read through this folder's instruction files.
   *
   * Runs in the background. If it blocked startup, opening an unfamiliar repo would mean
   * first sitting through a model call — and until the verdict is back, not one word of
   * those files is in the system prompt anyway (trust is now checking, fail closed), so
   * waiting on it buys nothing.
   */
  const startTrustReview = async (): Promise<string | undefined> => {
    if (trustJob !== undefined) return t.trustCheckBusy
    try {
      const job = await subagents.start({ name: TRUST_AGENT_NAME, prompt: trustReviewPrompt(root) })
      trustJob = job.id
      return undefined
    } catch (error) {
      // If it can't be dispatched (no model configured, concurrency full) we still say so.
      // Failing silently leaves a folder stuck in checking forever — and checking is
      // treated as untrusted, so the user's AGENTS.md stops taking effect from then on
      // without a single line explaining why
      return t.trustCheckNoModel(error instanceof Error ? error.message : String(error))
    }
  }

  /** The report is in. Persist it, say something, flip the live variable */
  const finishTrustReview = (report: string): void => {
    trustJob = undefined
    // During concerns, only a clean re-check can turn off the red light. A broken or
    // truncated report must not quietly downgrade an already confirmed risk to plain
    // untrusted.
    const previousConcern = trust === "concerns" ? trustConcern ?? "" : undefined
    const outcome = settleTrustReview(root, report, undefined, previousConcern)
    trust = outcome.trust
    trustConcern = outcome.trust === "concerns"
      ? outcome.verdict === "concerns" ? outcome.detail : previousConcern
      : undefined
    repaintTrustInput()
    if (outcome.verdict === "clean") {
      receipt(theme.green(`  ✓ ${t.trustClean}`), "good", t.trustClean)
      notifyTrustOutcome(trustReadyNote())
      return
    }
    const head = outcome.verdict === "concerns" ? t.trustConcerns : t.trustUnreadable
    const concern = outcome.verdict === "concerns"
    receipt(concern ? theme.red(`  ✗ ${head}`) : theme.yellow(`  ! ${head}`), concern ? "bad" : "warn", head)
    // When there's something to say, **show it to the user verbatim**. Summarizing it
    // means deciding for them which items matter, and these lines are exactly what they
    // need to look over themselves
    if (outcome.detail.length > 0) reply(concern ? theme.red(outcome.detail) : theme.dim(outcome.detail))
    if (concern) notifyTrustOutcome(trustConcernNote(outcome.detail))
  }

  /**
   * Data sources for `/jobs` and `/agents`. **Separate**, not one.
   *
   * A dev server and a subagent digging through the repo are the same kind of thing to
   * **the model** (both are viewed/awaited/stopped with `job`, so that tool still manages
   * them together), but not to **the user**: the former is "is the process I started
   * still alive", the latter is "how are the ones I sent out doing".
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
     * Attach the project memory to a new session's first message. Read from disk live —
     * what the last session just noted should already be there when this one opens (see
     * prompt/memory.ts).
     *
     * ── ★ Why trust matters here too ──
     * `.alfa/memory/` is **files that travel with the repo and go into git**. That means in
     * an unfamiliar repo, those few .md files were **written by its author**, and the
     * wording renderMemories uses when handing them to the model is "Notes **you** wrote
     * about this project" — even stronger than AGENTS.md's original "follow them": it's
     * not "do as told", it's "this is something you thought through yourself".
     *
     * This hole was only found by going back over the code after the trust piece was
     * done: at the time only the AGENTS.md / CLAUDE.md path was plugged, and a project has
     * more than one way to talk to the model.
     */
    memory: (sessionID) => {
      // ★ An untrusted folder gets **not a single note** (why: the comment above). The
      //   trustProject star in buildSystemParts and the subagents' memory in SubagentJobs
      //   make the same check — miss one and this door is only half shut
      if (trust !== "trusted") return undefined
      const set = discoverMemories(root, sessionID)
      const text = renderMemories(set)
      return text.length === 0 ? undefined : { text, notes: set.memos.length }
    },
    // Also attach a repo snapshot to the same message. Captured live — after the last
    // session ended the user may well have switched branches or committed, and starting
    // a new session with `/clear` is the most natural "take a fresh look" entry point
    // (see prompt/git.ts)
    gitContext: () => gitContextBlock(root),
    // Asked again every turn: tools denied wholesale aren't sent to the model, saving the
    // idle spin of "call → denied → rephrase"
    tools: activeTools,
    // The reply language is read live every turn: after the user runs /language reply ja,
    // the next turn should be in Japanese, not wait for a restart
    system: systemPrompt,
    // Read session.id live — after /resume swaps it, this turn's tools must write into the
    // new session
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

  const titleAbort = new AbortController()
  const titleSession = createSessionTitler({
    store, stream: request => stream(registry, request), model: () => model.ref,
    language: () => language.reply, signal: titleAbort.signal,
  })

  // ── Context usage ──
  //
  // The real number is picked up from step.finish (reported by the provider itself); the
  // estimate is recomputed once at turn boundaries. Computing it every frame won't do: the
  // footer is read on every animation frame, and this number only changes once a turn.
  const meter = new ContextMeter(model.info)
  emitter.on((event) => {
    if (event.type === "step.finish") meter.observe(event.part.tokens)
  })

  /** How much is used now, and by whom. If the provider has reported, its number wins */
  const measure = (): ContextReport =>
    contextReport({
      history: store.listAll(session.id),
      system: systemPrompt(),
      tools: activeTools(),
      // The catalogue section is **split out** of system, not added on top (see
      // agent/context.ts)
      skills: skillCatalogue(visibleSkills()),
      info: model.info,
      spent: meter.spent,
      ...(meter.real !== undefined ? { reported: meter.real } : {}),
    })

  /**
   * Re-estimate. After compaction, clearing or switching sessions, the number the provider
   * reported no longer holds
   */
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

  /**
   * Whether the nearly-full reminder has fired. Re-armed once compaction/clearing drops it
   * back below the yellow line
   */
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
    // The reminder fires only once, and as a receipt rather than a popup: it's about
    // something **not broken yet**, and interrupting what the user is doing would be out
    // of proportion
    const line = t.ctxNearlyFull(Math.round(ratio * 100))
    receipt(theme.yellow(`  ⌁ ${line}`), "warn", line)
  }

  /**
   * The compaction in progress. esc must be able to stop it — it takes as long as a
   * conversation turn, and when it's stuck esc is the only thing the user has.
   */
  let compaction: AbortController | undefined
  const compactor: CompactFn = createCompactor({
    execution: () => ({ sessionId: session.id, rootSessionId: session.id, agentInstanceId: session.id, depth: 0 }),
    stream: (request: LLMRequest) => stream(registry, request),
    model: () => model.ref,
    language: () => language.reply,
    // The request itself has to fit in the same window, and it's sent precisely when the
    // window is nearly full. Half goes to the material, the rest to the prompt and its own
    // output. Read live: switching models switches the window
    budgetTokens: () => Math.max(8_000, Math.floor(usable(model.info.limit) / 2)),
  })

  /**
   * @param text What the user said this turn. **Omitted = go on answering the unanswered
   *   message in history** — that's how subagent reports come in (see deliverReport): it's
   *   a synthetic message, not a new user request.
   */
  /**
   * Read the images the user's line refers to (see cli/attachments.ts) and say what was
   * attached — the line alone shows `@shot.png`, not whether shot.png got in.
   *
   * ★ A problem never blocks the turn: the text still goes, and the receipt says which
   *   image didn't. Refusing to send a whole question over one oversized screenshot would
   *   trade the user's words for our limit.
   */
  const attachImages = async (text: string): Promise<Attachment[]> => {
    if (imageReferences(text).length === 0) return []
    const { images, problems } = await collectImages(text, { cwd })
    for (const image of images) {
      const line = t.imageAttached(image.filename, formatBytes(image.bytes), image.resized)
      receipt(theme.dim(`  ⧉ ${line}`), "info", line)
    }
    for (const problem of problems) {
      const line = imageProblem(problem)
      receipt(theme.yellow(`  ⌁ ${line}`), "warn", line)
    }
    // Kept even so: switching to a model that takes images later makes them visible, and
    // this one gets a note saying an image was there (see toModelMessages). Only shown
    // when the user set false themselves — the default is yes
    if (images.length > 0 && model.info.images === false) {
      const line = t.imageTextOnly(model.spec)
      receipt(theme.yellow(`  ⌁ ${line}`), "warn", line)
    }
    return images.map((image) => ({ mediaType: image.mediaType, filename: image.filename, url: image.url }))
  }

  const runTurn = async (text?: string): Promise<TurnOutcome> => {
    // The interactive box already did this on paste (ShellDeps.pasteText); -p and piped
    // input arrive here with the data: URL still in them
    if (text !== undefined) text = saveDataImages(text, join(dataDir(), "clipboard"))
    if (!oneShot && text !== undefined) void titleSession(session.id, store.getSession(session.id)?.preview || text)
    // Land the pending "settings were just changed" note first. ★ It goes **before** the
    // user's message — reading down, it's "the switch was flipped, then they said this";
    // the other order would read as an extra demand attached to their message
    if (pendingNote !== undefined) {
      injectSynthetic(pendingNote)
      pendingNote = undefined
    }
    renderer.reset()
    const attachments = text !== undefined ? await attachImages(text) : []
    const run = runner.start({
      sessionID: session.id,
      model: model.ref,
      ...(text !== undefined ? { text } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(thinking ? { thinking: true } : {}),
      ...(effort ? { effort } : {}),
    })
    turnSignal = run.controller.signal
    const outcome: TurnOutcome = {}
    try {
      const result = await run.promise
      // ★ Images are sent by default (see ModelConfig.images), so a text-only endpoint
      //   fails every turn from the first image on — and its error rarely names the
      //   switch. Worded as "if" because the failure may be anything else; one extra line
      //   on a failed turn is cheap, a session stuck with no clue is not.
      if (result.error && model.info.images !== false && liveHistory(store.listAll(session.id)).messages.some((entry) => entry.parts.some((part) => part.type === "file"))) {
        const line = t.imageRejectedHint(model.spec)
        receipt(theme.yellow(`  ⌁ ${line}`), "warn", line)
      }
      if (result.interrupted) {
        interruptions++
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
   * Whether history holds a message nobody has answered.
   *
   * The criterion is **shared** with the main loop (isSettled in agent/loop.ts) — write it
   * twice and sooner or later "the UI thinks it's answered, while the loop wants another
   * turn".
   */
  const hasUnanswered = (): boolean => !isSettled(store.listAll(session.id))

  /**
   * The "settings were just changed" note not yet inserted. See noteToModel.
   *
   * ⚠ When idle it must **not** be inserted immediately: that would make hasUnanswered()
   *   true, and pump would then start a turn out of nowhere — the user flips a switch and
   *   gets a model call nobody asked for, plus a bill.
   */
  let pendingNote: string | undefined

  /**
   * Insert a piece of text into the current session as a **synthetic user message**.
   *
   * For what synthetic means, see session/schema.ts: the model sees it, while the
   * scrollback transcript never treats it as the user's own words — a subagent's report is obviously not
   * something the user said.
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

  notifyTrustOutcome = (note) => {
    // While running, put it straight into history — the main loop reads it live on the
    // next step; when idle, hold it for the next turn, so a status notification doesn't
    // wake the model out of nowhere and produce a request the user never asked for.
    if (turnSignal !== undefined) injectSynthetic(note)
    else pendingNote = pendingNote ? `${pendingNote}\n\n${note}` : note
  }

  /**
   * A message the user slips in **while it's still running**, inserted into the current
   * session on the spot.
   *
   * ── Why not queue it until this turn ends ──
   * The main loop rereads the full history from the store every turn (see agent/loop.ts),
   * so the inserted message is seen at the **next turn boundary** — it may be reading its
   * third file just as the user says "never mind that, run the tests first". Queued, the
   * message would only take effect once it had finished the whole thing, which is exactly
   * what the user wanted to stop.
   *
   * ★ This path is **the same mechanism** as subagent reports (see injectSynthetic); the
   *   only difference is a synthetic flag: a report isn't something the user said, while
   *   this is — it must show up in the scrollback and be recognized as
   *   the user's own words when resuming a session.
   *
   * ⚠ Slash commands don't take this path (the caller filters them out). `/clear` swaps
   *   the session, `/compact` folds history; touching them mid-run pulls the ground out
   *   from under it — those still queue and run after this turn ends.
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
    appendHistory(text)
  }

  /**
   * Turn a report into a paragraph for the main agent.
   *
   * The trailing "a few are still running" is deliberate: the model uses it to decide
   * whether to **act now** or **wait a bit longer**. Without it, it only knows this one
   * came back, so it starts drawing conclusions from a third of the material — while the
   * user sent three out wanting an answer from all three combined.
   */
  const reportMessage = (job: JobSnapshot, report: string): string => {
    // Queued ones also count as "not back yet". Count only running ones and a pipeline of
    // sixteen reports "this is the last one" between every batch — while eight are still
    // sitting in the queue, so the model wraps up early and draws conclusions
    const running = subagents.list().filter((each) => each.status !== "exited")
    const tail =
      running.length === 0
        ? `That was the last subagent. Carry on with what the user asked. It could not ask questions, so ` +
          `check any assumption it flagged before you act on it.`
        : `Still going: ${running.map((each) => `${each.id} (${each.status === "queued" ? "queued, " : ""}${each.command})`).join(", ")}. ` +
          `Each will reach you the same way. If your next step needs their answers too, say so in one line ` +
          `and stop — you will be woken up again.`
    // ★ The first line states "this isn't from the user". It is a user message (only that
    //   role can be inserted between turns), and the model's first reaction to a user
    //   message is "a person is talking to me" — so it starts answering a question nobody
    //   asked.
    // ★ Cost is **not written here**: the model can't make any decision with it, and the
    //   user's tally is already on the receipt
    return [
      `Automated message, not from the user. Subagent "${job.id}" has finished. It was asked to: ${job.command}`,
      "",
      report,
      "",
      tail,
    ].join("\n")
  }

  /**
   * When the main agent is idle, wake it up to digest the report that just came in.
   *
   * ── Why not "wait there" ──
   * The version where the main agent stood waiting for subagents held the whole turn, and
   * the user couldn't get a word in (see the three back-and-forth versions in the
   * tool/task.ts file header). Now it wraps up as soon as it has dispatched and hands the
   * conversation back to the user; when a report arrives it gets woken up again. Anything
   * the user says in between is a normal conversation turn as usual.
   *
   * ── Nothing to do while it's busy ──
   * The message is already in the store, and the main loop rereads the full history from
   * the store every turn (see agent/loop.ts): it will see this one on its own at the next
   * turn boundary and go around again. That's also exactly why "take the first subagent's
   * result and dispatch another" works.
   */
  let wake: () => void = () => {}

  /**
   * In `-p`, wait for all subagents to come back and digest their reports turn by turn.
   *
   * Interactive mode doesn't use this — there deliverReport wakes the main agent (see the
   * section above it). The cap is a lifeline: a subagent stuck on the network shouldn't
   * make a `-p` command never return.
   */
  const drainAgents = async (): Promise<void> => {
    const until = Date.now() + ONE_SHOT_AGENT_LIMIT_MS
    /**
     * Consecutive turns that ended badly. If history stays "unanswered", this would keep
     * rerunning the same turn
     */
    let failures = 0
    while (Date.now() < until) {
      if (hasUnanswered()) {
        if (failures >= 3) return
        const outcome = await runTurn()
        failures = outcome.error || outcome.interrupted ? failures + 1 : 0
        continue
      }
      // Wait for queued ones too: in `-p`, "it dispatched three investigators and exited
      // immediately" and "exited with three still in the queue" are the same kind of
      // unfinished answer
      if (!subagents.list().some((job) => job.status !== "exited")) return
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 200)
        timer.unref?.()
      })
    }
  }

  /**
   * Already shutting down. See shutdown: once the store is closed, any write is a write to
   * a dead handle
   */
  let closing = false

  const shutdown = async (): Promise<void> => {
    closing = true
    keyboard?.close()
    await runner.cancelAll()
    await runner.drain()
    // ★ Background jobs don't end with a turn, so this is the only place to clean them up.
    //   Don't kill them and a dev server started in its own process group gets adopted by
    //   init and keeps running — the user thinks they've exited, but they've left a mess
    //   of processes behind with the port still taken, and the next start reports "address
    //   in use" with no way to tell who's holding it
    await killAllJobs()
    // ★ Subagents must be fully cleaned up **before** store.close(): if one is still
    //   alive, its next tool result written to the store hits an already-closed SQLite
    //   handle — that's not a mess of processes left behind, it's an exception thrown
    //   where nobody catches it
    await subagents.killAll()
    // ★ MCP servers are child processes we started — same reason as background jobs: not
    //   cleaned up, they get adopted by init and keep running while the user thinks
    //   they've exited. killGroup goes the bash way (see mcp/transport.ts) — with `npx …`
    //   the one doing the real work is its grandchild
    await mcp.close()
    if (flags.report) writeFileSync(resolve(flags.report), JSON.stringify({
      version: 1, model: model.spec, sessionID: session.id,
      elapsedMs: Date.now() - invocationStarted, approvals: approvalCount, interruptions,
      requests: usageRecords,
      execution: aggregateExecutionUsage(usageRecords),
      cache: {
        ...aggregateCacheDiagnostics(usageRecords.flatMap(record => record.cache ? [record.cache] : [])),
        adapter: OPENAI_CACHE_RULES,
        adapters: CACHE_ADAPTERS,
        unsupportedOrUncapturedRequests: usageRecords.filter(record => !record.cache).length,
        scope: "Responses, Chat Completions and Anthropic requests captured in this invocation only. Unknown token ceilings and TTL remain null/uncertain; segment matching is not token LCP.",
      },
      tokens: billedFromHistory(usageRecords.map(record => ({ parts: [{ type: "step-finish", tokens: record.tokens }] }))),
      subagents: subagents.list().map(j => ({ id: j.id, input: j.tokensIn ?? null, output: j.tokensOut ?? null })),
      apiCostUSD: null, costNote: "No provider prices configured; token counts are reported, not a fabricated dollar amount.",
      tokenScope: "Invocation only, including main, subagents, titles and compaction. Requests without usage have unknown cost.",
      sandbox: sandboxStatus(access),
    }, null, 2) + "\n", { mode: 0o600 })
    stopUsage()
    access.dispose()
    titleAbort.abort()
    store.close()
    region.close()
    // ★ `/reset`'s deletion **can only happen here** — delete before store.close() and
    //   SQLite's WAL checkpoint on close writes sessions.db right back in place, while the
    //   user thinks they've reset everything (see cli/reset.ts)
    if (pendingReset.length > 0) {
      const outcome = performReset(pendingReset)
      for (const path of outcome.removed) process.stdout.write(theme.dim(`  · ${uiText("removed", "已删除", "削除済み")} ${path}\n`))
      for (const problem of outcome.failed) {
        process.stderr.write(theme.red(`  ✗ ${t.resetFailed(problem.path, problem.why)}\n`))
      }
      process.stdout.write(theme.green(`  ✓ ${t.resetDone}\n`))
    }
  }

  /**
   * The directories `/reset` picked. Empty = nobody pressed it.
   *
   * For why it's "note it down, delete only on exit", see the star in shutdown()
   */
  let pendingReset: ResetTarget[] = []

  /**
   * ★ Subagent done → report goes into the main session → wake it if needed.
   *
   * **Ones we stopped ourselves are not delivered** (`/clear`, `/resume`, `job kill`): by
   * then the user no longer wants that answer, and after `/clear` the session isn't even
   * the one it set out from — dumping the last session's work into a new conversation is
   * the most baffling kind of "smart" there is.
   */
  deliverReport = (job) => {
    // Reports arriving during shutdown are all dropped: the store is about to close (or
    // already has), and this path writes all the way down into it — an exception thrown
    // here has nobody to catch it
    if (closing) return
    // ★ Intercept the "take a look first" one first. The raw text doesn't go straight into
    //   the main conversation; finishTrustReview only delivers the state change, or wraps
    //   the risk summary in an untrusted envelope — see the star on trustJob. This must
    //   come **before** the signal check: a stopped check must also clear trustJob, or
    //   afterwards `/trust check` keeps saying "one is already running"
    if (job.id === trustJob) {
      const report = subagents.claimReport(job.id) ?? ""
      if (job.signal !== undefined) trustJob = undefined
      else finishTrustReview(report)
      // Killed, not left suspended: alfa dispatched it, not the main agent, and its whole
      // session is a read of possibly hostile project text — nothing the main agent should
      // ever wake and keep talking to. Left suspended it would also sit in the pinned
      // agents row of every session opened in a new folder
      void subagents.kill(job.id, "user").catch(() => { /* already gone with its session */ })
      return
    }
    if (job.signal !== undefined) return
    // ★ If someone is waiting on this report, it's already been spliced into that one's
    //   brief (see briefFor in subagent.ts). Insert another copy into the main
    //   conversation and the context that dispatching subagents was meant to save comes
    //   right back — twelve scouts each hand one in and the main conversation fills up on
    //   the spot. It can still be read with `job output`
    if ((job.feeds?.length ?? 0) > 0) return
    // ★ Deliver only to **the session that dispatched it**. After `/clear`, session.id has
    //   changed, and a subagent that happens to finish at that very moment (its abort
    //   arrived a beat late, signal still empty) would dump the last session's work into
    //   a brand-new conversation — the user sees a report with no beginning or end
    if (subagents.parentOf(job.id) !== session.id) return
    // Once and only once: the `task` call may already have delivered it on the spot (ones
    // that finish within 400ms)
    const report = subagents.claimReport(job.id)
    if (!report || report.length === 0) return
    injectSynthetic(reportMessage(job, report))
    // If busy, nothing to do: the main loop reads it from the store at the next turn
    // boundary (see the section above wake)
    if (!runner.isBusy(session.id)) wake()
  }

  // ── One-shot mode ──
  if (oneShot) {
    const onSigint = () => void runner.cancel(session.id)
    process.on("SIGINT", onSigint)
    const result = await runTurn(expandOneShot(flags.prompt!, { root, receipt, reply }))
    // ★ Dispatched subagents must be waited for. On the -p path there's no UI to wake
    //   anyone, and "it dispatched three investigators and exited immediately" hands the
    //   script an unfinished answer
    if (!result.interrupted && !result.error) await drainAgents()
    process.off("SIGINT", onSigint)
    await shutdown()
    return result.error ? 1 : result.interrupted ? 130 : 0
  }

  // ── Interactive mode ──
  keyboard = new Keyboard()
  // ★ When the terminal is gone we must leave. Nobody is watching the UI and keypresses
  //   will never come again, and the cost of staying is an orphan process spinning at
  //   full tilt (see watchHangup in keyboard.ts).
  //
  //   Shutdown goes through shutdown() as usual — background jobs and subagents need
  //   killing all the more, or they'll outlive this process. But it **must be time-boxed**:
  //   on this path the store may be held by a turn's unfinished write, and waiting here
  //   indefinitely turns the spin we avoided back into a hung orphan.
  keyboard.onHangup = () => {
    const forced = new Promise<void>((resolve) => setTimeout(resolve, HANGUP_SHUTDOWN_MS).unref?.())
    void Promise.race([shutdown(), forced]).finally(() => process.exit(0))
  }
  const deps: InteractiveDeps = {
    runner, runTurn, renderer, region, session, cwd, root, ui,
    spec: () => model.spec,
    workspace: workspaceLabel(root, cwd),
    store, language, titleSession,
    meter, measure, remeasure, settleContext,
    diagnostics: () => diagnostics.snapshot(),
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
    turnSignal: () => turnSignal,
    onResize: (handler) => {
      onResize = handler
    },
    jobs: processJobs,
    agents: agentJobs,
    killAgents: async () => {
      const ids = subagents.list().map(job => job.id)
      for (const id of ids) await subagents.kill(id, "user")
      return ids
    },
    suspendAgent: async (id) => {
      const result = await subagents.suspend(id, "user")
      return `${result.job.id}: ${result.job.status === "exited" ? uiText("suspended", "挂起", "一時停止") : result.job.status}\n${result.output}`
    },
    activity,
    plan,
    notices: { staleSessions: 0 },
    onLiveChange: (handler) => { liveChanged = handler },
    jobOutput: async (id, stop) => {
      if (subagents.list().some(j => j.id === id)) {
        if (!stop) {
          const read = await subagents.read(id, 0, "user")
          return `${read.job.id}: ${read.job.status}\n${read.output}`
        }
        const killed = await subagents.kill(id, "user")
        return `${id}: ${killed.removed ? uiText("killed — removed for good", "已 kill，彻底移除", "kill 済み — 完全に削除") : killed.job.status}\n${killed.output}`
      }
      const result = await (stop ? killJob(id, "user") : readJob(id, 0, "user"))
      return `${result.job.id}: ${result.job.status}\n${result.output}`
    },
    submitWhileBusy: (text) => {
      // Slash commands act on **this session** (switch session, fold history, switch
      // model); they're not words for the model. Running them mid-turn pulls the ground out
      // from under it — they still queue. The settings ones are the exception, executed on
      // the spot by the host (see isLiveCommand)
      if (text.trim().startsWith("/")) return false
      // A line with images waits for its own turn: injecting is synchronous and reading
      // (maybe shrinking) the images isn't, and a message the running turn sees at its
      // next step without its images would be answered as if there were none
      if (imageReferences(text).length > 0 || hasDataImage(text)) return false
      injectUser(text)
      return true
    },
    noteToModel: (text) => {
      // While running, insert on the spot: the main loop rereads the full history from the
      // store **every step** (see agent/loop.ts), so it sees it on the next step — and
      // that's exactly those few dozen seconds of "I flipped the switch, but it's still
      // doing things the old way"
      if (turnSignal !== undefined) injectSynthetic(text)
      // When idle, hold it and land it when the next turn starts. Inserting immediately
      // would make hasUnanswered() true, and pump would then start a turn out of nowhere —
      // a model call nobody asked for
      else pendingNote = text
    },
    hasUnanswered,
    drainAgents,
    stopAgents: () => subagents.abort(),
    onWake: (handler) => {
      wake = handler
    },
    extensions,
    access,
    gate,
    setMode: async (mode) => {
      if (gate.permissionMode === "auto" && mode !== "auto") {
        compaction?.abort(); manualCheck?.abort()
        await runner.cancelAll()
        await subagents.killAll()
        await killAllJobs()
        await runner.drain()
        if (runner.hasPending() || manualCheck || subagents.list().some(job => job.status !== "exited") || listJobs().some(job => job.status === "running")) throw new Error(uiText(
          "Tasks are still stopping; permission mode was not changed. Retry after they finish.",
          "任务仍在停止中，权限模式尚未更改。请稍后重试。",
          "タスクを停止中のため、権限モードは変更されませんでした。停止後に再試行してください。",
        ))
      }
      rememberPermission(mode)
      gate.setMode(mode)
    },
    reset: (targets) => {
      pendingReset = targets
    },
    thinking: () => thinking,
    setThinking: (value) => {
      thinking = value
      rememberThinking(value)
    },
    effort: () => effort,
    setEffort: (value) => {
      effort = value
      rememberEffort(value)
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
    modal,
    setApprovalDraft: value => { approvalDraft = value },
    sshAccess,
    setSandbox: async enabled => {
      compaction?.abort()
      manualCheck?.abort()
      await runner.cancelAll()
      await subagents.killAll()
      await killAllJobs()
      await runner.drain()
      if (runner.hasPending() || manualCheck || subagents.list().some(job => job.status !== "exited") || listJobs().some(job => job.status === "running")) throw new Error(uiText(
        "Tasks are still stopping; sandbox setting was not changed. Retry after they finish.",
        "任务仍在停止中，沙盒设置尚未更改。请稍后重试。",
        "タスクを停止中のため、サンドボックス設定は変更されませんでした。停止後に再試行してください。",
      ))
      const saved = loadConfig()
      saved.sandbox = enabled
      saveConfig(saved)
      access.sandboxEnabled = enabled
    },
    models: {
      limit: () => ({ ...model.info.limit }),
      setLimit: limit => {
        if (![limit.context, limit.output].every(n => Number.isSafeInteger(n) && n > 0) || limit.output > limit.context) throw new Error(uiText(
          "Use positive integer token limits; output must not exceed context.",
          "令牌上限必须为正整数，且输出上限不能超过上下文上限。",
          "トークン上限には正の整数を指定し、出力上限はコンテキスト上限以下にしてください。",
        ))
        const saved = loadConfig(), ref = parseModelRef(model.spec)
        const effective = resolveProviders({ config: saved, auth: loadAuth() }).find(p => p.id === ref.providerID)
        if (!effective) throw new Error(uiText("Current provider is unavailable", "当前 provider 不可用", "現在のプロバイダーは利用できません"))
        saved.providers ??= {}
        const provider = saved.providers[ref.providerID] ??= { type: effective.type }
        provider.models ??= {}
        provider.models[ref.modelID] = { ...provider.models[ref.modelID], limit: { ...limit } }
        saveConfig(saved)
        config = saved
        registry = buildRegistry({ config, auth: loadAuth() })
        model = { ...model, info: registry.resolve(model.spec).info }
        meter.retarget(model.info)
        remeasure()
        setModelChoices(registry.catalog())
      },
      reload: () => { config = loadConfig(); registry = buildRegistry({ config, auth: loadAuth() }); setModelChoices(registry.catalog()); model = { ...model, info: registry.resolve(model.spec).info }; meter.retarget(model.info); remeasure() },
      choices: () => registry.catalog(),
      supportsThinking: () => model.info.supportsThinking,
      // The only reason it can't be remembered. The environment variable overrides config
      // at startup (see defaultModelSpec in llm/setup.ts) — quietly writing a config that
      // won't stick means the next start mysteriously switches back
      rememberBlockedBy: () => envNameInUse("MODEL"),
      switch: (next, remember = true) => {
        let info: ModelInfo
        try {
          // ★ Resolve first, then switch. If resolving fails (unknown provider, no key for
          //   it) not a single field may change — a half-switched model is far worse than
          //   none: spec shows the new one while every turn's request still goes to the
          //   old one, or every turn reports the same credential error
          info = registry.resolve(next).info
        } catch (error) {
          if (error instanceof NoCredentialsError || error instanceof UnknownModelError) return error.message
          throw error
        }
        model = { spec: next, ref: parseModelRef(next), info }
        if (remember && !envNameInUse("MODEL")) setDefaultModel(next)
        // The window and the cache accounting all change with it; the reported number was
        // counted by the previous model
        meter.retarget(info)
        remeasure()

        return undefined
      },
      classifier: () => classifierSpec,
      setClassifier: (next) => {
        if (next !== undefined) {
          try {
            registry.resolve(next)
          } catch (error) {
            if (error instanceof NoCredentialsError || error instanceof UnknownModelError) return error.message
            throw error
          }
        }
        classifierSpec = next
        rememberClassifierModel(next)
        return undefined
      },
    },
    check: {
      command: () => checker?.command,
      enabled: () => checker !== undefined && !checkOff,
      setEnabled: (value) => {
        checkOff = !value
        // On = delete the false from config and go back to auto-detection; while at it,
        // rerun this session's detection (the user may have just run npm install, and tsc
        // wasn't there at last startup)
        rememberCheck(value ? undefined : false)
        checker = value ? detectChecker(root) : detectChecker(root, config.check)
      },
      run: async () => {
        // Its own controller, same reason as compaction: esc must be able to stop it. tsc
        // on a big repo takes tens of seconds, and when it's stuck esc is the only thing
        // the user has
        const controller = new AbortController()
        manualCheck = controller
        try {
          await runProjectCheck(controller.signal, { manual: true })
        } finally {
          manualCheck = undefined
        }
      },
    },
    receipt: (line, tone, text) => receipt(line, tone, text),
    reply: (text) => reply(text),
    asCommand: async (run) => {
      const outer = command
      command = { first: true }
      try { return await run() } finally { command = outer }
    },
    skillSet: () => visibleSkills(),
    mcpStatuses: () => mcp.statuses(),
    // What's on the shelf but not named this time. See shelf in mcp/config.ts — a shelf you
    // can't browse might as well not exist
    mcpShelf: () => mcpConfig.shelf,
    mcpProblems: () => mcpConfig.problems,
    /**
     * Shut down. Runs **time-boxed**; see the SIGTERM comment in boxed().
     *
     * It hangs off deps because the only place with a SIGTERM listener is in boxed(),
     * while `shutdown` is a closure of main() — on that path `process.exit()` skips
     * main()'s finally entirely, so not one line of the shutdown code would run.
     */
    shutdown: async () => {
      const forced = new Promise<void>((resolve) => setTimeout(resolve, HANGUP_SHUTDOWN_MS).unref?.())
      await Promise.race([shutdown(), forced])
    },
    trust: {
      state: () => trust,
      needsChoice: () => needsTrustPrompt,
      empty: () => emptyFolder,
      at: () => {
        // Config can be hand-broken mid-session, and this date is just one line of text
        // for humans — throwing over it would take down the whole startup banner or the
        // /trust reply
        try {
          return folderConfig(root, loadConfig())?.trustedAt
        } catch {
          return undefined
        }
      },
      concern: () => trustConcern,
      set: (next) => {
        trust = next
        if (next !== "concerns") trustConcern = undefined
        markTrust(root, next)
        repaintTrustInput()
      },
      remember: (next) => {
        trust = next
        if (next !== "concerns") trustConcern = undefined
        needsTrustPrompt = false
        rememberFolder(root, { trust: next })
      },
      check: async () => {
        // Started from a normal state, fail closed with checking; started from concerns,
        // the red light and the summary stay in place. `check` is a request for a re-check,
        // not evidence that the risk is gone.
        if (trust !== "concerns") {
          trust = "checking"
          markTrust(root, "checking")
          repaintTrustInput()
        }
        return await startTrustReview()
      },
      running: () => trustJob !== undefined,
      onChange: (handler) => {
        repaintTrustInput = handler
      },
    },
    mcpApprove: (name) => {
      if (!mcp.approve(name)) return false
      // ★ Persisting is this layer's job (src/mcp shouldn't know which file permissions
      //   live in). It goes the "don't ask again" way: separated per workspace, allow only
      rememberApprovals(root, [{ permission: MCP_SERVER_PERMISSION, pattern: name, action: "allow" }])
      return true
    },
    ...(continued ? { continued } : {}),
    wantContinue: flags.continue === true,
    askResume: flags.resume === true,
    // A pipe has no picker. `/resume` therefore takes the newest resumable session other
    // than the one receiving the command; replay stays off so history does not flood the
    // pipe. boxed() replaces this with the interactive picker before any command runs.
    openResume: () => {
      const info = pipedResumeTarget(sessionChoices(deps), deps.session.id)
      if (info) restore(deps, info, { replay: false })
      else reply(theme.dim(`  ${t.resumeCurrent}`))
    },
  }
  try {
    // ★ The terminal was gone before we even came up (automation setsid'd the process
    //   away and then closed the pty). In that case we **must not** fall back to reading
    //   line by line: that path reads a dead fd 0, gets EIO on every read and immediately
    //   reads again — another orphan spinning at full tilt, this time without even a UI.
    //   No terminal and no pipe = nobody will ever send anything in again; just leave.
    if (terminalGone()) return 0

    // open() is the real test: when isTTY is true but raw mode can't be obtained (some CI
    // pseudo-terminals), the drawn UI would never receive a keypress — in that case we
    // must fall back to reading line by line
    if (!keyboard.usable || !keyboard.open()) return await piped(deps)
    return await boxed(deps, keyboard)
  } finally {
    await shutdown()
  }
}

/**
 * Turn one progress step into a line of text.
 *
 * The wording belongs to the UI, not to update/upgrade.ts — it's the same upgrade code,
 * but on the command-line path the interface language hasn't been resolved yet (always
 * the English catalog), while on the in-session path the user may have the Chinese UI on.
 * Events are emitted there and words translated here, so the two paths don't end up one
 * in Chinese and one in English.
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
    // On the line-by-line output path there's no progress bar to draw, and writing a line
    // every 120ms floods the screen. Leave it to quarters() to report at a few marks
    case "progress":
      return undefined
  }
}

/**
 * Download progress without an overlay: one line per quarter.
 *
 * You can't draw a progress bar in line-by-line output, but **reporting nothing at all**
 * brings back the problem the user complained about ("if I don't look closely I can't
 * even tell it's downloading"). Four marks is the amount that shows it's moving without
 * flooding the screen. If the total size isn't available, report nothing — a number with
 * no denominator means nothing.
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
 * `alfa upgrade [--force]`.
 *
 * The output is deliberately verbose: it's modifying an executable on the user's machine,
 * and every step should be visible — which version was found, which file was downloaded,
 * whether it was verified, where it finally landed. A self-update that only says "done"
 * leaves nothing to investigate when something goes wrong.
 *
 * `/upgrade` inside a session is another entry point to the same thing (see
 * upgradeCommand).
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
    // Nobody can cancel on the command-line path (no overlay, no signal passed). It's
    // written here so the compiler keeps an eye on this switch — add a status later and
    // this errors immediately
    case "cancelled":
      process.stderr.write(theme.yellow(`  ${t.upgradeCancelled}\n`))
      return 1
  }
}

/**
 * `alfa uninstall [confirm]` — remove alfa from this machine completely, binary included.
 *
 * The two-step flow is exactly like `/reset`: without confirm it only lists. For why it's
 * retyping a command rather than y/N, see the cli/reset.ts file header — a y/N prompt
 * doesn't give the chance for "wait, there's stuff in there I don't want to lose".
 *
 * This **doesn't run into the sessions.db WAL problem**: this path never opened the
 * store at all (it's split off before any session assembly), so deleting directly is
 * clean. The in-session path can't do that, which is one of the reasons there's no
 * `/uninstall`.
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
    // The three weightiest lines each stand on their own, not mixed into the table above —
    // a table gets skimmed, these need to be read
    if (scope.targets.some((target) => target.hasCredentials)) out.write(theme.yellow(`  ! ${t.resetHasKeys}\n`))
    out.write(theme.yellow(`  ! ${t.resetSessions}\n`))
    if (runningFromSource()) out.write(theme.yellow(`  ! ${t.uninstallFromSource}\n`))
    out.write("\n")
    // .alfa/ dirs scattered across repos: give the command, don't scan on their behalf. See
    // item 1 in the cli/uninstall.ts header comment
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
  // Auth runs before normal startup, but it is still a user-facing screen. Read only the
  // language preference here; a broken config must not make credential repair impossible.
  try { setInterfaceLanguage(loadConfig().language?.interface ?? "auto") }
  catch { setInterfaceLanguage("auto") }
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        provider: { type: "string" },
        type: { type: "string" },
        "base-url": { type: "string" },
        model: { type: "string" },
        // Same as above: must be declared explicitly; parseArgs doesn't understand
        // --no-verify's negation semantics
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

/**
 * Turn outcomes decide whether automatic continuation and compaction may proceed.
 */
interface TurnOutcome {
  interrupted?: boolean
  hitStepLimit?: boolean
  error?: string
}

interface InteractiveDeps {
  setApprovalDraft(value: ApprovalDraft): void
  modal<T>(fn: () => Promise<T>): Promise<T>
  extensions: Extensions
  access: AccessManager
  sshAccess: SshHostAccess
  runner: Runner
  /** No text = go on answering the unanswered one in history (subagent reports use this) */
  runTurn(text?: string): Promise<TurnOutcome>
  renderer: Renderer
  region: LiveRegion
  /**
   * Mutable box for the current session. **Don't pull the id out and keep it** — /resume
   * swaps it
   */
  session: { id: string }
  cwd: string
  root: string
  /** cwd / root as shown to the user. The always-visible "where am I" in the UI */
  workspace: WorkspaceLabel
  /**
   * The current model string. **Read live** — `/model` swaps it, and anywhere that stores
   * a copy stays stuck on the old one forever
   */
  spec(): string
  store: Store
  titleSession(sessionID: string, initialPrompt: string): Promise<void>
  /**
   * The context gauge. The status line reads it every frame, so it must be **cached**, not
   * computed live
   */
  meter: ContextMeter
  /** How much is used now, and by whom. Used by `/context` */
  diagnostics(): DiagnosticSnapshot
  measure(): ContextReport
  /**
   * Re-estimate usage. Must be called after compaction, clearing or switching sessions —
   * the reported number no longer holds
   */
  remeasure(): void
  /** A turn finished: re-estimate + one reminder when nearly full */
  settleContext(): void
  /** Dispatch the compaction agent to write handoff notes. interrupt() handles aborts */
  compact(history: MessageWithParts[], focus?: string): Promise<CompactResult>
  /**
   * The user wants to stop what's in progress.
   *
   * Not just this turn: compaction is also something **that takes tens of seconds**, and
   * when the user presses esc they don't know which kind they're waiting on. Both share
   * one entry point so that "I pressed it and nothing happened" never occurs.
   */
  interrupt(): void
  /**
   * The UI's busy indicator. Compaction uses it — during those tens of seconds the keyboard
   * still takes input, but new messages should queue rather than be inserted into a
   * history that's being folded.
   */
  setBusy(busy: boolean): void
  /**
   * Interface / reply language. /language can change it, so it's a live object, not a
   * snapshot
   */
  language: Required<LanguageConfig>
  /**
   * The current turn's abort signal. On interrupt, any pending permission question must be
   * taken down along with it.
   */
  turnSignal(): AbortSignal | undefined
  ui: {
    preview(label: string, text: string): void
    clearPreview(): void
  }
  /** Background processes started by bash */
  jobs(): readonly JobSnapshot[]
  /** The main agent's phase, turn clock and writing speed (cli/activity.ts) */
  activity: Activity
  /** The checklist the pinned plan row shows; replaced on session switch and compaction */
  plan: { items: TodoItem[] }
  /** Facts found once at startup that only the tips read */
  notices: { update?: string; staleSessions: number }
  /** Install the repaint for changes the main event stream doesn't carry */
  onLiveChange(handler: () => void): void
  /**
   * Subagents dispatched by task. **Listed separately** from processes (`/agents` vs
   * `/jobs`); see the two data sources in main()
   */
  agents(): readonly JobSnapshot[]
  /** `/agents kill`: kill every subagent of this session for good. Returns the names killed. */
  killAgents(): Promise<string[]>
  /** `/agents <id> suspend`: stop it but keep its memory for resume. Returns the receipt. */
  suspendAgent(id: string): Promise<string>
  jobOutput(id: string, kill: boolean): Promise<string>
  /**
   * A message the user slips in while it's still running, passed into the running turn on
   * the spot.
   *
   * Returns false = this message can't be passed that way (a slash command); it queues as
   * usual.
   */
  submitWhileBusy(text: string): boolean
  /**
   * Insert a message into the current session that **the model sees but the UI doesn't
   * show**.
   *
   * ── Why flipping a switch also inserts a message into history ──
   * The system prompt is rebuilt every step, so once `/agentflow` is flipped, the next
   * request already carries the new section — in theory "effective immediately". In real
   * runs it isn't: in a session twenty turns in, **history speaks much louder than
   * system**. In front of the model sit twenty turns of evidence that "I've always done
   * it myself", while the change happens only inside a long text it has seen since the
   * first request, with a few sections quietly swapped this time. What the user sees is
   * "I flipped the switch, and it's still doing things the old way".
   *
   * A message landing **at the moment of the switch** turns it into an event: it has a
   * position, a time, and sits right next to the steps that follow. The synthetic flag
   * keeps it out of the scrollback — it's not something the user
   * said (see TextPart.synthetic in session/schema.ts).
   */
  noteToModel(text: string): void
  /** Whether history holds an unanswered message (that's how subagent reports come in) */
  hasUnanswered(): boolean
  /**
   * Wait for all subagents to come back and digest their reports. Needed by the two paths
   * that have no UI to wake anyone
   */
  drainAgents(): Promise<void>
  /**
   * The "something needs answering, go around once" entry point. The host hooks up its own
   * pump — besides the main loop there's queued user input and context
   * recomputation that must follow along, and only the host knows about those
   */
  onWake(handler: () => void): void
  /**
   * Stop all subagents; returns how many were stopped.
   *
   * Used by `/clear` and `/resume`: after switching conversations, the conclusions those
   * subagents bring back have nowhere to go (the session that dispatched them is gone),
   * while they keep burning money. **Background processes are not included** — a dev
   * server has nothing to do with which session you're in.
   */
  stopAgents(): number
  onResize(handler: () => void): void
  /**
   * The permission gatekeeper. Both commands and the UI read its mode — there's only one
   * source of truth.
   */
  gate: PermissionGate
  setMode(mode: PermissionMode): Promise<void>
  /**
   * `/reset` chose the directories to delete. **Only registers them** — the actual deletion
   * runs after cleanup (see the star in shutdown()). After registering, the caller is
   * responsible for exiting
   */
  reset(targets: ResetTarget[]): void
  /** Is extended thinking on right now. Read by `/think` */
  thinking(): boolean
  /** Toggle extended thinking and remember it. Effective next turn — no restart needed */
  setThinking(value: boolean): void
  /** Reasoning effort; undefined = provider default. Read and written by `/effort` */
  effort(): ReasoningEffort | undefined
  setEffort(value: ReasoningEffort | undefined): void
  /**
   * agentflow: when on, the max number of concurrent subagents; false = off. Read and
   * written by `/agentflow`
   */
  agentflow(): number | false
  setAgentflow(value: number | false): void
  /** Self-compact when the window is nearly full. Read and written by `/compact auto` */
  autoCompact(): boolean
  setAutoCompact(value: boolean): void
  setSandbox(enabled: boolean): Promise<void>
  /** Read and written by `/model` and the `/setting` screen */
  models: {
    limit(): { context: number; output: number }
    setLimit(limit: { context: number; output: number }): void
    /**
     * Which ones to list on tab. Empty doesn't mean broken, just that nobody configured any
     * (see catalog in llm/registry.ts)
     */
    choices(): string[]
    /**
     * Whether the current model supports extended thinking. Switching to one that doesn't
     * while /think is on must be called out on the spot
     */
    supportsThinking(): boolean
    /**
     * The reason it can't be saved (the environment variable overrides config at
     * startup). undefined if it can be saved
     */
    rememberBlockedBy(): string | undefined
    reload(): void
    /**
     * Switch over. **Either everything switches or not a single field changes** — a
     * returned sentence means it didn't switch, and says why (unknown provider / no key
     * for it).
     */
    switch(spec: string, remember?: boolean): string | undefined
    /** auto mode's classifier model; undefined = the conversation's model */
    classifier(): string | undefined
    /**
     * Change it and save it. Resolved first, like switch: a returned sentence means
     * nothing changed. undefined = follow the conversation's model again
     */
    setClassifier(spec: string | undefined): string | undefined
  }
  /** Auto check before wrapping up (see agent/check.ts). Read/written by `/check` */
  check: {
    /** The command currently recognized. undefined = none detected in this project */
    command(): string | undefined
    enabled(): boolean
    setEnabled(value: boolean): void
    /** Run once right now. By the time it returns the receipt has been written */
    run(): Promise<void>
  }
  /**
   * Where receipts currently go. Follows along after onReceipt swaps it — don't pull it
   * out and keep it
   */
  receipt(line: string, tone: NoteTone, text: string): void
  /**
   * Where slash-command replies are written: the scrollback, via renderer.line — hung
   * under the command's echo while asCommand is running one.
   */
  reply(text: string): void
  /**
   * Run a slash command whose echo has just been printed; every reply until it settles
   * goes under that echo. Only the interactive shell uses it: the pipe path keeps bare
   * lines, since whatever reads that stdout has no use for the elbow.
   */
  asCommand<T>(run: () => Promise<T>): Promise<T>
  /** Which skills this session has loaded. See prompt/skills.ts */
  skillSet(): SkillSet
  /** MCP status and approval. See mcp/manager.ts */
  mcpStatuses(): McpStatus[]
  mcpShelf(): string[]
  /**
   * The config entries that couldn't be read. **Someone must speak them out loud** — see
   * the star in mcpCommand
   */
  mcpProblems(): McpProblem[]
  /**
   * Time-boxed shutdown: kill background jobs, subagents, MCP servers; close the store.
   * See the SIGTERM comment in boxed()
   */
  shutdown(): Promise<void>
  /** This folder's trust piece. See cli/trust.ts */
  trust: {
    state(): TrustState
    /**
     * Never asked, or trust was explicitly turned off last time. Only a host with a
     * keyboard can choose again.
     */
    needsChoice(): boolean
    empty(): boolean
    /** The day the trust mark was set. undefined if none (or not trusted now) */
    at(): string | undefined
    /**
     * The summary of what the review explicitly found. Only meaningful in the concerns
     * state; must be wrapped in an untrusted envelope before reaching the model.
     */
    concern(): string | undefined
    set(next: TrustState): void
    /** The opening choice: updates both this session's state and seenAt. */
    remember(next: TrustState): void
    /** Dispatch someone to read it through. A returned sentence = not dispatched: why */
    check(): Promise<string | undefined>
    running(): boolean
    /**
     * A background review can change the state at a moment with no keypress, so the input
     * host must actively redraw on it.
     */
    onChange(handler: () => void): void
  }
  mcpApprove(name: string): boolean
  /** The session `--continue` resumed at startup. Absent means a fresh one */
  continued?: SessionInfo
  /**
   * The user asked for `--continue`. Kept separate from continued: asked for but none here
   * must be called out
   */
  wantContinue: boolean
  /** `--resume`: after assembly, first ask which session to resume */
  askResume: boolean
  /**
   * Resume through the host's available interaction. boxed() swaps in the picker drawn in
   * the live area; a pipe has no picker, so it resumes the newest other session directly.
   */
  openResume(): void
  /**
   * Open the settings screen. **Only boxed() can build it** (it needs arrow keys) —
   * undefined in pipes, where commands are still typed one by one (see settingCommand).
   */
  openDebugger?(): Promise<void>
  openSettings?(page?: string): Promise<void>
}

/**
 * If there's a new version, append a line after the banner.
 *
 * ★ Deliberately **not awaited**: the banner is the first thing that should appear at
 *   startup, and this is a network request. By the time it returns the banner is long
 *   drawn, so it's a receipt appended afterwards — a feature that makes every start two
 *   seconds slower just to deliver good news has negative net value.
 *
 * Asks at most once a day (cached in the data directory), and only tells, never installs:
 * when to switch is the user's call. See update/check.ts.
 *
 * ★ This reminder points at `/upgrade`, not `alfa upgrade`: it only appears in an
 *   interactive session, and at that moment this window is what the user has in hand —
 *   ask them to open another terminal to upgrade and most people drop it on the spot. The
 *   command-line name still works; it's in help.
 */
function noticeUpdate(deps: InteractiveDeps): void {
  void checkForUpdate()
    .then((version) => {
      if (!version) return
      deps.notices.update = version
      const line = t.updateAvailable(version, "/upgrade")
      deps.receipt(theme.yellow(`  ⌁ ${line}`), "warn", line)
    })
    .catch(() => {
      // The update check breaking on its own shouldn't leave any trace on the user's screen
    })
}

function banner(deps: InteractiveDeps): void {
  const { renderer } = deps
  const label = (text: string) => theme.dim(`  ${text.padEnd(6)} `)
  /**
   * ★ The **warnings** on the banner go through receipt, not renderer.line.
   *
   * They are the "the user must see this" lines — the active auto mode, agentflow being
   * on, unapproved MCP, an untrusted folder — and every one of them carries the same
   * reason: "stored things can be forgotten, what's written on screen can't". receipt is
   * the channel for that kind of line: today it is renderer.line underneath, and if a host
   * ever routes receipts somewhere more prominent (onReceipt), these follow with it.
   *
   * The **facts** above (version, model, window, cwd, rules) still go through
   * renderer.line: they're an opening introduction, not "you need to know this is in
   * effect".
   */
  const warn = (line: string, text: string) => deps.receipt(theme.yellow(`  ${line}`), "warn", text)
  const danger = (line: string, text: string) => deps.receipt(theme.red(`  ${line}`), "bad", text)
  renderer.line(theme.bold(`alfa ${VERSION}`))
  renderer.line(label(t.bannerModel) + theme.dim(deps.spec()))
  // How big the window is should be known before starting work: it decides how long this
  // session can go on, and finding out halfway through that it's only 120k is too late
  const snapshot = deps.meter.snapshot
  renderer.line(
    label(t.bannerWindow) + theme.dim(t.bannerWindowValue(compactNumber(snapshot.limit), compactNumber(snapshot.budget))),
  )
  renderer.line(label(t.bannerCwd) + theme.dim(deps.cwd))
  if (deps.root !== deps.cwd) renderer.line(label(t.bannerRoot) + theme.dim(deps.root))
  renderer.line(label(t.bannerRules) + rulesLine(deps))
  // Falling back to PowerShell / cmd is an **invisible input**: it decides what syntax the
  // model should write and whether every command gets asked about separately, and if not a
  // word of it is on screen, the user just thinks "it's being chatty today"
  const shell = resolveShell()
  if (!shell.posix) warn(t.bannerShellFallback(shell.label), t.bannerShellFallback(shell.label))
  // MCP servers defined in the project but not yet approved must be announced at startup —
  // they don't start by default, and if something "configured but not in effect" gets not
  // a word on screen, the user just assumes the config is wrong and goes to edit a file
  // that's perfectly fine
  const waiting = deps.mcpStatuses().filter((one) => one.state === "needs-approval").length
  if (waiting > 0) warn(t.mcpBanner(waiting), t.mcpBanner(waiting))
  // ★ Same rule, harder version: a server definition that **can't be read** doesn't even
  //   rank as "not approved" — it never made the list at all. Say nothing on screen and
  //   the user sees "I clearly configured it, yet it's not there" — while `/mcp` would
  //   reply "no MCP servers configured", pushing them to edit a file that's fine.
  const broken = deps.mcpProblems().length
  if (broken > 0) warn(t.mcpBannerProblems(broken), t.mcpBannerProblems(broken))
  // ★ Third time for the same rule: this folder's AGENTS.md is **not in effect**, and
  //   that's the kind of thing a user spends half an hour suspecting they got the format
  //   wrong over. Stored things can be forgotten, what's written on screen can't
  const trustState = deps.trust.state()
  if (trustState !== "trusted") {
    const line = trustState === "checking" ? t.trustBannerChecking : trustState === "concerns" ? t.trustBannerConcerns : t.trustBanner
    if (trustState === "concerns") danger(line, line)
    else warn(line, line)
  }
  // Remembered allows must be announced at startup. They make some tool calls **stop
  // asking you**, which is exactly "invisible automation" — who approved it last time, and
  // what, is forgotten within a week
  // ★ Same rule, same reason: agentflow is **persisted** too. Someone who doesn't remember
  //   turning it on sees "why did it suddenly dispatch sixteen people", and those sixteen
  //   cost money
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

/**
 * The most instruction files the banner names. Beyond that, just a count — this line gets
 * a glance
 */
const RULES_SHOWN = 2

/**
 * "Which conventions this session starts work with".
 *
 * ── Why it's worth a line ──
 * AGENTS.md is an **invisible input**: it goes into the system prompt and changes every
 * reply, yet not a word of it is on screen. With two repos open at once, questions like
 * "why is it suddenly asking me to indent with tabs" can only be answered by this line.
 *
 * ── Even more important to say when there are none ──
 * Left empty, "this project has no instruction file yet" and "it does, it just didn't
 * tell you" look exactly the same. And the former can be fixed on the spot, so this is
 * the only "here's something you can do" on the whole banner.
 */
function rulesLine(deps: InteractiveDeps): string {
  const files = discoverInstructions({ cwd: deps.cwd, root: deps.root })
  const names = files.slice(0, RULES_SHOWN).map((file) => shortPath(file.path, deps.root))
  if (files.length > RULES_SHOWN) names.push(t.rulesMore(files.length - RULES_SHOWN))
  // Notes and instruction files are two halves of the same thing (see prompt/memory.ts),
  // so they're reported on the same line. The model writes them itself, which is all the
  // more reason to let the user know how many are riding along with every reply
  const memos = discoverMemories(deps.root).memos.length
  if (memos > 0) names.push(t.rulesMemos(memos))
  const body = names.length === 0 ? t.rulesNone : names.join(", ")
  // Only check whether the project's own one exists. The global one (in ~/.config) comes
  // with every repo and can't answer "how does this repo work" — let it suppress the hint
  // and the hint never appears
  const project = files.some((file) => file.scope === "project")
  return theme.dim(project ? body : `${body} ${t.rulesInitHint}`)
}

/**
 * Inside the workspace, write relative paths; outside, fold home into `~`. One banner line
 * can't hold an absolute path
 */
function shortPath(path: string, root: string): string {
  const rel = relative(root, path)
  return rel.length > 0 && !rel.startsWith("..") ? rel : homePath(path)
}

/**
 * Where a slash command goes after it runs.
 *
 *   true    — stop here, don't send it to the model
 *   false   — not a command at all; send it as-is as a message
 *   string  — the command **expanded into a prompt**; send that (`/init` is currently the
 *             only one)
 *
 * The third was added later. It exists because half of what `/init` does only the model
 * can do (reading through the repo), while the command itself has no runTurn — forcing a
 * turn to run here would mean writing the busy indicator and the queued next
 * message all over again in each host. Return a piece of text and all of that stays on
 * the host's usual path.
 */
type SlashOutcome = boolean | string

/**
 * Slash commands that can be **executed on the spot** even while a turn is running.
 *
 * ── Why this table exists ──
 * Running other slash commands mid-turn pulls the ground out from under it: `/clear`
 * swaps the session, `/compact` folds history, `/resume` switches to another session —
 * while the running turn rereads history from the store on every step. So they still
 * queue (see submitWhileBusy).
 *
 * ★ But these **only change a let**, and every one of those lets is read live: the system
 *   prompt is rebuilt every step, the permission mode is asked on every call, the
 *   interface language only affects the next frame (`/view` only replies). The only
 *   consequence of queueing them is "I flipped the switch, and it won't listen until
 *   it's done with this" — and `/agentflow` is exactly the one users want to press while
 *   **watching it grind away on its own**.
 *
 * ⚠ Before adding anything, ask: does this command touch session history, the model, or
 *   the running turn? An ordinary setting that touches any of them can't go in this table;
 *   /access and /ssh, which revoke access, are the exception — they explicitly interrupt
 *   work. That's how `/model` is kept out — the model is fixed at the start of the turn
 *   (see input.model in runner.start), and swapping it midway would have the rest of the
 *   turn's steps carry on with thinking blocks half of which belong to another provider.
 */
const LIVE_COMMANDS = ["/ssh", "/jobs", "/agents", "/access", "/detail",  "/agentflow", "/think", "/effort", "/permission", "/view", "/language"]

export function isLiveCommand(text: string): boolean {
  const name = text.trim().split(/\s+/)[0] ?? ""
  return LIVE_COMMANDS.includes(name.toLowerCase())
}

/**
 * Slash commands. For the return value see SlashOutcome.
 * Deliberately kept few — each one added is another chance for "the user thought it was
 * a message".
 *
 * ── Why async ──
 * Most commands are a synchronous one-line reply, but `/compact` dispatches an agent to
 * read the whole session, which takes tens of seconds. Have the caller await it, and
 * messages queued behind it **dutifully wait for it to finish** — fire-and-forget, and a
 * new message the user sends halfway through compaction gets folded in behind a summary
 * that doesn't contain it, then vanishes into thin air.
 */
async function slashCommand(
  raw: string,
  deps: InteractiveDeps,
  exit: () => void,
): Promise<SlashOutcome> {
  // ★ Match on the text with leading/trailing whitespace stripped. A command is a line on
  //   its own, and a trailing space shouldn't decide whether it's a command — completion
  //   leaves exactly one after filling in a command name (see bareHint in
  //   cli/commands.ts), and hand-typed `/help ` shows up everywhere. Without the trim none
  //   of them would match, and they'd be sent to the model as a message
  const text = raw.trim()
  if (await deps.extensions.command(text)) return true
  // The ones with arguments can't go through the exact-match switch below
  const arg = (name: string) => text.slice(name.length).trim()
  if (/^\/(jobs|agents)(\s|$)/.test(text)) {
    const [name, id, action] = text.split(/\s+/)
    try {
      if (name === "/agents" && id === "kill") {
        const killed = await deps.killAgents()
        deps.reply(killed.length > 0
          ? uiText(`Killed ${killed.join(", ")} — removed for good, they can't be woken.`, `已 kill ${killed.join("、")}，彻底移除，不能再唤醒。`, `${killed.join("、")} を kill しました。完全に削除され、再開できません。`)
          : uiText("No subagents to kill.", "没有可 kill 的子代理。", "kill できるサブエージェントはありません。"))
      } else if (name === "/agents" && id && action === "suspend") {
        deps.reply(await deps.suspendAgent(id))
      } else if (id) deps.reply(await deps.jobOutput(id, action === "kill"))
      else deps.reply((name === "/agents" ? deps.agents() : deps.jobs()).map(j => `${j.id} · ${j.status}${j.setup?.model ? ` · ${j.setup.model}` : ""} · ${j.command}`).join("\n") || uiText(
        "No background tasks. Use /jobs <id> or /agents <id> for output; append kill to stop.",
        "暂无后台任务。使用 /jobs <id> 或 /agents <id> 查看输出；末尾加 kill 可停止。",
        "バックグラウンドタスクはありません。出力は /jobs <id> または /agents <id>、停止は末尾に kill を付けます。",
      ))
    } catch (error) { deps.reply(describe(error)) }
    return true
  }

  if (text === "/ssh" || text.startsWith("/ssh ")) {
    const value = arg("/ssh")
    const revoke = /^revoke (\S+)$/.exec(value)
    if (revoke) {
      deps.sshAccess.revoke(revoke[1] === "all" ? undefined : revoke[1])
      deps.interrupt()
      deps.stopAgents()
      deps.reply(uiText("SSH host authorization revoked; active calls are being cancelled.", "已撤销 SSH 主机授权，正在取消活动调用。", "SSH ホストの許可を取り消しました。実行中の呼び出しを中止しています。"))
    } else if (!value) deps.reply(uiText(
      `SSH hosts authorized for this conversation: ${deps.sshAccess.list().join(", ") || "(none)"}\n/ssh revoke HOST|all`,
      `本次会话已授权的 SSH 主机：${deps.sshAccess.list().join("、") || "（无）"}\n/ssh revoke HOST|all`,
      `このセッションで許可済みの SSH ホスト：${deps.sshAccess.list().join("、") || "（なし）"}\n/ssh revoke HOST|all`,
    ))
    else deps.reply(uiText("Usage: /ssh or /ssh revoke HOST|all", "用法：/ssh 或 /ssh revoke HOST|all", "使用方法：/ssh または /ssh revoke HOST|all"))
    return true
  }
  if (text === "/access" || text.startsWith("/access ")) {
    const match = /^\/access (add|revoke) (?:(read|write) (session|persistent) )?(.+)$/.exec(text)
    try {
      if (match?.[1] === "add" && match[2] && match[3]) {
        const grant = deps.access.add(resolve(deps.cwd, match[4]!), match[2] as "read" | "write", match[3] === "persistent")
        deps.reply(uiText(
          `Granted ${grant.mode} directory: ${grant.path} (${match[3]})`,
          `已授权${grant.mode === "read" ? "读取" : "写入"}目录：${grant.path}（${match[3] === "persistent" ? "长期" : "本次会话"}）`,
          `${grant.mode === "read" ? "読み取り" : "書き込み"}ディレクトリを許可しました：${grant.path}（${match[3] === "persistent" ? "永続" : "このセッション"}）`,
        ))
      } else if (match?.[1] === "revoke") {
        deps.interrupt()
        deps.stopAgents()
        await killAllJobs()
        deps.access.revoke(match[4] === "all" ? undefined : resolve(deps.cwd, match[4]!))
        deps.reply(uiText("Access revoked; running jobs stopped.", "已撤销路径授权，并停止正在运行的任务。", "パスの許可を取り消し、実行中のタスクを停止しました。"))
      } else {
        const grants = deps.access.list().map(g => uiText(
          `${g.mode} ${g.directory ? "directory" : "file"} ${g.path} (${g.persistent ? "persistent" : "session"})`,
          `${g.mode === "read" ? "读取" : "写入"} ${g.directory ? "目录" : "文件"} ${g.path}（${g.persistent ? "长期" : "本次会话"}）`,
          `${g.mode === "read" ? "読み取り" : "書き込み"} ${g.directory ? "ディレクトリ" : "ファイル"} ${g.path}（${g.persistent ? "永続" : "このセッション"}）`,
        )).join("\n")
        deps.reply(uiText(
          `Initial root: ${deps.access.root}\nOS sandbox: ${sandboxStatus(deps.access)}\n${grants}\n/access add read|write session|persistent /absolute/directory\n/access revoke /absolute/path|all`,
          `初始根目录：${deps.access.root}\n系统沙盒：${sandboxStatus(deps.access)}\n${grants}\n/access add read|write session|persistent /absolute/directory\n/access revoke /absolute/path|all`,
          `初期ルート：${deps.access.root}\nOS サンドボックス：${sandboxStatus(deps.access)}\n${grants}\n/access add read|write session|persistent /absolute/directory\n/access revoke /absolute/path|all`,
        ))
      }
    } catch (error) { deps.reply(describe(error)) }
    return true
  }
  if (text === "/detail" || text.startsWith("/detail ")) {
    const records = deps.store.listAll(deps.session.id).flatMap(m => m.parts).filter((p): p is ToolPart => p.type === "tool")
    const query = arg("/detail")
    const selected = query ? records.filter(p => p.callID === query || p.tool === query) : records.slice(-1)
    deps.reply(selected.map(p => toolDetails(p, deps.root)).join("\n") || uiText("No tool records yet.", "暂无工具记录。", "ツールの記録はまだありません。"))
    return true
  }

  if (text === "/permission" || text.startsWith("/permission ")) {
    await permissionCommand(arg("/permission"), deps)
    return true
  }
  if (text === "/sandbox" || text.startsWith("/sandbox ")) {
    const value = text.slice(8).trim()
    if (value && value !== "on" && value !== "off") { deps.reply(uiText("Usage: /sandbox on|off", "用法：/sandbox on|off", "使用方法：/sandbox on|off")); return true }
    if (value) await deps.setSandbox(value === "on")
    deps.reply(sandboxMessage({ preference: deps.access.sandboxEnabled, active: deps.access.sandboxActive, backend: sandboxBackend(), blocked: bwrapBlocked() }))
    return true
  }
  if (text === "/setting" || text === "/settings" || text === "/config") {
    await settingCommand(deps)
    return true
  }
  if (text === "/view" || text.startsWith("/view ")) {
    viewCommand(arg("/view"), deps)
    return true
  }
  if (text === "/think" || text.startsWith("/think ")) {
    thinkCommand(arg("/think"), deps)
    return true
  }
  if (text === "/effort" || text.startsWith("/effort ")) {
    effortCommand(arg("/effort"), deps)
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
    await modelCommand(arg("/model"), deps)
    return true
  }
  if (text === "/models" || text.startsWith("/models ")) {
    await modelCommand(arg("/models"), deps)
    return true
  }
  if (text === "/history-clean" || text.startsWith("/history-clean ")) {
    cleanHistoryCommand(arg("/history-clean"), deps)
    return true
  }
  // The old name. Not listed in completion (see aliases in cli/commands.ts), but if it can
  // be typed it must be recognized — answer a deleting command with "unknown command" and
  // the user's next step is guessing what it's called now
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
  // The only one that expands into a prompt: the folder is created here, AGENTS.md is
  // left to the model
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
      deps.reply(theme.dim(t.helpPlain))
      return true
    case "/skills":
      skillsCommand(deps)
      return true
    case "/cache-hit":
      deps.reply(renderCacheMetrics(deps.diagnostics()))
      return true
    case "/debugger":
      if (deps.openDebugger) await deps.openDebugger()
      else deps.reply(renderCacheOverview(deps.diagnostics()))
      return true
    case "/context":
    case "/content":
      contextCommand(deps)
      return true
    case "/clear":
      clearCommand(deps)
      return true
    default:
      return false
  }
}

/**
 * `/clear`: start a new session.
 *
 * Clearing only the screen left the model in the old conversation. Switch sessions instead. The old one **loses not a single word** — it still sits
 * in `/resume`, ready to be picked up any time. That's also the precondition for safely
 * changing this command's semantics: the cost is one extra `/resume`, not lost data.
 *
 * ── Why start a new one rather than empty the current one ──
 * Emptying means DELETEing a whole session's messages. And "I pressed clear to change the
 * subject" and "I pressed clear to destroy the last half hour" are two entirely different
 * things; nobody has ever asked for the latter.
 */
function clearCommand(deps: InteractiveDeps): void {
  // ★ Stop subagents first, then switch sessions. They were dispatched by the **previous**
  //   session, and their answers have nowhere left to go
  const stopped = deps.stopAgents()
  deps.sshAccess.revoke()
  deps.access.clearSession()
  deps.gate.clearSession()
  void killAllJobs()
  const id = newSessionID()
  deps.store.createSession(id, deps.cwd)
  deps.session.id = id
  // ★ Reset first, then clear — same reason as restore(): the renderer may be holding a
  //   half line of markdown the previous session never closed, and the other order would
  //   drop that half line into the new session's transcript
  deps.renderer.reset()
  deps.renderer.resetPlan()
  deps.plan.items = []
  // A new session: context drops back to just system + tool definitions, and spend starts
  // from zero. Without clearing, the status line would keep showing the previous
  // session's numbers, which is exactly what this command is meant to clean up
  deps.meter.drop()
  deps.meter.resetSpend()
  // Files read in the previous session no longer count — in the new session it doesn't
  // hold a single byte of file content
  forgetReads()
  deps.settleContext()
  // Nothing else on screen changes — the old session's lines stay in the scrollback above
  // — so this line is the **only** evidence that the keypress did anything
  deps.reply(theme.dim(`  ${t.cleared}`))
  // Also say how many were stopped. Otherwise the ones the user sent out just never
  // report back, with no word why
  if (stopped > 0) deps.reply(theme.dim(`  ${t.agentsStopped(stopped)}`))
}

/**
 * `/think [on|off]`: toggle extended thinking, **remembered in config**.
 *
 * No argument means toggle — it's a two-state switch, and nobody uses a switch that makes
 * you remember "what's the argument called" every time. It's persisted because it isn't
 * a one-off choice: people who want to see how the model thinks want it every turn, and
 * `--thinking` would have to be retyped at every start.
 *
 * Effective next turn, no restart: it's read live every turn (see runTurn).
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
 * `/effort [low|medium|high|xhigh|max|default]`: how hard the model thinks, **remembered
 * in config**.
 *
 * No argument shows the current level instead of cycling: with five levels, a bare
 * command that silently moves to the next one would leave the user counting presses.
 * `default` is spelled out rather than being "no argument" for the same reason — it's a
 * choice (stop sending the field), not a query.
 *
 * It is one level for the whole session and its subagents; each adapter rounds it to
 * what the current model takes (see providers/*.ts), so switching `/model` never turns
 * a remembered level into a 400.
 */
function effortCommand(arg: string, deps: InteractiveDeps): void {
  const show = (level: ReasoningEffort | undefined) => level ?? t.effortProviderDefault
  if (arg.length === 0) {
    deps.reply(theme.dim("  ") + theme.bold(t.effortNow(show(deps.effort()))) + theme.dim(`\n  ${t.effortUsage}`))
    return
  }
  if (arg !== "default" && !isReasoningEffort(arg)) {
    deps.reply(theme.red(`  ${t.unknownEffort(arg)}`) + theme.dim(`\n  ${t.effortUsage}`))
    return
  }
  const next = arg === "default" ? undefined : arg
  deps.setEffort(next)
  const line = theme.dim("  ") + theme.bold(t.effortNow(show(next)))
  deps.reply(`${line}\n${theme.dim(`  ${next ? t.effortHint : t.effortDefaultHint}`)}\n${theme.dim(`  ${t.effortRemembered}`)}`)
}

/**
 * `/agentflow [on|off|N]`: let it dispatch many subagents at once, arranged into a
 * pipeline. **Remembered in config**.
 *
 * Turning it on changes three things: the concurrency window (4 → N), the total cap
 * (8 → 24), and an extra section in system about how to split up work (see
 * prompt/agentflow.ts). `task`'s `after` parameter is **there either way** —
 * orchestration shouldn't hinge on a display switch; the switch only tunes the scale.
 *
 * ── Why confirm mode only gets a warning, not a block ──
 * A dozen-odd subagents will line up a dozen-odd approval boxes in front of the user,
 * which is genuinely unpleasant. But the permission mode is something they set
 * explicitly, and changing it for them takes away a security decision — far worse than
 * unpleasant. Say it clearly, then do as they said.
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
  // ★ Say the same thing twice: once for the user (the three lines below), once for the
  //   model. Change only system and in a session twenty turns in it barely budges — see
  //   noteToModel
  if (next !== current) deps.noteToModel(flowNote(next))
  const head = theme.dim("  ") + theme.bold(next === false ? t.agentflowOff : t.agentflowOn(next, MAX_FLOW_ALIVE_JOBS))
  const hint = theme.dim(`  ${next === false ? t.agentflowOffHint(MAX_AGENT_JOBS) : t.agentflowHint}`)
  // ★ The warning must come **when it's turned on**, not when the tenth box pops up
  const warn =
    next !== false && deps.gate.permissionMode === "confirm"
      ? `\n${theme.yellow(`  ⚠ ${t.agentflowConfirmWarning}`)}`
      : ""
  deps.reply(`${head}\n${hint}${warn}`)
}

/**
 * The message given to the model the moment the switch flips. **Exported for unit
 * tests.**
 *
 * None of three things in the wording can be left out:
 *   · The first line states "not from the user". It's a user message (only that role can
 *     be inserted between turns), and the model's first reaction to a user message is "a
 *     person is talking to me".
 *   · State clearly what the setting is **now**, numbers included — those two numbers are
 *     the entire content of this switch.
 *   · Say outright that **nothing needs redoing**. Otherwise a model just told "go
 *     parallel now" may well tear apart the half it has already finished and redo it,
 *     when the user only flipped a switch.
 */
export function flowNote(flow: number | false): string {
  const head = "Automated message, not from the user."
  if (flow === false) {
    return `${head} The user has just switched agentflow off. The "Agentflow is on" section is gone from your system prompt: back to ordinary working, up to ${MAX_AGENT_JOBS} subagents at a time, with no expectation that you fan work out. Carry on from where you are — nothing needs redoing.`
  }
  return `${head} The user has just switched agentflow on: up to ${MAX_FLOW_ALIVE_JOBS} subagents in flight, ${flow} of them running at once. Your system prompt now carries an "Agentflow is on" section — read it and work that way from here, whatever you have been doing so far in this conversation. Carry on from where you are; nothing already finished needs redoing.`
}

/**
 * How old `/history-clean` clears when no day count is given. One week — see
 * cleanHistoryCommand
 */
const CLEAN_HISTORY_DAYS = 7

/**
 * Max lines in the directory list. Beyond that, just a count — the table is for spotting
 * "which project takes the space", not a ledger
 */
const CLEAN_DIR_LINES = 5

/**
 * `/history-clean [days] [confirm]`: delete old sessions sitting on this machine.
 *
 * ── Why this exists ──
 * Sessions **only ever accumulate**: one per start, another per `/clear`, and `/resume`
 * lists only the latest 50. After half a year, most of what sits in the store is stuff
 * nobody will ever open again, full text and all — code, paths, diffs. Undeletable
 * history is both an ever-growing chunk of disk and an unmanaged trail.
 *
 * ── Two steps, same reason as `/reset` ──
 * Without confirm it only **lists** what would be deleted: how many sessions, how many
 * messages, when the oldest one was, which directories they're spread across. This list
 * is the only chance to notice "wait, there's stuff in there I still want" before
 * pressing it. So `confirm` still **isn't a completion candidate** (see cli/commands.ts).
 *
 * ── The session in hand is never touched ──
 * Resume a three-week-old session and then tidy up while you're at it, and what gets
 * cleared is the very ground you're standing on. So the current session (along with the
 * subagents it dispatched) is kept unconditionally, guaranteed on the store side (see
 * staleHistory).
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
    // Which directory takes the space. **Aligned by display width** — paths may contain
    // Chinese, and counting characters would skew the column
    const shown = sweep.directories.slice(0, CLEAN_DIR_LINES)
    const pad = Math.max(0, ...shown.map((entry) => displayWidth(entry.directory)))
    for (const entry of shown) {
      lines.push(theme.dim(`    ${padToWidth(entry.directory, pad)}  ${entry.sessions}`))
    }
    if (sweep.directories.length > shown.length) {
      lines.push(theme.dim(`    ${t.cleanMoreDirs(sweep.directories.length - shown.length)}`))
    }
    // The two weightiest lines each stand on their own, not mixed into the table above —
    // a table gets skimmed, these two need to be read
    lines.push(theme.yellow(`  ! ${t.cleanWarn}`))
    lines.push(theme.dim(`  ${t.cleanKeeps}`))
    lines.push("")
    lines.push(theme.bold(`  ${t.cleanConfirm(`/history-clean ${days === CLEAN_HISTORY_DAYS ? "" : `${days} `}confirm`)}`))
    deps.reply(lines.join("\n"))
    return
  }

  const was = fileBytes(deps.store.file)
  deps.store.deleteSessions(sweep.ids)
  // After deleting we must VACUUM, or the file won't shrink by a single byte (see
  // store.vacuum). Failing to get the exclusive lock isn't a failure — the data is already
  // deleted; the file just couldn't be shrunk this time
  const blocked = deps.store.vacuum()
  const freed = was - fileBytes(deps.store.file)
  const done = [theme.dim(`  ${t.cleanDone(sweep.sessions + sweep.agents, sweep.messages)}`)]
  if (blocked !== undefined) done.push(theme.dim(`  ${t.cleanNotShrunk}`))
  else if (freed > 0) done.push(theme.dim(`  ${t.cleanFreed(`${compactNumber(freed)}B`)}`))
  deps.reply(done.join("\n"))
}

/**
 * How much disk the store takes.
 *
 * ★ **Count all three files together**: the store runs in WAL mode, and the few hundred KB
 *   just deleted are most likely still in `sessions.db-wal`; count only the main file and
 *   it reports "freed 0" — while `du` clearly shows half gone. Unreadable counts as 0: the
 *   number is only used to report "how much was freed", not worth aborting cleanup over.
 */
function fileBytes(path: string): number {
  let total = 0
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += statSync(path + suffix).size
    } catch {
      // Not having this file is perfectly normal (no WAL, or just checkpointed)
    }
  }
  return total
}

/**
 * `/reset [all] confirm`: delete everything belonging to alfa on this machine.
 *
 * ── Two steps, not one ──
 * Without confirm it only **lists** what would be deleted: which directories, how big,
 * what's in them. This list is the only chance to notice "wait, there's stuff in there I
 * don't want to lose" before pressing it — a y/N prompt can't give that chance, because
 * it doesn't spell out what's being deleted.
 *
 * ── confirm must be typed out in full ──
 * So it **isn't a completion candidate** (see cli/commands.ts): this command's only
 * safety boundary is "typing it out takes a few seconds", and a confirmation tab can fill
 * in is no confirmation at all.
 *
 * ── Exit after deleting ──
 * The process holds a resolved model and an open sessions.db. With the files gone but
 * those still around, the program enters a state that "looks normal but operates on
 * nonexistent things at every step". The actual deletion happens after cleanup (see
 * shutdown), otherwise SQLite would write the database file back when closing.
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
    // The two weightiest lines each stand on their own, not mixed into the table above —
    // a table gets skimmed, these two need to be read
    if (targets.some((target) => target.hasCredentials)) lines.push(theme.yellow(`  ! ${t.resetHasKeys}`))
    lines.push(theme.yellow(`  ! ${t.resetSessions}`))
    // The project directory is **not deleted by default**, but we must say it's there —
    // otherwise after a "complete reset" the model still remembers last round's notes, and
    // the user has no idea where they came from
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
 * `/setting`: lay out all settings on one screen.
 *
 * ── Why this command does almost nothing itself ──
 * That screen needs arrow keys and a cell that accepts characters, and pipes have none of
 * that. So this only **decides whether that screen exists**: if so, open it;
 * if not, fall back to the way out it always had — slash commands one by one. The
 * fallback lists the command names because this person has just proven they can't
 * remember them (otherwise they wouldn't have typed this one).
 */
async function settingCommand(deps: InteractiveDeps): Promise<void> {
  if (deps.openSettings) {
    await deps.openSettings()
    return
  }
  deps.reply(theme.dim(`  ${t.settingNoScreen}`))
}

/**
 * `/model [provider/model]`: see which one is in use, or switch on the spot.
 *
 * ── Why switching models doesn't clear history ──
 * What changes is "who answers next", not "start over". The whole conversation is carried
 * over as-is — the most common moment for this command is precisely "the cheap one is
 * stuck, switch to a strong one and keep going", and at that point history is the entire
 * value. Anyone who really wants to start over has `/clear`.
 *
 * The only thing that can't be carried over is **thinking blocks**: they're signed and
 * only the original vendor accepts them, so switching provider means dropping them
 * (agent/to-model-messages.ts has long been doing this, comparing providerID+modelID one
 * by one). So the receipt must say so — otherwise all the user notices is "after the
 * switch it seems to have forgotten what it was just thinking".
 *
 * ── Why list the candidates when there's no argument ──
 * Same reason as `/permission`: a command whose arguments you can only guess might as
 * well not exist. And it's worse here — the argument is a model name nobody can remember.
 */
async function modelCommand(arg: string, deps: InteractiveDeps): Promise<void> {
  const snapshot = deps.meter.snapshot
  const window = t.modelWindow(compactNumber(snapshot.limit), compactNumber(snapshot.budget))

  if (arg.length === 0) {
    const current = deps.spec()
    // ★ If that screen exists, open it straight on the **model page**. Bare `/model` has
    //   always been this command's most common use, and today its answer is "here's a
    //   list, now please type one of its lines back by hand" — nobody can remember those
    //   model names, and completion means retyping the command too. Picking one with the
    //   arrow keys and pressing enter is how this should have worked all along
    if (deps.openSettings) {
      await deps.openSettings("model")
      return
    }
    const lines = [theme.dim("  ") + t.modelCurrent(theme.bold(current)) + theme.dim(` · ${window}`)]
    const choices = deps.models.choices()
    if (choices.length === 0) lines.push(theme.dim(`  ${t.modelNoChoices}`))
    else {
      lines.push(theme.dim(`  ${t.modelChoicesTitle}`))
      for (const spec of choices) {
        // The current one stays in the list too, just marked — with "where you are"
        // removed from the list, the reader has to go through it first to know whether
        // they're on it
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

  // ★ Read the window live: the one above is from **before the switch**. Going from 200k
  //   to 30k, a receipt showing the old window is telling a lie on the spot, and this line
  //   is exactly what the user uses to judge "how much longer can we go"
  const after = deps.meter.snapshot
  const lines = [
    theme.dim("  ") +
      theme.bold(t.modelSwitched(arg)) +
      theme.dim(` · ${t.modelWindow(compactNumber(after.limit), compactNumber(after.budget))}`),
    theme.dim(`  ${t.modelKeepsHistory}`),
  ]
  // Switching to a model that doesn't support it while /think is on: from then on that
  // switch silently does nothing
  if (deps.thinking() && !deps.models.supportsThinking()) {
    lines.push(theme.yellow(`  ${t.modelNoThinking(arg)}`))
  }
  const blocked = deps.models.rememberBlockedBy()
  lines.push(blocked ? theme.yellow(`  ${t.modelEnvWins(blocked)}`) : theme.dim(`  ${t.modelRemembered}`))
  deps.reply(lines.join("\n"))
  // ★ Going from 200k to 30k, a session that had plenty of room a moment ago may no longer
  //   fit on the spot. This must be said **before** the next turn — find out it's over the
  //   limit only after sending, and all the user has left is an error
  deps.settleContext()
}

/**
 * `/permission [mode|forget]`.
 *
 * With no argument, report the current state and list the options — a command whose
 * arguments you can only guess might as well not exist. The current state **includes the
 * remembered allows**: together with the mode they decide "will this call ask you", and
 * a rule that's stored but can't be looked up is the same thing as an invisible
 * automatic allow.
 */
async function permissionCommand(arg: string, deps: InteractiveDeps): Promise<void> {
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
  await deps.setMode(mode)
  deps.reply(theme.dim("  ") + t.currentMode(theme.bold(mode), modeInfo(mode).hint))
}

/** List at most this many remembered allows. Beyond that, go look at the json */
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
 * `/permission forget`: clear all allows remembered for this workspace.
 *
 * Memory and disk are cleared together. Clear only one side and: memory only → they come
 * back at the next start; disk only → they stay in effect for this session while the user
 * thinks they've been revoked.
 */
function forgetCommand(deps: InteractiveDeps): void {
  const count = deps.gate.forgetApproved()
  forgetApprovals(deps.root)
  deps.reply(theme.dim("  ") + (count === 0 ? t.forgotNothing : t.forgotApprovals(count)))
}

/**
 * `/resume`: switch to another session and carry on.
 *
 * Only responsible for "is there anything to pick" and "bring up the UI". Which session
 * to pick is asked by the host, and switching over is done by restore() — keeping these
 * three apart is what lets `--resume` (at startup) and `/resume` (once running) take the
 * same path.
 */
function resumeCommand(deps: InteractiveDeps): void {
  if (sessionChoices(deps).length === 0) {
    deps.reply(theme.dim(`  ${t.resumeEmpty}`))
    return
  }
  deps.openResume()
}

/**
 * Sessions in this directory that can be resumed. Capped at 50: beyond that they can't be
 * told apart by date anyway.
 */
function sessionChoices(deps: InteractiveDeps): SessionInfo[] {
  return deps.store.listSessions({ directory: deps.cwd, limit: 50 })
}

/** A pipe cannot ask which row to choose; prefer the newest session that is not current. */
export function pipedResumeTarget(sessions: readonly SessionInfo[], currentID: string): SessionInfo | undefined {
  return sessions.find((session) => session.id !== currentID)
}

/**
 * Resume an old session.
 *
 * Two things done together; leave out either and it breaks:
 *   ① Swap the current session — otherwise new messages are written into another
 *      session, with no error
 *   ② Replay history into the scrollback — otherwise "it remembers, you can't see", and
 *      people start repeating what they already said
 *
 * `clear` runs right after the renderer reset. No caller passes one at present: the
 * previous session's lines simply stay in the terminal's scrollback above the replay.
 */
function restore(
  deps: InteractiveDeps,
  info: SessionInfo,
  options: { replay?: boolean; clear?: () => void } = {},
): void {
  // Same reason as `/clear`: after resuming another session, the conclusions the previous
  // session's subagents bring back have nowhere to go. See InteractiveDeps.stopAgents
  const stopped = deps.stopAgents()
  deps.sshAccess.revoke()
  deps.access.clearSession()
  deps.gate.clearSession()
  void killAllJobs()
  deps.session.id = info.id
  deps.store.touchSession(info.id)
  void deps.titleSession(info.id, info.preview)
  // ★ Reset first, then clear. The renderer may be holding a half line of markdown the
  //   previous session never closed — the other order would have that half line **land
  //   in the new session's transcript** after clearing
  deps.renderer.reset()
  options.clear?.()

  const history = deps.store.listAll(info.id)
  let restored = info.messages
  deps.renderer.resetPlan()
  deps.plan.items = latestPlan(history)
  if (options.replay !== false) {
    restored = replay(history, {
      line: (text) => deps.renderer.line(text),
      handle: (event) => deps.renderer.handle(event),
    })
    // After replay, finalize the half line markdown is holding, so it doesn't stick to
    // the first thing the user says next
    deps.renderer.reset()
  }
  deps.receipt(theme.dim(`  ⏎ ${t.resumed(restored)}`), "good", t.resumed(restored))
  if (stopped > 0) deps.receipt(theme.dim(`  · ${t.agentsStopped(stopped)}`), "info", t.agentsStopped(stopped))
  // A different session, so of course a different usage figure — the number the provider
  // reported belongs to the **previous** session, and the same goes for spend (it counts
  // "how much this run spent on this session").
  // Placed after "resumed": when resuming a nearly full session, the reminder then won't
  // jump ahead of "restored N messages" and read as if it were about another session
  deps.meter.drop()
  // ★ Spend **continues from the previous run of this session**, not from zero. Tokens this
  //   session spent before were really spent, and restarting the process doesn't refund
  //   them — show 0 and a long-running session resumed with `--continue` would only ever
  //   show the small "since this launch" slice, while the user reads it to learn what
  //   this session has cost
  deps.meter.resetSpend(billedFromHistory(history))
  // A different session, so what's been read changes too. The read outputs in history are
  // indeed still in context, but they may be from three days ago — and "resume after a
  // process restart" has to re-read anyway; the same command giving different safety
  // levels for "resume after restart" versus "resume while running" is what would
  // really bite
  forgetReads()
  deps.settleContext()

}



/**
 * `/context` (alias `/content`): what's in the window right now.
 *
 * ── Why this command exists ──
 * The cell on the status line only answers "how much is left", while the decision people
 * really need to make when the window is nearly full is "which chunk to cut". That
 * decision depends on the composition: if 80% is tool results, the answer is compaction;
 * if 80% is the system prompt, the answer is stop piling things into AGENTS.md. A gauge
 * that only reports the total keeps people guessing wrong.
 */
function contextCommand(deps: InteractiveDeps): void {
  deps.reply(renderContextReport(deps.measure(), deps.spec()))
}

/**
 * `/check [on|off]`: the automatic check before wrapping up.
 *
 * No argument = **run it once right now**, not print "it's on". Nine times out of ten
 * this command is typed when "I want to know whether it's red right now", and only
 * actually running it can answer that.
 *
 * This manual run's result isn't fed back to the model: the user wanted to take a look
 * themselves, not direct it to go fix things — if they want it fixed, one sentence does
 * it, and that sentence is the real instruction.
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

  // Running it may take several seconds. The busy indicator must light up, or the UI
  // looks dead
  deps.setBusy(true)
  deps.reply(theme.dim(`  ${t.checkRunning(command)}`))
  try {
    await deps.check.run()
  } finally {
    deps.setBusy(false)
  }
}

/**
 * `/upgrade [check|force]`: replace this binary without leaving the session.
 *
 * ── Why it deserves an entry point inside the session too ──
 * "A new version is out" shows up on the startup banner (see noticeUpdate), and at that
 * moment this window is all the user has in hand. Ask them to open another terminal to
 * upgrade, abandoning the session they're halfway through, and most people drop it on
 * the spot — so the reminder repeats every day and the version doesn't move for a month.
 *
 * ── Two levels ──
 *   /upgrade         install if there's a new version; if already latest, just say so
 *                    (`/upgrade check` is accepted as the same thing — see inside)
 *   /upgrade force   re-download and reinstall even if already latest (the only self-rescue
 *                    when the install is broken)
 *
 * `--force` / `-f` are accepted too: that's how the command line spells it, and "the same
 * thing needs two spellings in two places" is pure memory burden.
 *
 * ── No restart after switching ──
 * What gets replaced is the file on disk; the running process is still the old one (on
 * POSIX it holds the inode). So this command **doesn't end the session** — getting kicked
 * out mid-conversation is far worse than using the new version a few minutes later. The
 * cost is that the receipt must spell out "takes effect after restart", or the user will
 * assume the new features are there right away.
 */
async function upgradeCommand(arg: string, deps: InteractiveDeps): Promise<void> {
  const word = arg.trim().replace(/^--?/, "").toLowerCase()
  const force = word === "force" || word === "f"
  // `check` is still accepted, but it **is** /upgrade.
  //
  // It was once "check without installing": wanting to know whether there's a new
  // version isn't wanting to switch now. But that path split something that was really a
  // single action into two entry points — the user types check out of habit, gets
  // "already latest", and then has to type it again without an argument to actually
  // upgrade. And "check" is the first step of upgrading anyway: run it with no argument,
  // and if it's already latest it likewise just tells you so and installs nothing
  if (word.length > 0 && !force && word !== "check") {
    deps.reply(theme.red(`  ${t.upgradeUnknown(arg.trim())}`) + theme.dim(`\n  ${t.upgradeUsage}`))
    return
  }

  // ── Actually downloading and installing ──
  const controller = new AbortController()
  const progress = quarters()
  deps.reply(theme.dim(`  ${t.upgradeChecking}`))

  deps.setBusy(true)
  let outcome
  try {
    outcome = await upgrade({
      force,
      signal: controller.signal,
      onProgress: (event) => {
        const line = upgradeLine(event) ?? progress(event)
        if (line) deps.reply(theme.dim(`  ${line}`))
      },
    })
  } finally {
    deps.setBusy(false)
  }

  // "alfa on this machine was replaced once" must leave a
  // trace in the conversation — same rule as permission receipts (the approval box closes
  // and leaves one line; see confirm in cli/confirm.ts)
  switch (outcome.status) {
    case "current":
      deps.reply(theme.dim(`  ${t.upgradeCurrent(outcome.version)}`))
      return
    case "updated": {
      const line = t.upgradeDone(outcome.from, outcome.to)
      deps.receipt(theme.green(`  ✓ ${line}`), "good", line)
      deps.reply(theme.dim(`    ${outcome.path}`))
      return
    }
    case "cancelled":
      deps.reply(theme.yellow(`  ${t.upgradeCancelled}`))
      return
    case "blocked": {
      // "Couldn't even ask" and "something broke" are two different messages: the former
      // isn't a failure, it's "this can't be answered right now". Report it as a failure
      // and the user goes hunting for an error that doesn't exist (see reason in
      // update/upgrade.ts)
      const line = outcome.reason === "unreachable" ? t.upgradeUnreachable : t.upgradeFailed(outcome.why)
      deps.receipt(theme.red(`  ✗ ${line}`), "bad", line)
      return
    }
  }
}

/**
 * `/init`: so that from the next session on, this project doesn't have to be learned
 * from scratch again.
 *
 * See the long comment in prompt/init.ts. This only handles three things: create the
 * folder on the spot, say what was created, then expand the other half into a prompt and
 * hand it back to the host (see SlashOutcome).
 *
 * ── Carry on even if the folder can't be created ──
 * The folder only gets a README here; AGENTS.md is what this command is really after.
 * Blocking the whole thing over a read-only mount would let a minor failure wreck the
 * main success.
 *
 * ── `/init 重点看后端` ("focus on the backend") ──
 * Whatever follows is carried into the prompt as-is. It's what users instinctively try
 * the first time they use this command, and "unknown command" is the least reasonable
 * answer in that position.
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
 * The three things `/init` needs. A narrow interface rather than taking InteractiveDeps,
 * so that `--prompt "/init"` works too — on that path InteractiveDeps hasn't been
 * assembled yet.
 */
interface InitHost {
  root: string
  receipt(line: string, tone: NoteTone, text: string): void
  reply(text: string): void
}

/**
 * Recognize a slash command in a `--prompt` run.
 *
 * Only `/init`, and this isn't "support one now, add more later" — in one-shot mode,
 * `/think`, `/permission` and the like all change things for the **next session**, which
 * in a process that exits right after running amounts to doing nothing. `/init` is
 * different: it changes the disk, which persists after exit.
 */
function expandOneShot(text: string, host: InitHost): string {
  if (text === "/init" || text.startsWith("/init ")) return initCommand(text.slice("/init".length).trim(), host)
  return text
}

/**
 * Report → the shape the tool side understands (see ContextView in tool/types.ts).
 *
 * The tool layer doesn't know ContextReport, and shouldn't — it's the main loop's ledger,
 * which also holds things like ratio / limitSource that only the UI has use for.
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

/**
 * A one-line description of how it exited. Killed by a signal and exit 1 are two
 * different things; don't write both as "failed"
 */
function exitLabel(exit: number | null | undefined, signal: string | undefined): string {
  if (signal) return t.jobExitKilled(signal)
  return t.jobExitCode(exit === null || exit === undefined ? "?" : String(exit))
}

/**
 * With fewer messages than this there's nothing worth compacting — compaction itself
 * costs a request
 */
const COMPACT_MIN_MESSAGES = 4

/**
 * At what fraction to act on our own.
 *
 * Sitting a bit above the yellow line (WARN_AT = 0.8) is deliberate: that line first says
 * "nearly full", leaving the user some room to decide for themselves — compact now,
 * finish what they're in the middle of first, or just switch sessions. Only at this line
 * do we stop waiting for them, because beyond it is the wall, and hitting the wall looks
 * like "every turn fails" — by then the only move they have is compaction, and they're
 * most likely stuck in the middle of something half done.
 */
const AUTO_COMPACT_AT = 0.9

/**
 * A turn finished; see whether to compact on our own.
 *
 * ── Why **between turns**, not the moment it gets nearly full ──
 * Compaction rewrites nothing in the store, but it moves where the model's history
 * starts: it appends a compaction point, and from then on everything before it — bar
 * whole turns kept verbatim (CompactPart.keptFrom) — reaches the model only as the
 * summary. Drop that point mid-run and, unless the turn in progress fits the verbatim
 * tail, the first half of the model's current tool loop is folded into prose while the
 * rest is still being written after the point; and the summary itself was written from
 * calls still running. The turn boundary is the only moment when "the history is
 * complete and nobody is reading it".
 *
 * ── No compaction after an interrupt ──
 * The user just pressed esc; what they want is to **stop**. Automatically running
 * something that takes tens of seconds right then is exactly what that keypress was
 * trying to avoid.
 */
async function maybeAutoCompact(deps: InteractiveDeps, outcome?: { interrupted?: boolean }): Promise<void> {
  if (!deps.autoCompact() || outcome?.interrupted === true) return
  if (deps.meter.snapshot.ratio < AUTO_COMPACT_AT) return
  await runCompaction(deps, { auto: true })
}

/**
 * `/compact [auto on|off] [what to keep]`: fold history into handoff notes.
 *
 * ── It folds **the copy sent to the model**, not the one in the store ──
 * See CompactPart in session/schema.ts: not a word of the original is deleted; it's all
 * still in the store, and `/resume` replays it. So this command is safe — the worst case
 * is a poorly written summary, and even then the original is still there and `/resume`
 * can pick it back up.
 *
 * ── The argument is free text, not a subcommand ──
 * Apart from the `auto` branch, everything that follows is handed as-is to the compaction
 * agent as "what to take special care to keep this time" (see CompactRequest.focus).
 * Compaction is lossy, and only the user knows which part can't afford the loss — looking
 * at a whole session, the model can't tell that "those three lines of error are the
 * whole point of the last two days".
 */
async function compactCommand(arg: string, deps: InteractiveDeps): Promise<void> {
  const words = arg.split(/\s+/).filter(Boolean)
  if (words[0]?.toLowerCase() === "auto") {
    autoCompactCommand(words.slice(1).join(" ").toLowerCase(), deps)
    return
  }
  await runCompaction(deps, { focus: arg })
}

/**
 * `/skills` — which playbooks are at hand, and which ones failed to load.
 *
 * "The broken ones" must be spelled out: when a skill is missing its description or has
 * a space in its name, the symptom is that it **doesn't show up at all**, and all the
 * user has is "but I definitely wrote one". The error must say which file and what's
 * wrong.
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

/**
 * `/mcp` — see which servers this session has connected, and approve the ones coming from
 * the project.
 *
 * ── Why approval is a command, not a box that pops up at startup ──
 * A startup popup gets dismissed with eyes closed: at that moment the user is thinking "I
 * want to get to work", not "I want to audit a process list someone else wrote". Yet the
 * risk here can only be judged by looking carefully — a project's `.alfa/mcp.json` can
 * specify **commands to run**, so cloning an unfamiliar repo adds one more execution
 * path. So the default is **not to start them**; the banner says how many are waiting,
 * and `/mcp` lays them out, command lines included, for the user to see.
 */
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
   * ★ The malformed entries. **They need saying even more than "none configured" does.**
   *
   * These unreadable definitions originally never showed a single word: loadMcpConfig
   * deliberately doesn't throw (a bad config shouldn't stop the program from starting),
   * and then the caller took problems and threw them away. So someone missing a comma in
   * `.alfa/mcp.json` got this from `/mcp`: "no MCP servers configured — add them under
   * "mcp" in config.json" — a line pointing them somewhere else. They edited the file that
   * was fine, while the one actually broken was never even mentioned.
   */
  const problemLines = problems.map(
    (one) => `  ${theme.yellow("●")} ${theme.bold(one.name ?? "?")} ${theme.dim(one.source)}\n      ${theme.yellow(one.why)}`,
  )

  if (statuses.length === 0) {
    const empty = problems.length > 0 ? [...problemLines] : [theme.dim(`  ${t.mcpEmpty}`)]
    // Not a single server connected, but something on the shelf: exactly the occasion
    // most worth a word — the user has most likely switched projects and forgot this one
    // needs a `use`
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
 * `/trust [on | off | check]`.
 *
 * ── Why this command must exist ──
 * The "take a look first" path is **one-off**: once the check has run, it's settled. But
 * people's judgment of a repo changes — yesterday it was cloned just to look around,
 * today they're starting to commit to it. Without this command, the only way to change
 * one's mind is to hand-edit a key in config.json they most likely don't know exists.
 *
 * ★ `off` takes effect on the spot: the very next step's system prompt no longer carries
 *   those files (see the trustProject star in buildSystemParts). Not "next start" — a
 *   safety switch that needs a restart to take effect isn't protecting you yet at the
 *   moment you press it.
 */
async function trustCommand(arg: string, deps: InteractiveDeps): Promise<void> {
  const summary = trustSummary(deps.root, deps.trust.state(), deps.trust.at())

  if (arg.length === 0) {
    const lines = [theme.dim("  ") + summary]
    // When untrusted, also spell out "what this means". A bare state word doesn't let
    // the user judge whether they should change it
    if (deps.trust.state() === "concerns") {
      lines.push(theme.red(`  ${t.trustConcernAction}`))
      const detail = deps.trust.concern()
      if (detail) lines.push(theme.red(detail))
    } else if (deps.trust.state() !== "trusted") lines.push(theme.dim(`  ${t.trustNowUntrusted}`))
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

/** `/compact auto [on|off]`: the auto-compaction switch, remembered in config */
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
 * Actually run a compaction. `/compact` and the automatic trigger take the same path —
 * write it once for each and sooner or later you get an error like "manual compaction
 * cleared the ledger, automatic didn't", which only surfaces in long sessions.
 */
async function runCompaction(deps: InteractiveDeps, options: { focus?: string; auto?: boolean } = {}): Promise<void> {
  const history = deps.store.listAll(deps.session.id)
  const foldable = history.length - compactionIndex(history)
  if (foldable < COMPACT_MIN_MESSAGES) {
    // Stay quiet on the automatic path: the user pressed no key, and "nothing worth
    // compacting" isn't something they need to know
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
  // The reported number is from the request **before** compaction and no longer counts.
  // Without clearing it, the gauge would stay frozen — right at the moment the user is
  // staring at it
  deps.meter.drop()
  // The pinned plan follows what the model is sent: folded away → gone, kept tail → stays
  deps.plan.items = latestPlan(deps.store.listAll(deps.session.id))
  // The folded history includes those read outputs. Handoff notes often say "next: change
  // X to Y in foo.ts", and without clearing the ledger it would act on that line directly
  // — while it no longer has foo.ts in hand
  forgetReads()
  deps.remeasure()
  const freed = Math.max(0, before - deps.meter.snapshot.used)
  // Also say how many messages were kept verbatim. Otherwise "folded 40" reads as "the
  // last few turns are gone too", while the user's next message often continues exactly
  // those turns
  const line =
    t.compacted(result.folded, compactNumber(freed)) + (result.kept > 0 ? ` · ${t.compactKept(result.kept)}` : "")
  deps.receipt(theme.green(`  ⌦ ${line}`), "good", line)
  // Re-arm the "nearly full" reminder. If it's still above the yellow line after
  // compaction (possible in a session piled with tens of MB of output), it says so again
  // on the spot — which is exactly what the user needs to know
  deps.settleContext()
}

/**
 * `/view`: the single-column transcript is the only view, so this just says so and
 * points at the scrollback and `/detail`. Kept rather than deleted for anyone who still
 * types `/view stream` — "unknown command" would leave them guessing where the other view
 * went.
 */
function viewCommand(_arg: string, deps: InteractiveDeps): void {
  deps.reply(uiText(
    "The single-column transcript is the only view. Use terminal scrollback or /detail.",
    "目前仅提供单栏会话视图。可使用终端回滚记录或 /detail 查看详情。",
    "現在は 1 列の会話表示のみです。端末のスクロールバックまたは /detail を利用してください。",
  ))
}

/**
 * `/language [interface|reply] [auto|en|zh|ja]`.
 *
 * Two separate settings because they really are different: the interface language is
 * this program's own copy, the reply language is what the model speaks. A native Chinese
 * speaker working in Japan wants an English UI with Chinese replies — tie them together
 * and half the people always have to make do.
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
  // The interface language switches immediately; the reply language takes effect next
  // turn — it's spliced into the system prompt, and the running turn was sent long ago
  if (kind === "interface") setInterfaceLanguage(value)
  rememberLanguage(kind, value)
  // ★ The label must be **fetched again** after switching languages: if it still says
  //   "interface language" in the old language after switching to Japanese, the very first
  //   line of feedback is in the old language and looks like the switch didn't work
  const settled = kind === "interface" ? t.languageInterface : t.languageReply
  deps.reply(theme.dim("  ") + t.languageSwitched(settled, languageLabel(value)))
}

/**
 * The single-column terminal host. Model, context and working directory stay below the
 * input box; pickers share the keyboard stack.
 */
async function boxed(deps: InteractiveDeps, keyboard: Keyboard): Promise<number> {
  // By now the raw keyboard is really open, so -p / pipes can't be hit by mistake. First
  // clear the viewport left by earlier commands, then draw the α shared with the website;
  // scrollback is kept, so you can still scroll up when needed.
  clearInteractiveViewport(deps.region)
  for (const line of brandMark()) deps.renderer.line(theme.green(line))
  deps.renderer.line("")
  if (deps.trust.needsChoice()) {
    if (deps.trust.empty()) {
      // An empty directory has no project material that could influence the model, so
      // just remember we've been here; if files are added later, /trust off or check can
      // still take it back. This special case spares every newly created directory from
      // passing through an empty gate first.
      deps.trust.remember("trusted")
    } else {
      try {
        deps.trust.remember(await firstFolderReview(terminalForm(keyboard, deps.region), deps.root))
      } catch (error) {
        if (error instanceof InputCancelled) return 0
        throw error
      }
    }
  }
  // A red light left from the last exit can't live only in config and the banner. The
  // main agent needs the same verdict too, so it can answer the user's follow-up
  // questions and help delete harmful content; trustConcernNote adds the envelope in one
  // place.
  if (deps.trust.state() === "concerns") {
    deps.noteToModel(trustConcernNote(deps.trust.concern() ?? ""))
  }
  deps.settleContext()
  banner(deps)
  const sandboxNotice = sandboxStartupMessage({ preference: deps.access.sandboxEnabled, active: deps.access.sandboxActive, backend: sandboxBackend(), blocked: bwrapBlocked() })
  if (sandboxNotice) deps.reply(sandboxNotice)
  noticeUpdate(deps)
  // "Take a look first" isn't finished — either just chosen on the opening card, or cut
  // off halfway last time. Finish it in the background; when the verdict is back it will
  // say so itself (see finishTrustReview)
  if (deps.trust.state() === "checking" && !deps.trust.running()) void deps.trust.check()
  trimHistory()
  const editor = new Editor(loadHistory())

  let done = () => {}
  const exited = new Promise<void>((resolve) => {
    done = resolve
  })

  let toolOutput = loadConfig().appearance?.toolOutput ?? "compact"
  let animation = loadConfig().appearance?.animation ?? "on"
  let reasoningDisplay = loadConfig().appearance?.reasoning ?? "preview"
  const files = new FileIndex(deps.root)
  const tips = new Tips()
  // Counted once: a store query per paint would be a query per keystroke, and the answer
  // only changes when /history-clean runs (which says what it removed anyway)
  try {
    deps.notices.staleSessions = deps.store.staleHistory(Date.now() - CLEAN_HISTORY_DAYS * 86_400_000, [deps.session.id]).sessions
  } catch {
    // A tip is not worth failing startup over
  }
  /**
   * The footer's cache figure: `/cache-hit`'s actual hit rate for this session's task
   * requests on the model the footer names. Memoized on the ledger's request count — the
   * footer is read every animation frame, the figure changes once per request.
   */
  let cacheMemo: { key: string; value: number | null | undefined } | undefined
  const footerCache = (): number | null | undefined => {
    const snapshot = deps.diagnostics()
    const key = `${snapshot.totalRequests}|${deps.session.id}|${deps.spec()}`
    if (cacheMemo?.key === key) return cacheMemo.value
    const entries = snapshot.entries.filter(entry => {
      const execution = entry.usage.execution
      return (execution?.requestKind === "main" || execution?.requestKind === "subagent") &&
        (execution.rootSessionId ?? execution.sessionId) === deps.session.id &&
        `${entry.usage.model.providerID}/${entry.usage.model.modelID}` === deps.spec()
    })
    const records = entries.flatMap(entry => entry.usage.cache ? [entry.usage.cache] : [])
    const value = entries.length === 0 ? undefined : aggregateCacheDiagnostics(records).comparison.hitRate
    cacheMemo = { key, value }
    return value
  }
  const shell = new Shell({
    footer: (width) => {
      const snapshot = deps.meter.snapshot
      return footerLines({
        path: deps.workspace.path, spec: deps.spec(), ratio: snapshot.ratio, estimated: snapshot.estimated,
        cache: footerCache(), speed: deps.activity.speed(), thinking: deps.thinking(), effort: deps.effort(),
      }, width)
    },
    activity: deps.activity,
    animate: () => animation === "on",
    thinkingPreview: () => reasoningDisplay === "preview",
    pinned: (width, max) => pinnedRows({ plan: deps.plan.items, agents: deps.agents(), jobs: deps.jobs() }, width, max),
    placeholder: () => tips.current({
      ratio: deps.meter.snapshot.ratio, update: deps.notices.update, mode: deps.gate.permissionMode,
      staleSessions: deps.notices.staleSessions,
    }),
    region: deps.region,
    keyboard,
    editor,
    files: query => files.search(query),
    concern: () => deps.trust.state() === "concerns",
    pasteImage: async () => {
      const saved = await saveClipboardImage(join(dataDir(), "clipboard"))
      if ("path" in saved) return `@${displayPath(saved.path)} `
      throw new Error(saved.error === "no-image" ? t.clipboardNoImage : t.clipboardUnsupported(saved.hint))
    },
    pasteText: (text) => saveDataImages(text, join(dataDir(), "clipboard")),
    // The launch tip is gone for good once anything is sent (see cli/tips.ts)
    onSubmit: (text) => { tips.dismiss(); void pump(text) },
    onSubmitBusy: (text) => {
      // Settings-only commands are handled on the spot even mid-turn. See isLiveCommand
      if (isLiveCommand(text)) {
        // The trailing blank keeps the answer, which resumes streaming right after, from
        // reading as the block's last line
        void command(text.trim()).finally(() => deps.renderer.line(""))
        return "handled"
      }
      if (!deps.submitWhileBusy(text)) return false
      for (const line of userLines(text, deps.region.active ? deps.region.width : undefined)) deps.renderer.line(line)
      return true
    },
    onCancel: () => deps.interrupt(),
    onExit: done,
    mode: () => deps.gate.permissionMode,
    setMode: (mode) => deps.setMode(mode),
  })
  deps.trust.onChange(() => shell.paint())
  // Subagent steps and process exits arrive in bursts (a wave of agents all streaming);
  // coalesce them into one frame, and skip entirely while the animation timer is already
  // repainting several times a second
  let liveTimer: ReturnType<typeof setTimeout> | undefined
  deps.onLiveChange(() => {
    if (liveTimer) return
    liveTimer = setTimeout(() => { liveTimer = undefined; shell.paint() }, 100)
    liveTimer.unref?.()
  })

  deps.openDebugger = async () => {
    try {
      const input = terminalForm(keyboard, deps.region)
      const form: Form = {
        ...input,
        ask: (label, secret) => deps.modal(() => input.ask(label, secret)),
        choose: (label, choices, initial, options) => deps.modal(() => input.choose!(label, choices, initial, options)),
      }
      deps.onResize(() => form.repaint?.())
      await debuggerMenu(form, deps.diagnostics)
    } catch (error) { if (!(error instanceof InputCancelled)) deps.reply(describe(error)) }
    finally { deps.onResize(() => shell.paint()); shell.paint() }
  }
  deps.openSettings = async (page) => {
    try {
      const input = terminalForm(keyboard, deps.region)
      // ★ Hold the queue only while waiting for user input; the check command requests
      //   approval again, so holding the lock for the whole settings session would
      //   deadlock itself.
      const form: Form = {
        ...input,
        ask: (label, secret) => deps.modal(() => input.ask(label, secret)),
        choose: (label, choices, initial, options) => deps.modal(() => input.choose!(label, choices, initial, options)),
      }
      deps.onResize(() => form.repaint?.())
      await settings(form, {
          command: text => slashCommand(text, deps, done),
          reload: () => deps.models.reload(),
          switch: spec => deps.models.switch(spec, false),
          setClassifier: spec => deps.models.setClassifier(spec),
          models: () => deps.models.choices(),
          setLimit: limit => deps.models.setLimit(limit),
          state: () => ({ sandbox: deps.access.sandboxEnabled, limit: deps.models.limit(), model: deps.spec(), classifier: deps.models.classifier(), permission: deps.gate.permissionMode, trust: deps.trust.state(), interface: deps.language.interface, reply: deps.language.reply, check: deps.check.enabled(), thinking: deps.thinking(), effort: deps.effort(), agentflow: deps.agentflow(), autoCompact: deps.autoCompact(), theme: currentTheme(), toolOutput, animation, reasoning: reasoningDisplay }),
          appearance: (key, value) => {
            const config = loadConfig()
            config.appearance = { ...config.appearance, [key]: value }
            saveConfig(config)
            if (key === "theme") setTheme(value as ThemeName)
            else if (key === "animation") { animation = value as "on" | "off"; shell.refreshAnimation() }
            else if (key === "reasoning") { reasoningDisplay = value as "off" | "preview" | "full"; deps.renderer.setReasoning(reasoningDisplay) }
            else { toolOutput = value as "compact" | "expanded"; deps.renderer.setToolOutput(toolOutput) }
          },
          access: {
            list: () => deps.access.list(),
            add: (path, mode, persistent) => {
              if (!isAbsolute(path)) throw new Error(uiText("Use an absolute directory path", "请输入绝对目录路径", "絶対パスのディレクトリを指定してください"))
              deps.access.add(path, mode, persistent)
            },
            revoke: async path => {
              deps.interrupt(); deps.stopAgents(); await killAllJobs(); deps.access.revoke(path)
            },
          },
        }, page)
    } catch (error) { if (!(error instanceof InputCancelled)) deps.reply(describe(error)) }
    finally { deps.onResize(() => shell.paint()); shell.paint() }
  }
  deps.setApprovalDraft({ editor, restore: () => shell.paint() })
  deps.setBusy = (busy) => shell.setBusy(busy)
  deps.ui.preview = (label, text) => shell.setPreview(label, text)
  deps.ui.clearPreview = () => shell.clearPreview()
  deps.onResize(() => shell.paint())
  /**
   * The picker is drawn in the live area, where the input box is drawn too — after
   * picking, the input box must redraw once to cover it back.
   *
   * Not awaited here: slash commands are synchronous, while picking is a process that
   * waits on keypresses. Suspend the whole pump to wait for it and every message queued
   * behind gets stuck.
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
   * User input and subagent wake-ups share one lock; after an interrupt it must not resume
   * on its own
   */
  const pending: string[] = []
  let pumping = false
  /**
   * Was woken while running.
   *
   * ★ Without recording this there's a hole: a report lands after runTurn returns but
   *   before the loop has decided, that wake is blocked by the pumping lock, and if this
   *   turn was interrupted by esc (mayResume is false) the loop just wraps up — the report
   *   sits in the store waiting for the user to speak, while the screen says "you'll be
   *   woken". A newly arrived report is **new input**, not "carry on after an interrupt".
   */
  let wokenWhilePumping = false
  const echo = (text: string) => {
    for (const line of userLines(text, deps.region.width)) deps.renderer.line(line)
  }
  /**
   * Echo a slash command as typed, then run it with its replies hung under that echo. A
   * command that throws says so inside its own block and counts as handled — thrown out
   * to pump, the error landed below the block and ended the loop, stranding whatever was
   * queued behind it until the next wake.
   */
  const command = (text: string): Promise<SlashOutcome> => {
    echo(text)
    return deps.asCommand(() => slashCommand(text, deps, done).catch((error): SlashOutcome => {
      deps.reply(describe(error))
      return true
    }))
  }

  /**
   * Run one message, then check whether anything piled up in the queue.
   *
   * Pressing enter while running doesn't interrupt: a plain message slips into the running
   * turn (submitWhileBusy), a slash command queues here — an afterthought shouldn't force
   * the user to wait for the previous turn to end before they can type.
   */
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
          // A line starting with `/` is echoed before it runs, so what it prints lands
          // under it; anything else is echoed as the message it turns out to be. A path
          // like `/Users/…` or an unknown command takes the first branch and still goes
          // to the model — the echo is the same one either way
          const slash = next.trim().startsWith("/")
          const expanded = slash ? await command(next) : await slashCommand(next, deps, done)
          if (expanded === true) continue
          if (!slash) echo(next)
          send = expanded === false ? next : expanded
        }

        shell.setBusy(true)
        const outcome = await deps.runTurn(send)
        const summary = deps.activity.end()
        shell.setBusy(false)
        if (summary) deps.renderer.line(theme.dim(`  ✻ ${turnReceipt(summary)}`))
        deps.renderer.line("")
        mayResume = !outcome.interrupted && !outcome.hitStepLimit && outcome.error === undefined
        deps.settleContext()
        await maybeAutoCompact(deps, outcome)
        void files.refresh().then(() => shell.paint())
      }
    } catch (error) {
      shell.setBusy(false)
      deps.reply(describe(error))
    } finally {
      pumping = false
    }
  }
  deps.onWake(() => void pump())

  // ★ Installing a SIGTERM listener replaces the default "terminate", so this must exit
  //   itself — only restore the terminal and `kill` tidies the screen while the process
  //   **keeps running**, leaving `kill -9` as the only way out. 143 = 128+15, the code a
  //   shell gives a TERM kill, so scripts can't tell the difference.
  //
  // ⚠ Restoring the terminal isn't enough either: shutdown() is the only place that kills
  //   background jobs, subagents and MCP servers. Skip it and after `kill <pid>` or
  //   `docker stop` the dev server still holds its port and the `npx` MCP tree keeps
  //   running, all adopted by init. deps.shutdown is time-boxed for the same reason as
  //   onHangup in main(): the store may be held by a turn's unfinished write.
  const onTerm = () => { shell.stop(); void deps.shutdown().finally(() => process.exit(143)) }
  process.on("SIGTERM", onTerm)
  shell.start()
  void files.refresh().then(() => shell.paint())
  if (deps.continued) restore(deps, deps.continued)
  else if (deps.wantContinue) deps.renderer.line(theme.dim(`  ${t.continueNone}`))
  // The picker and the input box fight over the same live area, so let the shell draw
  // first and then call it — the other order would have the input box cover the list
  // immediately
  if (deps.askResume) resumeCommand(deps)
  try { await exited } finally { process.off("SIGTERM", onTerm); shell.stop() }
  return 0
}

/**
 * No terminal (pipe / CI): read line by line, one line per turn.
 *
 * This path must stay. `echo "fix the test" | alfa` and stuffing it into scripts are real
 * uses, and the input-box setup can't draw a single character without a TTY.
 */
async function piped(deps: InteractiveDeps): Promise<number> {
  banner(deps)
  const sandboxNotice = sandboxStartupMessage({ preference: deps.access.sandboxEnabled, active: deps.access.sandboxActive, backend: sandboxBackend(), blocked: bwrapBlocked() })
  if (sandboxNotice) deps.reply(sandboxNotice)
  noticeUpdate(deps)
  // ★ On this path the trust re-check is **not** re-run automatically. This is the
  //   fallback for when "the keyboard can't be obtained" (CI pseudo-terminals, pipes), and
  //   kicking off a model call on its own in a process nobody is watching is exactly the
  //   kind of invisible automation this program avoids everywhere. Wait until the next
  //   time they open the interactive UI, or type `/trust check` themselves.

  // Nobody can pick in a pipe, but the intent "continue from last time" is clear — fall
  // back to the most recent session, and say so. Quietly starting a new one would make
  // the script author think the history was lost.
  const resumed = deps.continued ?? (deps.askResume ? deps.store.latestSession(deps.cwd) : undefined)
  // No replay: output on this path mostly goes into a pipe or log, and spitting out the
  // whole history again is pollution
  if (resumed) restore(deps, resumed, { replay: false })
  else if (deps.askResume || deps.wantContinue) deps.renderer.line(theme.dim(`  ${t.continueNone}`))
  let stop = false
  const exit = () => {
    stop = true
  }
  for await (const line of readLines(process.stdin)) {
    const text = line.trim()
    if (text.length === 0) continue
    // A pipe has no echo, so print the question ourselves; otherwise the output holds only
    // answers with no way to tell what they're answering
    for (const line of userLines(text, deps.region.active ? deps.region.width : undefined)) deps.renderer.line(line)
    const expanded = await slashCommand(text, deps, exit)
    if (expanded !== true) {
      const outcome = await deps.runTurn(expanded === false ? text : expanded)
      // ★ Dispatched subagents must be waited for. On the pipe path there's no UI to wake
      //   anyone, and "it dispatched three investigators and exited immediately" hands
      //   downstream an unfinished answer
      await deps.drainAgents()
      deps.renderer.line("")
      deps.settleContext()
      // Pipes need it even more: dozens of messages fed in by a while loop, and once the
      // window is full every remaining one fails, with nobody there to see it
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

/** 1.2 MB / 340 KB — for the attachment receipts, where exact bytes mean nothing */
function formatBytes(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1_000))} KB`
}

function imageProblem(problem: ImageProblem): string {
  if (problem.kind === "too-many") return t.imageTooMany(problem.limit)
  const name = basename(problem.path)
  return problem.kind === "not-image" ? t.imageNotImage(name) : t.imageTooLarge(name, formatBytes(problem.bytes))
}

function describe(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error))
}

/**
 * An uncaught exception prints just one line; the SDK's stack trace isn't thrown at the
 * user — that's both scary and uninformative. For the real stack, set ALFA_DEBUG=1 and
 * look in the log.
 */
export async function run(argv?: string[]): Promise<number> {
  try {
    return await main(argv)
  } catch (error) {
    process.stderr.write(theme.red(`${programName()}: ${describe(error)}\n`))
    return 1
  }
}

// Both a library and an executable entry point.
// import.meta.main is true only when **this file itself is the entry** — false when
// imported by the shim in bin/, so it doesn't run twice. bun build --compile honors this
// check too.
if (import.meta.main) {
  process.exitCode = await run()
}
