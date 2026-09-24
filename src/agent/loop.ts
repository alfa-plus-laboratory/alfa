/**
 * The main loop.
 *
 * ── Re-read the full history from storage every round ──
 * Not caution — a correctness requirement. Interrupt wind-down **rewrites** parts already
 * persisted (running → error). If the loop clung to an in-memory copy and kept going,
 * those rewrites wouldn't take effect, and what the model sees would fork from what's in
 * storage — a fork that raises no error and only shows up as "why is it reading that file
 * it already read, again". The cost of re-reading is one full SQLite table scan, a few
 * hundred microseconds.
 *
 * ── Why not the SDK's stopWhen ──
 * Handing multi-round control to the AI SDK also hands over everything between rounds:
 * compaction, the step cap, re-planning after a permission block, re-reading history. All
 * of that happens **at round boundaries**, so we have to write it ourselves.
 *
 * ── Why the exit test ignores finishReason ──
 * See needsAnotherRound(). This is the easiest place in this file to get wrong.
 */
import {
  ContextOverflowError,
  type LLMRequest,
  type AgentExecutionContext,
  type LLMStreamFn,
  type ModelRef,
  type ReasoningEffort,
  type Tokens,
} from "../llm/types.ts"
import { MAX_STEPS, MAX_STEPS_PROMPT } from "../prompt/max-steps.ts"
import { newMessageID, newPartID } from "../session/id.ts"
import type { AssistantMessage, MessageWithParts, ToolPart } from "../session/schema.ts"
import type { Store } from "../session/store.ts"
import type { ToolContext } from "../tool/types.ts"
import { Emitter, type UIEvent } from "./events.ts"
import { Processor } from "./processor.ts"
import { toLLMMessages } from "./to-model-messages.ts"
import { accumulateBilled, emptyTokens } from "./tokens.ts"

export interface LoopDeps {
  store: Store
  emitter: Emitter<UIEvent>
  stream: LLMStreamFn
  /**
   * Tools available this round. Asked afresh every round — the permission layer can
   * disable a tool midway.
   */
  tools(): import("../tool/types.ts").ToolDef<any>[]
  /** Reassembled for every request — the date changes, and AGENTS.md may get edited. */
  system(): string[]
  makeToolContext(call: { messageID: string; callID: string; abortSignal: AbortSignal }): ToolContext
  /**
   * It's about to wrap up; run one more check.
   *
   * Returns text = there's a problem: that text is fed back as a **synthetic user
   * message**, the loop keeps turning, and it has to deal with the problem before it can
   * really finish. Returns undefined = no problem / not applicable / not configured.
   *
   * Why hook it here rather than on the edit tool: editing ten files in one turn would run
   * the check ten times, and nine of those errors would be "you're only halfway done" —
   * noise that drowns out the real problem, and ten times slower. At wrap-up it runs just
   * once, and that moment is precisely the second before "it's about to say done".
   */
  verify?(input: VerifyInput): Promise<string | undefined>
  /**
   * Before the first message of a new session, attach the project memory.
   *
   * ── Why attach it here rather than splice it into the system prompt ──
   * See MemoryPart in session/schema.ts. The gist: it has to be accountable on its own (a
   * slice of its own in `/context`), and it's **a one-off fact**, not a per-turn
   * instruction — whatever the model remembers or deletes afterwards is all in tool
   * results (see tool/memory.ts).
   *
   * ── Why only on the first message ──
   * That's what "new conversations get it automatically" means. When picking an old session
   * back up it isn't injected again: the copy attached at that session's start is still in
   * history, and attaching another would put the same batch of notes into the same context
   * twice.
   */
  memory?(sessionID: string): { text: string; notes: number } | undefined
  /**
   * Before the first message of a new session, also attach a repo snapshot (branch,
   * uncommitted changes, recent commits).
   *
   * ── Why not splice it into the system prompt ──
   * Those three change more often than anything else in a session, and system is the
   * longest cacheable prefix — a single commit by the model would send tools + system back
   * to full-price recomputation (see the opening passage of prompt/git.ts). Attached to
   * history it's different: history only grows and is never changed, so the attached text
   * never changes by a single character afterwards.
   *
   * ── Why only on the first message ──
   * The same reason as memory, plus a harder one: later changes are **mostly its own
   * doing**, and the result of every edit / commit it makes is already in history. Where
   * accuracy really matters, the block tells it to run git itself.
   */
  gitContext?(): string | undefined
}

export interface VerifyInput {
  /** Files touched by edit/write/apply_patch this turn (absolute paths, deduplicated) */
  touched: string[]
  abortSignal: AbortSignal
}

/**
 * Max number of verifications per turn.
 *
 * Must be more than 1: problem found → it fixes → **the fix needs verifying again**,
 * otherwise "fixed it" is, again, only its own word. It can't be large either: a problem
 * it can't fix would have it burning money here over and over — at the cap it's let go to
 * answer, and the receipt in the UI still says the check failed, so the user can see it.
 */
const MAX_VERIFY_ROUNDS = 2

/**
 * An image the user attached to this turn's message; becomes a file part right after the
 * text (see FilePartSchema in session/schema.ts). Built by the host — only it knows where
 * the user's files are (cli/attachments.ts).
 */
export interface Attachment {
  mediaType: string
  filename: string
  /** `data:` URL */
  url: string
}

export interface RunInput {
  execution?: AgentExecutionContext
  sessionID: string
  model: ModelRef
  /**
   * What the user said this turn. Absent means "carry on from last time" (used when
   * resuming a session).
   */
  text?: string
  abortSignal: AbortSignal
  thinking?: boolean
  /** Unset = the provider's default. See ReasoningEffort in llm/types.ts */
  effort?: ReasoningEffort
  /** Images on this turn's message. Ignored without text */
  attachments?: Attachment[]
}

export interface RunResult {
  /** Number of request rounds actually sent */
  steps: number
  /** Cumulative usage, by the billing measure */
  billedTokens: Tokens
  interrupted: boolean
  error?: Error
  /** Stopped because it hit MAX_STEPS */
  hitStepLimit: boolean
}

export class Loop {
  constructor(private readonly deps: LoopDeps) {}

  async run(input: RunInput): Promise<RunResult> {
    const { store, emitter } = this.deps
    const execution: AgentExecutionContext = input.execution ?? {
      requestKind: "main", runId: crypto.randomUUID(), sessionId: input.sessionID,
      rootSessionId: input.sessionID, agentInstanceId: input.sessionID, depth: 0,
    }

    if (input.text !== undefined) this.appendUserMessage(input.sessionID, input.text, false, input.attachments)

    let steps = 0
    let billed = emptyTokens()
    let interrupted = false
    let error: Error | undefined
    let hitStepLimit = false
    let verifyRounds = 0

    while (true) {
      if (input.abortSignal.aborted) {
        interrupted = true
        break
      }

      const history = store.listAll(input.sessionID)
      if (isSettled(history)) {
        // ★ The last gate before wrapping up. What's fed back is a **synthetic** user
        //   message: the model sees it, and the UI doesn't treat it as the user's words (see
        //   TextPart.synthetic in session/schema.ts)
        const reminder = await this.verify(input, history, verifyRounds)
        if (reminder === undefined) break
        verifyRounds++
        this.appendUserMessage(input.sessionID, reminder, true)
        continue
      }

      steps++
      const isLastStep = steps >= MAX_STEPS

      const parentID = latestUser(history)?.info.id
      if (!parentID) break // no user message at all, nothing to answer

      const message = this.createAssistantShell(input.sessionID, parentID, input.model)
      emitter.emit({ type: "message.start", message })

      // ⚠ Creating the stream and consuming it must share **one** error path.
      //   Split them into two trys, and an error thrown synchronously by stream() bypasses
      //   both the interrupt detection and the ContextOverflowError rewrite — on Ctrl-C the
      //   user sees "Error: aborted", and on context overflow the raw provider error.
      //   Neither is an error about a bug; both are the experience falling apart.
      //
      // processor can only be built after makeToolContext (it needs handle.info), so it's
      // declared here first and captured by the closure — by the time a tool actually
      // runs, it's certain to have been assigned.
      let processor: Processor | undefined

      const system = this.deps.system()
      const request: LLMRequest = {
        execution,
        model: input.model,
        // On the round that hits the cap: put it in system, not history — it shouldn't be
        // persisted, and the next turn has no need to see this text again.
        system: isLastStep ? [...system, MAX_STEPS_PROMPT] : system,
        messages: toLLMMessages(history, { model: input.model }),
        tools: this.deps.tools(),
        makeToolContext: (call) => {
          const ctx = this.deps.makeToolContext({
            messageID: message.id,
            callID: call.callID,
            abortSignal: call.abortSignal,
          })
          return {
            ...ctx,
            // Metadata a tool reports must go into the part as well — diff / exitCode /
            // on-disk path all travel this channel; cut it and the UI gets no details.
            metadata: (patch) => {
              ctx.metadata(patch)
              processor?.setToolMetadata(call.callID, patch)
            },
          }
        },
        // Empty array = tool calls forbidden (stream.ts also sets toolChoice to none)
        ...(isLastStep ? { activeTools: [] } : {}),
        ...(input.thinking ? { thinking: true } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        abortSignal: input.abortSignal,
      }

      try {
        const handle = this.deps.stream(request)
        processor = new Processor(store, emitter, message, handle.info)
        const outcome = await processor.run(handle.events)
        billed = accumulateBilled(billed, outcome.billedTokens)
        // ★ abort does **not** throw out of here, so the test has to be the signal itself.
        //
        //   The catch below holds a complete interrupt handler, and in production it's
        //   never reached: the AI SDK doesn't throw on abort; it pushes a
        //   `{type:"abort"}` and closes the stream normally, and normalize in
        //   llm/stream.ts explicitly ignores abort — so the generator ends normally,
        //   outcome.error is undefined, and this line wraps up as "done".
        //
        //   The consequence isn't one missing notice: for every tool that didn't finish,
        //   cleanup("done") writes "the tool was NOT run and nothing changed. Call it
        //   again", while killGroup really did kill the command — so it had run. On that
        //   basis the model redoes a write/edit that already hit the disk. And
        //   metadata.interrupted=false makes needsAnotherRound true, so in `alfa -p`
        //   SIGINT **can't stop it**: it starts a whole new round to rerun the work that
        //   was just interrupted.
        //
        //   Testing the signal rather than an event keeps us independent of the upstream
        //   event vocabulary: if the SDK expresses abort some other way, this still holds.
        const aborted = input.abortSignal.aborted
        processor.cleanup(outcome.error ? "error" : aborted ? "interrupted" : "done")
        if (aborted) {
          interrupted = true
          break
        }
        if (outcome.error) {
          error = outcome.error
          break
        }
      } catch (thrown) {
        const failure = toError(thrown)
        if (isAbort(failure, input.abortSignal)) {
          interrupted = true
          if (processor) processor.cleanup("interrupted")
          else this.closeShell(message, "interrupted", failure)
          break
        }
        error = describe(failure)
        if (processor) processor.cleanup("error", error)
        else this.closeShell(message, "error", error)
        emitter.emit({ type: "error", error })
        // Stop on error. Retries already happened in llm/retry.ts; getting here means a
        // non-retryable error or retries exhausted — another round would just keep burning
        // money in a different pose.
        break
      }

      if (input.abortSignal.aborted) {
        interrupted = true
        break
      }
      if (isLastStep) {
        hitStepLimit = true
        break
      }
    }

    return {
      steps,
      billedTokens: billed,
      interrupted,
      hitStepLimit,
      ...(error ? { error } : {}),
    }
  }

  // ───────────────────────────────────────────── Internals

  private appendUserMessage(sessionID: string, text: string, synthetic = false, attachments: Attachment[] = []): void {
    const now = Date.now()
    const id = newMessageID()
    // ★ "Is this the first message" must be asked **before** inserting. Ask afterwards and
    //   the message just inserted is itself that user message, so the test can never hold
    const first = !synthetic && !this.hasUserMessage(sessionID)
    this.deps.store.upsertMessage({ id, sessionID, role: "user", timeCreated: now })
    // The snapshot and memory both hang on **this message**, not a separate user message:
    // given two user messages in a row, some providers merge them and some error out, and
    // these two are background for this very message anyway
    if (first) {
      this.attachGitContext(sessionID, id, now)
      this.attachMemory(sessionID, id, now)
    }
    this.deps.store.upsertPart({
      id: newPartID(),
      sessionID,
      messageID: id,
      timeCreated: now,
      type: "text",
      text,
      ...(synthetic ? { synthetic: true } : {}),
    })
    // After the text, in the order they were named: the text says which image is which
    // ("compare @before.png with @after.png"), and the model reads them in that order
    for (const file of attachments) {
      this.deps.store.upsertPart({
        id: newPartID(),
        sessionID,
        messageID: id,
        timeCreated: now,
        type: "file",
        mediaType: file.mediaType,
        filename: file.filename,
        url: file.url,
      })
    }
    this.deps.store.touchSession(sessionID)
  }

  /**
   * Whether the user has spoken yet in this session.
   *
   * The test is "is there a user message in the store", not "the process just started":
   * `/clear` switches sessions, `/resume` picks up a session that already has a beginning —
   * this one test tells both cases apart naturally.
   */
  private hasUserMessage(sessionID: string): boolean {
    return this.deps.store.listAll(sessionID).some((entry) => entry.info.role === "user")
  }

  /**
   * Attach the repo snapshot to this user message. Only called on a session's first
   * message.
   *
   * It uses a synthetic text part rather than a part type of its own: the UI doesn't
   * render it anyway (see TextPart.synthetic in session/schema.ts — that field is exactly
   * about "environment blocks"), and the three checks in compaction, replay and "is this
   * turn answered" excluded synthetic long ago. A new part type for one fixed-length piece
   * of background would mean changing schema, conversion and `/context` all at once, just
   * to gain one more slice in the report — a slice the user can neither cut nor delete.
   */
  private attachGitContext(sessionID: string, messageID: string, now: number): void {
    if (!this.deps.gitContext) return
    const text = this.deps.gitContext()
    if (!text || text.length === 0) return
    this.deps.store.upsertPart({
      id: newPartID(),
      sessionID,
      messageID,
      // One millisecond earlier still than memory (now-1). The three blocks go: repo state
      // → project memory → the user's words. Facts first, then conventions, the question
      // last — the later something sits, the more likely it's acted on, and this block is
      // exactly the one of the three that least needs emphasis
      timeCreated: now - 2,
      type: "text",
      text,
      synthetic: true,
    })
  }

  /**
   * Attach the project memory to this user message. Only called on a session's first
   * message
   */
  private attachMemory(sessionID: string, messageID: string, now: number): void {
    if (!this.deps.memory) return
    const memory = this.deps.memory(sessionID)
    if (!memory || memory.text.length === 0) return
    this.deps.store.upsertPart({
      id: newPartID(),
      sessionID,
      messageID,
      // ★ One millisecond before the text. Parts are ordered by (time_created, id), and id
      //   is random — under the same timestamp, which comes first is pure luck, and this
      //   one must come **before** the question: background first, then the question
      timeCreated: now - 1,
      type: "memory",
      text: memory.text,
      notes: memory.notes,
    })
  }

  /**
   * Run the pre-wrap-up verification once; returns the text to feed back.
   *
   * ⚠ This **swallows every exception**. Verification is a bonus: it breaking on its own
   *   shouldn't turn an already-answered turn into an error — the user would think the
   *   model's answer had failed.
   */
  private async verify(
    input: RunInput,
    history: MessageWithParts[],
    rounds: number,
  ): Promise<string | undefined> {
    if (!this.deps.verify) return undefined
    if (rounds >= MAX_VERIFY_ROUNDS) return undefined
    if (input.abortSignal.aborted) return undefined
    const touched = touchedFiles(history)
    if (touched.length === 0) return undefined
    try {
      return await this.deps.verify({ touched, abortSignal: input.abortSignal })
    } catch {
      return undefined
    }
  }

  private createAssistantShell(sessionID: string, parentID: string, model: ModelRef): AssistantMessage {
    const message: AssistantMessage = {
      id: newMessageID(),
      sessionID,
      role: "assistant",
      parentID,
      providerID: model.providerID,
      modelID: model.modelID,
      cost: 0,
      timeCreated: Date.now(),
    }
    // Must be persisted before it goes to processor — parts have a foreign key to it
    this.deps.store.upsertMessage(message)
    return message
  }

  /**
   * Failed before a Processor could even be built (stream() threw synchronously). The
   * shell is already persisted, so fill in its wind-down state here — otherwise history
   * keeps an empty assistant that's forever "unfinished", and isSettled(), seeing no
   * timeCompleted, thinks this turn isn't answered yet, so next time it just spins.
   */
  private closeShell(message: AssistantMessage, finish: "error" | "interrupted", error: Error): void {
    message.finish = finish
    if (finish === "error") message.error = { name: error.name, message: error.message }
    message.timeCompleted = Date.now()
    this.deps.store.upsertMessage(message)
    this.deps.emitter.emit({ type: "message.end", message })
  }
}

// ─────────────────────────────────────────────── Exit test

/**
 * Whether this turn has been answered. It's done only when all five conditions hold:
 *
 *   ① there is an assistant answer
 *   ② it answers **the current** user message (parentID matches)
 *   ③ no tool results are still waiting to be digested
 *   ④ it has been wound down (timeCompleted is set)
 *   ⑤ its last assistant text is not explicitly an interim commentary item
 *
 * Condition ② is no longer trivially true: a subagent's report is a **synthetic user
 * message**, and it may come in halfway through this turn (see deliverReport in
 * cli/main.ts). At that point the last assistant answered the previous user message, so
 * parentID doesn't match — which is how the loop knows "there's new work", and it goes
 * another round to digest the report. Keeping this condition back then was the right call.
 *
 * ★ Exported for the CLI: it needs to answer "is there a message nobody has answered" (if
 *   so, the main agent has to be woken up). That judgment and this one must be **the same
 *   code** — write it twice and sooner or later you get "the UI thinks it's answered,
 *   while the loop wants another round".
 */
export function isSettled(history: MessageWithParts[]): boolean {
  const user = latestUser(history)
  if (!user) return true
  const assistant = latestAssistant(history)
  if (!assistant || assistant.info.role !== "assistant") return false
  if (assistant.info.parentID !== user.info.id) return false
  if (!assistant.info.timeCompleted) return false
  // A progress-only response can end with "stop" too. Continue only on an explicit
  // phase: legacy/null phases keep their previous behavior, and errors/interrupts must
  // not silently restart a failed or cancelled request when the CLI checks this flag.
  if (assistant.info.finish !== "error" && assistant.info.finish !== "interrupted") {
    const lastText = assistant.parts.findLast(part => part.type === "text" && !part.synthetic)
    if (lastText?.type === "text" && lastText.responses?.phase === "commentary") return false
  }
  return !needsAnotherRound(assistant)
}

/**
 * ★ Whether another round has to be sent.
 *
 * The test is "did any tool run this round", **not finishReason**.
 *
 * Why: plenty of OpenAI-compatible endpoints (MiniMax is one) still report finishReason:
 * "stop" when they clearly issued a tool call. Trust it and the tools run, the results are
 * persisted, yet another round showing the model those results is never sent — what the
 * user sees is "it ran the command and then ended without a word". This bug is extremely
 * hard to spot in logs, because every step, taken on its own, succeeded.
 *
 * Conversely, interrupted tools **must not** count, or after Ctrl-C the loop spins
 * forever: it sees a tool part, thinks a result needs delivering, sends a round, gets
 * aborted again, sees the tool part again...
 */
function needsAnotherRound(message: MessageWithParts): boolean {
  const tools = message.parts.filter((part): part is ToolPart => part.type === "tool")
  return tools.some((part) => !isInterrupted(part))
}

function isInterrupted(part: ToolPart): boolean {
  return part.state.status === "error" && part.state.metadata["interrupted"] === true
}

/**
 * Which files were changed this turn.
 *
 * Walk back from the end and stop on hitting **something the user actually said**.
 * Synthetic messages (the text verification itself fed back) aren't a boundary —
 * otherwise the second verification would see only the changes made after the first,
 * when what needs verifying at that point is the whole turn's result.
 */
function touchedFiles(history: MessageWithParts[]): string[] {
  const out = new Set<string>()
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!
    if (entry.info.role === "user") {
      if (entry.parts.some((part) => part.type === "text" && !part.synthetic && part.text.length > 0)) break
      continue
    }
    for (const part of entry.parts) {
      if (part.type !== "tool") continue
      if (part.tool !== "edit" && part.tool !== "write" && part.tool !== "apply_patch") continue
      if (part.state.status !== "completed") continue
      const path = part.state.metadata["filePath"]
      if (typeof path === "string" && path.length > 0) out.add(path)
    }
  }
  return [...out]
}

/**
 * The last user message that **needs an answer**.
 *
 * ★ The compaction point doesn't count. It's persisted as user (the handoff has to go in
 *   as the first message of the new history, see session/schema.ts), but it isn't
 *   something anyone said — it's **the same history written another way**; nobody made a
 *   new request. Counted as awaiting an answer, the loop would go another round the moment
 *   compaction lands, and that round's input would be "a summary, and no question": the
 *   model could only talk to itself over its own handoff note, or worse — redo the work
 *   it just handed off. After automatic compaction this path is hit every single time, so
 *   it has to be cut off right here.
 */
function latestUser(history: MessageWithParts[]): MessageWithParts | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!
    if (entry.info.role !== "user") continue
    if (entry.parts.length > 0 && entry.parts.every((part) => part.type === "compact")) continue
    return entry
  }
  return undefined
}

function latestAssistant(history: MessageWithParts[]): MessageWithParts | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.info.role === "assistant") return history[i]
  }
  return undefined
}

// ─────────────────────────────────────────────── Errors

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function isAbort(error: Error, signal: AbortSignal): boolean {
  return signal.aborted || error.name === "AbortError"
}

/** Context overflow: give a line the user can act on, not the provider's raw text. */
function describe(error: Error): Error {
  if (error instanceof ContextOverflowError) {
    const hint = new ContextOverflowError(
      `Context window exceeded. Run /compact to fold this session into a summary and keep going, ` +
        `or /clear to start fresh. (${error.message})`,
    )
    hint.cause = error
    return hint
  }
  return error
}
