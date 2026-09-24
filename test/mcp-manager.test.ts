import { describe, expect, test } from "bun:test"
import { McpManager } from "../src/mcp/manager.ts"
import type { McpServerEntry } from "../src/mcp/config.ts"
import type { Transport } from "../src/mcp/transport.ts"

function entry(name: string, extra: Partial<McpServerEntry> = {}): McpServerEntry {
  return { name, command: "fake", origin: "global", source: "test", ...extra }
}

/**
 * A fake server that spawns no process: it answers JSON-RPC directly in memory.
 * Whether a process can start is not this layer's concern; what this layer checks is
 * "how much does one broken server cost".
 */
function fakeTransport(options: { tools?: string[]; failInitialize?: boolean; silent?: boolean } = {}): Transport {
  const messageHandlers: Array<(line: string) => void> = []
  const closeHandlers: Array<(why: string) => void> = []
  let closed = false
  return {
    send(line: string): void {
      if (options.silent) return // never replies: tests timeouts / hangs
      const message = JSON.parse(line) as { id?: number; method?: string }
      if (message.id === undefined) return
      const reply = (body: unknown): void => {
        queueMicrotask(() => {
          for (const handler of messageHandlers) handler(JSON.stringify(body))
        })
      }
      if (message.method === "initialize") {
        if (options.failInitialize) {
          reply({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "boom" } })
          return
        }
        reply({
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2025-06-18", serverInfo: { name: "fake", version: "1" } },
        })
        return
      }
      if (message.method === "tools/list") {
        reply({
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: (options.tools ?? ["one"]).map((name) => ({ name, inputSchema: {} })) },
        })
      }
    },
    onMessage(handler) {
      messageHandlers.push(handler)
    },
    onClose(handler) {
      closeHandlers.push(handler)
      if (closed) handler("closed")
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      for (const handler of closeHandlers) handler("closed")
    },
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30))
}

describe("McpManager", () => {
  test("once connected the tools are there, and the status says which server it is", async () => {
    const manager = new McpManager({
      root: process.cwd(),
      entries: [entry("alpha")],
      isTrusted: () => true,
      open: () => fakeTransport({ tools: ["search", "write_note"] }),
    })
    manager.start()
    await settle()

    expect(manager.tools().map((one) => one.id)).toEqual(["mcp__alpha__search", "mcp__alpha__write_note"])
    const status = manager.statuses()[0]
    expect(status?.state).toBe("ready")
    expect(status?.tools).toBe(2)
    expect(status?.server?.name).toBe("fake")
    await manager.close()
  })

  test("★ one broken server costs only a few tools", async () => {
    const manager = new McpManager({
      root: process.cwd(),
      entries: [entry("broken"), entry("fine")],
      isTrusted: () => true,
      open: (one) => fakeTransport(one.name === "broken" ? { failInitialize: true } : { tools: ["ok"] }),
    })
    manager.start()
    await settle()

    expect(manager.tools().map((one) => one.id)).toEqual(["mcp__fine__ok"])
    const broken = manager.statuses().find((one) => one.name === "broken")
    expect(broken?.state).toBe("failed")
    // the error has to say where to go fix it
    expect(broken?.why).toContain("test")
    await manager.close()
  })

  test("★ a server from the project starts no process until approved", async () => {
    let opened = 0
    const manager = new McpManager({
      root: process.cwd(),
      entries: [entry("fromRepo", { origin: "project", source: ".alfa/mcp.json" })],
      isTrusted: () => false,
      open: () => {
        opened++
        return fakeTransport()
      },
    })
    manager.start()
    await settle()

    expect(opened).toBe(0)
    expect(manager.statuses()[0]?.state).toBe("needs-approval")
    expect(manager.pending()).toHaveLength(1)
    expect(manager.tools()).toEqual([])

    // once approved, it connects right away
    expect(manager.approve("fromRepo")).toBe(true)
    await settle()
    expect(opened).toBe(1)
    expect(manager.statuses()[0]?.state).toBe("ready")
    await manager.close()
  })

  test("the global ones don't ask — the user wrote those in their own home directory", async () => {
    let opened = 0
    const manager = new McpManager({
      root: process.cwd(),
      entries: [entry("mine")],
      isTrusted: () => false,
      open: () => {
        opened++
        return fakeTransport()
      },
    })
    manager.start()
    await settle()
    expect(opened).toBe(1)
    await manager.close()
  })

  test("enabled: false means not connecting, and that's not a failure either", async () => {
    const manager = new McpManager({
      root: process.cwd(),
      entries: [entry("paused", { enabled: false })],
      isTrusted: () => true,
      open: () => fakeTransport(),
    })
    manager.start()
    await settle()
    expect(manager.statuses()[0]?.state).toBe("off")
    expect(manager.tools()).toEqual([])
    await manager.close()
  })

  test("same-named tools on two servers don't collapse into one", async () => {
    const manager = new McpManager({
      root: process.cwd(),
      entries: [entry("a"), entry("b")],
      isTrusted: () => true,
      open: () => fakeTransport({ tools: ["search"] }),
    })
    manager.start()
    await settle()
    const ids = manager.tools().map((one) => one.id)
    expect(new Set(ids).size).toBe(2)
    await manager.close()
  })

  test("start() returns immediately — a silent server must not hold up startup", async () => {
    const manager = new McpManager({
      root: process.cwd(),
      entries: [entry("slow")],
      isTrusted: () => true,
      open: () => fakeTransport({ silent: true }),
    })
    const before = Date.now()
    manager.start()
    expect(Date.now() - before).toBeLessThan(50)
    expect(manager.statuses()[0]?.state).toBe("connecting")
    await manager.close()
  })

  test("after close, the tools are gone", async () => {
    const manager = new McpManager({
      root: process.cwd(),
      entries: [entry("a")],
      isTrusted: () => true,
      open: () => fakeTransport(),
    })
    manager.start()
    await settle()
    expect(manager.tools()).toHaveLength(1)
    await manager.close()
    expect(manager.tools()).toEqual([])
  })
})
