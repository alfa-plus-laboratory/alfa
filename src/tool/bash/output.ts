/**
 * 命令输出的收集与截断。
 *
 * 三个消费者,三套预算,别合并:
 *   - **模型**:尾部 2000 行 / 50KB。超出的部分留在磁盘上,让它自己用
 *     grep / read offset 去挖。这是唯一进 LLM 上下文的那份。
 *   - **磁盘**:完整输出。一旦超过 50KB 就转成追加写,所以落盘文件**永远是全的**。
 *   - **UI**:30KB 滚动尾巴,只用于实时刷新,不进上下文。
 *
 * 环形缓冲留 100KB(= 2×模型预算),是为了「行数超限但字节没超」时还能
 * 从内存里取到完整的尾部 2000 行。
 */
import { createWriteStream, type WriteStream } from "node:fs"
import { join } from "node:path"
import { toolOutputDir } from "../../util/xdg.ts"
import { tail } from "../../util/truncate.ts"

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
const RING_KEEP_BYTES = MAX_BYTES * 2
const UI_PREVIEW_CHARS = 30_000

export interface CollectResult {
  /** 喂给模型的文本(已加截断说明与落盘路径) */
  output: string
  truncated: boolean
  /** 完整输出的落盘路径,仅在发生截断时存在 */
  outputPath?: string
  /** 给 UI 的滚动尾巴 */
  preview: string
}

export class OutputCollector {
  private chunks: Array<{ text: string; size: number }> = []
  private used = 0
  /** 尚未落盘时的完整积累 */
  private full = ""
  private sink: WriteStream | undefined
  private file: string | undefined
  private cut = false

  constructor(private readonly id: string) {}

  push(text: string): void {
    if (text.length === 0) return

    const size = Buffer.byteLength(text, "utf8")

    // ── 环形缓冲(服务于最终返回)──
    this.chunks.push({ text, size })
    this.used += size
    while (this.used > RING_KEEP_BYTES && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.used -= dropped.size
      this.cut = true
    }

    // ── 落盘(服务于「完整输出」)──
    if (this.sink) {
      this.sink.write(text)
      return
    }
    this.full += text
    if (Buffer.byteLength(this.full, "utf8") > MAX_BYTES) {
      this.file = join(toolOutputDir(), `tool_${this.id}.log`)
      // 切换点之前的部分一次性写入,之后追加 —— 保证文件里是完整输出。
      //
      // ⚠ flags 必须是 "w" 不是 "a"。文件名由 callID 决定,而 callID 会重复
      //   (跨会话、或 provider 复用 id),用 "a" 的话新输出会追加在陈旧内容
      //   后面,模型读到的是两次运行拼起来的垃圾。上游用 "a" 是因为假设落盘
      //   那刻文件必然是新的 —— 这个假设不成立。
      this.sink = createWriteStream(this.file, { flags: "w" })
      this.sink.write(this.full)
      this.full = ""
      this.cut = true
    }
  }

  /** 给 UI 的滚动尾巴。 */
  livePreview(): string {
    const text = this.chunks.map((c) => c.text).join("")
    if (text.length <= UI_PREVIEW_CHARS) return text
    return "…\n\n" + text.slice(-UI_PREVIEW_CHARS)
  }

  async finish(): Promise<CollectResult> {
    const raw = this.chunks.map((c) => c.text).join("")
    const trimmed = tail(raw, MAX_LINES, MAX_BYTES)
    let cut = this.cut || trimmed.truncated

    // 行数超限但字节没超 → 中途没触发落盘,这里补一次,否则模型拿不到完整输出的入口
    if (cut && !this.file) {
      this.file = join(toolOutputDir(), `tool_${this.id}.log`)
      await Bun.write(this.file, raw)
    }

    if (this.sink) {
      const sink = this.sink
      await new Promise<void>((resolve) => sink.end(resolve))
      this.sink = undefined
    }

    let output = trimmed.text
    if (cut && this.file) {
      output =
        `...output truncated...\n\n` +
        `Full output saved to: ${this.file}\n` +
        `Use grep to search it, or read with offset/limit to view specific sections. ` +
        `Do NOT read the whole file — it is large on purpose.\n\n` +
        output
    }

    return {
      output,
      truncated: cut,
      outputPath: cut ? this.file : undefined,
      preview: this.livePreview(),
    }
  }
}
