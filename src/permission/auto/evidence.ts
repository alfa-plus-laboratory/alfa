/**
 * What the classifier gets to see: the operation, and what the user has actually said.
 *
 * ── The user's words come from history, not from a variable ──
 * The previous reviewer saw one string, "the user's last message", kept in a variable in
 * main.ts. Two things went wrong with that. An answer given through the ask tool is a
 * tool result, not a user message, so after "should I delete it?" → "yes" the reviewer
 * still only saw the original request — the confirmation the whole scoring design relies
 * on never reached it. And a reply like "go ahead" says nothing without the question it
 * answers; the judge before that one called a plain "confirm" ambiguous for exactly this
 * reason (see the header of prompt/safety.ts). So the evidence is read from the session:
 * the user's last few messages, their answers to the agent's questions, and the tail of
 * the agent message the latest reply answers — the last one labelled as agent-written.
 *
 * ★ Only text the user typed or picked counts as the user. Synthetic user messages
 *   (subagent reports, environment notes) are skipped, and the operation itself is
 *   described under its own key: an agent that writes "the user approved this" into a
 *   command has not produced a user message.
 *
 * ── What the command runs, not just its name ──
 * For bash, `details.projectScripts` carries the repository text the command executes
 * (package.json scripts, a Makefile recipe, a script file's head; see scripts.ts). Tool
 * results stay out: the classifier sees operations, never what earlier operations
 * returned, so a poisoned file can't argue with it. The script text is the exception
 * because it *is* the operation.
 *
 * ── Sizes ──
 * Everything is clipped, visibly. The old reviewer refused anything over 48,000
 * characters outright, which meant a new 45 KB file could not be written in auto at
 * all; a clipped diff still shows what kind of change it is. The edit card's `preview`
 * (a second copy of the diff) and bash's `segments` (the command again, split) are
 * dropped rather than sent twice.
 */
import { within } from "../../fs/guard.ts"
import type { MessageWithParts } from "../../session/schema.ts"
import type { AskInput } from "../../tool/types.ts"
import type { ClassifierState } from "./classifier.ts"
import { projectScripts } from "./scripts.ts"
import { isSecretPath } from "./secrets.ts"

const KEEP_MESSAGES = 4
const KEEP_ANSWERS = 4
const MESSAGE_CHARS = 2_000
const REPLY_TO_CHARS = 1_500
const TASK_CHARS = 3_000
const VALUE_CHARS = 6_000
const DIFF_LINES = 300
const DIFF_CHARS = 16_000
const MAX_TARGETS = 20

/** Metadata that is a copy of something else, or UI bookkeeping */
const DROP = new Set(["preview", "segments", "job"])

export function describeOperation(input: AskInput, root: string): ClassifierState["operation"] {
  const details: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    if (DROP.has(key) || value === undefined) continue
    details[key] = key === "diff" && typeof value === "string" ? clipDiff(value) : clipValue(value)
  }
  // What a project command really runs (scripts.ts). Kept out of clipValue's single
  // 6,000-character budget: each script is already capped on its own
  const command = input.metadata?.["command"]
  const workdir = input.metadata?.["workdir"]
  if (input.permission === "bash" && typeof command === "string") {
    const scripts = projectScripts(command, typeof workdir === "string" ? workdir : root, root)
    if (scripts.length > 0) details["projectScripts"] = scripts
  }
  const file = input.metadata?.["filePath"]
  if (typeof file === "string") {
    details["insideWorkspace"] = within(file, root)
    // The classifier needs to know a key file is being written, not the key
    if (details["diff"] !== undefined && isSecretPath(file, root)) details["diff"] = "(omitted: secret file)"
  }
  const targets = input.patterns.slice(0, MAX_TARGETS).map((target) => clip(target, 500))
  if (input.patterns.length > MAX_TARGETS) targets.push(`… ${input.patterns.length - MAX_TARGETS} more`)
  return { tool: input.permission, targets, details }
}

export function userVoice(history: MessageWithParts[]): ClassifierState["user"] {
  const messages: string[] = []
  const answers: string[] = []
  let agentSaid: string | undefined
  let replyingTo: string | undefined
  for (const { info, parts } of history) {
    const text = parts
      .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
      .join("\n")
      .trim()
    if (info.role === "user") {
      if (!text) continue
      messages.push(text)
      replyingTo = agentSaid
      agentSaid = undefined
      continue
    }
    if (text) agentSaid = text
    for (const part of parts) {
      // Only questions that got an answer: "nobody to ask" and dismissals are not the
      // user agreeing to anything
      if (part.type === "tool" && part.tool === "ask" && part.state.status === "completed" && part.state.metadata["answered"] === true) {
        answers.push(part.state.output)
      }
    }
  }
  return {
    messages: messages.slice(-KEEP_MESSAGES).map((message) => clip(message, MESSAGE_CHARS)),
    answers: answers.slice(-KEEP_ANSWERS).map((answer) => clip(answer, MESSAGE_CHARS)),
    // The tail: a question to the user sits at the end of what the agent wrote
    ...(replyingTo ? { replyingTo: tail(replyingTo, REPLY_TO_CHARS) } : {}),
  }
}

/** A subagent's brief: the first message of its own session. */
export function delegatedTask(history: MessageWithParts[]): string | undefined {
  const first = history.find(({ info }) => info.role === "user")
  const text = first?.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim()
  return text ? clip(text, TASK_CHARS) : undefined
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… [${text.length - limit} more characters]`
}

function tail(text: string, limit: number): string {
  return text.length <= limit ? text : `[${text.length - limit} earlier characters] …\n${text.slice(-limit)}`
}

function clipValue(value: unknown): unknown {
  if (typeof value === "string") return clip(value, VALUE_CHARS)
  if (value === null || typeof value !== "object") return value
  const json = JSON.stringify(value)
  return json.length <= VALUE_CHARS ? value : clip(json, VALUE_CHARS)
}

function clipDiff(diff: string): string {
  const lines = diff.split("\n")
  const kept = lines.length > DIFF_LINES ? [...lines.slice(0, DIFF_LINES), `… [${lines.length - DIFF_LINES} more lines]`] : lines
  return clip(kept.join("\n"), DIFF_CHARS)
}
