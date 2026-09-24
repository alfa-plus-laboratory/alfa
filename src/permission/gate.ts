/**
 * The permission gate works off one shared mode. ★ auto is an auto-execute mode the
 * user explicitly chose: the auto decider (permission/auto/) lets basic work through and
 * scores the rest; a block goes back to the agent with the scores, not to a confirmation
 * box. Only default / confirm apply the rest of the rules table.
 * Cancellation always comes first — full trust doesn't mean ignoring a cancel.
 * auto writes no invisible allow rules; on leaving it, the previous rules and grants are
 * back in force immediately.
 *
 * ── Two things auto no longer skips (they follow Claude Code's auto mode) ──
 * · A deny rule holds in every mode. auto used to settle before the rules table, so a
 *   deny the user wrote was silently void exactly in the mode where nobody is watching.
 * · Repeated blocks hand the decision back to the user: 3 blocks in a row or 20 in total
 *   and the next blocked action becomes a confirmation box. Without that, an agent that
 *   keeps rephrasing a blocked step spends the session arguing with the classifier and
 *   the user never learns why nothing happens. A review that failed (timeout, provider
 *   error) is not a block and doesn't count.
 */
import type { AutoDecider, AutoVerdict } from "./auto/index.ts"
import { dirname } from "node:path"
import { alwaysPattern } from "./arity.ts"
import { DEFAULT_MODE, type PermissionMode } from "./mode.ts"
import { runsProjectScript } from "./routine.ts"
import { DEFAULTS, evaluate, type Action, type Ruleset } from "./rules.ts"
import type { Assessment } from "./auto/policy.ts"
import type { AskDecision, AskInput } from "../tool/types.ts"
import { PermissionDeniedError } from "../tool/types.ts"

export interface PromptRequest {
  permission: string
  /** `auto`: auto mode paused after repeated classifier blocks (see PermissionGate.askAuto) */
  cause?: "mode" | "structure" | "rule" | "auto"
  patterns: string[]
  /**
   * The rules written if the user picks always, computed up front so the UI can show
   * "don't ask about X again"
   */
  alwaysPatterns: string[]
  forbidAlways: boolean
  /** An independent host capability may allow a session grant but still no persistent one. */
  allowSession?: boolean
  metadata?: Record<string, unknown>
  /** Why the ask was triggered (risk markers from the bash statement splitter) */
  reasons?: string[]
  /**
   * Which tool call this ask belongs to. The UI uses it to draw the outcome back onto
   * that card; see AskInput.callID
   */
  callID?: string
  /**
   * What this ask dies with. See AskInput.signal — a question coming from the background
   * shouldn't hang off the user's turn
   */
  signal?: AbortSignal
}

export type PromptFn = (request: PromptRequest) => Promise<AskDecision>

export interface GateOptions {
  /** auto mode's decision. Left unwired, auto blocks everything it would have scored */
  auto?: AutoDecider
  /** Workspace root. Used to judge "is this script in the project"; see routine.ts */
  root?: string
  /**
   * The user picked always; store these. Left unwired, they only last for this process.
   *
   * Where and how they are stored is not the gate's concern (see
   * permission/approvals.ts) — its only job is to speak up at the moment something
   * should be remembered. That is why tests can stay off the filesystem entirely.
   */
  remember?(rules: Ruleset): void
}

export class PermissionGate {
  /**
   * Rules from user config: the layer between DEFAULTS and the always rules in evaluate.
   * Only tests call setUserRules — config.json has no rules field — so in the app this
   * stays empty
   */
  private userRules: Ruleset = []
  /**
   * The always rules in effect. One copy in-process, also persisted via
   * options.remember.
   *
   * ⚠ It is the **last** ruleset passed to evaluate, so it can override DEFAULTS.
   */
  private approved: Ruleset = []
  private sessionApproved: Ruleset = []
  private mode: PermissionMode = DEFAULT_MODE
  private readonly options: GateOptions

  constructor(
    private prompt: PromptFn,
    options: GateOptions = {},
  ) {
    this.options = options
  }

  setUserRules(rules: Ruleset): void {
    this.userRules = rules
  }

  get permissionMode(): PermissionMode {
    return this.mode
  }

  setMode(mode: PermissionMode): void {
    // A fresh run of auto starts with a clean count; blocks from an earlier one say
    // nothing about this one
    if (mode === "auto" && this.mode !== "auto") this.blocks = { consecutive: 0, total: 0 }
    this.mode = mode
  }

  /** The always rules currently in effect, for the UI / debugging. */
  listApproved(): Ruleset {
    return [...this.approved, ...this.sessionApproved]
  }

  /**
   * Load back the always rules saved last time. **Only allow is accepted** — nothing
   * else belongs in the store, and anything else there is treated as absent: a deny read
   * from a file would silently change the gate's verdicts, and the user would have no
   * way at all to tell where it came from.
   */
  restoreApproved(rules: Ruleset): void {
    this.approved = rules.filter((rule) => rule.action === "allow")
  }

  /**
   * The user said stop remembering. The persisted copy is cleared by the caller — the
   * gate doesn't know about files.
   */
  forgetApproved(): number {
    const count = this.approved.length + this.sessionApproved.length
    this.approved = []
    this.sessionApproved = []
    return count
  }

  clearSession(): void { this.sessionApproved = [] }

  private queue: Promise<void> = Promise.resolve()

  /** Classifier blocks in this run of auto; see the file header */
  private blocks = { consecutive: 0, total: 0 }

  /**
   * ★ What gets queued is the re-evaluation, not a precomputed ask; an earlier
   * session/always must be able to cancel out duplicate approvals queued behind it.
   */
  ask(input: AskInput): Promise<void> {
    // ★ auto skips the queue. The queue exists so confirmation boxes appear one at a
    //   time; auto shows one only when it pauses (fallBack, which queues just that box),
    //   and queueing its decisions made every parallel tool call and every background
    //   subagent wait on each other's classifier round trips
    if (this.mode === "auto") return this.askAuto(input)
    const pending = this.queue.then(() => this.askNow(input))
    this.queue = pending.catch(() => {})
    return pending
  }

  /** @param queued Already running inside the queue (reached through askNow) */
  private async askAuto(input: AskInput, queued = false): Promise<void> {
    if (input.signal?.aborted) throw new PermissionDeniedError(input.permission, input.patterns[0] ?? "", "Cancelled while waiting for permission")
    this.denyByRule(input)
    let verdict: AutoVerdict = { allow: false, failed: true, message: "The auto-mode classifier is not available. This is not a risk verdict; tell the user." }
    try { verdict = await this.options.auto?.(input) ?? verdict } catch {}
    if (input.signal?.aborted) throw new PermissionDeniedError(input.permission, input.patterns[0] ?? "", "Cancelled during auto review")
    // Left auto while it was being scored: that verdict belongs to a mode no longer in
    // force. ⚠ From inside the queue it must re-decide in place — queueing again would
    // wait on itself forever
    if (this.mode !== "auto") return queued ? this.askNow(input) : this.ask(input)
    if (verdict.allow) {
      this.blocks.consecutive = 0
      return
    }
    if (verdict.failed) throw new PermissionDeniedError(input.permission, input.patterns[0] ?? "", verdict.message)
    this.blocks.consecutive++
    this.blocks.total++
    if (this.blocks.consecutive < MAX_CONSECUTIVE_BLOCKS && this.blocks.total < MAX_TOTAL_BLOCKS) {
      throw new PermissionDeniedError(input.permission, input.patterns[0] ?? "", verdict.message)
    }
    return this.fallBack(input, verdict, queued)
  }

  /**
   * Auto mode paused: this one blocked action goes to the user. Approving it resumes auto
   * (the count that tripped starts over); rejecting it is an ordinary rejection. No grant
   * is written either way, so nothing outlives the answer. A host with nobody to ask
   * rejects, and the agent carries on without the action.
   */
  private async fallBack(input: AskInput, verdict: AutoVerdict, queued: boolean): Promise<void> {
    const request: PromptRequest = {
      permission: input.permission,
      patterns: input.patterns,
      alwaysPatterns: [],
      forbidAlways: true,
      cause: "auto",
      metadata: input.metadata,
      reasons: verdict.assessment ? [scoreLine(verdict.assessment)] : [],
      ...(input.callID ? { callID: input.callID } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    }
    const asked = queued ? this.prompt(request) : this.queue.then(() => this.prompt(request))
    if (!queued) this.queue = asked.then(() => {}, () => {})
    const decision = await asked
    if (decision === "reject" || input.signal?.aborted) {
      throw new PermissionDeniedError(
        input.permission,
        input.patterns[0] ?? "",
        "Auto mode paused after repeated classifier blocks, and the user rejected this operation when asked. Do not retry it; ask the user what they want instead.",
      )
    }
    this.blocks.consecutive = 0
    if (this.blocks.total >= MAX_TOTAL_BLOCKS) this.blocks.total = 0
  }

  /** A deny rule holds in every mode; see the file header */
  private denyByRule(input: AskInput): void {
    const denied = input.patterns.find((pattern) =>
      evaluate(input.permission, pattern, DEFAULTS, this.userRules, this.approved, this.sessionApproved) === "deny")
    if (denied === undefined) return
    throw new PermissionDeniedError(
      input.permission,
      denied,
      `Permission denied by rule: ${input.permission} on "${denied}" is set to deny. ` +
        `Do not retry; tell the user what you wanted to do and why.`,
    )
  }

  private async askNow(input: AskInput): Promise<void> {
    if (input.signal?.aborted) throw new PermissionDeniedError(input.permission, input.patterns[0] ?? "", "Cancelled while waiting for permission")
    // Queued under default/confirm, reached after the user switched to auto
    if (this.mode === "auto") return this.askAuto(input, true)
    // ── 1. Evaluate each pattern ──
    this.denyByRule(input)
    const decisions = input.patterns.map((pattern) => ({
      pattern,
      action: evaluate(input.permission, pattern, DEFAULTS, this.userRules, this.approved, this.sessionApproved),
    }))

    // force: ask even when the rules say allow. The danger isn't in the command name,
    // it's in the structure around it (pipes / subshells / privilege escalation). Note
    // force only turns allow→ask; deny has already short-circuited above.
    // confirm mode works the same way — it pulls every decision still standing back in
    // to be asked.
    // ★ Except the ask tool. Its only effect is a question to the user, so confirming it
    //   first asked "may I ask you something?" — a card whose one line was `*` — before
    //   the question itself, and answering the question already is the consent. Only
    //   confirm's blanket pull skips it: a user rule of ask or deny for it still holds
    //   (deny above, ask through needsAsk below).
    const askAll = input.force === true || this.mode === "confirm" && input.permission !== "ask"
    const needsAsk = askAll ? decisions : decisions.filter((d) => d.action === "ask")
    if (needsAsk.length === 0) return

    // ── 2. The deterministic tier: the project's own scripts, run in the project ──
    //
    // Placed before the question to the user, and it **checks the filesystem**. See
    // routine.ts: "is the file this command runs inside the project" is a question one
    // statSync answers, whereas "read a script and predict whether it's dangerous" is not.
    // The user is kept for what genuinely can't be settled.
    //
    // Note it comes after askAll: force (subshell / redirect / privilege escalation /
    // network egress) and confirm mode both override it — the danger isn't in the
    // command name, it's in the structure around it.
    if (!askAll && input.permission === "bash" && this.routine(input, needsAsk)) return

    // ── 3. Assemble the question ──
    const alwaysPatterns = input.patterns.map((p) => narrowAlways(input.permission, p))
    const request: PromptRequest = {
      permission: input.permission,
      patterns: input.patterns,
      alwaysPatterns,
      forbidAlways: this.mode === "confirm" || (input.forbidAlways ?? false),
      cause: this.mode === "confirm" ? "mode" : input.force ? "structure" : "rule",
      metadata: input.metadata,
      reasons: (input.metadata?.["reasons"] as string[] | undefined) ?? undefined,
      ...(input.callID ? { callID: input.callID } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    }

    // ── 5. Ask ──
    const decision = await this.prompt(request)

    if (decision === "reject" || input.signal?.aborted) {
      throw new PermissionDeniedError(input.permission, needsAsk[0]!.pattern)
    }
    if ((decision === "always" || decision === "session") && !request.forbidAlways) {
      const added: Ruleset = alwaysPatterns.map((pattern) => ({
        permission: input.permission,
        pattern,
        action: "allow" as Action,
      }))
      if (decision === "always") this.approved.push(...added)
      else this.sessionApproved.push(...added)
      // Persisting comes **after adding to memory**: if it can't be stored (read-only
      // data directory), this one is still allowed as usual and just gets asked again
      // next time — rather than throwing away the decision the user just made because a
      // file couldn't be written
      if (decision === "always") this.options.remember?.(added)
    }
  }

  /** Whether every subcommand in this batch is just "running the project's own script". */
  private routine(input: AskInput, needsAsk: Array<{ pattern: string }>): boolean {
    const root = this.options.root
    if (!root) return false
    const workdir = input.metadata?.["workdir"]
    if (typeof workdir !== "string" || workdir.length === 0) return false
    // If one segment isn't, the whole thing isn't allowed — when a command has something
    // else mixed in, what gets allowed is the whole command
    return needsAsk.every((d) => runsProjectScript({ command: d.pattern, workdir, root }))
  }

  /**
   * Tool-visibility pruning: if a tool is denied outright, don't send it to the model —
   * that saves the wasted turns of the model going "call → denied → rephrase and call
   * again".
   */
  disabled(toolID: string): boolean {
    return evaluate(toolID, "*", DEFAULTS, this.userRules, this.approved, this.sessionApproved) === "deny"
  }
}

/** Claude Code's thresholds; not configurable there either */
const MAX_CONSECUTIVE_BLOCKS = 3
const MAX_TOTAL_BLOCKS = 20

/** The scores behind a block, for the confirmation box. Dimension names and numbers are data */
function scoreLine(a: Assessment): string {
  return `intent ${a.intent} · harm ${a.harm} · reach ${a.reach} · leak ${a.leak}`
}

/**
 * Narrow the scope of always.
 *
 * In opencode, always is `*` across the board — one click opens that permission up
 * completely for the rest of the process. Acceptable for read, dangerous for edit
 * (together with webfetch it is a complete data-exfiltration channel).
 *
 * ⚠ Mind the wildcard semantics: in this implementation `*` is `.*` and **crosses
 *   `/`**. So `src/foo/*` in fact also matches `src/foo/a/b/c.ts`. That's wider than
 *   the literal intuition, but still far narrower than `*`.
 */
export function narrowAlways(permission: string, pattern: string): string {
  switch (permission) {
    case "edit":
    case "write":
      // Narrow to the directory the file is in
      return dirname(pattern) + "/*"
    case "bash":
      // Reduce to a command prefix via the arity dictionary:
      // git commit -m "..." → git commit *
      return alwaysPattern(pattern.trim().split(/\s+/))
    case "webfetch":
      // Narrow to one origin. Storing the whole URL is as good as storing nothing (the
      // next page asks again), while `*` means "go anywhere from now on" — what the
      // user nodded to was "this site is fine to look at", not "the whole web is open"
      return webOrigin(pattern)
    default:
      return "*"
  }
}

/**
 * `https://docs.example.com/a/b?x=1` → `https://docs.example.com/*`. Falls back to the
 * original text if it can't be parsed.
 */
function webOrigin(pattern: string): string {
  try {
    const url = new URL(pattern)
    return `${url.protocol}//${url.host}/*`
  } catch {
    return pattern
  }
}
