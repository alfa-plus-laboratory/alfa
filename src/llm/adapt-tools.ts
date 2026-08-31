/**
 * ToolDef → AI SDK ToolSet 的翻译层。
 *
 * 这是**唯一**同时认识两边的地方。src/tool 不认识 SDK,src/agent 也不认识,
 * 所以换 SDK(或者哪天不用 SDK 了)的代价被锁在这一个文件里。
 */
import { jsonSchema, tool, type ToolSet } from "ai"
import type { ZodError } from "zod"
import type { ToolContext, ToolDef } from "../tool/types.ts"

export interface AdaptOptions {
  tools: ToolDef<any>[]
  makeToolContext(call: { callID: string; abortSignal: AbortSignal }): ToolContext
}

/**
 * 校验失败的说法。**给模型看的**,所以要是一句它能照着补的话,而不是一段
 * zod 的结构化报错 —— 后者它得先猜一遍格式才知道自己漏了什么。
 */
function complaints(error: ZodError): string {
  const parts = error.issues.slice(0, 4).map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join(".") : "(root)"
    return issue.code === "invalid_type" && issue.input === undefined
      ? `${where} is required`
      : `${where}: ${issue.message}`
  })
  return `invalid arguments — ${parts.join("; ")}. Nothing ran; call it again with all required arguments.`
}

export function adaptTools(options: AdaptOptions): ToolSet {
  const entries = options.tools
    // ⚠ 必须排序。工具定义是 system prompt 之后最靠前的缓存前缀,
    //   顺序随注册代码变动就意味着 prompt cache 永远 miss。
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .map((def) => {
      const description = typeof def.description === "function" ? def.description() : def.description

      return [
        def.id,
        tool({
          description,
          // 自带 JSON Schema 的(MCP)原样送出去,不经过 zod 那一趟有损往返;
          // 其余的照旧由 SDK 从 zod 生成(见 tool/types.ts 的 rawSchema)
          inputSchema: def.rawSchema !== undefined ? (jsonSchema(def.rawSchema as never) as never) : (def.parameters as never),
          async execute(input, { toolCallId, abortSignal }) {
            // ★ 自己再校一遍参数。
            //
            // SDK 本来会按 inputSchema 校验,但这是**别人家的保证**:换个 SDK 版本、
            // 换个 provider 的函数调用格式,漏过来的就是一个 `{}`。那时候工具里
            // 那几句零散的 `if (!args.filePath)` 各说各话(有的抛、有的当默认值),
            // 而模型收到的是一句看不出该怎么补的错误。
            //
            // 在这儿统一挡一次,报出来的是"少了哪个字段" —— 模型能照着改的那种。
            const parsed = def.parameters.safeParse(input)
            if (!parsed.success) throw new Error(`${def.id}: ${complaints(parsed.error)}`)

            const ctx = options.makeToolContext({
              callID: toolCallId,
              abortSignal: abortSignal ?? new AbortController().signal,
            })
            const result = await def.execute(parsed.data, ctx)
            // 只有 output 回给模型。metadata 是给 UI 和存储的,不烧 token。
            //
            // ⚠ 但 metadata 必须**送出去**,不能算完就扔。SDK 的 tool-result 事件
            //   里只有字符串输出,diff / exitCode / outputPath 全在这里。丢掉的
            //   直接后果:edit 的 diff 永远打印不出来 —— 而 edit 默认 allow 正是
            //   以"改了什么当场看得见"为前提换来的,不打 diff 那个默认值就不成立了。
            ctx.metadata(result.metadata)
            return result.output
          },
        }),
      ] as const
    })

  return Object.fromEntries(entries)
}
