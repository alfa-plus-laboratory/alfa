/**
 * UI event bus.
 *
 * The main loop and rendering talk **only through this channel**. The reason isn't a
 * decoupling fetish: a direct console.log anywhere in the main loop fights the streaming
 * output for stdout and tears apart the line being typed. The render layer is the sole owner
 * of stdout; everyone else can only emit events.
 *
 * Events carry **the persisted part objects**, not incremental fragments — the render layer
 * can redraw a whole block at any moment without accumulating state of its own. delta is
 * just a fast path offered along the way.
 */
import type { AssistantMessage, Part, StepFinishPart, ToolPart } from "../session/schema.ts"

export type UIEvent =
  | { type: "message.start"; message: AssistantMessage }
  | { type: "message.end"; message: AssistantMessage }
  | { type: "part.start"; part: Part }
  | { type: "part.delta"; part: Part; delta: string }
  | { type: "part.end"; part: Part }
  | { type: "tool.state"; part: ToolPart }
  | { type: "step.finish"; part: StepFinishPart }
  /** Retrying. attempt is the one that just failed. */
  | { type: "retry"; attempt: number; maxAttempts: number; delayMs: number; message: string }
  | { type: "error"; error: Error }

export type Listener<E> = (event: E) => void

export class Emitter<E extends { type: string }> {
  private listeners = new Set<Listener<E>>()

  on(listener: Listener<E>): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * One subscriber throwing must **not** take down the main loop — a render-layer bug
   * shouldn't kill a running tool call midway; that leaves a tool_use with no tool_result,
   * and the next turn gets a 400 outright.
   */
  emit(event: E): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // the subscriber's own problem; swallow it
      }
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}
