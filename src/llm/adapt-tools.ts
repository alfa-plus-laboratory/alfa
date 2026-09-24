/**
 * The translation layer from ToolDef to the AI SDK's ToolSet.
 *
 * This is the **only** place that knows both sides. src/tool doesn't know the SDK, and
 * neither does src/agent, so the cost of switching SDKs (or dropping the SDK some day)
 * is locked inside this one file.
 * Native apply_patch is opt-in at the Responses profile boundary. Its structured output
 * belongs to the wire protocol; the executor and stored tool result stay SDK-independent.
 */
import { jsonSchema, tool, type ToolSet } from "ai"
import { openai } from "@ai-sdk/openai"
import type { ZodError } from "zod"
import type { ToolContext, ToolDef } from "../tool/types.ts"

export interface AdaptOptions {
  tools: ToolDef<any>[]
  makeToolContext(call: { callID: string; abortSignal: AbortSignal }): ToolContext
  nativeApplyPatch?: boolean
}

/**
 * How validation failures are phrased. **Meant for the model**, so it has to be a
 * sentence it can act on to fill in what's missing, not a structured zod error — with
 * the latter it would first have to guess the format to find out what it left out.
 */
function complaints(error: ZodError): string {
  const parts = error.issues.slice(0, 4).map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join(".") : "(root)"
    return issue.code === "invalid_type" && issue.input === undefined
      ? `${where} is required`
      : `${where}: ${issue.message}`
  })
  return `invalid arguments — ${parts.join("; ")}. Nothing ran; call it again with all required arguments.`
}

export function adaptTools(options: AdaptOptions): ToolSet {
  const entries = options.tools
    // ⚠ Must be sorted. Tool definitions are the earliest part of the cache prefix after
    //   the system prompt; an order that shifts with the registration code means the
    //   prompt cache always misses.
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .map((def) => {
      const description = typeof def.description === "function" ? def.description() : def.description

      const execute = async (input: unknown, { toolCallId, abortSignal }: { toolCallId: string; abortSignal?: AbortSignal }) => {
        // ★ Validate the arguments again ourselves.
        //
        // The SDK does validate against inputSchema, but that's **someone else's
        // guarantee**: a different SDK version or a different provider's function
        // calling format, and what slips through is a `{}`. Then the scattered
        // `if (!args.filePath)` checks in the tools each do their own thing (some
        // throw, some fall back to a default), and the model gets an error that gives
        // no clue how to fix it.
        //
        // Blocking it once here, uniformly, reports "which field is missing" — the kind
        // the model can act on.
        const parsed = def.parameters.safeParse(input)
        if (!parsed.success) throw new Error(`${def.id}: ${complaints(parsed.error)}`)

        const ctx = options.makeToolContext({
          callID: toolCallId,
          abortSignal: abortSignal ?? new AbortController().signal,
        })
        const result = await def.execute(parsed.data, ctx)
        // Only output goes back to the model. metadata is for the UI and storage and
        // burns no tokens.
        //
        // ⚠ But metadata must be **sent on**, not thrown away once computed. The SDK's
        //   tool-result event carries only output; diff / exitCode /
        //   outputPath all live here. The direct consequence of dropping it: edit's diff
        //   can never be printed — and edit being allowed by default was bought on the
        //   premise that "what changed is visible right there"; without the diff that
        //   default no longer holds.
        ctx.metadata(result.metadata)
        return result.output
      }
      if (options.nativeApplyPatch && def.id === "apply_patch") {
        return [def.id, openai.tools.applyPatch({ execute: async (input, context) => ({ status: "completed" as const, output: await execute(input, context) }) })] as const
      }
      return [def.id, tool({
        description,
        // MCP schemas bypass the lossy zod round trip; see rawSchema in tool/types.ts.
        inputSchema: def.rawSchema !== undefined ? (jsonSchema(def.rawSchema as never) as never) : (def.parameters as never),
        execute,
      })] as const
    })

  return Object.fromEntries(entries)
}
