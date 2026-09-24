/**
 * One native patch operation uses the same path authorization, session freshness, lock,
 * and human diff approval as edit/write. The SDK adapter lives in llm, never here.
 *
 * ★ The lock covers preflight through approval and commit, but external editors do not
 * share our mutex. Recheck both identity and exact bytes after approval, then commit with
 * no asynchronous gap. Updates stage in a sibling file and rename so write failure cannot
 * leave half a file. Native calls are single-file transactions, not a multi-file batch.
 * Existing symlinks resolve to their authorized target; a changed target aborts. Moves,
 * binary text and fuzzy hunks are unsupported rather than silently approximated.
 * Replacement preserves Unix owner/group and rwx mode; extended attributes/ACLs are not
 * copied by rename. There is no cross-process filesystem compare-and-swap: the final
 * synchronous checks narrow races but cannot lock out an unrelated OS process.
 */
import { z } from "zod"
import { lstatSync, readFileSync, writeFileSync, renameSync, linkSync, unlinkSync, chmodSync, chownSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { ensureDirSync } from "../fs/dir.ts"
import { authorizePath, canonicalPath } from "../fs/guard.ts"
import { assertFresh, noteRead } from "../fs/freshness.ts"
import { withFileLock } from "../fs/mutex.ts"
import { workspacePattern } from "../permission/pattern.ts"
import { createPatch, diffStat, renderDiffPreview } from "./edit/diff.ts"
import { bomJoin, convertToLineEnding, decodeWithBomStrict, detectLineEnding, normalizeLineEndings } from "./edit/line-ending.ts"
import { applyV4A } from "./patch/v4a.ts"
import type { ToolDef } from "./types.ts"

const Parameters = z.object({
  callId: z.string(),
  operation: z.discriminatedUnion("type", [
    z.object({ type: z.literal("create_file"), path: z.string().min(1), diff: z.string() }).strict(),
    z.object({ type: z.literal("update_file"), path: z.string().min(1), diff: z.string() }).strict(),
    z.object({ type: z.literal("delete_file"), path: z.string().min(1) }).strict(),
  ]),
})

export const ApplyPatchTool: ToolDef<z.infer<typeof Parameters>> = {
  id: "apply_patch",
  description: "Apply one create_file, update_file, or delete_file operation using a V4A diff. Read existing files first in this session; unread or stale files are rejected. Update hunks require unique exact context, not line numbers. Create diffs use '+' prefixed lines. File moves and multi-file patch wrappers are unsupported. Every operation uses file authorization and diff approval.",
  parameters: Parameters,
  async execute(input, ctx) {
    const { operation } = Parameters.parse(input)
    const authorized = await authorizePath(operation.path, ctx, "write")
    const path = canonicalPath(authorized)
    const execute = async () => {
      const creating = operation.type === "create_file"
      const stat = (() => {
        try { return lstatSync(path) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
          throw error
        }
      })()
      if (creating && stat) throw new Error(`Cannot create ${operation.path}: the file already exists`)
      if (!creating && !stat) throw new Error(`File not found: ${operation.path}`)
      if (stat && (!stat.isFile() || stat.nlink > 1)) throw new Error(`apply_patch requires a regular file without hard links: ${operation.path}`)
      if (!creating) assertFresh(ctx.sessionID, authorized, operation.path, "edit")
      const snapshot = creating ? undefined : readFileSync(path)
      const source = snapshot ? decodeWithBomStrict(snapshot, operation.path) : { text: "", bom: "" }
      if (source.text.includes("\u0000")) throw new Error("apply_patch only supports text files without NUL bytes")
      const before = normalizeLineEndings(source.text)
      const after = operation.type === "delete_file" ? "" : applyV4A(before, operation.diff, creating)
      const patch = createPatch(path, before, after)
      const stats = diffStat(before, after)
      await ctx.ask({
        permission: "edit",
        patterns: [workspacePattern(path, canonicalPath(ctx.root))],
        metadata: { filePath: path, diff: patch, preview: renderDiffPreview(patch), creating, deleting: operation.type === "delete_file", ...stats },
      })
      if (ctx.abortSignal.aborted) throw new Error("Patch aborted before writing")
      // Authorize the original spelling again: a directory symlink may have moved during approval.
      const checked = await authorizePath(operation.path, ctx, "write")
      if (canonicalPath(checked) !== path) throw new Error("Patch target changed during approval; read it again")
      if (ctx.abortSignal.aborted) throw new Error("Patch aborted before writing")
      if (creating) {
        ensureDirSync(dirname(path))
        if (canonicalPath(checked) !== path) throw new Error("Patch target changed while creating its parent directory")
      }
      if (!creating) {
        assertFresh(ctx.sessionID, authorized, operation.path, "edit")
        const current = lstatSync(path)
        if (!current.isFile() || current.ino !== stat!.ino || current.dev !== stat!.dev || current.mode !== stat!.mode || current.uid !== stat!.uid || current.gid !== stat!.gid || current.nlink !== stat!.nlink || !readFileSync(path).equals(snapshot!)) {
          throw new Error("File changed during patch approval; read it again")
        }
      }
      const text = bomJoin(convertToLineEnding(after, detectLineEnding(source.text)), source.bom)
      if (operation.type === "delete_file") {
        unlinkSync(path)
      } else {
        const temporary = join(dirname(path), `.alfa-patch-${randomUUID()}.tmp`)
        try {
          writeFileSync(temporary, text, { flag: "wx", mode: stat ? stat.mode & 0o777 : 0o666 })
          if (stat) {
            const staged = lstatSync(temporary)
            if (staged.uid !== stat.uid || staged.gid !== stat.gid) chownSync(temporary, stat.uid, stat.gid)
            chmodSync(temporary, stat.mode & 0o777)
          }
          // Linking is exclusive: even a late concurrent creator cannot be overwritten.
          if (creating) linkSync(temporary, path)
          else renameSync(temporary, path)
        } finally {
          if (existsSync(temporary)) unlinkSync(temporary)
        }
      }
      if (operation.type !== "delete_file") {
        noteRead(ctx.sessionID, authorized)
        if (authorized !== path) noteRead(ctx.sessionID, path)
      }
      ctx.metadata({ filePath: path, diff: patch, ...stats })
      return {
        output: `${operation.type === "create_file" ? "Created" : operation.type === "delete_file" ? "Deleted" : "Updated"} ${operation.path}`,
        title: `${operation.path} (+${stats.additions} -${stats.deletions})`,
        metadata: { truncated: false, filePath: path, diff: patch, ...stats },
      }
    }
    // edit/write lock the authorized spelling; also lock the target to serialize aliases.
    return authorized === path
      ? withFileLock(path, execute)
      : withFileLock(authorized, () => withFileLock(path, execute))
  },
}
