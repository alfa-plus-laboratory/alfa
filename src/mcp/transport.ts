/**
 * 和一个 MCP server 之间的**管子**:一行一条 JSON,进和出。
 *
 * 传输被做成接口而不是直接写死 stdio,理由不是抽象洁癖 —— 是这条路上迟早要接
 * 远端的 server(HTTP)。真到那天,换的是这个文件里多一个实现,protocol.ts 和
 * client.ts 一个字都不用动:它们只认「能发一行、能收一行、会关」。
 */
import { spawn, type ChildProcess } from "node:child_process"
import { buildChildEnv } from "../env/whitelist.ts"
import { killGroup } from "../tool/bash/kill.ts"
import { logger } from "../util/log.ts"
import type { McpServerEntry } from "./config.ts"

const log = logger("mcp")

export interface Transport {
  /** 发一行(不带换行,由实现补) */
  send(line: string): void
  /** 收到一行完整的消息 */
  onMessage(handler: (line: string) => void): void
  /**
   * 管子断了。参数是一句能说给人听的原因。
   *
   * ★ 可以挂**多个**,一个都不能少。这条路上至少有两位听众:JsonRpcClient 要把
   *   挂着的请求全部拒掉,McpClient 要记下"为什么断的"给界面看。写成"只留最后
   *   一个"的后果不是少一条通知 —— 是那些 Promise 永远不会 settle,而等它的人
   *   会一直等下去(测试里就是整个测试进程挂住不退)。
   */
  onClose(handler: (why: string) => void): void
  /** 关掉。已经关了要能重复调 */
  close(): Promise<void>
}

/**
 * stdio 传输:起一个子进程,拿它的 stdin/stdout 当管子。
 *
 * ── 三件必须做对的事 ──
 *
 * ① **server 的 stderr 一个字都不许上终端。** 它们几乎都往 stderr 打启动日志,
 *    而全屏界面是个差分合成器 —— 一行不经过它的输出就把整帧撕开,而且屏幕不会
 *    自己恢复(这个洞刚在 b193c6d 修过一次,来源是 Node 的告警)。所以 stderr
 *    整条进日志文件。
 *
 * ② **必须能连着子孙一起杀。** MCP server 常常是 `npx …`,真正干活的是它孙子那
 *    一层;只杀直接子进程留下的是一个没人管的常驻进程 —— 而它比 alfa 活得还久
 *    (935c0d0 那次孤儿进程烧掉四百多个 CPU 小时,教训就在这儿)。所以 POSIX 上
 *    起独立进程组,关的时候走 bash 那套已经验过的 killGroup:进程树怎么杀干净
 *    这件事只该有一份实现。
 *
 * ③ **一行是一条消息,而一行可能分几次到。** stdout 是字节流,没有"消息"这个
 *    概念:一条 JSON 可能被切成三个 chunk,也可能三条挤在一个 chunk 里。所以
 *    这里自己攒缓冲、按 \n 切。
 */
export function stdioTransport(entry: McpServerEntry, root: string): Transport {
  const proc: ChildProcess = spawn(entry.command, entry.args ?? [], {
    cwd: entry.cwd ?? root,
    // ★ 走门卫,不是 `{...process.env}`。
    //
    //   MCP server 的常态是 `npx some-mcp-server` —— 一份别人写的、这台机器上
    //   刚下下来的代码。透传全环境等于把 ANTHROPIC_API_KEY、ALFA_KEY_*、AWS_*、
    //   GITHUB_TOKEN 一起交给它,而它一件也不需要。
    //   env/whitelist.ts 的文件头正是拿这个场景当存在理由的,这里一度是全仓
    //   唯一没走它的 spawn。
    //
    //   entry.env 排在后面,所以 config 里显式写的(含 `${VAR}` 展开)照旧生效 ——
    //   那正是"给这个 server 它需要的那一个 token"的正路。
    env: { ...buildChildEnv().env, ...entry.env },
    stdio: ["pipe", "pipe", "pipe"],
    // Windows 上 detached 是另一个意思(开新控制台窗口),那边靠 taskkill /T 收树
    detached: process.platform !== "win32",
    windowsHide: true,
  })

  const messageHandlers: Array<(line: string) => void> = []
  const closeHandlers: Array<(why: string) => void> = []
  let closed: string | undefined
  /** 已经动手杀过了。和 closed 分开:进程自己先死了之后,close() 照旧要收尸 */
  let killed = false
  let buffer = ""

  const finish = (why: string): void => {
    if (closed) return
    closed = why
    for (const handler of closeHandlers) handler(why)
  }

  proc.stdout?.setEncoding("utf8")
  proc.stdout?.on("data", (chunk: string) => {
    buffer += chunk
    let at = buffer.indexOf("\n")
    while (at >= 0) {
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      if (line.length > 0) for (const handler of messageHandlers) handler(line)
      at = buffer.indexOf("\n")
    }
  })

  proc.stderr?.setEncoding("utf8")
  proc.stderr?.on("data", (chunk: string) => {
    // 进日志,不上屏。出问题时"当时 server 在 stderr 上说了什么"是第一手材料
    log.warn(`${entry.name} stderr`, { text: chunk.trimEnd().slice(-2000) })
  })

  // spawn 本身失败(命令不存在是最常见的一种)。这条要说得出是哪个 server、
  // 哪条命令 —— 用户下一步要去改的正是那一行配置
  proc.on("error", (error: Error) => finish(`could not start "${entry.command}" — ${error.message}`))
  proc.on("close", (code, signal) => {
    const how = signal ? `killed by ${signal}` : `exited with code ${code ?? "null"}`
    finish(`the server process ${how}`)
  })

  return {
    send(line: string): void {
      if (closed) throw new Error(`mcp server "${entry.name}" is not running`)
      proc.stdin?.write(line + "\n")
    },
    onMessage(handler) {
      messageHandlers.push(handler)
    },
    onClose(handler) {
      closeHandlers.push(handler)
      // 挂之前就已经死了的,补一次 —— 否则调用方会等一个永远不来的通知
      if (closed) handler(closed)
    },
    async close(): Promise<void> {
      // ★ 主动关也要走 finish。对面正在等的那些请求分不出"它自己死了"和"我们
      //   把它关了" —— 两种情况下它们都不会有答案,而不通知的结果是它们永远
      //   挂着。收摊时挂住的进程,查起来比任何一种报错都贵。
      const first = !killed
      killed = true
      finish("the connection to the server was closed")
      if (!first) return
      try {
        proc.stdin?.end()
      } catch {
        // 已经断了就算了,下面照样要杀
      }
      await killGroup(proc)
    },
  }
}
