/**
 * Draws a saved session back onto the screen.
 *
 * ── Why synthesize events instead of laying it out here ──
 * All the rendering rules live in Renderer: markdown's streaming finalization, the
 * `◆ agent` signature, the tool cards' `●` / `↳`, how result lines hang during parallel
 * calls. Writing the layout again here would amount to admitting "the same text looks
 * different after resuming" — and that is exactly what's most easily mistaken for "the
 * resume went wrong". So this does just one thing: turn the stored parts back into
 * **the original stream of events** and hand them to the same renderer.
 *
 * ── What isn't replayed ──
 * Thinking (reasoning): it's scratch work; at the time it only flashed in the live area
 * and never made it into the scrollback.
 * step-finish usage stats: that's "what did this step just cost" — meaningless a day
 * later, and it would litter the replayed history with numbers everywhere.
 * Half-finished tools (pending / running): the process has changed, they can never get
 * a result — drawing a spinner that spins forever is worse than drawing nothing.
 */
import type { UIEvent } from "../agent/events.ts"
import { t } from "../i18n/index.ts"
import type { MessageWithParts, ToolPart } from "../session/schema.ts"
import { userLines } from "./render.ts"
import { theme } from "./theme.ts"

export interface ReplaySink {
  /** Write one line into the scrollback (what the user said). */
  line(text: string): void
  /** Model-side events, handed to the renderer. */
  handle(event: UIEvent): void
}

/**
 * Replay the whole history. Returns how many messages were drawn — the caller uses it
 * for the "restored N" line.
 */
export function replay(history: MessageWithParts[], sink: ReplaySink): number {
  let count = 0
  for (const message of history) {
    if (message.info.role === "user") {
      // A compaction point. **It must be drawn** — the model can no longer see the big
      // stretch above it, while the user, looking at a complete record, would assume it
      // still remembers. The summary itself isn't spread out: it's a handoff for the
      // model; `/context` is there for reading it in full
      const folded = message.parts.find((part) => part.type === "compact")
      if (folded?.type === "compact") {
        sink.line("")
        sink.line(theme.dim(`  ⌦ ${t.compactedMarker(folded.folded)}`))
        continue
      }
      const text = textOf(message)
      if (text.length === 0) continue
      for (const line of userLines(text)) sink.line(line)
      // The same receipt as when it was sent: the line shows `@shot.png`, only this says
      // the image itself went with it
      for (const part of message.parts) {
        if (part.type !== "file") continue
        sink.line(theme.dim(`  ⧉ ${t.imageAttached(part.filename ?? part.mediaType, dataURLSize(part.url), false)}`))
      }
      count += 1
      continue
    }

    // assistant: announce first (the signature depends on it), then hand the parts over
    // in stored order
    sink.handle({ type: "message.start", message: message.info })
    let spoke = false
    for (const part of message.parts) {
      if (part.type === "text") {
        if (part.text.length === 0) continue
        // Give the whole thing at once. Renderer's markdown is streaming, but "one big
        // chunk at a time" is a legal stream too — it finalizes by line, not by chunk
        sink.handle({ type: "part.delta", part, delta: part.text })
        sink.handle({ type: "part.end", part })
        spoke = true
      } else if (part.type === "tool" && isFinished(part)) {
        sink.handle({ type: "tool.state", part })
        spoke = true
      }
    }
    sink.handle({ type: "message.end", message: message.info })
    if (spoke) count += 1
  }
  return count
}

/**
 * Only finished ones are replayed. pending / running will never get an outcome in a new
 * process.
 */
function isFinished(part: ToolPart): boolean {
  return part.state.status === "completed" || part.state.status === "error"
}

/** Decoded size of a base64 `data:` URL, for the receipt */
function dataURLSize(url: string): string {
  const comma = url.indexOf(",")
  const bytes = comma < 0 ? 0 : Math.floor(((url.length - comma - 1) * 3) / 4)
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1_000))} KB`
}

/** Synthetic instructions belong in model history, never in the human transcript. */
function textOf(message: MessageWithParts): string {
  return message.parts
    .filter((part) => part.type === "text" && !part.synthetic)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim()
}
