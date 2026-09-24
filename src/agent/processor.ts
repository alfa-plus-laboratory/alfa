/**
 * Consumes LLMEvents, persists them, emits UI events.
 *
 * One Processor instance corresponds to **one assistant message**; it isn't reused across
 * turns. Responses item metadata stays on each text part: the session part ID is local,
 * and discarding the provider item ID/phase would turn progress into an apparent answer.
 *
 * ── Why every event is persisted immediately ──
 * The main loop's correctness rests on "storage is the single source of truth": every turn
 * it re-reads the full history from the Store instead of carrying on with an in-memory
 * array. Only that way are interrupt wind-down, external history edits and post-crash
 * recovery all the same code path. The cost is one SQLite write per delta — bun:sqlite
 * writes the WAL synchronously, a few microseconds each, negligible next to network latency.
 *
 * ── The single most important thing on interrupt ──
 * A tool part stuck at running must be rewritten to error. Leaving it running isn't a
 * problem as mild as "the status is off": when history is fed back it becomes a tool_use
 * with no result, and from then on **every** request gets a 400. See the top of
 * to-model-messages.ts.
 */
import type { LLMEvent, ModelInfo, Tokens, ResponsesTextMetadata } from "../llm/types.ts"
import {
  type AssistantMessage,
  type Part,
  type ReasoningPart,
  type StepFinishPart,
  type TextPart,
  type ToolPart,
} from "../session/schema.ts"
import { newPartID } from "../session/id.ts"
import type { Store } from "../session/store.ts"
import { Emitter, type UIEvent } from "./events.ts"
import { accumulateBilled, emptyTokens } from "./tokens.ts"

export interface ProcessorOutcome {
  /** finishReason of the last step. undefined if the stream never reached step-finish. */
  finishReason?: string
  /** Context measure: usage of the **last** step, not a running total */
  contextTokens: Tokens
  /** Billing measure: all steps summed */
  billedTokens: Tokens
  /** Error that occurred in the stream (already written to message.error) */
  error?: Error
  /** Whether it was wound down by an interrupt */
  interrupted: boolean
  /** How many tool calls the model made in this stream */
  toolCalls: number
}

export class Processor {
  private text = new Map<string, TextPart>()
  private reasoning = new Map<string, ReasoningPart>()
  private tools = new Map<string, ToolPart>()
  /** Metadata a tool has reported, held here while its part hasn't landed yet */
  private toolMetadata = new Map<string, Record<string, unknown>>()
  private finishReason: string | undefined
  private contextTokens: Tokens = emptyTokens()
  private billedTokens: Tokens = emptyTokens()
  private error: Error | undefined
  private interrupted = false
  private toolCalls = 0
  private done = false

  constructor(
    private readonly store: Store,
    private readonly emitter: Emitter<UIEvent>,
    private readonly message: AssistantMessage,
    private readonly info: ModelInfo,
  ) {}

  async run(events: AsyncIterable<LLMEvent>): Promise<ProcessorOutcome> {
    for await (const event of events) {
      this.handle(event)
    }
    return this.outcome()
  }

  private handle(event: LLMEvent): void {
    switch (event.type) {
      // ── Text ──
      case "text-start":
        this.openText(event.id, event.responses)
        break
      case "text-delta": {
        const part = this.openText(event.id)
        part.text += event.text
        this.save(part)
        this.emitter.emit({ type: "part.delta", part, delta: event.text })
        break
      }
      case "text-end": {
        const part = this.text.get(event.id)
        if (!part) break
        if (event.responses) part.responses = { ...part.responses, ...event.responses }
        if (part.time) part.time.end = Date.now()
        this.save(part)
        this.emitter.emit({ type: "part.end", part })
        this.text.delete(event.id)
        break
      }

      // ── Reasoning ──
      case "reasoning-start":
        this.openReasoning(event.id)
        break
      case "reasoning-delta": {
        const part = this.openReasoning(event.id)
        part.text += event.text
        this.save(part)
        this.emitter.emit({ type: "part.delta", part, delta: event.text })
        break
      }
      case "reasoning-end": {
        const part = this.reasoning.get(event.id)
        if (!part) break
        // The signature must be stored. If it's missing when fed back next turn, Anthropic
        // rejects the whole thinking block.
        if (event.signature) part.signature = event.signature
        if (part.time) part.time.end = Date.now()
        this.save(part)
        this.emitter.emit({ type: "part.end", part })
        this.reasoning.delete(event.id)
        break
      }

      // ── Tools ──
      case "tool-input-start": {
        // Arguments aren't all in yet; hold a placeholder first. The UI can already show
        // "preparing to call xxx" at this point.
        const part = this.openTool(event.callID, event.tool)
        this.emitter.emit({ type: "tool.state", part })
        break
      }
      case "tool-call": {
        const part = this.openTool(event.callID, event.tool)
        this.toolCalls++
        part.state = { status: "running", input: event.input, time: { start: Date.now() } }
        this.save(part)
        this.emitter.emit({ type: "tool.state", part })
        break
      }
      case "tool-result": {
        const part = this.openTool(event.callID, event.tool)
        const start = startOf(part)
        part.state = {
          status: "completed",
          input: inputOf(part),
          output: event.output,
          metadata: this.toolMetadata.get(event.callID) ?? {},
          time: { start, end: Date.now() },
        }
        this.save(part)
        this.emitter.emit({ type: "tool.state", part })
        break
      }
      case "tool-error": {
        const part = this.openTool(event.callID, event.tool)
        const start = startOf(part)
        part.state = {
          status: "error",
          input: inputOf(part),
          error: event.error,
          metadata: this.toolMetadata.get(event.callID) ?? {},
          time: { start, end: Date.now() },
        }
        this.save(part)
        this.emitter.emit({ type: "tool.state", part })
        break
      }

      // ── step ──
      case "step-start": {
        const part: Part = {
          id: newPartID(),
          sessionID: this.message.sessionID,
          messageID: this.message.id,
          timeCreated: Date.now(),
          type: "step-start",
        }
        this.save(part)
        this.emitter.emit({ type: "part.start", part })
        break
      }
      case "step-finish": {
        this.finishReason = event.finishReason
        // Context measure takes the last step, not a sum — every step's input already
        // contains the full history
        this.contextTokens = event.tokens
        this.billedTokens = accumulateBilled(this.billedTokens, event.tokens)
        const part: StepFinishPart = {
          id: newPartID(),
          sessionID: this.message.sessionID,
          messageID: this.message.id,
          timeCreated: Date.now(),
          type: "step-finish",
          finishReason: event.finishReason,
          tokens: event.tokens,
          cost: 0,
        }
        this.save(part)
        this.emitter.emit({ type: "step.finish", part })
        break
      }

      case "error":
        this.error = event.error
        this.emitter.emit({ type: "error", error: event.error })
        break
    }
  }

  /**
   * Metadata a tool reports while executing (diff, exitCode, on-disk path...).
   *
   * Timing: it arrives **before** tool-result (the tool calls ctx.metadata before it has
   * returned), so it's held first and written in once the part becomes completed/error.
   * If the part has already landed, patch it in place and emit the event again.
   */
  setToolMetadata(callID: string, patch: Record<string, unknown>): void {
    const merged = { ...(this.toolMetadata.get(callID) ?? {}), ...patch }
    this.toolMetadata.set(callID, merged)

    const part = this.tools.get(callID)
    if (!part) return
    if (part.state.status !== "completed" && part.state.status !== "error") return
    part.state.metadata = { ...part.state.metadata, ...patch }
    this.save(part)
    this.emitter.emit({ type: "tool.state", part })
  }

  // ───────────────────────────────────────────── Wind-down

  /**
   * Wind down. Both normal completion and interrupts go through here, and it **must run
   * exactly once**.
   *
   * @param reason "done" finished normally / "interrupted" was interrupted / "error"
   *               aborted on an error
   */
  cleanup(reason: "done" | "interrupted" | "error", error?: Error): ProcessorOutcome {
    if (this.done) return this.outcome()
    this.done = true
    if (error) this.error = error
    if (reason === "interrupted") this.interrupted = true
    const now = Date.now()

    // Give blocks that never got text-end / reasoning-end an end time, or the UI spins
    // forever
    for (const part of [...this.text.values(), ...this.reasoning.values()]) {
      if (part.time) part.time.end = now
      this.save(part)
      this.emitter.emit({ type: "part.end", part })
    }
    this.text.clear()
    this.reasoning.clear()

    // ★ Key point: every tool part that hasn't landed must be rewritten to error.
    //   Leaving a pending/running one in history = a 400 on every turn after.
    for (const part of this.tools.values()) {
      if (part.state.status === "completed" || part.state.status === "error") continue
      const start = startOf(part)
      part.state = {
        status: "error",
        input: inputOf(part),
        error:
          reason === "interrupted"
            ? "Tool execution was interrupted by the user before it completed."
            : // ★ This sentence has to make clear that **nothing happened**.
              //
              // Getting here means the turn ended before the call's arguments were
              // fully sent (output truncated, the provider cut the stream midway, the
              // step limit was hit): the tool **was never called at all**. It used to
              // say only "Tool execution did not complete." — after reading that, the
              // model couldn't tell whether the file had been written, so it either
              // assumed it had (and kept editing on top) or wrote it again. For tools
              // that change the disk, like write / edit, that ambiguity does real damage
              `The ${part.tool} call never arrived complete — its arguments stopped mid-stream, so the tool was NOT run and nothing changed. Call it again with all required arguments.`,
        metadata: { interrupted: reason === "interrupted" },
        time: { start, end: now },
      }
      this.save(part)
      this.emitter.emit({ type: "tool.state", part })
    }

    this.message.timeCompleted = now
    this.message.tokens = this.contextTokens
    if (reason === "interrupted") this.message.finish = "interrupted"
    else if (this.error) this.message.finish = "error"
    else this.message.finish = this.finishReason ?? "unknown"
    if (this.error) this.message.error = { name: this.error.name, message: this.error.message }
    this.store.upsertMessage(this.message)
    this.store.touchSession(this.message.sessionID)
    this.emitter.emit({ type: "message.end", message: this.message })

    return this.outcome()
  }

  // ───────────────────────────────────────────── Internals

  private openText(id: string, responses?: ResponsesTextMetadata): TextPart {
    const existing = this.text.get(id)
    if (existing) {
      if (responses) {
        existing.responses = { ...existing.responses, ...responses }
        this.save(existing)
      }
      return existing
    }
    const part: TextPart = {
      id: newPartID(),
      sessionID: this.message.sessionID,
      messageID: this.message.id,
      timeCreated: Date.now(),
      type: "text",
      text: "",
      ...(responses ? { responses } : {}),
      time: { start: Date.now() },
    }
    this.text.set(id, part)
    this.save(part)
    this.emitter.emit({ type: "part.start", part })
    return part
  }

  private openReasoning(id: string): ReasoningPart {
    const existing = this.reasoning.get(id)
    if (existing) return existing
    const part: ReasoningPart = {
      id: newPartID(),
      sessionID: this.message.sessionID,
      messageID: this.message.id,
      timeCreated: Date.now(),
      type: "reasoning",
      text: "",
      time: { start: Date.now() },
    }
    this.reasoning.set(id, part)
    this.save(part)
    this.emitter.emit({ type: "part.start", part })
    return part
  }

  /**
   * Get the tool part by callID, creating it if there is none.
   *
   * Must tolerate missing events: some providers skip tool-input-start and go straight to
   * tool-call; worse, tool-result can arrive before tool-call (seen with retries and
   * out-of-order delivery). So every branch goes through this function instead of assuming
   * the previous event must have come.
   */
  private openTool(callID: string, tool: string): ToolPart {
    const existing = this.tools.get(callID)
    if (existing) return existing
    // callID is unique within a message (the DDL has a unique index on it), so it can be
    // recovered after a restart
    const stored = this.store.findToolPart(this.message.id, callID)
    if (stored && stored.type === "tool") {
      this.tools.set(callID, stored)
      return stored
    }
    const part: ToolPart = {
      id: newPartID(),
      sessionID: this.message.sessionID,
      messageID: this.message.id,
      timeCreated: Date.now(),
      type: "tool",
      callID,
      tool,
      state: { status: "pending" },
    }
    this.tools.set(callID, part)
    this.save(part)
    return part
  }

  private save(part: Part): void {
    this.store.upsertPart(part)
  }

  private outcome(): ProcessorOutcome {
    return {
      ...(this.finishReason ? { finishReason: this.finishReason } : {}),
      contextTokens: this.contextTokens,
      billedTokens: this.billedTokens,
      ...(this.error ? { error: this.error } : {}),
      interrupted: this.interrupted,
      toolCalls: this.toolCalls,
    }
  }

  /** For the main loop to judge context pressure */
  modelInfo(): ModelInfo {
    return this.info
  }
}

function startOf(part: ToolPart): number {
  const state = part.state
  return "time" in state && state.time ? state.time.start : part.timeCreated
}

/**
 * The known call arguments, or {} if there are none.
 *
 * ⚠ Must not return undefined. The part is persisted via JSON.stringify, so an undefined
 *   key **vanishes entirely**; read back, the completed state lacks its input field → zod
 *   parsing fails → that message can never be read again, and the whole session is dead.
 *   Also, on the Anthropic side tool_use.input must be an object, and {} is exactly the
 *   value to send when feeding it back.
 *
 *   The trigger path isn't rare: a provider sends tool-result out of order, before
 *   tool-call.
 */
function inputOf(part: ToolPart): unknown {
  const state = part.state
  if ("input" in state && state.input !== undefined) return state.input
  return {}
}
