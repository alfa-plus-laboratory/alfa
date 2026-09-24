/**
 * Session data model: two levels, message / part.
 *
 * Why two levels rather than one message holding a lump of content:
 * every turn the main loop has to answer "is this turn done", and the test is "what is
 * the last assistant's finish" plus "is there still an unfinished tool part under it".
 * Parts must be individually addressable and advance their state independently, or
 * streaming writes to the database and interrupt cleanup have nowhere to land.
 *
 * There are 8 part types (PartSchema below). The DDL's type column is free text, so a new
 * kind needs no migration — that is how `compact` and `memory` were added, and how the
 * ones not defined yet (snapshot / patch / subtask / retry) would be.
 */
import { z } from "zod"

// ─────────────────────────────────────────────────────────── Common

export const TokensSchema = z.object({
  input: z.number().default(0),
  output: z.number().default(0),
  reasoning: z.number().default(0),
  cache: z
    .object({
      read: z.number().default(0),
      write: z.number().default(0),
    })
    .default({ read: 0, write: 0 }),
  /** Total reported by the provider. Used if present; otherwise sum input+output+cache. */
  total: z.number().optional(),
})
export type Tokens = z.infer<typeof TokensSchema>

export const ModelRefSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
})
export type ModelRef = z.infer<typeof ModelRefSchema>

// ─────────────────────────────────────────────────────────── Part

const partBase = {
  id: z.string(),
  sessionID: z.string(),
  messageID: z.string(),
  /** When the event happened, not when the message was created. Used for sorting. */
  timeCreated: z.number(),
}

export const TextPartSchema = z.object({
  ...partBase,
  type: z.literal("text"),
  text: z.string(),
  /**
   * Synthetically injected text (environment block, reminders), not model output; the UI
   * doesn't render it.
   */
  synthetic: z.boolean().optional(),
  // Optional JSON fields keep old sessions readable without inventing a final phase.
  responses: z.object({
    itemId: z.string().optional(),
    phase: z.enum(["commentary", "final_answer"]).nullable().optional(),
  }).optional(),
  time: z.object({ start: z.number(), end: z.number().optional() }).optional(),
})

export const ReasoningPartSchema = z.object({
  ...partBase,
  type: z.literal("reasoning"),
  text: z.string(),
  /**
   * Anthropic's thinking signature. Must be sent back verbatim when replaying history,
   * or you get a 400. Drop it when switching models — other providers don't accept it.
   */
  signature: z.string().optional(),
  time: z.object({ start: z.number(), end: z.number().optional() }).optional(),
})

export const ToolStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.literal("running"),
    input: z.unknown(),
    title: z.string().optional(),
    time: z.object({ start: z.number() }),
  }),
  z.object({
    status: z.literal("completed"),
    input: z.unknown(),
    output: z.string(),
    title: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    time: z.object({ start: z.number(), end: z.number() }),
  }),
  z.object({
    status: z.literal("error"),
    input: z.unknown().optional(),
    error: z.string(),
    /** interrupted=true: it was wrapped up by Ctrl-C, not a failure of the tool itself. */
    metadata: z.record(z.string(), z.unknown()).default({}),
    time: z.object({ start: z.number(), end: z.number() }),
  }),
])
export type ToolState = z.infer<typeof ToolStateSchema>

export const ToolPartSchema = z.object({
  ...partBase,
  type: z.literal("tool"),
  /** The provider's toolCallId; used to pair up tool_result when replaying. */
  callID: z.string(),
  tool: z.string(),
  state: ToolStateSchema,
})

export const StepStartPartSchema = z.object({
  ...partBase,
  type: z.literal("step-start"),
})

export const StepFinishPartSchema = z.object({
  ...partBase,
  type: z.literal("step-finish"),
  finishReason: z.string(),
  tokens: TokensSchema,
  cost: z.number().default(0),
})

export const FilePartSchema = z.object({
  ...partBase,
  type: z.literal("file"),
  mediaType: z.string(),
  filename: z.string().optional(),
  url: z.string(),
})

/**
 * Compaction point. The pin that `/compact` drives in.
 *
 * ★ It is **a boundary, not a message**. Not one message of history before it is
 *   deleted — it all still sits in the database and can still be replayed by `/resume` —
 *   but of what came before it, only the turns from `keptFrom` on are still sent to the
 *   model, verbatim; everything earlier is replaced by the summary in text (see
 *   liveHistory in agent/to-model-messages.ts).
 *
 * Deleting history and not sending history are a whole order of magnitude apart: the
 * former is irreversible, and what the user wants from `/compact` is never "destroy the
 * last half hour".
 */
export const CompactPartSchema = z.object({
  ...partBase,
  type: z.literal("compact"),
  /** Handoff summary. It becomes the first line of the new history, as a user message */
  text: z.string(),
  /** How many messages were folded. It is what the boundary line shows on replay */
  folded: z.number().default(0),
  /**
   * **Which message** the verbatim-kept stretch starts from (message id).
   *
   * ── Why keep a stretch of the original after the summary ──
   * The handoff note is prose, and the last few turns are full of things prose cannot
   * restate: the exact text of an error, the exact form of a command, the wording of the
   * user's last message. Compaction happens most often exactly when the work is half
   * done, and that half's details are the most expensive. So the most recent turns
   * **follow the summary untouched, character for character**; only the earlier part is
   * folded.
   *
   * Store the **message id, not an index**: an index drifts as history grows, and this
   * pin has to hold for good. Old sessions don't have this column (compacted back when
   * no tail was kept), which means "keep nothing" — exactly what it did back then.
   */
  keptFrom: z.string().optional(),
  /**
   * How many tokens it took up before folding.
   *
   * Compaction is lossy, and **a lossy operation has to leave its own record**: looking
   * back days later at "under what conditions was this session compacted", this number
   * is the only answer. It takes part in no computation.
   */
  tokensBefore: z.number().default(0),
})

/**
 * Project memory. The copy hung in front of a new session's first message.
 *
 * ── Why it is a part and not a section of the system prompt ──
 * Three reasons, each sufficient on its own:
 *   1. **It has to be accounted for separately**. Mixed into the system lump, `/context`
 *      would only show "system 12k" — and what the user is deciding when looking at that
 *      report is exactly "which block to cut".
 *   2. **It is a one-off fact, not a per-turn instruction**. The system prompt is resent
 *      every turn, while memory only needs loading once — whatever it writes or deletes
 *      afterwards is all in the tool results.
 *   3. **It is written by a tool, not by the prompt**. See tool/memory.ts: additions and
 *      removals are explicit model calls, so "what it remembered" has a visible record
 *      in the conversation, instead of the system prompt quietly growing a bit longer
 *      after some turn.
 *
 * Like a text part it enters the model as a user message (it is background briefing), but
 * the UI does not render it — those are not the user's words.
 */
export const MemoryPartSchema = z.object({
  ...partBase,
  type: z.literal("memory"),
  /** The assembled text, sent straight to the model */
  text: z.string(),
  /** How many notes were loaded. For the `/context` line `memory 3 notes` */
  notes: z.number().default(0),
})

export const PartSchema = z.discriminatedUnion("type", [
  TextPartSchema,
  ReasoningPartSchema,
  ToolPartSchema,
  StepStartPartSchema,
  StepFinishPartSchema,
  FilePartSchema,
  CompactPartSchema,
  MemoryPartSchema,
])
export type Part = z.infer<typeof PartSchema>
export type TextPart = z.infer<typeof TextPartSchema>
export type ReasoningPart = z.infer<typeof ReasoningPartSchema>
export type ToolPart = z.infer<typeof ToolPartSchema>
export type StepFinishPart = z.infer<typeof StepFinishPartSchema>
export type CompactPart = z.infer<typeof CompactPartSchema>
export type MemoryPart = z.infer<typeof MemoryPartSchema>

// ─────────────────────────────────────────────────────────── Message

export const UserMessageSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  role: z.literal("user"),
  timeCreated: z.number(),
})

export const AssistantMessageSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  role: z.literal("assistant"),
  /**
   * Points at the user message that triggered it.
   *
   * This is the key to the main loop deciding "is this turn done": only when the last
   * assistant's parentID equals the last user message's id is it answering the current
   * turn — otherwise the user sent a new message midway, and it has to keep running.
   */
  parentID: z.string(),
  providerID: z.string(),
  modelID: z.string(),
  /** 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'error' | 'other' */
  finish: z.string().optional(),
  error: z.object({ name: z.string(), message: z.string() }).optional(),
  cost: z.number().default(0),
  tokens: TokensSchema.optional(),
  timeCreated: z.number(),
  timeCompleted: z.number().optional(),
})

export const MessageSchema = z.discriminatedUnion("role", [UserMessageSchema, AssistantMessageSchema])
export type Message = z.infer<typeof MessageSchema>
export type UserMessage = z.infer<typeof UserMessageSchema>
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>

/** History's container shape: one message with all of its parts. */
export interface MessageWithParts {
  info: Message
  parts: Part[]
}
