/**
 * Persisted parts are the source of runtime evidence; stdout mixes UI and tool output.
 * Explicit Responses phases win. Without phases, text in an assistant message that
 * also invokes tools is operational commentary; plain assistant text is an answer.
 * This is a capture convention, not a claim about the model's private intent. Pending
 * tool inputs never executed and cannot count as an environment-first tool call.
 */
import type { MessageWithParts } from "../src/session/schema.ts"
import { redact } from "../src/util/redact.ts"
import type { RuntimeEvidence } from "./runtime.ts"

export const captureConvention = "Explicit commentary/final_answer phases take precedence. Unphased text in assistant messages with non-pending tool parts is commentary; other assistant text is an answer. Synthetic text and reasoning are excluded. Pending tool inputs do not count as calls."

export function captureRuntime(history: MessageWithParts[], identity: Pick<RuntimeEvidence, "scenario" | "model" | "repetition">) {
  const events: RuntimeEvidence["events"] = []
  const environmentObservations: Array<{ callID: string; status: string; output: string | null }> = []
  for (const message of history.toSorted((a, b) => a.info.timeCreated - b.info.timeCreated || a.info.id.localeCompare(b.info.id))) {
    if (message.info.role !== "assistant") continue
    const parts = message.parts.toSorted((a, b) => a.timeCreated - b.timeCreated || a.id.localeCompare(b.id))
    const hasTools = parts.some(part => part.type === "tool" && part.state.status !== "pending")
    for (const part of parts) {
      if (part.type === "text" && !part.synthetic && part.text.trim()) {
        const phase = part.responses?.phase
        const type = phase === "commentary" || phase !== "final_answer" && hasTools ? "commentary" : "answer"
        events.push({ type, text: redact(part.text) })
      } else if (part.type === "tool" && part.state.status !== "pending") {
        events.push({ type: "tool-call", tool: part.tool })
        if (part.tool === "environment") environmentObservations.push({
          callID: part.callID, status: part.state.status,
          output: part.state.status === "completed" ? redact(part.state.output) : part.state.status === "error" ? redact(part.state.error) : null,
        })
      }
    }
  }
  return { ...identity, events, environmentObservations, captureConvention }
}
