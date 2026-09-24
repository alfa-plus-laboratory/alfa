/**
 * A session with one MCP server: handshake → list tools → call tools → wrap up.
 *
 * This layer only handles **one conversation at the protocol level**. Who connects, what
 * happens when a connection fails, how tools become alfa tools — all of that lives
 * elsewhere. One client maps to exactly one server and has no idea whether there are
 * others.
 */
import { JsonRpcClient, RpcError, type RpcOptions } from "./protocol.ts"
import type { Transport } from "./transport.ts"
import { VERSION } from "../update/release.ts"

/**
 * The version we claim to speak.
 *
 * During the handshake the server replies with its own, and **a mismatch is not a
 * failure**: the shapes of tools/list and tools/call haven't changed between versions, and
 * refusing to talk over a version string turns "this server is missing something" into
 * "this server is unusable". A mismatch just gets noted (see protocolVersion).
 */
const PROTOCOL_VERSION = "2025-06-18"

/**
 * Handshake and listing tools should both be fast. This slow, the wrong thing was most
 * likely started; saying so early beats hanging
 */
const HANDSHAKE_TIMEOUT_MS = 30_000

export interface McpToolInfo {
  name: string
  title?: string
  description?: string
  /** The JSON Schema as-is. **Not converted to zod** — see the note in tools.ts */
  inputSchema: unknown
}

export interface McpCallResult {
  /** The assembled text. Non-text content blocks are replaced by a one-line note */
  text: string
  /** The server itself says this call failed (not a protocol error — the tool failed) */
  isError: boolean
  /** How many blocks aren't text — the UI must be able to say "two more images not shown" */
  nonText: number
}

export class McpClient {
  private readonly rpc: JsonRpcClient
  private readonly transport: Transport
  readonly name: string
  /** The server's self-reported name and version. Only available after the handshake */
  serverInfo: { name?: string; version?: string } = {}
  /** Protocol version the server replied with. If it differs from ours, the only clue */
  protocolVersion?: string
  private closedWhy: string | undefined

  constructor(name: string, transport: Transport) {
    this.name = name
    this.transport = transport
    this.rpc = new JsonRpcClient(transport, {
      timeoutMs: HANDSHAKE_TIMEOUT_MS,
      onNotification: () => {
        // Notifications like "tool list changed" are received and ignored for now.
        // **Swapping tools on the fly has a price**: tool definitions are the very front of
        // the prompt's cache prefix, and swapping them mid-conversation invalidates the
        // whole cache. If it's ever supported, the layer above should decide to reconnect
        // between turns, not have it changed casually here.
      },
    })
    transport.onClose((why) => {
      this.closedWhy = why
    })
  }

  /** Whether it's disconnected, and why. The UI must be able to give the reason */
  get closed(): string | undefined {
    return this.closedWhy
  }

  /**
   * Handshake.
   *
   * The order is fixed by the protocol: initialize request → initialized notification →
   * only then anything else. Skip that notification and a strictly implemented server
   * rejects every request after it.
   */
  async initialize(options: RpcOptions = {}): Promise<void> {
    const result = (await this.rpc.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        // We don't provide sampling / roots / elicitation. The empty object is an **honest
        // declaration**: claim them without implementing them and the server will send
        // requests and wait for a reply that never comes
        capabilities: {},
        clientInfo: { name: "alfa", version: VERSION },
      },
      { timeoutMs: HANDSHAKE_TIMEOUT_MS, ...options },
    )) as { protocolVersion?: unknown; serverInfo?: { name?: unknown; version?: unknown } }

    if (typeof result?.protocolVersion === "string") this.protocolVersion = result.protocolVersion
    if (result?.serverInfo) {
      this.serverInfo = {
        ...(typeof result.serverInfo.name === "string" ? { name: result.serverInfo.name } : {}),
        ...(typeof result.serverInfo.version === "string" ? { version: result.serverInfo.version } : {}),
      }
    }

    // ★ The server may return some `instructions` here, and we **deliberately don't use
    //   them**. That's text written by the server's author; splicing it into the system
    //   prompt would let a third party slip things across the "only the user's messages
    //   are instructions" line (see prompt/untrusted.ts). Its tool descriptions still go
    //   into the prompt, but those are **attached to specific tools** and read as "how to
    //   use this tool", not "how you should go about things from now on".

    this.rpc.notify("notifications/initialized")
  }

  /**
   * List tools. Pagination must be followed to the end — take only the first page and the
   * tools after it simply don't exist as far as the model is concerned
   */
  async listTools(options: RpcOptions = {}): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    // Page cap: guards against a broken server that keeps handing the cursor back to us
    for (let page = 0; page < 50; page++) {
      const result = (await this.rpc.request(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        { timeoutMs: HANDSHAKE_TIMEOUT_MS, ...options },
      )) as { tools?: unknown; nextCursor?: unknown }

      for (const raw of Array.isArray(result?.tools) ? result.tools : []) {
        const one = raw as { name?: unknown; title?: unknown; description?: unknown; inputSchema?: unknown }
        if (typeof one.name !== "string" || one.name.length === 0) continue
        tools.push({
          name: one.name,
          ...(typeof one.title === "string" ? { title: one.title } : {}),
          ...(typeof one.description === "string" ? { description: one.description } : {}),
          inputSchema: one.inputSchema ?? { type: "object", properties: {} },
        })
      }

      if (typeof result?.nextCursor !== "string" || result.nextCursor.length === 0) break
      cursor = result.nextCursor
    }
    return tools
  }

  /**
   * Call one tool.
   *
   * The two kinds of failure must be kept apart: protocol-level errors (RpcError — wrong
   * name, invalid arguments) are handled by the caller as exceptions; `isError: true`
   * means **the tool itself failed when run**, which is a normal result and must be handed
   * to the model as-is so it can try something else. Lump them together and all the model
   * ever hears is "the tool is broken".
   */
  async call(name: string, args: unknown, options: RpcOptions = {}): Promise<McpCallResult> {
    const result = (await this.rpc.request("tools/call", { name, arguments: args ?? {} }, options)) as {
      content?: unknown
      isError?: unknown
      structuredContent?: unknown
    }

    const parts: string[] = []
    let nonText = 0
    for (const raw of Array.isArray(result?.content) ? result.content : []) {
      const block = raw as { type?: unknown; text?: unknown; resource?: { text?: unknown; uri?: unknown } }
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text)
        continue
      }
      // An embedded text resource is still text; use it if we can get it
      if (block.type === "resource" && typeof block.resource?.text === "string") {
        parts.push(String(block.resource.text))
        continue
      }
      nonText++
      parts.push(`[${typeof block.type === "string" ? block.type : "unknown"} content — alfa can only read text results]`)
    }

    // Some servers give only structuredContent and no content; don't lose their answer
    if (parts.length === 0 && result?.structuredContent !== undefined) {
      parts.push(JSON.stringify(result.structuredContent, null, 2))
    }

    return { text: parts.join("\n"), isError: result?.isError === true, nonText }
  }

  async close(): Promise<void> {
    await this.transport.close()
  }
}

export { RpcError }
