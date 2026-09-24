/**
 * MCP server config: where it's defined, what it looks like, how the two places merge.
 *
 * ── Why MCP has project-level config when alfa itself doesn't ──
 * `prompt/skills/alfa-config.md` states plainly that there is no project-level config,
 * and that decision still stands today: which provider the model should use, how big the
 * window is, what the check command is — those belong to **this machine**; having them
 * travel with the repo only makes the same repo behave differently on two machines.
 *
 * MCP is the reverse — which servers a repo hooks up to is precisely a property of **this
 * repo**: the backend repo wants postgres, the frontend repo wants puppeteer, and that
 * doesn't change on another machine. Allowing it only in the home directory means everyone
 * has to reconfigure it after cloning, and nobody knows what to configure.
 *
 * So both are read, but **not from the same file**: the project one is called
 * `.alfa/mcp.json` and only covers MCP. Not reusing the name `config.json` is deliberate —
 * in the notes `/init` generates, that name is marked "roadmap, not a feature", and the
 * model has already gone digging through the project once for that nonexistent file. A new name that holds only one thing is cheaper than an old name
 * whose meaning is already taken.
 *
 * ── ★ A file in the project can name a process to run ──
 * This is the fundamental difference between this config and every other one: `command`
 * is an **execution path**. Clone an unfamiliar repo, cd in, type alfa, and the
 * `.alfa/mcp.json` inside it can make us start a process. So every server that comes from
 * the project carries `origin: "project"`, and the wiring layer asks the user directly
 * once before first connecting to it (see manager.ts). This layer is only responsible for
 * **labeling the origin truthfully**; it makes no allow decision — judgment is left to the
 * layer that can see the user, and once the origin is lost here it can never be recovered
 * later.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** Location of the project's config. Relative to the repo root. */
export const PROJECT_MCP_PATH = join(".alfa", "mcp.json")

export interface McpServerConfig {
  /** The executable to run. The only way to start a stdio server */
  command: string
  args?: string[]
  /** Vars added to the child's environment. Values may use ${NAME} to reference ours */
  env?: Record<string, string>
  /** Working directory. Defaults to the repo root */
  cwd?: string
  /**
   * false means "keep the definition but don't connect this time". Deleting the config and
   * switching it off for now are two different things
   */
  enabled?: boolean
}

export interface McpServerEntry extends McpServerConfig {
  name: string
  /**
   * Where this definition came from. **project ones are connected only after asking the
   * user directly**.
   *
   * `library` ones are those on the shelf that the project names: the definition lives in
   * the user's own home directory, and the project file only writes down a name. So they
   * **need no trust** — the command to run was typed into the global config by the user
   * themselves; the most an unfamiliar repo can do is name something they don't have, and
   * that's just one problem entry.
   */
  origin: "global" | "project" | "library"
  /** The file holding the definition; errors must be able to say which one */
  source: string
}

/**
 * The ones that couldn't be read. **Doesn't throw** — one broken config shouldn't keep the
 * whole program from starting
 */
export interface McpProblem {
  /** Which server, if we can tell; undefined if we can't (the whole file is broken) */
  name?: string
  source: string
  why: string
}

export interface McpConfigResult {
  servers: McpServerEntry[]
  problems: McpProblem[]
  /**
   * Names on the shelf that **weren't named this time**.
   *
   * It exists for one reason only: to make the "stored but not in effect" layer visible.
   * A shelf you can't browse is no different from no shelf — the user forgets what they
   * put on it, then writes the definition all over again in a second project.
   * (Same on the skills side; see SkillSet.library.)
   */
  shelf: string[]
}

/**
 * Merge the two configs.
 *
 * On a name clash **the project one wins** — the more specific one winning is the norm
 * for config systems, and the reverse would be hard to explain: the user clearly wrote one
 * in the repo, yet the invisible one in the home directory takes effect.
 *
 * The order is stable (sorted by name), because tool definitions are among the very
 * front of the prompt's cache prefix; one wobble in order and the whole prompt cache
 * misses (same as that note in tool/registry.ts).
 */
export function loadMcpConfig(input: {
  /** The global config's mcp.servers section. Parsed by config/config.ts and passed in */
  global?: Record<string, McpServerConfig>
  /**
   * The `mcp.library` section of the global config — **the shelf**: defined here, but not
   * connected.
   *
   * Same shape as the skills shelf, for the same reason: not every project needs every
   * server you've collected (one that connects to the production DB, one used only in a
   * particular client's repo), and the cost of "connect them in every project" is a pile of
   * tool definitions sent every turn + a pile of processes started for nothing. A project
   * that wants one names it with `use: ["name"]` in its own `.alfa/mcp.json`.
   */
  library?: Record<string, McpServerConfig>
  globalSource: string
  /** Repo root. Outside a repo (or without that file) only the global half applies */
  root?: string
  /** The current environment, for expanding ${NAME}. Tests can substitute it */
  env?: Record<string, string | undefined>
}): McpConfigResult {
  const problems: McpProblem[] = []
  const byName = new Map<string, McpServerEntry>()
  const env = input.env ?? process.env

  const take = (
    servers: Record<string, McpServerConfig>,
    origin: McpServerEntry["origin"],
    source: string,
  ): void => {
    for (const [name, raw] of Object.entries(servers)) {
      const checked = validate(name, raw, source)
      if (typeof checked === "string") {
        problems.push({ name, source, why: checked })
        continue
      }
      const expanded = expand(checked, env)
      if (typeof expanded === "string") {
        problems.push({ name, source, why: expanded })
        continue
      }
      byName.set(name, { ...expanded, name, origin, source })
    }
  }

  if (input.global) take(input.global, "global", input.globalSource)

  if (input.root) {
    const path = join(input.root, PROJECT_MCP_PATH)
    if (existsSync(path)) {
      const parsed = readProjectFile(path)
      if (typeof parsed === "string") problems.push({ source: path, why: parsed })
      else {
        /**
         * ★ Names first, definitions second — the order matters here.
         *
         * The ones the project defines itself (`servers`) still need trust, because they
         * carry a command to run. The ones named from the shelf (`use`) don't, because
         * that command was written by the user. On a clash `servers` wins: a project
         * that both names one and writes its own clearly wants the one it wrote — and
         * that one **does** go through trust, so there's no "bypass approval by naming"
         * route.
         */
        takeShelf(parsed.use, input.library, input.globalSource, path, take, problems)
        take(parsed.servers, "project", path)
      }
    }
  }

  const servers = [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name))
  const shelf = Object.keys(input.library ?? {})
    .filter((name) => !byName.has(name))
    .toSorted((a, b) => a.localeCompare(b))
  return { servers, problems, shelf }
}

/**
 * Take the ones named by `use: [...]` down off the shelf.
 *
 * ★ **Naming only, never defining** — this is the shelf layer's one and only safety
 *   argument. What appears in the project file is a string, not a command; what runs is
 *   decided by the config in the user's home directory. So the worst an unfamiliar repo
 *   can do is "name something you don't have", and that's just a one-line notice.
 */
function takeShelf(
  use: string[] | undefined,
  library: Record<string, McpServerConfig> | undefined,
  librarySource: string,
  projectPath: string,
  take: (servers: Record<string, McpServerConfig>, origin: McpServerEntry["origin"], source: string) => void,
  problems: McpProblem[],
): void {
  if (!use || use.length === 0) return
  for (const name of use) {
    const found = library?.[name]
    if (!found) {
      // Say plainly "not on the shelf" rather than "config is wrong": the most common
      // cause is a different machine, and the fix is adding a definition to the global
      // config, not editing this file in the repo
      problems.push({
        name,
        source: projectPath,
        why: `is named in "use" but there is no "${name}" in mcp.library — add it to ${librarySource}, or drop the name here`,
      })
      continue
    }
    take({ [name]: found }, "library", librarySource)
  }
}

/**
 * Reads only the project file. If the whole file is broken, returns a plain-language
 * sentence; never throws.
 */
function readProjectFile(path: string): { servers: Record<string, McpServerConfig>; use?: string[] } | string {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    return `could not be read (${(error as Error).message})`
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    // Hand-editing this file is a supported use, so errors must be in plain words (same as
    // config/config.ts)
    return `is not valid JSON — ${(error as Error).message}`
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return `must be a JSON object`
  const servers = (data as { servers?: unknown }).servers
  const use = (data as { use?: unknown }).use
  // Either key may appear alone: a project that only names omits servers; one that only
  // defines its own omits use
  if (servers === undefined && use === undefined) return `has neither a "servers" nor a "use" key`
  if (servers !== undefined && (servers === null || typeof servers !== "object" || Array.isArray(servers))) {
    return `"servers" must be an object of name → definition`
  }
  if (use !== undefined && (!Array.isArray(use) || use.some((one) => typeof one !== "string"))) {
    return `"use" must be an array of names from mcp.library`
  }
  return {
    servers: (servers ?? {}) as Record<string, McpServerConfig>,
    ...(use ? { use: use as string[] } : {}),
  }
}

/** Whether one definition is itself valid. A returned string is "what's wrong". */
function validate(name: string, raw: unknown, source: string): McpServerConfig | string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "must be an object"
  const value = raw as Record<string, unknown>
  const command = value["command"]
  if (typeof command !== "string" || command.trim().length === 0) {
    return `needs a "command" — the executable to run (${source} defines ${name} without one)`
  }
  const args = value["args"]
  if (args !== undefined && (!Array.isArray(args) || args.some((one) => typeof one !== "string"))) {
    return `"args" must be an array of strings`
  }
  const cwd = value["cwd"]
  if (cwd !== undefined && typeof cwd !== "string") return `"cwd" must be a string`
  const enabled = value["enabled"]
  if (enabled !== undefined && typeof enabled !== "boolean") return `"enabled" must be true or false`
  const envValue = value["env"]
  if (envValue !== undefined) {
    if (envValue === null || typeof envValue !== "object" || Array.isArray(envValue)) {
      return `"env" must be an object of NAME → value`
    }
    for (const [key, one] of Object.entries(envValue)) {
      if (typeof one !== "string") return `"env.${key}" must be a string`
    }
  }
  return {
    command,
    ...(args ? { args: args as string[] } : {}),
    ...(envValue ? { env: envValue as Record<string, string> } : {}),
    ...(typeof cwd === "string" ? { cwd } : {}),
    ...(typeof enabled === "boolean" ? { enabled } : {}),
  }
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * Expand `${NAME}`.
 *
 * ── Why it's a must ──
 * Almost every server needs a token, and the project's config **goes into git**. Without
 * this, the user has only two options: write the key into the repo in plain text, or skip
 * project-level config.
 *
 * ── Why a missing variable is an **error** and not an empty string ──
 * An empty string lets the server start normally, then fail on the first call with an
 * auth error that has nothing to do with the cause. Saying "${GITHUB_TOKEN} isn't set"
 * here is far cheaper.
 */
function expand(
  config: McpServerConfig,
  env: Record<string, string | undefined>,
): McpServerConfig | string {
  const missing = new Set<string>()
  const one = (text: string): string =>
    text.replace(PLACEHOLDER, (whole, name: string) => {
      const value = env[name]
      if (value === undefined) {
        missing.add(name)
        return whole
      }
      return value
    })

  const result: McpServerConfig = {
    ...config,
    command: one(config.command),
    ...(config.args ? { args: config.args.map(one) } : {}),
    ...(config.env
      ? { env: Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, one(value)])) }
      : {}),
    ...(config.cwd ? { cwd: one(config.cwd) } : {}),
  }
  if (missing.size > 0) {
    const names = [...missing].join(", ")
    return `refers to ${names}, which ${missing.size > 1 ? "are" : "is"} not set in this environment`
  }
  return result
}
