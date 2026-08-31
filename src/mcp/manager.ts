/**
 * 一场会话里所有 MCP server 的总管:谁连上了、谁没连上、工具从哪来、退出时谁负责杀。
 *
 * ── 一条贯穿始终的原则:一个 server 出问题,代价必须是「少几个工具」 ──
 * 不是启动变慢,不是报一屏错,更不是起不来。MCP server 是别人写的程序,由用户的
 * 配置文件指定 —— 它拼错了命令、装丢了依赖、连不上自己的后端,都是常态。所以
 * 连接一律在后台跑,失败原样记下来给 `/mcp` 看,主流程一步都不等。
 */
import { toToolDefs } from "./tools.ts"
import { McpClient } from "./client.ts"
import { stdioTransport, type Transport } from "./transport.ts"
import type { McpServerEntry } from "./config.ts"
import type { ToolDef } from "../tool/types.ts"
import { logger } from "../util/log.ts"

const log = logger("mcp")

/**
 * 「这个来自项目的 server 可以起」这条许可的权限键。
 *
 * 借的是「以后不再问」那套现成的落盘(按工作区分开、只存 allow)—— 它问的正是
 * 同一类问题:这台机器上的这个仓库,用户点过什么头。另起一个存储只会多一处
 * 要各自维护的真值。和调用工具那条权限(`mcp`)分开:一个管"能不能起这个进程",
 * 一个管"能不能干这件事"。
 */
export const MCP_SERVER_PERMISSION = "mcp-server"

export type McpState =
  /** 配置里写着 enabled: false */
  | "off"
  /** 来自项目、用户还没点头。**没有起过任何进程** */
  | "needs-approval"
  | "connecting"
  | "ready"
  | "failed"

export interface McpStatus {
  name: string
  origin: McpServerEntry["origin"]
  source: string
  state: McpState
  /** ready 时有几个工具 */
  tools: number
  /** failed 时为什么 */
  why?: string
  /** server 自报的名字和版本 */
  server?: { name?: string; version?: string }
}

export interface ManagerDeps {
  root: string
  entries: McpServerEntry[]
  /**
   * 这个来自项目的 server 用户点过头没有。
   *
   * ★ 只对 project 来路的问。全局那份是用户自己写在家目录里的,再问一遍是把
   *   "他自己做过的决定"当成"别人的输入"。
   */
  isTrusted(entry: McpServerEntry): boolean
  /** 换掉传输,给测试用 */
  open?(entry: McpServerEntry, root: string): Transport
  /** 有 server 的状态变了(连上了/挂了)。界面据此重画 */
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
  /** 全场共用一张已占用的工具名表 —— 两个 server 各有一个 `search` 是常事 */
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
   * 开始连。**立刻返回** —— 每个 server 各连各的,一个慢的不拖住其它的,
   * 更不拖住用户敲第一句话。
   */
  start(): void {
    for (const slot of this.slots.values()) {
      if (slot.state === "connecting") void this.connect(slot)
    }
  }

  /** 现在能用的工具。没连上的 server 就是没有工具,不是报错的工具 */
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

  /** 有没有等着用户点头的。启动横幅要据此提一句 */
  pending(): McpStatus[] {
    return this.statuses().filter((one) => one.state === "needs-approval")
  }

  /**
   * 用户点头了:现在就连。
   *
   * 落盘由调用方负责(`src/mcp` 不该知道许可存在哪个文件里)—— 这里只管
   * "从这一刻起它可以连了"。
   */
  approve(name: string): boolean {
    const slot = this.slots.get(name)
    if (!slot || slot.state !== "needs-approval") return false
    slot.state = "connecting"
    void this.connect(slot)
    return true
  }

  /** 收摊:把所有子进程连着子孙一起杀掉。**必须等** —— 见 M30 那次孤儿进程 */
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
      // 报出来的话要**说得出下一步去改哪儿** —— 用户手里只有一个"它没出现"
      slot.why = `${(error as Error).message} (defined in ${entry.source})`
      slot.tools = []
      try {
        await slot.client?.close()
      } catch {
        // 连都没连上,收尸失败无所谓
      }
      log.warn("connect failed", { server: entry.name, why: slot.why })
    }
    this.deps.onChange?.()
  }
}
