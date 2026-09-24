import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpClient } from "../src/mcp/client.ts"
import { loadMcpConfig, PROJECT_MCP_PATH, type McpServerEntry } from "../src/mcp/config.ts"
import { stdioTransport } from "../src/mcp/transport.ts"

const FIXTURE = join(import.meta.dir, "fixtures", "mcp-server.ts")

const temps: string[] = []
function workspace(mcpJson?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "apc-mcp-"))
  temps.push(root)
  if (mcpJson !== undefined) {
    mkdirSync(join(root, ".alfa"), { recursive: true })
    writeFileSync(
      join(root, PROJECT_MCP_PATH),
      typeof mcpJson === "string" ? mcpJson : JSON.stringify(mcpJson),
    )
  }
  return root
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("config: global + project", () => {
  test("both are read; on a name clash the project one wins", () => {
    const root = workspace({ servers: { db: { command: "project-db" }, extra: { command: "only-here" } } })
    const { servers, problems } = loadMcpConfig({
      global: { db: { command: "global-db" }, shared: { command: "global-shared" } },
      globalSource: "~/.config/alfa/config.json",
      root,
    })
    expect(problems).toEqual([])
    expect(servers.map((one) => one.name)).toEqual(["db", "extra", "shared"])
    const db = servers.find((one) => one.name === "db")
    expect(db?.command).toBe("project-db")
    expect(db?.origin).toBe("project")
    expect(servers.find((one) => one.name === "shared")?.origin).toBe("global")
  })

  test("★ origin travels with each server — the allow decision depends on it", () => {
    const root = workspace({ servers: { sneaky: { command: "curl" } } })
    const { servers } = loadMcpConfig({ globalSource: "g", root })
    expect(servers[0]?.origin).toBe("project")
    expect(servers[0]?.source).toContain(".alfa")
  })

  test("${VAR} expands; a missing variable is an error, not an empty string", () => {
    const root = workspace({
      servers: {
        good: { command: "run", args: ["--token", "${MY_TOKEN}"], env: { KEY: "${MY_TOKEN}" } },
        bad: { command: "run", args: ["${NOT_SET_ANYWHERE}"] },
      },
    })
    const { servers, problems } = loadMcpConfig({ globalSource: "g", root, env: { MY_TOKEN: "s3cret" } })
    expect(servers.map((one) => one.name)).toEqual(["good"])
    expect(servers[0]?.args).toEqual(["--token", "s3cret"])
    expect(servers[0]?.env).toEqual({ KEY: "s3cret" })
    expect(problems[0]?.name).toBe("bad")
    expect(problems[0]?.why).toContain("NOT_SET_ANYWHERE")
  })

  test("a broken entry costs one server, not startup", () => {
    const root = workspace({ servers: { noCommand: { args: ["x"] }, ok: { command: "fine" } } })
    const { servers, problems } = loadMcpConfig({ globalSource: "g", root })
    expect(servers.map((one) => one.name)).toEqual(["ok"])
    expect(problems).toHaveLength(1)
    expect(problems[0]?.why).toContain("command")
  })

  test("a file that isn't JSON: one readable error, and the global half still works", () => {
    const root = workspace("{ this is not json")
    const { servers, problems } = loadMcpConfig({
      global: { g: { command: "still-here" } },
      globalSource: "g",
      root,
    })
    expect(servers.map((one) => one.name)).toEqual(["g"])
    expect(problems[0]?.why).toContain("not valid JSON")
  })

  test("without a project file, only the global half", () => {
    const { servers, problems } = loadMcpConfig({ global: { g: { command: "x" } }, globalSource: "g", root: workspace() })
    expect(servers).toHaveLength(1)
    expect(problems).toEqual([])
  })
})

function connect(mode = "normal"): { client: McpClient; close: () => Promise<void> } {
  const entry: McpServerEntry = {
    name: "fake",
    command: "bun",
    args: [FIXTURE, mode],
    origin: "global",
    source: "test",
  }
  const transport = stdioTransport(entry, process.cwd())
  const client = new McpClient(entry.name, transport)
  return { client, close: () => client.close() }
}

/**
 * The shelf: defined globally, connected only when named.
 *
 * ★ The **entire** security argument of this layer is "you can only name, not define":
 *   what appears in the project file is a string, and the command that actually runs is
 *   written in the user's own home directory. That's why servers picked off the shelf
 *   don't need `/mcp trust`, and the worst a strange repo can do is name something you
 *   don't have. Each test below checks one half of that sentence.
 */
describe("shelf: mcp.library + use", () => {
  const library = { "db-prod": { command: "pg-mcp" }, scratch: { command: "s" } }

  test("a named entry connects with origin library and **needs no trust**", () => {
    const root = workspace({ use: ["db-prod"] })
    const { servers, problems, shelf } = loadMcpConfig({ library, globalSource: "g", root })
    expect(problems).toEqual([])
    expect(servers.map((one) => one.name)).toEqual(["db-prod"])
    expect(servers[0]!.origin).toBe("library")
    // ★ its origin isn't project, so the manager won't park it as needs-approval
    expect(servers[0]!.origin).not.toBe("project")
    // the unnamed one sends nothing at all; it only shows its name in the shelf list
    expect(shelf).toEqual(["scratch"])
  })

  test("★ unnamed shelf entries never auto-connect — the one difference from mcp.servers", () => {
    const { servers, shelf } = loadMcpConfig({ library, globalSource: "g", root: workspace() })
    expect(servers).toEqual([])
    expect(shelf).toEqual(["db-prod", "scratch"])
  })

  test("naming something not on the shelf is reported, not connected as an empty entry", () => {
    const root = workspace({ use: ["nope"] })
    const { servers, problems } = loadMcpConfig({ library, globalSource: "g", root })
    expect(servers).toEqual([])
    expect(problems).toHaveLength(1)
    // the fix is adding a definition globally, not editing this file in the repo — the
    // error has to say so
    expect(problems[0]!.why).toContain("mcp.library")
    expect(problems[0]!.name).toBe("nope")
  })

  test("a project's own definition stays project (still needs trust) and wins on a name clash", () => {
    const root = workspace({ use: ["db-prod"], servers: { "db-prod": { command: "mine" } } })
    const { servers } = loadMcpConfig({ library, globalSource: "g", root })
    expect(servers).toHaveLength(1)
    // ★ the project's copy wins, and it **does** go through trust — so there's no "use
    // `use` to bypass approval" route
    expect(servers[0]!.origin).toBe("project")
    expect(servers[0]!.command).toBe("mine")
  })

  test("use without servers is valid; only having neither is reported", () => {
    const onlyUse = loadMcpConfig({ library, globalSource: "g", root: workspace({ use: [] }) })
    expect(onlyUse.problems).toEqual([])
    const neither = loadMcpConfig({ globalSource: "g", root: workspace({ other: 1 }) })
    expect(neither.problems[0]!.why).toContain('neither a "servers" nor a "use" key')
  })
})

describe("session: handshake, list tools, call tools", () => {
  test("the handshake gets serverInfo, and the second page of tools is there too", async () => {
    const { client, close } = connect()
    try {
      await client.initialize()
      expect(client.serverInfo.name).toBe("fake")
      expect(client.protocolVersion).toBe("2025-06-18")

      const tools = await client.listTools()
      expect(tools.map((one) => one.name)).toEqual(["echo", "second_page_tool"])
      // JSON Schema kept as is, not converted to zod
      expect((tools[0]?.inputSchema as { properties?: unknown })?.properties).toBeDefined()
    } finally {
      await close()
    }
  }, 20_000)

  test("call: text comes back; a tool's own failure is a result, not an exception", async () => {
    const { client, close } = connect()
    try {
      await client.initialize()
      const ok = await client.call("echo", { text: "hello mcp" })
      expect(ok.text).toBe("hello mcp")
      expect(ok.isError).toBe(false)

      const bad = await client.call("fails", {})
      expect(bad.isError).toBe(true)
      expect(bad.text).toContain("the tool itself failed")
    } finally {
      await close()
    }
  }, 20_000)

  test("non-text content isn't silently dropped; its block count is reported", async () => {
    const { client, close } = connect()
    try {
      await client.initialize()
      const result = await client.call("picture", {})
      expect(result.nonText).toBe(1)
      expect(result.text).toContain("alfa can only read text")
    } finally {
      await close()
    }
  }, 20_000)

  test("protocol errors are thrown, kept distinct from 'tool failed'", async () => {
    const { client, close } = connect()
    try {
      await client.initialize()
      await expect(client.call("nope", {})).rejects.toThrow(/Unknown tool/)
    } finally {
      await close()
    }
  }, 20_000)

  test("timeout: doesn't hang, and names the method", async () => {
    const { client, close } = connect()
    try {
      await client.initialize()
      await expect(client.call("hangs", {}, { timeoutMs: 300 })).rejects.toThrow(/tools\/call timed out/)
    } finally {
      await close()
    }
  }, 20_000)

  test("once the server dies, pending requests are rejected at once — not left unsettled forever", async () => {
    const { client, close } = connect()
    await client.initialize()
    // catch the rejection before closing — otherwise it happens at a moment when nobody
    // is awaiting, and counts as an unhandled rejection
    const pending = client.call("hangs", {}, { timeoutMs: 20_000 }).then(
      () => undefined,
      (error: Error) => error,
    )
    await close()
    const error = await pending
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain("closed")
  }, 20_000)

  test("a garbage line on stdout or a server-initiated request doesn't bring the connection down", async () => {
    const { client, close } = connect()
    try {
      await client.initialize()
      // after initialized, the fixture sent both a non-JSON line and a request we don't
      // support
      await Bun.sleep(150)
      const ok = await client.call("echo", { text: "still alive" })
      expect(ok.text).toBe("still alive")
      expect(client.closed).toBeUndefined()
    } finally {
      await close()
    }
  }, 20_000)
})
