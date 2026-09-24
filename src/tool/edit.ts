/**
 * edit tool.
 *
 * Structure: validate args → file lock → read → match → build diff → request
 * authorization → write to disk. Authorization **must** happen inside the lock — otherwise
 * B has already changed the file while the user is looking at A's diff, and writing back
 * after approval is a lost update based on stale content.
 */
import { z } from "zod"
import { existsSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { ensureDir } from "../fs/dir.ts"
import { assertFresh, noteRead } from "../fs/freshness.ts"
import { authorizePath } from "../fs/guard.ts"
import { withFileLock } from "../fs/mutex.ts"
import { workspacePattern } from "../permission/pattern.ts"
import { createPatch, diffStat, renderDiffPreview } from "./edit/diff.ts"
import {
  bomJoin,
  convertToLineEnding,
  decodeWithBomStrict,
  detectLineEnding,
  normalizeLineEndings,
} from "./edit/line-ending.ts"
import { replace } from "./edit/replace.ts"
import type { ToolDef } from "./types.ts"

const Parameters = z.object({
  filePath: z.string().describe("Absolute or workspace-relative path to the file to modify"),
  oldString: z.string().describe("The exact text to replace. Must be empty only when creating a new file."),
  newString: z.string().describe("The text to replace it with. Must differ from oldString."),
  replaceAll: z.boolean().optional().describe("Replace every occurrence instead of requiring a unique match"),
})

type Args = z.infer<typeof Parameters>

const DESCRIPTION = `Performs an exact-with-fallback string replacement in a single file.

Usage rules:
- Always read the file first, in the current session. Editing a file you have not read is rejected, and so is editing one that changed on disk after you read it — in both cases, read it (again) and redo the edit against what is actually there.
- Do NOT include the "12: " line-number prefixes that the read tool adds. Pass the raw file text only.
- oldString must uniquely identify the text to change. Include 3-5 lines of surrounding context when the snippet alone is ambiguous, otherwise the edit is rejected with "multiple matches".
- Set replaceAll to change every occurrence (useful for renaming a symbol).
- To create a new file, pass an empty oldString. This fails if the file already exists.
- Prefer several focused edits over one giant edit; each one is verified independently.`

export const EditTool: ToolDef<Args> = {
  id: "edit",
  description: DESCRIPTION,
  parameters: Parameters,

  async execute(args, ctx) {
    if (!args.filePath) throw new Error("filePath is required")
    // Order matters: identical must be checked first, otherwise
    // {oldString:"", newString:""} reports the wrong error
    if (args.oldString === args.newString) {
      throw new Error("No changes to apply: oldString and newString are identical.")
    }

    const path = await authorizePath(args.filePath, ctx, "write")

    return withFileLock(path, async () => {
      const creating = args.oldString === ""

      if (creating && existsSync(path)) {
        throw new Error(
          "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
        )
      }
      if (!creating) {
        if (!existsSync(path)) throw new Error(`File ${args.filePath} not found`)
        if (statSync(path).isDirectory()) throw new Error(`Path is a directory, not a file: ${args.filePath}`)
        // Inside the lock, before reading the disk: if it was never read / changed after
        // being read, the fuzzy cascade below will "make do" with a match on a similar but
        // wrong spot, without any error. See fs/freshness.ts
        assertFresh(ctx.sessionID, path, args.filePath, "edit")
      }

      const source = creating
        ? { text: "", bom: "" }
        : decodeWithBomStrict(new Uint8Array(await Bun.file(path).arrayBuffer()), args.filePath)

      const ending = creating ? detectLineEnding(args.newString) : detectLineEnding(source.text)
      const oldLF = normalizeLineEndings(source.text)

      let newLF: string
      let replacements = 1
      let replacerIndex = -1
      if (creating) {
        newLF = normalizeLineEndings(args.newString)
      } else {
        const result = replace(
          oldLF,
          normalizeLineEndings(args.oldString),
          normalizeLineEndings(args.newString),
          args.replaceAll ?? false,
        )
        newLF = result.content
        replacements = result.replacements
        replacerIndex = result.replacerIndex
      }

      const patch = createPatch(path, oldLF, newLF)
      const stat = diffStat(oldLF, newLF)

      await ctx.ask({
        permission: "edit",
        // Relative path — an absolute path makes rules like "*.env" silently stop working,
        // see permission/pattern.ts
        patterns: [workspacePattern(path, ctx.root)],
        metadata: {
          filePath: path,
          diff: patch,
          preview: renderDiffPreview(patch),
          creating,
          ...stat,
        },
      })

      if (ctx.abortSignal.aborted) throw new Error("Edit aborted before writing")

      if (creating) await ensureDir(dirname(path))
      await Bun.write(path, bomJoin(convertToLineEnding(newLF, ending), source.bom))
      // What was just written is the latest content it has "seen". Without re-stamping,
      // when it edits the same file twice in a row, the second cut gets ruled stale by its
      // own first cut
      noteRead(ctx.sessionID, path)

      ctx.metadata({ filePath: path, diff: patch, ...stat })

      const summary = creating
        ? `Created ${args.filePath}`
        : `Edit applied successfully.${replacements > 1 ? `\nReplacements: ${replacements}` : ""}`

      // Reserved hook for LSP diagnostics. Always empty in the first version — once wired
      // up, append here
      //   `\n\nLSP errors detected in this file, please fix:\n<diagnostics ...>`
      const block = ""

      return {
        output: summary + block,
        title: `${args.filePath} (+${stat.additions} -${stat.deletions})`,
        metadata: {
          truncated: false,
          filePath: path,
          diff: patch,
          replacements,
          replacerIndex,
          ...stat,
        },
      }
    })
  },
}
