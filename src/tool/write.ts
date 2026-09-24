/**
 * The write tool: whole-file writes.
 *
 * Division of labor with edit: write is "I know what the whole file should look like",
 * edit is "change one stretch of it". Overwriting an existing file likewise produces a
 * diff and goes through approval — a whole-file overwrite is more dangerous than a
 * partial replacement, and must not be more lenient just because its interface is
 * simpler.
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
  decodeWithBom,
  detectLineEnding,
  normalizeLineEndings,
} from "./edit/line-ending.ts"
import type { ToolDef } from "./types.ts"

const Parameters = z.object({
  filePath: z.string().describe("Absolute or workspace-relative path to write"),
  content: z.string().describe("Full content of the file"),
})

type Args = z.infer<typeof Parameters>

const DESCRIPTION = `Writes a file to the local filesystem, creating parent directories as needed.

Usage rules:
- Overwrites the file completely. Overwriting an existing file you have not read in the current session is rejected, and so is overwriting one that changed on disk after you read it — otherwise you would silently destroy content you have not seen.
- Prefer the edit tool for changing part of an existing file. Use write for new files, or when you are intentionally replacing the whole thing.
- Never write documentation or README files unless the user explicitly asked for them.`

export const WriteTool: ToolDef<Args> = {
  id: "write",
  description: DESCRIPTION,
  parameters: Parameters,

  async execute(args, ctx) {
    if (!args.filePath) throw new Error("filePath is required")
    const path = await authorizePath(args.filePath, ctx, "write")

    return withFileLock(path, async () => {
      const exists = existsSync(path)
      if (exists && statSync(path).isDirectory()) {
        throw new Error(`Path is a directory, not a file: ${args.filePath}`)
      }
      // Overwriting deserves blocking even more than a partial replacement: what gets
      // lost here is every part of the **whole file** it hasn't seen, and lost without a
      // sound. See fs/freshness.ts
      if (exists) assertFresh(ctx.sessionID, path, args.filePath, "overwrite")

      const source = exists
        ? decodeWithBom(new Uint8Array(await Bun.file(path).arrayBuffer()))
        : { text: "", bom: "" }

      // An existing file keeps its line-ending style; a new file follows its own content
      const ending = exists ? detectLineEnding(source.text) : detectLineEnding(args.content)
      const oldLF = normalizeLineEndings(source.text)
      const newLF = normalizeLineEndings(args.content)

      if (exists && oldLF === newLF) {
        return {
          output: `No changes: ${args.filePath} already has this exact content.`,
          title: args.filePath,
          metadata: { truncated: false, filePath: path, additions: 0, deletions: 0 },
        }
      }

      const patch = createPatch(path, oldLF, newLF)
      const stat = diffStat(oldLF, newLF)

      await ctx.ask({
        permission: "edit", // key shared with edit: to the user both are "changing my files"
        patterns: [workspacePattern(path, ctx.root)],
        metadata: {
          filePath: path,
          diff: patch,
          preview: renderDiffPreview(patch),
          creating: !exists,
          ...stat,
        },
      })

      if (ctx.abortSignal.aborted) throw new Error("Write aborted before writing")

      if (!exists) await ensureDir(dirname(path))
      const finalText = bomJoin(convertToLineEnding(newLF, ending), source.bom)
      await Bun.write(path, finalText)
      // Once written, this is the latest content it has seen; a newly created file gets
      // stamped too, otherwise the edit that follows right after would say "you haven't
      // read this" — when it just wrote the thing with its own hands
      noteRead(ctx.sessionID, path)

      ctx.metadata({ filePath: path, diff: patch, ...stat })

      return {
        output: `Wrote ${Buffer.byteLength(finalText, "utf8")} bytes to ${args.filePath}`,
        title: `${args.filePath} (+${stat.additions} -${stat.deletions})`,
        metadata: { truncated: false, filePath: path, diff: patch, ...stat },
      }
    })
  },
}
