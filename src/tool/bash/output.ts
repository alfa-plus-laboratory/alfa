/**
 * Collecting and truncating command output.
 *
 * Three consumers, three budgets, don't merge them:
 *   - **The model**: the last 2000 lines / 50KB. The rest stays on disk for it to dig
 *     through itself with grep / read offset. This is the only copy that enters the LLM
 *     context.
 *   - **Disk**: the full output. Once it passes 50KB it switches to appending, so the file
 *     on disk is **always complete**.
 *   - **UI**: a 30KB rolling tail, only for live refresh, never enters the context.
 *
 * The ring buffer keeps 100KB (= 2× the model's budget) so that when "too many lines but
 * not too many bytes" we can still take the full last 2000 lines from memory.
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
  /** The text fed to the model (with the truncation note and on-disk path already added) */
  output: string
  truncated: boolean
  /** On-disk path of the full output; present only when truncation happened */
  outputPath?: string
  /** The rolling tail for the UI */
  preview: string
}

export class OutputCollector {
  private chunks: Array<{ text: string; size: number }> = []
  private used = 0
  /** Full accumulation while nothing has been written to disk yet */
  private full = ""
  private sink: WriteStream | undefined
  private file: string | undefined
  private cut = false

  constructor(private readonly id: string) {}

  push(text: string): void {
    if (text.length === 0) return

    const size = Buffer.byteLength(text, "utf8")

    // ── Ring buffer (serves the final return) ──
    this.chunks.push({ text, size })
    this.used += size
    while (this.used > RING_KEEP_BYTES && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.used -= dropped.size
      this.cut = true
    }

    // ── To disk (serves "the full output") ──
    if (this.sink) {
      this.sink.write(text)
      return
    }
    this.full += text
    if (Buffer.byteLength(this.full, "utf8") > MAX_BYTES) {
      this.file = join(toolOutputDir(), `tool_${this.id}.log`)
      // Everything before the switch point is written in one go, then appended — so the
      // file holds the complete output.
      //
      // ⚠ flags must be "w", not "a". The file name is determined by the callID, and
      //   callIDs repeat (across sessions, or a provider reusing ids); with "a" the new
      //   output gets appended after stale content, and the model reads garbage spliced
      //   from two runs. Upstream uses "a" because it assumes the file is necessarily new
      //   at the moment of writing — that assumption doesn't hold.
      this.sink = createWriteStream(this.file, { flags: "w" })
      this.sink.write(this.full)
      this.full = ""
      this.cut = true
    }
  }

  /** The rolling tail for the UI. */
  livePreview(): string {
    const text = this.chunks.map((c) => c.text).join("")
    if (text.length <= UI_PREVIEW_CHARS) return text
    return "…\n\n" + text.slice(-UI_PREVIEW_CHARS)
  }

  async finish(): Promise<CollectResult> {
    const raw = this.chunks.map((c) => c.text).join("")
    const trimmed = tail(raw, MAX_LINES, MAX_BYTES)
    let cut = this.cut || trimmed.truncated

    // Too many lines but not too many bytes → nothing was spilled to disk along the way, so
    // do it once here, otherwise the model has no way in to the full output
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
