/**
 * Streaming UTF-8 decoding of child-process output.
 *
 * ── ★ One per stream; **two streams must never share one** ──
 * A multibyte character gets split down the middle by the pipe: "你" is the three bytes
 * `e4 bd a0`, and a 64 KB pipe boundary landing inside it is routine. `TextDecoder`'s
 * `{ stream: true }` exists for exactly this — it keeps the half-character state **in
 * the decoder** and stitches it together when the next chunk arrives.
 *
 * ⚠ So that "kept in the decoder" becomes a bug when stdout and stderr share a decoder:
 *
 *     stdout: e4 bd      ← the decoder is holding half a "你"
 *     stderr: "ERR\n"    ← decoded with the same decoder, the half character becomes
 *                          its prefix
 *     stdout: a0         ← the byte that arrives next no longer has a home
 *
 *   What comes out is `<?>ERR<?>` instead of "你". **Both streams are dirtied**, and
 *   dirtied in a spot that has nothing to do with either one's content.
 *
 *   This isn't a corner case: any build tool that writes progress to stderr while the
 *   other side outputs CJK text (webpack, vite, gradle, cargo under a Chinese locale)
 *   will hit it.
 *
 * ── Why not `String(chunk)` / `chunk.toString()` ──
 * Those two decode **one-shot**, with no cross-chunk state: each side of the split
 * character gets a U+FFFD, silently. It looks "cleaner" than a shared decoder, but it
 * is really the same bug written another way — it just never spreads the error to the
 * other stream.
 */

/**
 * Make a decode function that belongs to **one** stream only.
 *
 * Call once per stream:
 *
 *     proc.stdout?.on("data", pump(streamDecoder()))
 *     proc.stderr?.on("data", pump(streamDecoder()))
 */
export function streamDecoder(): (chunk: Buffer | string) => string {
  const decoder = new TextDecoder("utf-8")
  // If it's already a string, don't run it through the decoder again — that would
  // decode it a second time as latin-1 bytes. A child process should only hand over
  // Buffers, but the stream's encoding can have been set from outside
  return (chunk) => (typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }))
}
