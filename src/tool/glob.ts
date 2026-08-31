/**
 * glob 工具:按文件名模式找路径,按修改时间倒序(最近改过的通常更相关)。
 *
 * M1 里它不是「五个工具」之一,但仍然实现并注册 —— 成本极低(Bun.Glob 内置),
 * 而且模型没有它就只能用 bash 里的 find/ls,那反而更难管。
 */
import { z } from "zod"
import { statSync } from "node:fs"
import { resolve } from "node:path"
import { assertInsideWorkspace } from "../fs/guard.ts"
import { walk } from "../fs/ripgrep.ts"
import type { ToolDef } from "./types.ts"

const RESULT_LIMIT = 100

const Parameters = z.object({
  pattern: z.string().describe('Glob pattern to match file paths against, e.g. "**/*.ts" or "src/**/test_*.py"'),
  path: z.string().optional().describe("Directory to search in. Defaults to the workspace root."),
})

type Args = z.infer<typeof Parameters>

const DESCRIPTION = `Finds files by name pattern. Results are sorted by modification time, most recent first.

Usage rules:
- pattern is a glob, not a regex: "**/*.ts", "src/**/*.test.*".
- To search file *contents* instead of names, use grep.
- Results are capped at ${RESULT_LIMIT} files. If truncated, narrow the pattern.`

export const GlobTool: ToolDef<Args> = {
  id: "glob",
  description: DESCRIPTION,
  parameters: Parameters,

  async execute(args, ctx) {
    if (!args.pattern) throw new Error("pattern is required")
    await ctx.ask({ permission: "glob", patterns: [args.pattern] })

    const searchDir = args.path
      ? assertInsideWorkspace(args.path, { cwd: ctx.cwd, root: ctx.root })
      : ctx.cwd

    const found: Array<{ path: string; mtime: number }> = []
    // rawPattern:glob 工具的 pattern 是显式 glob,保持字面语义
    // (与 grep 的 include 不同 —— 那个要对齐 ripgrep 的 basename 语义)
    for await (const rel of walk(searchDir, args.pattern, true)) {
      if (ctx.abortSignal.aborted) break
      const absolute = resolve(searchDir, rel)
      let mtime = 0
      try {
        mtime = statSync(absolute).mtimeMs
      } catch {
        continue
      }
      found.push({ path: absolute, mtime })
    }

    found.sort((a, b) => b.mtime - a.mtime)
    const truncated = found.length > RESULT_LIMIT
    const shown = truncated ? found.slice(0, RESULT_LIMIT) : found

    if (shown.length === 0) {
      return {
        output: "No files found",
        title: args.pattern,
        metadata: { truncated: false, files: 0 },
      }
    }

    const out = shown.map((f) => f.path)
    if (truncated) out.push("", `(Showing ${RESULT_LIMIT} of ${found.length} files. Narrow the pattern to see the rest.)`)

    return {
      output: out.join("\n"),
      title: args.pattern,
      metadata: { truncated, files: found.length },
    }
  },
}
