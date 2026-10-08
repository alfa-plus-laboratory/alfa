/**
 * A session's history cut into turns: what a compaction's index lists and what `recall`
 * reads back.
 *
 * ── Why this exists ──
 * Compaction folds history into a summary, and the summary is lossy by design. Before this,
 * whatever it left out was gone for the model: the originals were still in the store (only
 * `/resume` replayed them, for the user), but nothing let the model look. So a detail the
 * summarizer judged unimportant — the exact error from two hours ago, the option the user
 * rejected, the command line that finally worked — had to be rediscovered or guessed. Now
 * every compaction pins an index of the folded turns to its summary, and `recall` searches
 * or reads them back.
 *
 * ── Why a turn is the unit ──
 * A turn starts where the user spoke — the one boundary both reader and writer already
 * think in ("when I asked for X"). Everything until the next one belongs to it: the
 * agent's rounds, tool calls, and synthetic user messages (a check's reminder, a message
 * from another agent) that arrive mid-turn. Fixed-size chunks were the alternative; they
 * cut a request away from its outcome, which is the one pairing a lookup needs.
 *
 * ★ Numbering counts every turn in the store, compacted or not, from 1. History is
 *   append-only, so a number written into an index stays valid through later compactions:
 *   the third compaction's summary can say "turn 4" and recall still finds the same turn.
 * ⚠ Compaction points are left out of every turn. They are summaries, not history;
 *   reading one back would hand the model a superseded summary as if it were the record.
 */
import type { MessageWithParts } from "./schema.ts"

export interface Turn {
  /** 1-based, stable for the life of the session (see the ★ above) */
  number: number
  messages: MessageWithParts[]
}

/** How much of each piece a full read-back shows. Generous: this is the detail on request */
const READ_TEXT = 20_000
const READ_INPUT = 2_000
const READ_OUTPUT = 8_000

export function splitTurns(history: readonly MessageWithParts[]): Turn[] {
  const turns: Turn[] = []
  for (const message of history) {
    if (message.parts.some(part => part.type === "compact")) continue
    if (startsTurn(message) || turns.length === 0) turns.push({ number: turns.length + 1, messages: [] })
    turns.at(-1)!.messages.push(message)
  }
  return turns
}

function startsTurn(message: MessageWithParts): boolean {
  if (message.info.role !== "user") return false
  return message.parts.some(part => (part.type === "text" && !part.synthetic && part.text.trim().length > 0) || part.type === "file")
}

/** The user's words that opened the turn ("" for a turn that opened on its own) */
export function turnRequest(turn: Turn): string {
  const first = turn.messages[0]
  if (!first || first.info.role !== "user") return ""
  return first.parts.flatMap(part => part.type === "text" && !part.synthetic ? [part.text] : []).join("\n").trim()
}

/** Paths edit/write actually changed in this turn, in order of first touch */
export function turnFiles(turn: Turn): string[] {
  const files = new Set<string>()
  for (const message of turn.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.state.status !== "completed") continue
      if (part.tool !== "edit" && part.tool !== "write") continue
      const path = (part.state.input as Record<string, unknown> | undefined)?.["filePath"]
      if (typeof path === "string" && path.length > 0) files.add(path)
    }
  }
  return [...files]
}

/**
 * One index line: when, what was asked, how much happened, what it changed. Enough to
 * pick the turn to read back, not to replace reading it.
 */
export function turnLine(turn: Turn): string {
  let calls = 0
  let failed = 0
  for (const message of turn.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.state.status === "pending") continue
      calls++
      if (part.state.status === "error") failed++
    }
  }
  const when = stamp(turn.messages[0]?.info.timeCreated)
  const request = oneLine(turnRequest(turn), 90)
  const files = turnFiles(turn)
  const shown = files.slice(0, 4).map(path => path.split("/").slice(-2).join("/"))
  return [
    `turn ${turn.number}`,
    when,
    request.length > 0 ? `"${request}"` : "(continued without a new request)",
    calls > 0 ? `${calls} tool call${calls === 1 ? "" : "s"}${failed > 0 ? `, ${failed} failed` : ""}` : "",
    files.length > 0 ? `edited ${shown.join(", ")}${files.length > shown.length ? ` (+${files.length - shown.length})` : ""}` : "",
  ].filter(Boolean).join(" · ")
}

/** The whole turn as text, for a read-back */
export function renderTurn(turn: Turn): string {
  const lines: string[] = [`=== turn ${turn.number} · ${stamp(turn.messages[0]?.info.timeCreated)} ===`]
  for (const message of turn.messages) {
    const user = message.info.role === "user"
    for (const part of message.parts) {
      switch (part.type) {
        case "text":
          if (part.text.trim().length === 0) break
          lines.push(user ? (part.synthetic ? `NOTE (not the user's words): ${clip(part.text, READ_TEXT)}` : `USER: ${clip(part.text, READ_TEXT)}`) : `AGENT: ${clip(part.text, READ_TEXT)}`)
          break
        case "file":
          lines.push(`USER attached: ${part.filename ?? part.mediaType}`)
          break
        case "tool": {
          const state = part.state
          if (state.status === "pending") break
          const input = "input" in state ? clip(json(state.input), READ_INPUT) : ""
          if (state.status === "completed") lines.push(`TOOL ${part.tool} ${input}\n  -> ${clip(state.output, READ_OUTPUT)}`)
          else if (state.status === "error") lines.push(`TOOL ${part.tool} ${input}\n  -> FAILED: ${clip(state.error, READ_OUTPUT)}`)
          else lines.push(`TOOL ${part.tool} ${input}\n  -> (did not finish)`)
          break
        }
        default:
          break
      }
    }
    if (message.info.role === "assistant") {
      if (message.info.finish === "interrupted") lines.push("(the user interrupted here)")
      else if (message.info.finish === "error") lines.push(`(failed: ${message.info.error?.message ?? "error"})`)
    }
  }
  return lines.join("\n\n")
}

export interface Hit {
  turn: number
  where: string
  snippet: string
}

/**
 * Pieces (a text, a tool call with its result) containing every word of the query,
 * ignoring case, newest first — the recent past is what a lookup is most often after.
 */
export function searchTurns(turns: readonly Turn[], query: string): Hit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(term => term.length > 0)
  if (terms.length === 0) return []
  const hits: Hit[] = []
  for (const turn of [...turns].reverse()) {
    for (const message of [...turn.messages].reverse()) {
      for (const part of [...message.parts].reverse()) {
        const piece = pieceOf(message, part)
        if (!piece) continue
        const lower = piece.text.toLowerCase()
        if (!terms.every(term => lower.includes(term))) continue
        hits.push({ turn: turn.number, where: piece.where, snippet: around(piece.text, lower.indexOf(terms[0]!)) })
      }
    }
  }
  return hits
}

function pieceOf(message: MessageWithParts, part: MessageWithParts["parts"][number]): { where: string; text: string } | undefined {
  if (part.type === "text" && part.text.trim().length > 0) {
    return { where: message.info.role === "user" ? (part.synthetic ? "note" : "user") : "agent", text: part.text }
  }
  if (part.type !== "tool" || part.state.status === "pending") return undefined
  const state = part.state
  const input = "input" in state ? json(state.input) : ""
  const result = state.status === "completed" ? state.output : state.status === "error" ? state.error : ""
  return { where: `tool ${part.tool}`, text: `${input}\n${result}` }
}

function around(text: string, at: number): string {
  const from = Math.max(0, at - 120)
  const to = Math.min(text.length, at + 200)
  return `${from > 0 ? "…" : ""}${oneLine(text.slice(from, to), 400)}${to < text.length ? "…" : ""}`
}

function stamp(time: number | undefined): string {
  if (time === undefined) return ""
  const date = new Date(time)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function oneLine(text: string, max: number): string {
  const flat = text.replaceAll(/\s+/g, " ").trim()
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…"
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + ` …(+${text.length - max} chars)`
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}
