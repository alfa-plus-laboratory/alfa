/**
 * grep 工具:内容正则检索。
 */
import { z } from "zod"
import { statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { assertInsideWorkspace } from "../fs/guard.ts"
import { grep } from "../fs/ripgrep.ts"
import type { ToolDef } from "./types.ts"

const RESULT_LIMIT = 100

const Parameters = z.object({
  pattern: z.string().describe("The regular expression to search for in file contents"),
  path: z.string().optional().describe("Directory to search in. Defaults to the workspace root."),
  include: z.string().optional().describe('Glob filter for which files to search, e.g. "*.ts" or "*.{ts,tsx}"'),
})

type Args = z.infer<typeof Parameters>

const DESCRIPTION = `Searches file contents with a regular expression.

Usage rules:
- pattern is a regex, not a literal string. Escape regex metacharacters when you mean them literally.
- path must be a directory. To search one file, read it instead.
- Use include to narrow by filename, e.g. include: "*.ts".
- Hidden files are searched; .git and common build directories are not. .gitignore is respected.
- Results are capped at ${RESULT_LIMIT} matches. If truncated, narrow the pattern or the path rather than paging.`

export const GrepTool: ToolDef<Args> = {
  id: "grep",
  description: DESCRIPTION,
  parameters: Parameters,

  async execute(args, ctx) {
    if (!args.pattern) throw new Error("pattern is required")
    await ctx.ask({ permission: "grep", patterns: [args.pattern] })

    const requested = args.path
      ? assertInsideWorkspace(args.path, { cwd: ctx.cwd, root: ctx.root })
      : ctx.cwd

    let searchDir = requested
    try {
      if (!statSync(requested).isDirectory()) searchDir = dirname(requested)
    } catch {
      throw new Error(`Search path not found: ${args.path ?? ctx.cwd}`)
    }

    const result = await grep({
      cwd: searchDir,
      pattern: args.pattern,
      include: args.include,
      limit: RESULT_LIMIT,
      signal: ctx.abortSignal,
    })

    if (result.matches.length === 0) {
      return {
        output: "No matches found",
        title: args.pattern,
        metadata: { truncated: false, matches: 0, engine: result.engine },
      }
    }

    // 同文件的匹配连续输出;换文件时空一行再打路径
    const out: string[] = [
      `Found ${result.matches.length} matches${result.truncated ? " (more matches available)" : ""}`,
    ]
    let currentFile: string | undefined
    for (const match of result.matches) {
      if (match.path !== currentFile) {
        currentFile = match.path
        out.push("", `${resolve(searchDir, match.path)}:`)
      }
      out.push(`  Line ${match.line}: ${match.text}`)
    }
    if (result.truncated) {
      out.push("", "(Results truncated. Consider using a more specific path or pattern.)")
    }
    if (result.partial) {
      out.push("", "(Some files could not be read and were skipped.)")
    }

    return {
      output: out.join("\n"),
      title: args.pattern,
      metadata: {
        truncated: result.truncated,
        matches: result.matches.length,
        engine: result.engine,
        partial: result.partial,
      },
    }
  },
}
