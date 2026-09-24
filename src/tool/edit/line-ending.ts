/**
 * Detecting / restoring line endings and the BOM.
 *
 * Three pitfalls:
 * 1. BOM — the default TextDecoder **swallows** U+FEFF: invisible when read in, lost when
 *    written back, and in a Windows team's repo that turns into a whole-file diff.
 *    { ignoreBOM: true } is a must.
 * 2. Line endings — which line ending the model's oldString/newString use is out of our
 *    control. The strategy: normalize everything to LF for matching, and expand back to
 *    **the file's original style** when writing. One vote per file: a single CRLF anywhere
 *    and the whole file is treated as CRLF (a file with mixed endings ought to be unified
 *    anyway).
 * 3. **Non-UTF-8** — see decodeWithBomStrict. A caller that **changes one part and writes
 *    back the whole file** (edit) must use the strict one, otherwise every invalid byte in
 *    the file gets replaced with U+FFFD on the way back.
 */

export const BOM = "﻿"

export interface BomSplit {
  text: string
  bom: string
}

/** Strip the leading BOM and return the two separately. */
export function bomSplit(input: string): BomSplit {
  return input.startsWith(BOM) ? { text: input.slice(BOM.length), bom: BOM } : { text: input, bom: "" }
}

export function bomJoin(text: string, bom: string): string {
  if (!bom) return text
  return text.startsWith(BOM) ? text : bom + text
}

/**
 * Decode file bytes in a way that keeps the BOM visible. **Lenient** — invalid bytes
 * become U+FFFD.
 *
 * Only for uses like "compute a diff of the old content for a human to look at" (the write
 * tool: it overwrites the whole file, and writes back nothing it failed to understand).
 * Anything that will **write the decoded result back to the file** uses the strict one
 * below, no exceptions.
 */
export function decodeWithBom(bytes: Uint8Array): BomSplit {
  return bomSplit(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes))
}

/** The file is not valid UTF-8. Thrown when edit refuses to go any further */
export class NotUtf8Error extends Error {
  constructor(display: string) {
    super(
      `${display} is not valid UTF-8, so edit cannot safely modify it. ` +
        `Editing decodes the whole file, replaces in text, and writes the whole file back — ` +
        `every byte it could not decode would be replaced with U+FFFD, including on lines this edit does not touch. ` +
        `Do not retry this edit. Tell the user the file's encoding needs converting first (e.g. iconv), or use a shell command that works on bytes.`,
    )
    this.name = "NotUtf8Error"
  }
}

/**
 * Strict decoding: throws if it isn't valid UTF-8.
 *
 * ★ Why edit must use this ──
 *   edit's shape is "decode the whole file → replace within the string → write the whole
 *   file back". Lenient decoding turns every invalid byte into U+FFFD, and on write-back
 *   they are stored as the bytes of U+FFFD — **the original bytes are gone for good**.
 *   What's more:
 *
 *   - `fs/binary.ts` counts bytes ≥0x80 as printable, so Latin-1 / Shift-JIS / GBK files
 *     pass read and the freshness check, and the model sees nothing wrong at all;
 *   - the destroyed bytes are often **on lines the edit never touched**;
 *   - the approval diff is computed from the **decoded** text, so that damage is
 *     **invisible** on the approval screen.
 *
 *   All three together = an edit that looks perfectly normal quietly corrupting another
 *   part of the file. So this fails closed: better to refuse the edit than to guess the
 *   user's encoding.
 */
export function decodeWithBomStrict(bytes: Uint8Array, display: string): BomSplit {
  let text: string
  try {
    text = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(bytes)
  } catch {
    throw new NotUtf8Error(display)
  }
  return bomSplit(text)
}

export type LineEnding = "\n" | "\r\n"

/** One vote per file: any CRLF at all means CRLF. */
export function detectLineEnding(content: string): LineEnding {
  return content.includes("\r\n") ? "\r\n" : "\n"
}

export function normalizeLineEndings(content: string): string {
  return content.replaceAll("\r\n", "\n")
}

export function convertToLineEnding(content: string, ending: LineEnding): string {
  const lf = normalizeLineEndings(content)
  return ending === "\n" ? lf : lf.replaceAll("\n", "\r\n")
}
