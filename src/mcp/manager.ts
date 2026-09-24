/**
 * Manager of every MCP server in a session: who connected, who didn't, where tools come
 * from, and who's responsible for killing what on exit.
 *
 * ── One principle throughout: a server's problem must cost only "a few fewer tools" ──
 * Not a slower startup, not a screenful of errors, and certainly not failing to start. MCP
 * servers are programs someone else wrote, specified by the user's config file — a
 * misspelled command, a missing dependency, failing to reach its own backend: all
 * routine. So connecting always runs in the background, failures are recorded as-is for
 * `/mcp` to show, and the main flow doesn't wait a single step.
 */
import { toToolDefs } from "./tools.ts"
import { McpClient } from "./client.ts"
import { stdioTransport, type Transport } from "./transport.ts"
import type { McpServerEntry } from "./config.ts"
import type { ToolDef } from "../tool/types.ts"
import { logger } from "../util/log.ts"

const log = logger("mcp")

/**
 * Permission key for the grant "this server from the project may be started".
 *
 * It borrows the ready-made persistence behind "以后不再问" (the "always" / don't-ask-again
 * choice; per workspace, stores allows only) — which answers exactly the same kind of
 * question: for this repo on this machine, what has the user nodded to. A separate store
 * would just add one more source of truth to maintain on its own. Kept apart from the
 * tool-call permission (`mcp`): one governs "may this process be started", the other
 * "may this be done".
 */
export const MCP_SERVER_PERMISSION = "mcp-server"

export type McpState =
  /** Config says enabled: false */
  | "off"
  /** From the project, not yet approved by the user. **No process has been started** */
  | "needs-approval"
  | "connecting"
  | "ready"
  | "failed"

export interface McpStatus {
  name: string
  origin: McpServerEntry["origin"]
  source: string
  state: McpState
  /** How many tools, when ready */
  tools: number
  /** Why, when failed */
  why?: string
  /** The server's self-reported name and version */
  server?: { name?: string; version?: string }
}

export interface ManagerDeps {
  root: string
  entries: McpServerEntry[]
  /**
   * Whether the user has approved this server from the project.
   *
   * ★ Only asked for project-origin ones. The global config is something the user wrote in
   *   their own home directory; asking again would treat "a decision they made themselves"
   *   as "someone else's input".
   */
  isTrusted(entry: McpServerEntry): boolean
  /** Swaps out the transport, for tests */
  open?(entry: McpServerEntry, root: string): Transport
  /** Some server's state changed (connected / died). The UI redraws on this */
  onChange?(): void
}

interface Slot {
  entry: McpServerEntry
  state: McpState
  why?: string
  client?: McpClient
  tools: ToolDef<any>[]
}

export class McpManager {
  private readonly deps: ManagerDeps
  private readonly slots = new Map<string, Slot>()
  /** One shared table of taken tool names — two servers each having a `search` is common */
  private readonly taken = new Set<string>()

  constructor(deps: ManagerDeps) {
    this.deps = deps
    for (const entry of deps.entries) {
      this.slots.set(entry.name, {
        entry,
        state:
          entry.enabled === false
            ? "off"
            : entry.origin === "project" && !deps.isTrusted(entry)
              ? "needs-approval"
              : "connecting",
        tools: [],
      })
    }
  }

  /**
   * Start connecting. **Returns immediately** — each server connects on its own, so a slow
   * one holds up neither the others nor, above all, the user typing their first message.
   */
  start(): void {
    for (const slot of this.slots.values()) {
      if (slot.state === "connecting") void this.connect(slot)
    }
  }

  /** Tools usable now. A server that didn't connect has no tools, not erroring tools */
  tools(): ToolDef<any>[] {
    const all: ToolDef<any>[] = []
    for (const slot of this.slots.values()) all.push(...slot.tools)
    return all
  }

  statuses(): McpStatus[] {
    return [...this.slots.values()]
      .map((slot) => ({
        name: slot.entry.name,
        origin: slot.entry.origin,
        source: slot.entry.source,
        state: slot.state,
        tools: slot.tools.length,
        ...(slot.why ? { why: slot.why } : {}),
        ...(slot.client ? { server: slot.client.serverInfo } : {}),
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name))
  }

  /** Any waiting for the user's approval. The startup banner mentions them based on this */
  pending(): McpStatus[] {
    return this.statuses().filter((one) => one.state === "needs-approval")
  }

  /**
   * The user approved: connect now.
   *
   * Persisting is the caller's job (`src/mcp` shouldn't know which file grants are stored
   * in) — this only handles "from this moment on, it may connect".
   */
  approve(name: string): boolean {
    const slot = this.slots.get(name)
    if (!slot || slot.state !== "needs-approval") return false
    slot.state = "connecting"
    void this.connect(slot)
    return true
  }

  /**
   * Wrap up: kill every child process along with its descendants. **Must be awaited** —
   * otherwise shutdown can leave orphaned processes running.
   */
  async close(): Promise<void> {
    await Promise.all(
      [...this.slots.values()].map(async (slot) => {
        slot.tools = []
        if (!slot.client) return
        try {
          await slot.client.close()
        } catch (error) {
          log.warn("close failed", { server: slot.entry.name, why: (error as Error).message })
        }
      }),
    )
  }

  private async connect(slot: Slot): Promise<void> {
    const entry = slot.entry
    try {
      const transport = (this.deps.open ?? stdioTransport)(entry, this.deps.root)
      const client = new McpClient(entry.name, transport)
      slot.client = client
      await client.initialize()
      const listed = await client.listTools()
      slot.tools = toToolDefs(entry.name, listed, client, this.taken)
      slot.state = "ready"
      log.warn("connected", { server: entry.name, tools: slot.tools.length })
    } catch (error) {
      slot.state = "failed"
      // What's reported must **say where to go fix it next** — all the user has is "it
      // didn't show up"
      slot.why = `${(error as Error).message} (defined in ${entry.source})`
      slot.tools = []
      try {
        await slot.client?.close()
      } catch {
        // It never even connected; failing to clean up after it doesn't matter
      }
      log.warn("connect failed", { server: entry.name, why: slot.why })
    }
    this.deps.onChange?.()
  }
}
