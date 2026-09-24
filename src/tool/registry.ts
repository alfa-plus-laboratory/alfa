/**
 * Tool registry.
 *
 * Deliberately kept pure: **no** conversion to AI SDK shapes here. The plan originally put
 * toAiSdkTools() in this file, but that would make src/tool depend on "ai", which clashes
 * with the boundary "the tool layer doesn't know the SDK". The conversion lives in
 * src/llm/adapt-tools.ts — the LLM layer knows both sides, so it is the only place that
 * should carry the translation job.
 */
import type { ToolEvent } from "../extension/api.ts"
import type { ToolDef, ToolResult } from "./types.ts"
import { inspectLocalText, LOCAL_SOURCES } from "./untrusted.ts"

/**
 * Applied here rather than inside each tool, so that a tool marked `outputSource` can't
 * forget one of its return paths (bash alone has four). The warning goes in front: the
 * model reads it before the text it is about.
 */
function flagOutput(result: ToolResult, source: NonNullable<ToolDef["outputSource"]>): ToolResult {
  const warning = inspectLocalText(result.output, LOCAL_SOURCES[source])
  return warning.length === 0 ? result : { ...result, output: [...warning, result.output].join("\n") }
}

export class ToolRegistry {
  private hooks = { before: [] as Array<(event: ToolEvent) => void | Promise<void>>, after: [] as Array<(event: ToolEvent) => void | Promise<void>> }
  onTool(phase: "before" | "after", listener: (event: ToolEvent) => void | Promise<void>): void { this.hooks[phase].push(listener) }
  private tools = new Map<string, ToolDef<any>>()

  register(def: ToolDef<any>): this {
    if (this.tools.has(def.id)) throw new Error(`Tool "${def.id}" is already registered`)
    this.tools.set(def.id, { ...def, execute: async (input, context) => {
      const event: ToolEvent = { tool: def.id, input, context }
      try {
        for (const hook of this.hooks.before) await hook(event)
        event.result = await def.execute(input, context)
        if (def.outputSource) event.result = flagOutput(event.result, def.outputSource)
        return event.result
      } catch (error) { event.error = error; throw error }
      // After-hook errors are swallowed: an observer must not turn a side effect that
      // already happened into a failure and invite a retry.
      finally { for (const hook of this.hooks.after) { try { await hook(event) } catch { /* see above */ } } }
    } })
    return this
  }

  get(id: string): ToolDef<any> | undefined {
    return this.tools.get(id)
  }

  has(id: string): boolean {
    return this.tools.has(id)
  }

  /**
   * Returned in lexicographic id order.
   *
   * ⚠ Sorting is not fastidiousness: tool definitions are the earliest cache prefix after
   *   the system prompt, and if the order jitters, the whole prompt cache misses. Map's
   *   insertion order shifts whenever the registration code changes, so it must be sorted.
   */
  list(): ToolDef<any>[] {
    return [...this.tools.values()].toSorted((a, b) => a.id.localeCompare(b.id))
  }

  ids(): string[] {
    return this.list().map((t) => t.id)
  }
}
