/**
 * Content search: spawn the system ripgrep if there is one, otherwise the pure-TS
 * fallback.
 *
 * Deliberately **not** doing opencode's "if it's missing, download and unpack it from
 * GitHub Releases": a local tool silently going online to fetch a binary on first run is
 * a poor trust posture. If the system has rg, use it (dozens of times faster); if not,
 * use the fallback (slower, but the same results).
 *
 * Both paths must produce the same set of {path, line} — an invariant guarded by tests,
 * otherwise the user switches machines and sees the agent's behavior drift.
 */
import { readEnv } from "../env/vars.ts"
import { readFileSync, statSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { isBinaryPath } from "./binary.ts"

export interface Match {
  /** Path relative to cwd */
  path: string
  /** 1-based */
  line: number
  text: string
}

export interface GrepResult {
  matches: Match[]
  truncated: boolean
  /** rg exit code 2: some files errored (permissions etc.); results so far remain valid */
  partial: boolean
  engine: "ripgrep" | "fallback"
}

export interface GrepOptions {
  authorizeFile?(path: string): Promise<boolean>
  cwd: string
  pattern: string
  include?: string
  limit: number
  signal?: AbortSignal
}

const MAX_LINE_TEXT = 2000
const MAX_JSON_LINE_BYTES = 64 * 1024
/** Size threshold above which the fallback path skips a file */
const FALLBACK_MAX_FILE_BYTES = 5 * 1024 * 1024

export class InvalidPatternError extends Error {
  constructor(pattern: string, detail: string) {
    super(`Invalid regex pattern ${JSON.stringify(pattern)}: ${detail}`)
    this.name = "InvalidPatternError"
  }
}

/**
 * Unify the include semantics of the two engines.
 *
 * ripgrep's --glob=*.ts matches on basename at **any depth**; Bun.Glob's *.ts matches only
 * at the **top level**. The same argument meaning different things on the two paths = the
 * user switches machines and sees the agent's behavior drift. ripgrep's semantics win
 * (that's also what the model expects): any pattern without a "/" gets "**\/" prepended.
 * After that it's still correct for rg too — "**\/" matches zero or more directory
 * levels.
 */
export function normalizeIncludeGlob(include: string): string {
  return include.includes("/") ? include : `**/${include}`
}

let rgPath: string | null | undefined

/** Probe once and cache. Set ALFA_NO_RG=1 to force the fallback (for tests). */
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
  if (options.authorizeFile) return grepFallback(options)
  const rg = ripgrepPath()
  return rg ? grepWithRipgrep(rg, options) : grepFallback(options)
}

// ────────────────────────────────────────────── ripgrep path

async function grepWithRipgrep(rg: string, options: GrepOptions): Promise<GrepResult> {
  const args = [
    rg,
    "--no-config", // ignore the user's RIPGREP_CONFIG_PATH, otherwise behavior is unpredictable
    "--json",
    "--hidden", // must be able to find .env / .github
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
      if (raw.length > MAX_JSON_LINE_BYTES) continue // oversized line: skip rather than crash
      const match = parseRipgrepLine(raw)
      if (!match) continue
      // Take one extra to tell whether the result was truncated
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
  if (code === 1) return { matches: [], truncated: false, partial: false, engine: "ripgrep" } // no matches
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

// ────────────────────────────────────────────── pure-TS fallback

/** A small set of directories, matching ripgrep's default ignores. */
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
    if (options.authorizeFile && !await options.authorizeFile(absolute)) continue
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
    if (content.includes("\u0000")) continue // a binary file the extension check didn't catch

    const fileLines = content.split("\n")
    for (let i = 0; i < fileLines.length; i++) {
      const text = fileLines[i]!.replace(/\r$/, "")
      if (!regex.test(text)) continue
      regex.lastIndex = 0 // guard against leftover state from a /g flag
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
 * Walk the files under cwd, yielding relative paths.
 *
 * `include` goes through normalizeIncludeGlob (lined up with rg); when `rawPattern` is
 * true it's used as is — the glob tool's pattern is a glob the user/model gave
 * explicitly, and must keep its literal semantics.
 *
 * ★ "under cwd" is **enforced**, not just a description.
 *
 *   Bun.Glob dutifully expands `../` in the pattern: `{ pattern: "../../../../etc/host*" }`
 *   hands back /etc/hosts. On the caller's side searchDir went through the gatekeeper, but
 *   the pattern didn't — so the glob tool could list every repo in the home directory,
 *   and grep's fallback engine (machines without rg) could read the **contents** of files
 *   outside the workspace with `include: "../*.env"`. Both tools are allowed by default,
 *   no prompt at any point.
 *
 *   The test is applied to the **results**, not the pattern text: checking the text for
 *   ".." doesn't stop equivalent spellings. Skip silently rather than throw — results
 *   outside the boundary shouldn't exist in the first place, and aborting the whole
 *   search over them makes no sense; a pattern really aimed outside gets an empty result.
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

/** Display path relative to root. */
export function displayPath(absolute: string, root: string): string {
  const rel = relative(root, absolute)
  return rel === "" ? "." : rel
}
