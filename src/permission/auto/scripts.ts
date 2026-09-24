/**
 * What a project command will actually run, read from the repository, for the classifier.
 *
 * ── Why the classifier needs this ──
 * `npm test` says nothing about what it does: the repository decides that, in
 * package.json. The fast path used to let the project's own build and test commands
 * through without review, and scoring them wouldn't help by itself either. A classifier
 * that sees only the name approves `npm test` whenever the user asked for tests, whatever
 * `"test": "curl … | sh"` says. Claude Code has the same blind spot and relies on its OS
 * sandbox for this case. Here the script text goes into the evidence, so harm and reach
 * are scored on what runs.
 *
 * routine.ts records why this was once rejected: a judge asked "is demo.py dangerous"
 * answered "its contents were not provided". That was a judge given the name without
 * the text. This file is the text.
 *
 * ── Limits ──
 * Only what one read can resolve: package.json scripts (with their pre/post hooks, after
 * `--prefix` / `--cwd` / `-C`), a Makefile recipe (after `-f` / `-C`, with one level of
 * prerequisites), the head of a script file run by an interpreter or by path. Workspace
 * flags (`-w`, `--filter`, `-r`) are reported as unresolved rather than guessed. Test
 * runners that load config code (conftest.py, jest.config.js, build.rs) aren't followed;
 * the classifier still sees the command. Files outside the workspace (at their real
 * path) and secret files are never read. ⚠ Everything returned is repository content, not the user speaking;
 * llm.ts and rubric.ts say so, and removing that sentence lets a script comment claim
 * approval.
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { canonicalPath, within } from "../../fs/guard.ts"
import { scan } from "../../tool/bash/scan.ts"
import { isSecretPath } from "./secrets.ts"

export interface ProjectScript {
  /** Where the text came from, e.g. `package.json scripts.test` */
  source: string
  runs: string
}

const MAX_SCRIPTS = 4
const MAX_CHARS = 3_000
const MAKEFILE_HEAD_LINES = 60

/** Subcommands that are the package manager's own, not a script name */
const BUILTIN: Record<string, ReadonlySet<string>> = {
  npm: new Set(["install", "i", "ci", "add", "uninstall", "remove", "rm", "update", "publish", "pack", "link", "exec", "x", "init", "audit", "outdated", "ls", "list", "view", "info", "config", "cache", "version"]),
  pnpm: new Set(["install", "i", "add", "remove", "rm", "update", "up", "publish", "pack", "link", "exec", "dlx", "init", "audit", "outdated", "ls", "list", "why", "store", "config", "create"]),
  yarn: new Set(["install", "add", "remove", "upgrade", "up", "publish", "pack", "link", "exec", "dlx", "init", "audit", "outdated", "info", "why", "config", "create", "workspaces", "workspace"]),
  bun: new Set(["install", "i", "add", "remove", "rm", "update", "publish", "pm", "link", "x", "init", "create", "build", "test", "upgrade", "repl", "outdated"]),
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash"])
const INTERPRETERS = new Set(["python", "python3", "node", "bun", "deno", "ruby", "perl", "php", "Rscript", "ts-node", "tsx", ...SHELLS])

export function projectScripts(command: string, workdir: string, root: string): ProjectScript[] {
  const result = scan(command)
  if (!result.parseOk) return []
  const found: ProjectScript[] = []
  let cwd = workdir
  for (const segment of result.segments) {
    const [name, ...args] = segment.tokens
    if (!name) continue
    if (name === "cd") {
      if (args.length === 1) cwd = resolve(cwd, args[0]!)
      continue
    }
    found.push(...forSegment(name, args, cwd, root))
    if (found.length >= MAX_SCRIPTS) break
  }
  return found.slice(0, MAX_SCRIPTS)
}

function forSegment(name: string, args: string[], cwd: string, root: string): ProjectScript[] {
  if (name in BUILTIN) return managerScripts(name, args, cwd, root)
  if (name === "make" || name === "gmake") return makeRecipe(args, cwd, root)
  if (INTERPRETERS.has(name)) {
    const target = args.find((arg) => !arg.startsWith("-"))
    // `python -c …` / `node -e …` put the code on the command line, which the classifier sees
    return target && !args.some((arg) => /^-(?:c|e|m|-eval)$/.test(arg)) ? fileHead(target, cwd, root) : []
  }
  if (name.includes("/")) return fileHead(name, cwd, root)
  return []
}

/** Flags that move the package manager to another directory; their value is that directory */
const DIRECTORY_FLAGS = new Set(["--prefix", "-C", "--dir", "--cwd"])
/**
 * Flags that run the script in other workspace packages. Resolving them means reading the
 * workspace layout; saying "not resolved" is honest, showing the root's script is not
 */
const WORKSPACE_FLAGS = new Set(["-w", "--workspace", "--workspaces", "-ws", "--filter", "-F", "-r", "--recursive", "--include-workspace-root", "--all"])
/** Other flags that take a value, so the value isn't mistaken for the script name */
const VALUE_FLAGS = new Set(["--loglevel", "--registry", "--userconfig", "--cache", "--reporter", "--config"])

/**
 * ★ The evidence must be what actually runs or say that it couldn't tell. Showing the
 *   wrong script is worse than showing none: `npm test --prefix sub` once showed the
 *   root's harmless `test` while npm ran `sub/package.json`'s.
 */
function managerScripts(manager: string, args: string[], cwd: string, root: string): ProjectScript[] {
  let dir = cwd
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const [flag, inline] = arg.startsWith("-") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined]
    if (DIRECTORY_FLAGS.has(flag)) {
      const value = inline ?? args[++i]
      if (value === undefined) return []
      dir = resolve(cwd, value)
      continue
    }
    if (WORKSPACE_FLAGS.has(flag)) return [{ source: `${manager} ${arg}`, runs: "(runs the script in other workspace packages; their scripts were not resolved)" }]
    if (VALUE_FLAGS.has(flag) && inline === undefined) { i++; continue }
    if (arg === "--") break
    if (arg.startsWith("-")) continue
    positional.push(arg)
  }
  const script = scriptName(manager, positional)
  if (!script) return []
  const fromPackage = packageScripts(script, dir, root)
  if (fromPackage.length > 0) return fromPackage
  // `bun run file.ts` / `bun file.ts`
  return manager === "bun" ? fileHead(script, dir, root) : []
}

function scriptName(manager: string, positional: string[]): string | undefined {
  const [first, second] = positional
  if (!first) return undefined
  if (first === "run" || first === "run-script") return second
  if (first === "test" || first === "t" || first === "tst") return manager === "bun" ? undefined : "test"
  if (BUILTIN[manager]!.has(first)) return undefined
  // npm only runs a bare name for its lifecycle shortcuts; the other three run any script
  if (manager === "npm") return ["start", "stop", "restart"].includes(first) ? first : undefined
  return first
}

function packageScripts(script: string, cwd: string, root: string): ProjectScript[] {
  const path = nearest("package.json", cwd, root)
  if (!path) return []
  let scripts: Record<string, unknown>
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, unknown> }
    scripts = parsed.scripts ?? {}
  } catch {
    return []
  }
  // npm and pnpm run pre<name> and post<name> around it; that code runs too
  return [`pre${script}`, script, `post${script}`].flatMap((key) =>
    typeof scripts[key] === "string" ? [{ source: `${relative(path, root)} scripts.${key}`, runs: clip(scripts[key] as string) }] : [],
  )
}

/** make flags that take a value (as the next argument or joined) */
const MAKE_VALUE_FLAGS = new Set(["-f", "--file", "--makefile", "-C", "--directory", "-I", "--include-dir", "-o", "--old-file", "--assume-old", "-W", "--what-if", "--new-file", "--assume-new", "-l", "--load-average"])

function makeRecipe(args: string[], cwd: string, root: string): ProjectScript[] {
  let dir = cwd
  let file: string | undefined
  const targets: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const joined = /^-[fCIoWl]./.test(arg) ? [arg.slice(0, 2), arg.slice(2)] : arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : undefined
    const [flag, inline] = joined ?? [arg, undefined]
    if (MAKE_VALUE_FLAGS.has(flag!)) {
      const value = inline ?? args[++i]
      if (value === undefined) return []
      if (flag === "-C" || flag === "--directory") dir = resolve(dir, value)
      if (flag === "-f" || flag === "--file" || flag === "--makefile") file = value
      continue
    }
    if (arg.startsWith("-") || arg.includes("=")) continue
    targets.push(arg)
  }
  const path = file !== undefined ? resolve(dir, file) : ["GNUmakefile", "makefile", "Makefile"].map((each) => join(dir, each)).find((each) => readable(each, root))
  if (!path || !readable(path, root)) return []
  const text = readFileSync(path, "utf8")
  const recipes = targets.map((target) => [target, recipeOf(text, target)] as const)
  if (recipes.length > 0 && recipes.every(([, recipe]) => recipe !== undefined)) {
    // `test: setup` runs setup's recipe first; one level of prerequisites is shown too,
    // so a harmless-looking target can't hide what it depends on
    const shown = new Map<string, string>()
    for (const [target, recipe] of recipes) {
      shown.set(target, recipe!)
      for (const prerequisite of prerequisitesOf(recipe!)) {
        const theirs = recipeOf(text, prerequisite)
        if (theirs !== undefined && !shown.has(prerequisite)) shown.set(prerequisite, theirs)
      }
    }
    return [...shown].slice(0, MAX_SCRIPTS).map(([target, recipe]) => ({ source: `${relative(path, root)} target ${target}`, runs: clip(recipe) }))
  }
  // Default target, or one we couldn't isolate: the head shows what the file sets up
  return [{ source: `${relative(path, root)} (first ${MAKEFILE_HEAD_LINES} lines)`, runs: clip(text.split("\n").slice(0, MAKEFILE_HEAD_LINES).join("\n")) }]
}

/** The names after the colon on a rule's first line, before any `;` recipe or `|` order-only part */
function prerequisitesOf(recipe: string): string[] {
  const rule = recipe.split("\n")[0]!
  const after = rule.slice(rule.indexOf(":") + 1).replace(/^:/, "").split(/[;|]/)[0]!
  return after.split(/\s+/).filter((name) => name.length > 0 && !name.includes("$"))
}

function recipeOf(text: string, target: string): string | undefined {
  const lines = text.split("\n")
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const rule = new RegExp(`^(?:[^:#=]*\\s)?${escaped}(?:\\s[^:#=]*)?::?(?!=)`)
  // Rule lines never start with a tab; recipe lines always do, and `\techo test: done`
  // must not be taken for the `test:` rule
  const start = lines.findIndex((line) => !line.startsWith("\t") && rule.test(line))
  if (start < 0) return undefined
  const body = [lines[start]!]
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("\t") && line.trim() !== "") break
    body.push(line)
  }
  return body.join("\n").trimEnd()
}

function fileHead(target: string, cwd: string, root: string): ProjectScript[] {
  const path = resolve(cwd, target)
  if (!readable(path, root)) return []
  return [{ source: relative(path, root), runs: clip(readFileSync(path, "utf8")) }]
}

/**
 * Inside the workspace at its real path (a committed symlink can point anywhere), a
 * regular file, and not a secret
 */
function readable(path: string, root: string): boolean {
  if (!within(canonicalPath(path), canonicalPath(root)) || isSecretPath(path, root)) return false
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function nearest(name: string, from: string, root: string): string | undefined {
  let dir = from
  while (within(dir, root)) {
    const candidate = join(dir, name)
    if (existsSync(candidate) && readable(candidate, root)) return candidate
    if (dir === root) break
    dir = dirname(dir)
  }
  return undefined
}

function relative(path: string, root: string): string {
  return path.startsWith(root + "/") ? path.slice(root.length + 1) : path
}

function clip(text: string): string {
  return text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS)}\n… [${text.length - MAX_CHARS} more characters]`
}
