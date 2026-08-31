/**
 * 一个 MCP server 的会话:握手 → 列工具 → 调工具 → 收摊。
 *
 * 这一层只管**协议上的一次对话**。谁去连、连不上怎么办、工具怎么变成 alfa 的
 * 工具,都在别处 —— 一个 client 只对应一个 server,不知道还有没有别人。
 */
import { JsonRpcClient, RpcError, type RpcOptions } from "./protocol.ts"
import type { Transport } from "./transport.ts"
import { VERSION } from "../update/release.ts"

/**
 * 我们声称说的版本。
 *
 * 握手时 server 会回它自己的那个,而**对不上不算失败**:tools/list 和 tools/call
 * 这两件事的形状在各版之间没有变过,为一个版本字符串拒绝对话,换来的是"这个
 * server 用不了"而不是"这个 server 少了点什么"。对不上只记一笔(见 protocolVersion)。
 */
const PROTOCOL_VERSION = "2025-06-18"

/** 握手和列工具都该很快。慢到这个份上多半是起错了东西,早点说比挂着强 */
const HANDSHAKE_TIMEOUT_MS = 30_000

export interface McpToolInfo {
  name: string
  title?: string
  description?: string
  /** 原样的 JSON Schema。**不转成 zod** —— 见 tools.ts 里那段 */
  inputSchema: unknown
}

export interface McpCallResult {
  /** 拼好的文本。非文本的内容块会被换成一行说明 */
  text: string
  /** server 自己说这次是失败的(不是协议错误,是工具执行失败) */
  isError: boolean
  /** 有多少块不是文本 —— UI 上要说得出"还有两张图没法看" */
  nonText: number
}

export class McpClient {
  private readonly rpc: JsonRpcClient
  private readonly transport: Transport
  readonly name: string
  /** server 自报的名字和版本。握手之后才有 */
  serverInfo: { name?: string; version?: string } = {}
  /** server 回的协议版本。和我们声称的不一样时,这个值是唯一的线索 */
  protocolVersion?: string
  private closedWhy: string | undefined

  constructor(name: string, transport: Transport) {
    this.name = name
    this.transport = transport
    this.rpc = new JsonRpcClient(transport, {
      timeoutMs: HANDSHAKE_TIMEOUT_MS,
      onNotification: () => {
        // 工具列表变了之类的通知先收着不做事。**动态换工具是要付代价的**:
        // 工具定义是 prompt 里最靠前的缓存前缀,聊到一半换一遍等于整段缓存作废。
        // 真要支持,该由上层在轮次之间决定重连,而不是在这儿随手改。
      },
    })
    transport.onClose((why) => {
      this.closedWhy = why
    })
  }

  /** 断了没有,以及为什么。UI 要说得出原因 */
  get closed(): string | undefined {
    return this.closedWhy
  }

  /**
   * 握手。
   *
   * 顺序是协议规定的:initialize 请求 → initialized 通知 → 之后才能干别的。
   * 少发那条通知,严格实现的 server 会拒掉后面每一个请求。
   */
  async initialize(options: RpcOptions = {}): Promise<void> {
    const result = (await this.rpc.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        // 我们不提供 sampling / roots / elicitation。空对象是**如实声明**:
        // 声称有而不实现,server 会发过来然后等一个永远不来的答复
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

    // ★ server 可以在这里回一段 `instructions`,而我们**故意不用它**。
    //   那是 server 作者写的字,拼进 system prompt 就等于让一个第三方往
    //   「只有用户的消息才是指令」那条线里塞东西(见 prompt/untrusted.ts)。
    //   它的工具说明照样会进 prompt,但那些是**挂在具体工具上**的,读起来是
    //   "这个工具怎么用",不是"你接下来该怎么做事"。

    this.rpc.notify("notifications/initialized")
  }

  /** 列工具。分页要跟到底 —— 只拿第一页的话,后面那些工具在模型眼里根本不存在 */
  async listTools(options: RpcOptions = {}): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    // 页数上限:防的是一个坏掉的 server 把 cursor 一直回给我们
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
   * 调一个工具。
   *
   * 两种失败要分开:协议层面的错(RpcError —— 名字不对、参数不合法)由调用方
   * 当异常处理;而 `isError: true` 是**工具自己跑失败了**,那是一条正常的结果,
   * 要原样交给模型让它换个做法。混成一种的话,模型收到的永远是"工具坏了"。
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
      // 嵌进来的文本资源照样是文本,拿得到就用
      if (block.type === "resource" && typeof block.resource?.text === "string") {
        parts.push(String(block.resource.text))
        continue
      }
      nonText++
      parts.push(`[${typeof block.type === "string" ? block.type : "unknown"} content — alfa can only read text results]`)
    }

    // 只给了 structuredContent 没给 content 的 server 是有的,别把它的答案丢掉
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
