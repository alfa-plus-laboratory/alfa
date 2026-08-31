/**
 * read 工具:把单文件 / 单目录变成带行号的受控文本。
 *
 * 三重硬上限(任何一条触发都要告诉模型「怎么继续」,不能静默截断):
 *   2000 行 / 单行 2000 字符 / 总计 50KB
 *
 * 一个容易忽略的分支差异:
 *   - **行数**上限触发时,继续扫完整个文件 —— 为了尾注里的总行数是真的。
 *   - **字节**上限触发时,立刻停 —— 已经烧掉 50KB 了,再扫下去只为报个数字不值。
 *
 * ⚠ metadata.truncated 必须显式设置。上层的全局截断包装器只在它为 undefined
 *   时才介入,设了就等于声明「这个工具自管上限」,避免被二次截断。
 */
import { z } from "zod"
import { readdirSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { assertInsideWorkspace } from "../fs/guard.ts"
import { isBinaryFile } from "../fs/binary.ts"
import { noteRead } from "../fs/freshness.ts"
import { workspacePattern } from "../permission/pattern.ts"
import { inspectLocalText } from "./untrusted.ts"
import type { ToolDef } from "./types.ts"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = "50 KB"

const Parameters = z.object({
  filePath: z.string().describe("The path to the file or directory to read"),
  offset: z.number().int().min(1).optional().describe("The line number to start reading from (1-indexed)"),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`The maximum number of lines to read (defaults to ${DEFAULT_READ_LIMIT})`),
})

type Args = z.infer<typeof Parameters>

const DESCRIPTION = `Reads a file from the local filesystem, or lists a directory when given a directory path.

Usage rules:
- Read whole files. Do not read a narrow 30-line window and guess at the rest; you will miss context and make bad edits. Use offset/limit only for files too large to read at once.
- Output lines are prefixed with "N: ". That prefix is display only — never include it in edit's oldString.
- Reading a directory lists its entries; subdirectories are suffixed with "/".
- Binary files are rejected. Do not try to read them.
- If the file does not exist, the error may suggest similarly named files in the same directory.`

export const ReadTool: ToolDef<Args> = {
  id: "read",
  description: DESCRIPTION,
  parameters: Parameters,

  async execute(args, ctx) {
    const path = assertInsideWorkspace(args.filePath, { cwd: ctx.cwd, root: ctx.root })
    const display = relative(ctx.root, path) || basename(path)

    // 默认放行,只有工作区内的密钥文件(*.env / *.pem / *id_rsa* …)会弹窗
    await ctx.ask({ permission: "read", patterns: [workspacePattern(path, ctx.root)] })

    const stat = statOrUndefined(path)
    if (!stat) throw new Error(notFoundMessage(path))

    if (stat.isDirectory()) return readDirectory(path, display, args)
    if (isBinaryFile(path)) throw new Error(`Cannot read binary file: ${args.filePath}`)

    // ★ 印记取**读之前**这一份,理由见 fs/freshness.ts 的 noteRead
    const stamp = { mtimeMs: stat.mtimeMs, size: stat.size }
    const result = await readFile(path, display, args)
    // 读成功才记账 —— offset 越界那条路抛在半道上,模型什么也没看到
    noteRead(ctx.sessionID, path, stamp)
    return result
  },
}

// ────────────────────────────────────────────────── 目录分支

function readDirectory(path: string, display: string, args: Args) {
  const entries = readdirSync(path, { withFileTypes: true })
    .map((entry) => {
      if (entry.isDirectory()) return entry.name + "/"
      if (entry.isSymbolicLink()) {
        const target = statOrUndefined(join(path, entry.name))
        return target?.isDirectory() ? entry.name + "/" : entry.name
      }
      return entry.name
    })
    .sort((a, b) => a.localeCompare(b))

  const limit = args.limit ?? DEFAULT_READ_LIMIT
  const offset = args.offset ?? 1
  const start = offset - 1
  const sliced = entries.slice(start, start + limit)
  const truncated = start + sliced.length < entries.length

  const footer = truncated
    ? `(Showing ${sliced.length} of ${entries.length} entries. Use 'offset' parameter to read beyond entry ${offset + sliced.length})`
    : `(${entries.length} entries)`

  return Promise.resolve({
    output: [`<path>${path}</path>`, `<type>directory</type>`, `<entries>`, sliced.join("\n"), "", footer, `</entries>`].join(
      "\n",
    ),
    title: display + "/",
    metadata: {
      truncated,
      preview: sliced.slice(0, 20).join("\n"),
      entries: entries.length,
    },
  })
}

// ────────────────────────────────────────────────── 文件分支

async function readFile(path: string, display: string, args: Args) {
  const limit = args.limit ?? DEFAULT_READ_LIMIT
  const offset = args.offset ?? 1
  const start = offset - 1

  const raw: string[] = []
  let bytes = 0
  let count = 0
  /** 撞到字节上限 */
  let cut = false
  /** 还有更多内容没读 */
  let more = false

  outer: for await (const chunk of lines(path)) {
    count++
    if (count <= start) continue
    if (raw.length >= limit) {
      // 行数超了但不停 —— 继续数完,尾注里的总行数才是真的
      more = true
      continue
    }
    const line =
      chunk.length > MAX_LINE_LENGTH
        ? chunk.slice(0, MAX_LINE_LENGTH) + `... (line truncated to ${MAX_LINE_LENGTH} chars)`
        : chunk
    const size = Buffer.byteLength(line, "utf8") + (raw.length > 0 ? 1 : 0)
    if (bytes + size > MAX_BYTES) {
      // 字节超了立刻停,count 从此不再准确 —— 所以尾注只说 capped,不报总数
      cut = true
      more = true
      break outer
    }
    raw.push(line)
    bytes += size
  }

  // 空文件 + offset=1 是合法的,豁免掉
  if (count < offset && !(count === 0 && offset === 1)) {
    throw new Error(`Offset ${offset} is out of range for this file (${count} lines)`)
  }

  const last = offset + raw.length - 1
  const next = last + 1
  const footer = cut
    ? `(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${offset}-${last}. Use offset=${next} to continue.)`
    : more
      ? `(Showing lines ${offset}-${last} of ${count}. Use offset=${next} to continue.)`
      : `(End of file - total ${count} lines)`

  const body = raw.map((line, i) => `${i + offset}: ${line}`).join("\n")

  // ★ 「本地」不等于「用户写的」。这个文件可能是 npm install 装进来的依赖的
  //   README、刚 clone 的仓库根目录、下载下来的示例 —— 而里面的祈使句会和
  //   用户说的话进同一个通道。只标记,**绝不改动内容**:改了的话 edit 的
  //   oldString 从此对不上盘上的字节。见 tool/untrusted.ts 文件头那条不对称
  const warning = inspectLocalText(raw.join("\n"))

  return {
    output: [
      `<path>${path}</path>`,
      `<type>file</type>`,
      ...warning,
      `<content>`,
      body,
      "",
      footer,
      `</content>`,
    ].join("\n"),
    title: display,
    metadata: {
      truncated: more || cut,
      preview: raw.slice(0, 20).join("\n"),
      lines: raw.length,
      ...(warning.length > 0 ? { flagged: true } : {}),
    },
  }
}

/** 流式按行读,避免把整个大文件塞进内存。 */
async function* lines(path: string): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8")
  let buffer = ""
  for await (const chunk of Bun.file(path).stream()) {
    buffer += decoder.decode(chunk, { stream: true })
    let index: number
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      yield line.endsWith("\r") ? line.slice(0, -1) : line
    }
  }
  buffer += decoder.decode()
  if (buffer.length > 0) yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer
}

// ────────────────────────────────────────────────── 辅助

function statOrUndefined(path: string) {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}

/**
 * 找不到文件时给模型三个相近的名字。
 *
 * 刻意做得便宜:同目录、双向 substring、大小写不敏感、最多 3 条。
 * 不做编辑距离 —— 模型的错误通常是「记错了扩展名/复数」,substring 够用。
 */
function notFoundMessage(path: string): string {
  const dir = dirname(path)
  const base = basename(path).toLowerCase()
  let suggestions: string[] = []
  try {
    suggestions = readdirSync(dir)
      .filter((item) => {
        const lower = item.toLowerCase()
        return lower.includes(base) || base.includes(lower)
      })
      .map((item) => join(dir, item))
      .slice(0, 3)
  } catch {
    // 目录本身都不存在,没建议可给
  }
  if (suggestions.length === 0) return `File not found: ${path}`
  return `File not found: ${path}\n\nDid you mean one of these?\n${suggestions.join("\n")}`
}

/** 供 grep fallback 复用的路径归一。 */
export function resolveSearchPath(input: string | undefined, cwd: string): string {
  if (!input) return cwd
  return isAbsolute(input) ? resolve(input) : resolve(cwd, input)
}
