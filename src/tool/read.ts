/**
 * read tool: turn a single file / single directory into controlled, line-numbered text.
 *
 * Three hard limits (whichever one triggers must tell the model "how to continue"; no
 * silent truncation):
 *   2000 lines / 2000 chars per line / 50KB total
 *
 * One easily overlooked difference between the branches:
 *   - When the **line** limit triggers, keep scanning the whole file — so that the total
 *     line count in the footer is real.
 *   - When the **byte** limit triggers, stop at once — 50KB has already been burned, and
 *     scanning on just to report a number isn't worth it.
 *
 * ⚠ metadata.truncated must be set explicitly. The global truncation wrapper above only
 *   steps in when it is undefined; setting it amounts to declaring "this tool manages its
 *   own limits", which avoids being truncated a second time.
 */
import { z } from "zod"
import { readdirSync, statSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import { authorizePath } from "../fs/guard.ts"
import { isBinaryFile } from "../fs/binary.ts"
import { noteRead } from "../fs/freshness.ts"
import { workspacePattern } from "../permission/pattern.ts"
import { inspectLocalText } from "./untrusted.ts"
import type { ToolDef } from "./types.ts"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = "50 KB"
const IMAGE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|avif)$/i

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
- Binary files are rejected. Do not try to read them. That includes images: an image the user attaches is already in their message, as an image.
- If the file does not exist, the error may suggest similarly named files in the same directory.`

export const ReadTool: ToolDef<Args> = {
  id: "read",
  description: DESCRIPTION,
  parameters: Parameters,

  async execute(args, ctx) {
    const path = await authorizePath(args.filePath, ctx, "read")
    const display = relative(ctx.root, path) || basename(path)

    // Allowed by default; only secret files inside the workspace (*.env / *.pem /
    // *id_rsa* …) pop a prompt
    await ctx.ask({ permission: "read", patterns: [workspacePattern(path, ctx.root)] })

    const stat = statOrUndefined(path)
    if (!stat) throw new Error(notFoundMessage(path))

    if (stat.isDirectory()) return readDirectory(path, display, args)
    // ★ An image gets its own sentence. The generic one sent the model off to decode the
    //   PNG in Python and compile a Swift OCR tool, for a picture the user had already
    //   attached to the message it was answering
    if (IMAGE.test(path)) throw new Error(`${args.filePath} is an image, and read returns text only. If the user attached it (named with @ or as a full path, or pasted with ctrl-v), it is already in their message as an image: look at it there. Otherwise ask the user to attach it.`)
    if (isBinaryFile(path)) throw new Error(`Cannot read binary file: ${args.filePath}`)

    // ★ The stamp is taken from **before the read**; for why, see noteRead in
    //   fs/freshness.ts
    const stamp = { mtimeMs: stat.mtimeMs, size: stat.size }
    const result = await readFile(path, display, args)
    // Record it only if the read succeeded — the offset-out-of-range path throws halfway,
    // and the model saw nothing
    noteRead(ctx.sessionID, path, stamp)
    return result
  },
}

// ────────────────────────────────────────────────── Directory branch

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

// ────────────────────────────────────────────────── File branch

async function readFile(path: string, display: string, args: Args) {
  const limit = args.limit ?? DEFAULT_READ_LIMIT
  const offset = args.offset ?? 1
  const start = offset - 1

  const raw: string[] = []
  let bytes = 0
  let count = 0
  /** Hit the byte limit */
  let cut = false
  /** There is more content left unread */
  let more = false

  outer: for await (const chunk of lines(path)) {
    count++
    if (count <= start) continue
    if (raw.length >= limit) {
      // Over the line limit but don't stop — keep counting to the end, so the total in the
      // footer is real
      more = true
      continue
    }
    const line =
      chunk.length > MAX_LINE_LENGTH
        ? chunk.slice(0, MAX_LINE_LENGTH) + `... (line truncated to ${MAX_LINE_LENGTH} chars)`
        : chunk
    const size = Buffer.byteLength(line, "utf8") + (raw.length > 0 ? 1 : 0)
    if (bytes + size > MAX_BYTES) {
      // Over the byte limit: stop at once, and count is no longer accurate from here on —
      // so the footer only says capped and reports no total
      cut = true
      more = true
      break outer
    }
    raw.push(line)
    bytes += size
  }

  // Empty file + offset=1 is legitimate; exempt it
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

  // ★ "Local" does not mean "written by the user". This file may be the README of a
  //   dependency npm install brought in, the root of a freshly cloned repo, a downloaded
  //   example — and the imperative sentences in it enter the same channel as what the
  //   user says. Only flag it, **never alter the content**: alter it and edit's oldString
  //   no longer matches the bytes on disk. See the asymmetry in the tool/untrusted.ts
  //   file header
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

/** Stream it line by line, so a large file never gets stuffed into memory whole. */
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

// ────────────────────────────────────────────────── Helpers

function statOrUndefined(path: string) {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}

/**
 * When the file isn't found, give the model three similar names.
 *
 * Deliberately cheap: same directory, substring both ways, case-insensitive, at most 3.
 * No edit distance — the model's mistake is usually "misremembered the extension /
 * plural", and substring is enough for that.
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
    // The directory itself doesn't exist; no suggestions to give
  }
  if (suggestions.length === 0) return `File not found: ${path}`
  return `File not found: ${path}\n\nDid you mean one of these?\n${suggestions.join("\n")}`
}
