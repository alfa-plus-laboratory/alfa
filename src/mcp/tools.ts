/**
 * MCP tools → alfa tools.
 *
 * This layer does four things, each with a reason it can't be skipped: naming, passing the
 * shape through, going past the gatekeeper, and sealing the envelope.
 */
import { z } from "zod"
import type { McpToolInfo } from "./client.ts"
import { envelope, sanitize, scanForInjection } from "../tool/untrusted.ts"
import type { ToolContext, ToolDef, ToolResult } from "../tool/types.ts"

/**
 * Legal characters in a tool name.
 *
 * Not fastidiousness on our part — function names on the OpenAI side are
 * `^[a-zA-Z0-9_-]+$`, with dots, slashes and colons all rejected. Names from MCP can
 * contain anything, so they have to go through this.
 */
const SAFE = /[^a-zA-Z0-9_-]/g

/** Every provider's function-name length cap is around 64; go with the tightest one */
const MAX_ID = 64

/**
 * The prefix. Double underscore because the rule above squeezes it out of both server and
 * tool names, so as a separator it can't collide.
 *
 * Exported because it's no longer just a naming habit: the context report relies on it to
 * separate "how much other people's tools take up" from "our own tools" (see
 * agent/context.ts). If the two places each wrote "mcp__" themselves, the day the prefix
 * changed, the breakdown would quietly count every MCP tool as our own — and that number
 * is exactly what the user relies on to decide "should I turn off a server".
 */
export const MCP_TOOL_PREFIX = "mcp__"

/**
 * A server's tool descriptions go into the prompt as-is, and that's text written by the
 * server's author.
 *
 * It can't go in an envelope (tool descriptions are part of the structure, not content),
 * so we settle for second best: scrub invisible characters and forged markers (which is
 * exactly what sanitize does), then truncate by length. A 30,000-character "tool
 * description" is an attack in itself — what it crowds out is everyone else's context.
 */
const MAX_DESCRIPTION = 4_000

/**
 * Cap on the text one call returns. Over it, keep the head, cut the tail and say so — a
 * list-type tool can return megabytes
 */
const MAX_OUTPUT = 60_000

/**
 * Naming: `mcp__<server>__<tool>`.
 *
 * ── Why the prefix ──
 * ① Must not collide with built-in tools (an MCP tool called `read` would displace our own
 *    read, and the registry just throws on that); ② the model can see at a glance that
 *    this step **leaves this machine**; ③ when something goes wrong, the name the user
 *    sees already says who provided it.
 *
 * Truncation cuts from the **tool name** end, keeping the prefix and server name: a run of
 * tools sharing a prefix is easier to debug than a run of tools you can't attribute to
 * anyone.
 */
export function toolID(server: string, tool: string, taken?: Set<string>): string {
  const cleanServer = server.replace(SAFE, "_")
  const cleanTool = tool.replace(SAFE, "_")
  const head = `${MCP_TOOL_PREFIX}${cleanServer}__`
  let id = (head + cleanTool).slice(0, MAX_ID)

  if (taken) {
    // On a collision, append a sequence number. Both truncation and different original
    // names can collide, and to the model two tools with the same name are one and the
    // same — it will call the right name and do the wrong thing
    let n = 2
    while (taken.has(id)) {
      const suffix = `_${n++}`
      id = (head + cleanTool).slice(0, MAX_ID - suffix.length) + suffix
    }
    taken.add(id)
  }
  return id
}

/** Whether this tool was provided by some MCP server */
export function isMcpTool(id: string): boolean {
  return id.startsWith(MCP_TOOL_PREFIX)
}

/** Only this one method is relied on, so tests can swap out the real client */
export interface ToolCaller {
  call(
    name: string,
    args: unknown,
    options: { signal?: AbortSignal },
  ): Promise<{ text: string; isError: boolean; nonText: number }>
}

export interface McpToolInput {
  server: string
  info: McpToolInfo
  caller: ToolCaller
  /** Tool names already taken. Pass the same Set when converting one batch together */
  taken?: Set<string>
}

/**
 * **Local** validation of arguments: a loose fallback.
 *
 * The real shape handed to the provider is rawSchema (whatever the server reports); this
 * only guarantees that what reaches execute is an object — the model occasionally sends a
 * no-argument call as undefined. Strict validation shouldn't be done a second time here:
 * if it differs even slightly from the server's own judgment, what gets reported is an
 * error the server itself wouldn't recognize.
 */
const Parameters = z.record(z.string(), z.unknown()).default({})

export function toToolDef(input: McpToolInput): ToolDef<Record<string, unknown>> {
  const { server, info, caller } = input
  const id = toolID(server, info.name, input.taken)
  const description = sanitize(info.description ?? info.title ?? `The ${info.name} tool.`).text.slice(
    0,
    MAX_DESCRIPTION,
  )

  return {
    id,
    description,
    parameters: Parameters,
    // Shape passed through as-is, not converted to zod (why: see rawSchema in tool/types.ts)
    rawSchema: info.inputSchema,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      /**
       * ★ Past the gatekeeper every single time, and **ignoring the server's claim to be
       *   read-only**.
       *
       * MCP annotations have fields like readOnlyHint, and using that as grounds to allow
       * is tempting — but the server fills it in itself, and the gatekeeper exists
       * precisely to "not take this side's word for it". A tool claiming to be read-only
       * can still send email, modify a database, or ship repo contents off somewhere.
       *
       * The permission key is the `mcp` family, with the target written as
       * `server/tool`: so "以后不再问" (the "always" / don't-ask-again choice) can pin a
       * single tool, or use the existing wildcard as `github/*` — the unit in the user's
       * mind is "this server", not "this function".
       */
      await ctx.ask({
        permission: "mcp",
        patterns: [`${server}/${info.name}`],
        metadata: { server, tool: info.name, arguments: args },
      })

      const result = await caller.call(info.name, args, { signal: ctx.abortSignal })

      const clipped = result.text.length > MAX_OUTPUT
      const body = clipped ? result.text.slice(0, MAX_OUTPUT) : result.text
      const clean = sanitize(body)
      const findings = scanForInjection(clean.text)

      const notes: string[] = []
      if (result.isError) {
        // ★ The tool itself failing is **not** an exception: it's a normal result, and the
        //   model should try something else based on it. Lump it in with exceptions and
        //   "wrong arguments" looks the same to the model as "this server is broken"
        notes.push(`The server reported this call as a failure.`)
      }
      if (clipped) {
        notes.push(
          `Only the first ${Math.round(MAX_OUTPUT / 1000)}k characters are shown. Ask the server for something narrower rather than repeating this call.`,
        )
      }
      if (result.nonText > 0) {
        notes.push(`${result.nonText} non-text block(s) in the result could not be read.`)
      }

      const output = envelope({
        source: `${server} (MCP server)`,
        kind: `the result of ${info.name}`,
        body: clean.text.length > 0 ? clean.text : "(the tool returned nothing)",
        notes,
        findings,
        sanitized: clean,
      })

      const flagged = findings.filter((one) => one.severity === "high").length
      return {
        output,
        title: `${server}/${info.name}${flagged > 0 ? ` · ${flagged} flagged` : ""}`,
        metadata: {
          truncated: clipped,
          server,
          tool: info.name,
          failed: result.isError,
          flagged,
          ...(result.nonText > 0 ? { nonText: result.nonText } : {}),
        },
      }
    },
  }
}

/** Convert a whole server's tools together — one batch shares one dedup table */
export function toToolDefs(server: string, tools: McpToolInfo[], caller: ToolCaller, taken?: Set<string>): ToolDef<any>[] {
  const seen = taken ?? new Set<string>()
  return tools.map((info) => toToolDef({ server, info, caller, taken: seen }))
}
