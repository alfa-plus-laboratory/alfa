import { describe, expect, test } from "bun:test"
import { McpManager } from "../src/mcp/manager.ts"
import type { McpServerEntry } from "../src/mcp/config.ts"
import type { Transport } from "../src/mcp/transport.ts"

function entry(name: string, extra: Partial<McpServerEntry> = {}): McpServerEntry {
  return { name, command: "fake", origin: "global", source: "test", ...extra }
}

/**
 * 一个不起进程的假 server:直接在内存里答 JSON-RPC。
 * 起不起得来进程不是这一层要验的事,这一层要验的是「一个坏掉的 server 值多少代价」。
 */
function fakeTransport(options: { tools?: string[]; failInitialize?: boolean; silent?: boolean } = {}): Transport {
  const messageHandlers: Array<(line: string) => void> = []
  const closeHandlers: Array<(why: string) => void> = []
  let closed = false
  return {
    send(line: string): void {
      if (options.silent) return // 永远不回:验超时/挂住
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

describe("总管", () => {
  test("连上之后工具就在了,状态说得出是谁", async () => {
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

  test("★ 一个 server 挂了,代价只是少几个工具", async () => {
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
    // 报错要说得出去哪儿改
    expect(broken?.why).toContain("test")
    await manager.close()
  })

  test("★ 来自项目的 server 没点头就一个进程都不起", async () => {
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

    // 点头之后当场连上
    expect(manager.approve("fromRepo")).toBe(true)
    await settle()
    expect(opened).toBe(1)
    expect(manager.statuses()[0]?.state).toBe("ready")
    await manager.close()
  })

  test("全局那份不问 —— 那是用户自己写在家目录里的", async () => {
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

  test("enabled: false 就是不连,也不算失败", async () => {
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

  test("两个 server 各有一个同名工具,不会撞成一个", async () => {
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

  test("start() 立刻返回 —— 一个不吭声的 server 不该拖住启动", async () => {
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

  test("收摊之后工具就没了", async () => {
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
