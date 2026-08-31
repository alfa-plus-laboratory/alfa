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

describe("配置:全局 + 项目", () => {
  test("两边都读,同名时项目那份赢", () => {
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

  test("★ 来路必须带着走 —— 放行决定要靠它", () => {
    const root = workspace({ servers: { sneaky: { command: "curl" } } })
    const { servers } = loadMcpConfig({ globalSource: "g", root })
    expect(servers[0]?.origin).toBe("project")
    expect(servers[0]?.source).toContain(".alfa")
  })

  test("${VAR} 展开;缺变量是错误,不是空字符串", () => {
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

  test("写坏的配置只是少一个 server,不是起不来", () => {
    const root = workspace({ servers: { noCommand: { args: ["x"] }, ok: { command: "fine" } } })
    const { servers, problems } = loadMcpConfig({ globalSource: "g", root })
    expect(servers.map((one) => one.name)).toEqual(["ok"])
    expect(problems).toHaveLength(1)
    expect(problems[0]?.why).toContain("command")
  })

  test("整份文件不是 JSON:报一句人话,全局那半照常用", () => {
    const root = workspace("{ this is not json")
    const { servers, problems } = loadMcpConfig({
      global: { g: { command: "still-here" } },
      globalSource: "g",
      root,
    })
    expect(servers.map((one) => one.name)).toEqual(["g"])
    expect(problems[0]?.why).toContain("not valid JSON")
  })

  test("没有项目文件时就只有全局那半", () => {
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
 * 货架:定义在全局、点名才连。
 *
 * ★ 这一层的**全部**安全论证是「只能点名,不能定义」:项目文件里出现的是一个
 *   字符串,要跑的那条命令写在用户自己家目录里。所以从货架点到的那些不需要
 *   `/mcp trust`,而一个陌生仓库能造成的最坏结果是点到一个你没有的名字。
 *   下面每条测的都是这句话的一半。
 */
describe("货架:mcp.library + use", () => {
  const library = { "db-prod": { command: "pg-mcp" }, scratch: { command: "s" } }

  test("点了名的连上,来路是 library,而且**不要 trust**", () => {
    const root = workspace({ use: ["db-prod"] })
    const { servers, problems, shelf } = loadMcpConfig({ library, globalSource: "g", root })
    expect(problems).toEqual([])
    expect(servers.map((one) => one.name)).toEqual(["db-prod"])
    expect(servers[0]!.origin).toBe("library")
    // ★ 来路不是 project,所以 manager 那边不会把它挂成 needs-approval
    expect(servers[0]!.origin).not.toBe("project")
    // 没点名的那个一个字都不发,只在货架清单里露个名字
    expect(shelf).toEqual(["scratch"])
  })

  test("★ 没点名的货架条目绝不自动连 —— 那是它和 mcp.servers 的唯一区别", () => {
    const { servers, shelf } = loadMcpConfig({ library, globalSource: "g", root: workspace() })
    expect(servers).toEqual([])
    expect(shelf).toEqual(["db-prod", "scratch"])
  })

  test("点到一个货架上没有的名字:报出来,而不是连一个空的", () => {
    const root = workspace({ use: ["nope"] })
    const { servers, problems } = loadMcpConfig({ library, globalSource: "g", root })
    expect(servers).toEqual([])
    expect(problems).toHaveLength(1)
    // 修法是往全局补定义,不是改仓库里这个文件 —— 报错要说得出这一点
    expect(problems[0]!.why).toContain("mcp.library")
    expect(problems[0]!.name).toBe("nope")
  })

  test("项目自己定义的照旧是 project(照旧要 trust),同名时它赢", () => {
    const root = workspace({ use: ["db-prod"], servers: { "db-prod": { command: "mine" } } })
    const { servers } = loadMcpConfig({ library, globalSource: "g", root })
    expect(servers).toHaveLength(1)
    // ★ 项目那份赢,而它**会**过 trust —— 所以没有"用 use 绕过审批"这条路
    expect(servers[0]!.origin).toBe("project")
    expect(servers[0]!.command).toBe("mine")
  })

  test("只写 use、不写 servers 是合法的;两个都没有才报", () => {
    const onlyUse = loadMcpConfig({ library, globalSource: "g", root: workspace({ use: [] }) })
    expect(onlyUse.problems).toEqual([])
    const neither = loadMcpConfig({ globalSource: "g", root: workspace({ other: 1 }) })
    expect(neither.problems[0]!.why).toContain('neither a "servers" nor a "use" key')
  })
})

describe("会话:握手、列工具、调工具", () => {
  test("握手拿到 serverInfo,并且分页的第二页也在", async () => {
    const { client, close } = connect()
    try {
      await client.initialize()
      expect(client.serverInfo.name).toBe("fake")
      expect(client.protocolVersion).toBe("2025-06-18")

      const tools = await client.listTools()
      expect(tools.map((one) => one.name)).toEqual(["echo", "second_page_tool"])
      // JSON Schema 原样留着,不转 zod
      expect((tools[0]?.inputSchema as { properties?: unknown })?.properties).toBeDefined()
    } finally {
      await close()
    }
  }, 20_000)

  test("调用:文本回来,工具自己失败是结果不是异常", async () => {
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

  test("非文本内容不静悄悄丢掉,数得出有几块", async () => {
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

  test("协议层的错抛出来,和「工具失败」分得开", async () => {
    const { client, close } = connect()
    try {
      await client.initialize()
      await expect(client.call("nope", {})).rejects.toThrow(/Unknown tool/)
    } finally {
      await close()
    }
  }, 20_000)

  test("超时:不会挂着,而且说得出是哪个方法", async () => {
    const { client, close } = connect()
    try {
      await client.initialize()
      await expect(client.call("hangs", {}, { timeoutMs: 300 })).rejects.toThrow(/tools\/call timed out/)
    } finally {
      await close()
    }
  }, 20_000)

  test("server 死了之后,挂着的请求立刻被拒 —— 不是永远不 settle", async () => {
    const { client, close } = connect()
    await client.initialize()
    // 先把拒绝接住再关 —— 否则那一拒发生在没人 await 的瞬间,算未处理拒绝
    const pending = client.call("hangs", {}, { timeoutMs: 20_000 }).then(
      () => undefined,
      (error: Error) => error,
    )
    await close()
    const error = await pending
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain("closed")
  }, 20_000)

  test("stdout 里混进一行垃圾、server 主动发请求,都不会让连接倒下", async () => {
    const { client, close } = connect()
    try {
      await client.initialize()
      // fixture 在 initialized 之后既发了非 JSON 的一行,也发了一个我们不支持的请求
      await Bun.sleep(150)
      const ok = await client.call("echo", { text: "still alive" })
      expect(ok.text).toBe("still alive")
      expect(client.closed).toBeUndefined()
    } finally {
      await close()
    }
  }, 20_000)
})
