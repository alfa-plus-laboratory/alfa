/**
 * edit 工具。
 *
 * 结构:参数校验 → 文件锁 → 读 → 匹配 → 生成 diff → 请求授权 → 写盘。
 * 授权**必须**在锁内 —— 否则用户看 A 的 diff 时 B 已经改了文件,批准后写回去
 * 就是基于陈旧内容的丢失更新。
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
    // 顺序重要:identical 必须先判,否则 {oldString:"", newString:""} 会报错误的那条
    if (args.oldString === args.newString) {
      throw new Error("No changes to apply: oldString and newString are identical.")
    }

    const path = assertInsideWorkspace(args.filePath, { cwd: ctx.cwd, root: ctx.root })

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
        // 在锁内、在读盘之前:没读过 / 读完又变了的话,下面那套模糊级联会
        // 「凑合」匹配到一个相似但不对的地方,而且不报错。见 fs/freshness.ts
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
        // 相对路径 —— 绝对路径会让 "*.env" 这类规则静默失效,见 permission/pattern.ts
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
      // 刚写下去的这一份就是它「看过」的最新内容。不重新盖印的话,连着改同一个
      // 文件时,第二刀会被自己的第一刀判成过期
      noteRead(ctx.sessionID, path)

      ctx.metadata({ filePath: path, diff: patch, ...stat })

      const summary = creating
        ? `Created ${args.filePath}`
        : `Edit applied successfully.${replacements > 1 ? `\nReplacements: ${replacements}` : ""}`

      // 预留 LSP 诊断挂钩。第一版恒空 —— 接上之后在这里追加
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
