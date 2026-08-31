/**
 * MCP 的工具 → alfa 的工具。
 *
 * 这一层做四件事,每一件都有一条不能省的理由:起名、透传形状、过门卫、装信封。
 */
import { z } from "zod"
import type { McpToolInfo } from "./client.ts"
import { envelope, sanitize, scanForInjection } from "../tool/untrusted.ts"
import type { ToolContext, ToolDef, ToolResult } from "../tool/types.ts"

/**
 * 工具名的合法字符。
 *
 * 不是我们的洁癖 —— OpenAI 那一侧的函数名就是 `^[a-zA-Z0-9_-]+$`,点号、斜杠、
 * 冒号一律不收。MCP 那边的名字什么都可能有,所以必须过一遍。
 */
const SAFE = /[^a-zA-Z0-9_-]/g

/** 各家对函数名长度的上限都在 64 附近,按最紧的那个来 */
const MAX_ID = 64

/**
 * 前缀。双下划线是因为它在 server 名和工具名里都会被上面那条规则挤掉,拿来当
 * 分隔符不会撞。
 *
 * 导出是因为它已经不只是个命名习惯了:上下文报告要靠它把「别人家的工具占了多少」
 * 从「我们自己的工具」里分出来(见 agent/context.ts)。两处各写一遍 "mcp__" 的话,
 * 哪天前缀改了,分栏会静悄悄地把所有 MCP 工具算回自己头上 —— 而那个数正是用户
 * 用来决定"要不要关掉一个 server"的依据。
 */
export const MCP_TOOL_PREFIX = "mcp__"

/**
 * server 的工具说明会原样进 prompt,而那是 server 作者写的字。
 *
 * 装不进信封(工具说明是结构的一部分,不是内容),所以退而求其次:洗掉隐形字符
 * 和伪造的标记(sanitize 干的就是这件事),再按长度截。一份三万字的"工具说明"
 * 本身就是一种攻击 —— 它挤掉的是别人的上下文。
 */
const MAX_DESCRIPTION = 4_000

/** 一次调用回来的文本上限。超了留头去尾并说明 —— 一个 list 类的工具能回几兆 */
const MAX_OUTPUT = 60_000

/**
 * 起名:`mcp__<server>__<tool>`。
 *
 * ── 为什么带前缀 ──
 * ① 不能和内建工具撞(一个叫 `read` 的 MCP 工具会顶掉我们自己的 read,而
 *    registry 那边是直接抛的);② 模型一眼看得出这一步**要离开这台机器**;
 * ③ 出问题时用户看到的名字里就写着是谁提供的。
 *
 * 截断从**工具名**那头下刀,前缀和 server 名留着:一串同名前缀的工具比一串
 * 认不出是谁家的工具好查。
 */
export function toolID(server: string, tool: string, taken?: Set<string>): string {
  const cleanServer = server.replace(SAFE, "_")
  const cleanTool = tool.replace(SAFE, "_")
  const head = `${MCP_TOOL_PREFIX}${cleanServer}__`
  let id = (head + cleanTool).slice(0, MAX_ID)

  if (taken) {
    // 撞名了往后加序号。截断和不同的原名都可能撞,而两个同名工具在模型眼里
    // 是同一个 —— 它会调对名字、干错事
    let n = 2
    while (taken.has(id)) {
      const suffix = `_${n++}`
      id = (head + cleanTool).slice(0, MAX_ID - suffix.length) + suffix
    }
    taken.add(id)
  }
  return id
}

/** 这个工具是不是某个 MCP server 给的 */
export function isMcpTool(id: string): boolean {
  return id.startsWith(MCP_TOOL_PREFIX)
}

/** 只认这一个方法,好在测试里换掉真的 client */
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
  /** 已经占掉的工具名。同一批一起转的时候传同一个 Set */
  taken?: Set<string>
}

/**
 * 参数的**本地**校验:一个宽松的兜底。
 *
 * 真正的形状交给 provider 的是 rawSchema(server 报什么就是什么),这里只保证
 * 落到 execute 手里的是个对象 —— 模型偶尔会把没有参数的调用发成 undefined。
 * 严格校验不该在这儿做第二遍:它和 server 的判断只要差一点,报出去的就是一个
 * server 自己都不认识的错。
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
    // 形状原样透传,不转 zod(理由见 tool/types.ts 的 rawSchema)
    rawSchema: info.inputSchema,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      /**
       * ★ 每一次都过门卫,而且**不看 server 说自己是只读的**。
       *
       * MCP 的 annotations 里有 readOnlyHint 这种字段,拿它当放行依据很诱人 ——
       * 但那是 server 自己填的,而门卫存在的意义正是"不信这一侧的说法"。一个
       * 声称只读的工具照样可以发邮件、改数据库、把仓库内容传出去。
       *
       * 权限键是 `mcp` 这一家、目标写成 `server/tool`:于是「以后不再问」既能
       * 点单个工具,也能用现成的通配写成 `github/*` —— 用户心里的单位是"这个
       * server",不是"这个函数"。
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
        // ★ 工具自己失败**不是**异常:它是一条正常的结果,模型要据此换个做法。
        //   混成异常的话,"参数写错了"和"这个 server 坏了"在它眼里长得一样
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

/** 一整个 server 的工具一起转 —— 同一批共用一个去重表 */
export function toToolDefs(server: string, tools: McpToolInfo[], caller: ToolCaller, taken?: Set<string>): ToolDef<any>[] {
  const seen = taken ?? new Set<string>()
  return tools.map((info) => toToolDef({ server, info, caller, taken: seen }))
}
