/**
 * Summaries and handoffs consume final text, not progress narration. Responses can reveal
 * an item's phase only at text-end, so stopping collection at the character limit could
 * mistakenly save commentary as the result. Drain the bounded model response while
 * retaining at most maxChars of text, and discard explicit commentary after its end.
 * Legacy streams without phase keep their text; no phase is inferred from prose.
 */
import type { LLMEvent, ResponsesTextMetadata } from "../llm/types.ts"

export async function collectFinalText(handle: { events: AsyncIterable<LLMEvent> }, maxChars: number): Promise<string> {
  const items: Array<{ text: string; phase?: ResponsesTextMetadata["phase"] }> = []
  const active = new Map<string, (typeof items)[number]>()
  let retained = 0
  for await (const event of handle.events) {
    if (event.type === "error") throw event.error
    if (event.type !== "text-start" && event.type !== "text-delta" && event.type !== "text-end") continue
    let item = active.get(event.id)
    if (!item) {
      item = { text: "" }
      active.set(event.id, item)
      items.push(item)
    }
    if (event.type !== "text-delta" && event.responses && "phase" in event.responses) item.phase = event.responses.phase
    if (event.type === "text-delta" && item.phase !== "commentary") {
      const chunk = event.text.slice(0, Math.max(0, maxChars - retained))
      item.text += chunk
      retained += chunk.length
    }
    if (item.phase === "commentary") {
      retained -= item.text.length
      item.text = ""
    }
    if (event.type === "text-end") active.delete(event.id)
  }
  return items.filter(item => item.phase !== "commentary").map(item => item.text).join("")
}
