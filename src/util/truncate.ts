/**
 * Two kinds of truncation, in different units; do not merge them:
 *
 * - tail()    counts **bytes**, for tool output the model sees. Command output can be
 *             tens of MB, and counting by character length badly underestimates the
 *             real token cost of multibyte text.
 * - preview() counts **characters**, only feeds the terminal UI, never enters the
 *             model's context.
 */

/** UTF-8 continuation byte: 0b10xxxxxx */
function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}

export interface TailResult {
  text: string
  truncated: boolean
  /** Original total line count (before truncation) */
  totalLines: number
  /** Original total byte count (before truncation) */
  totalBytes: number
}

/**
 * Keep the tail: truncate by lines first, then by bytes.
 *
 * The order matters — lines first, then bytes, so that the "line count within limit but
 * a single enormous line" case (say minified JS, or a blob of base64) is still stopped
 * by the byte gate.
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
    // Don't split a multibyte character down the middle: move forward to the next
    // character boundary
    while (start < buf.byteLength && isContinuation(buf[start]!)) start++
    buf = buf.subarray(start)
    text = buf.toString("utf8")
    truncated = true
  }

  return { text, truncated, totalLines, totalBytes }
}

/** Short preview for the terminal, truncated by character count, with an ellipsis if
 *  over. */
export function preview(text: string, maxChars: number): string {
  const flat = text.replace(/\r?\n/g, " ").trim()
  if (flat.length <= maxChars) return flat
  return flat.slice(0, Math.max(0, maxChars - 1)) + "…"
}

/** Hard truncation of a single line, for overlong lines in the read tool. */
export function clampLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line
  return line.slice(0, maxChars) + `... (line truncated, ${line.length} chars total)`
}
