/**
 * write 工具:整文件写入。
 *
 * 与 edit 的分工:write 是「我知道整个文件该长什么样」,edit 是「改其中一段」。
 * 覆盖已有文件时同样出 diff 走授权 —— 整文件覆盖比局部替换更危险,不能因为
 * 接口更简单就更宽松。
 */
import { z } from "zod"
import { existsSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { ensureDir } from "../fs/dir.ts"
import { assertFresh, noteRead } from "../fs/freshness.ts"
import { assertInsideWorkspace } from "../fs/guard.ts"
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
    const path = assertInsideWorkspace(args.filePath, { cwd: ctx.cwd, root: ctx.root })

    return withFileLock(path, async () => {
      const exists = existsSync(path)
      if (exists && statSync(path).isDirectory()) {
        throw new Error(`Path is a directory, not a file: ${args.filePath}`)
      }
      // 覆盖比局部替换更该拦:这里丢掉的是**整个文件**里它没看过的部分,
      // 而且丢得悄无声息。见 fs/freshness.ts
      if (exists) assertFresh(ctx.sessionID, path, args.filePath, "overwrite")

      const source = exists
        ? decodeWithBom(new Uint8Array(await Bun.file(path).arrayBuffer()))
        : { text: "", bom: "" }

      // 已有文件保持原行尾风格;新文件跟随内容自身
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
        permission: "edit", // 与 edit 共用权限键:对用户而言都是「改我的文件」
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
      // 写完就是它看过的最新内容;新建的文件也要盖印,否则紧接着的 edit 会说
      // 「你没读过」—— 而它刚刚才亲手写出来
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
