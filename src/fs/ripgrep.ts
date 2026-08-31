/**
 * 内容检索:优先 spawn 系统 ripgrep,没有就走纯 TS 兜底。
 *
 * 刻意**不**做 opencode 那套「找不到就从 GitHub Releases 下载解压」:
 * 一个本地工具在首次运行时静默联网下二进制,是很差的信任姿态。系统有 rg
 * 就用(快几十倍),没有就用兜底(慢但结果一致)。
 *
 * 两条路径必须给出一致的 {path, line} 集合 —— 这是有测试守着的不变式,
 * 否则用户换台机器就会看到 agent 行为漂移。
 */
import { readEnv } from "../env/vars.ts"
import { readFileSync, statSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { isBinaryPath } from "./binary.ts"

export interface Match {
  /** 相对 cwd 的路径 */
  path: string
  /** 1-based */
  line: number
  text: string
}

export interface GrepResult {
  matches: Match[]
  truncated: boolean
  /** rg 退出码 2:部分文件出错(权限等),已得结果仍然有效 */
  partial: boolean
  engine: "ripgrep" | "fallback"
}

export interface GrepOptions {
  cwd: string
  pattern: string
  include?: string
  limit: number
  signal?: AbortSignal
}

const MAX_LINE_TEXT = 2000
const MAX_JSON_LINE_BYTES = 64 * 1024
/** 兜底路径下跳过的大文件阈值 */
const FALLBACK_MAX_FILE_BYTES = 5 * 1024 * 1024

export class InvalidPatternError extends Error {
  constructor(pattern: string, detail: string) {
    super(`Invalid regex pattern ${JSON.stringify(pattern)}: ${detail}`)
    this.name = "InvalidPatternError"
  }
}

/**
 * 统一两个引擎的 include 语义。
 *
 * ripgrep 的 --glob=*.ts 按 basename 匹配**任意深度**;Bun.Glob 的 *.ts 只匹配
 * **顶层**。同一个参数在两条路径下含义不同 = 用户换台机器就看到 agent 行为漂移。
 * 以 ripgrep 语义为准(模型也是这么预期的):不含 "/" 的模式一律补 "**\/"。
 * 补过之后对 rg 也仍然正确 —— "**\/" 匹配零个或多个目录层级。
 */
export function normalizeIncludeGlob(include: string): string {
  return include.includes("/") ? include : `**/${include}`
}

let rgPath: string | null | undefined

/** 探测一次并缓存。设 ALFA_NO_RG=1 可强制走兜底(测试用)。 */
export function ripgrepPath(): string | null {
  if (rgPath === undefined) {
    rgPath = readEnv("NO_RG") === "1" ? null : (Bun.which("rg") ?? null)
  }
  return rgPath
}

export function __resetRipgrepCacheForTest(): void {
  rgPath = undefined
}

export async function grep(options: GrepOptions): Promise<GrepResult> {
  const rg = ripgrepPath()
  return rg ? grepWithRipgrep(rg, options) : grepFallback(options)
}

// ────────────────────────────────────────────── ripgrep 路径

async function grepWithRipgrep(rg: string, options: GrepOptions): Promise<GrepResult> {
  const args = [
    rg,
    "--no-config", // 屏蔽用户的 RIPGREP_CONFIG_PATH,否则行为不可预测
    "--json",
    "--hidden", // 要能搜到 .env / .github
    "--no-messages",
  ]
  if (options.include) args.push(`--glob=${normalizeIncludeGlob(options.include)}`)
  args.push("--glob=!**/.git/**", "--", options.pattern, ".")

  const proc = Bun.spawn(args, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    signal: options.signal,
  })

  const matches: Match[] = []
  let truncated = false

  const decoder = new TextDecoder()
  let buffer = ""
  outer: for await (const chunk of proc.stdout) {
    buffer += decoder.decode(chunk, { stream: true })
    let index: number
    while ((index = buffer.indexOf("\n")) !== -1) {
      const raw = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (raw.length > MAX_JSON_LINE_BYTES) continue // 单行过大,跳过而不是崩
      const match = parseRipgrepLine(raw)
      if (!match) continue
      // 多取一条来判断是否被截断
      if (matches.length >= options.limit) {
        truncated = true
        proc.kill()
        break outer
      }
      matches.push(match)
    }
  }

  if (truncated) return { matches, truncated, partial: false, engine: "ripgrep" }

  const code = await proc.exited
  if (code === 1) return { matches: [], truncated: false, partial: false, engine: "ripgrep" } // 无匹配
  if (code === 0) return { matches, truncated: false, partial: false, engine: "ripgrep" }
  if (code === 2) {
    const stderr = await new Response(proc.stderr).text()
    if (/regex parse error|error parsing regex/i.test(stderr)) {
      throw new InvalidPatternError(options.pattern, stderr.trim().split("\n").at(-1) ?? stderr.trim())
    }
    return { matches, truncated: false, partial: true, engine: "ripgrep" }
  }
  const stderr = await new Response(proc.stderr).text()
  throw new Error(`ripgrep exited with code ${code}: ${stderr.trim()}`)
}

function parseRipgrepLine(raw: string): Match | undefined {
  let event: any
  try {
    event = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (event?.type !== "match") return undefined
  const data = event.data
  const path = normalizeRelative(String(data?.path?.text ?? ""))
  if (!path) return undefined
  const text = String(data?.lines?.text ?? "").replace(/\r?\n$/, "")
  return {
    path,
    line: Number(data?.line_number ?? 0),
    text: text.length > MAX_LINE_TEXT ? text.slice(0, MAX_LINE_TEXT) + "..." : text,
  }
}

function normalizeRelative(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\//, "")
}

// ────────────────────────────────────────────── 纯 TS 兜底

/** 与 ripgrep 默认忽略保持一致的一小撮目录。 */
const IGNORED_DIRS = ["node_modules", ".git", "dist", "build", ".next", ".venv", "__pycache__", "target"]

export async function grepFallback(options: GrepOptions): Promise<GrepResult> {
  let regex: RegExp
  try {
    regex = new RegExp(options.pattern)
  } catch (error) {
    throw new InvalidPatternError(options.pattern, error instanceof Error ? error.message : String(error))
  }

  const matches: Match[] = []
  let truncated = false

  for await (const file of walk(options.cwd, options.include)) {
    if (options.signal?.aborted) break
    const absolute = resolve(options.cwd, file)
    if (isBinaryPath(absolute)) continue
    try {
      if (statSync(absolute).size > FALLBACK_MAX_FILE_BYTES) continue
    } catch {
      continue
    }

    let content: string
    try {
      content = readFileSync(absolute, "utf8")
    } catch {
      continue
    }
    if (content.includes("\u0000")) continue // 扩展名没兜住的二进制文件

    const fileLines = content.split("\n")
    for (let i = 0; i < fileLines.length; i++) {
      const text = fileLines[i]!.replace(/\r$/, "")
      if (!regex.test(text)) continue
      regex.lastIndex = 0 // 防 /g 标志导致的状态残留
      if (matches.length >= options.limit) {
        truncated = true
        return { matches, truncated, partial: false, engine: "fallback" }
      }
      matches.push({
        path: normalizeRelative(file),
        line: i + 1,
        text: text.length > MAX_LINE_TEXT ? text.slice(0, MAX_LINE_TEXT) + "..." : text,
      })
    }
  }

  return { matches, truncated, partial: false, engine: "fallback" }
}

/**
 * 遍历 cwd 下的文件,返回相对路径。
 *
 * `include` 走 normalizeIncludeGlob(与 rg 对齐);`rawPattern` 为 true 时
 * 原样使用 —— glob 工具的 pattern 是用户/模型显式给的 glob,要保持字面语义。
 *
 * ★ "cwd 下的"这四个字是**强制的**,不只是说明。
 *
 *   Bun.Glob 会老老实实展开 pattern 里的 `../`:`{ pattern: "../../../../etc/host*" }`
 *   交出来的就是 /etc/hosts。调用方那边 searchDir 过了门卫,但 pattern 没有 ——
 *   于是 glob 工具能列出家目录里的每一个仓库、grep 的兜底引擎(没装 rg 的机器)
 *   能拿 `include: "../*.env"` 把工作区外面的文件**内容**读出来。两个工具都是
 *   默认放行的,全程不弹窗。
 *
 *   判据放在**结果**上而不是 pattern 文本上:查文本里有没有 ".." 挡不住等价写法。
 *   静默跳过而不是抛错 —— 越界的结果本来就不该存在,为它中断整次搜索没道理;
 *   真正瞄着外面的 pattern 得到的是一个空结果。
 */
export async function* walk(cwd: string, include?: string, rawPattern = false): AsyncGenerator<string> {
  const pattern = include ? (rawPattern ? include : normalizeIncludeGlob(include)) : "**/*"
  const glob = new Bun.Glob(pattern)
  const base = resolve(cwd)
  for await (const entry of glob.scan({ cwd, onlyFiles: true, dot: true, followSymlinks: false })) {
    const rel = relative(base, resolve(base, entry))
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue
    const normalized = normalizeRelative(entry)
    if (IGNORED_DIRS.some((dir) => normalized === dir || normalized.startsWith(dir + "/") || normalized.includes("/" + dir + "/"))) {
      continue
    }
    yield normalized
  }
}

/** 相对 root 的展示路径。 */
export function displayPath(absolute: string, root: string): string {
  const rel = relative(root, absolute)
  return rel === "" ? "." : rel
}
