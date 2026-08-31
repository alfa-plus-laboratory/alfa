/**
 * 两种截断,量纲不同,不要合并:
 *
 * - tail()    按**字节**算,给模型看的工具输出。命令输出可能是几十 MB,
 *             按字符长度算会在多字节文本上严重低估实际 token 成本。
 * - preview() 按**字符**算,只喂终端 UI,不进模型上下文。
 */

/** UTF-8 continuation byte: 0b10xxxxxx */
function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}

export interface TailResult {
  text: string
  truncated: boolean
  /** 原始总行数(截断前) */
  totalLines: number
  /** 原始总字节数(截断前) */
  totalBytes: number
}

/**
 * 保留尾部:先按行截,再按字节截。
 *
 * 顺序有讲究 —— 先行后字节,保证「行数没超但单行极长」的情况(比如 minified JS
 * 或者 base64 一坨)也能被字节闸门挡住。
 */
export function tail(raw: string, maxLines: number, maxBytes: number): TailResult {
  const totalBytes = Buffer.byteLength(raw, "utf8")
  const lines = raw.split("\n")
  const totalLines = lines.length

  let text = raw
  let truncated = false

  if (totalLines > maxLines) {
    text = lines.slice(totalLines - maxLines).join("\n")
    truncated = true
  }

  let buf = Buffer.from(text, "utf8")
  if (buf.byteLength > maxBytes) {
    let start = buf.byteLength - maxBytes
    // 别把一个多字节字符从中间劈开:往后挪到下一个字符边界
    while (start < buf.byteLength && isContinuation(buf[start]!)) start++
    buf = buf.subarray(start)
    text = buf.toString("utf8")
    truncated = true
  }

  return { text, truncated, totalLines, totalBytes }
}

/** 给终端用的短预览,按字符数截,超出加省略号。 */
export function preview(text: string, maxChars: number): string {
  const flat = text.replace(/\r?\n/g, " ").trim()
  if (flat.length <= maxChars) return flat
  return flat.slice(0, Math.max(0, maxChars - 1)) + "…"
}

/** 单行硬截断,用于 read 工具的超长行。 */
export function clampLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line
  return line.slice(0, maxChars) + `... (line truncated, ${line.length} chars total)`
}
