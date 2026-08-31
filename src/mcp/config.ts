/**
 * MCP server 的配置:定义在哪、长什么样、两处怎么合。
 *
 * ── 为什么 MCP 有项目级配置,而 alfa 本身没有 ──
 * `prompt/config.ts` 里明写着「没有项目级 config」,那条决定今天仍然成立:模型该用
 * 哪个 provider、窗口多大、检查命令是什么,是**这台机器**的事,跟着仓库走只会让
 * 同一个仓库在两台机器上表现不同。
 *
 * MCP 反过来 —— 一个仓库要接哪些 server 恰恰是**这个仓库**的属性:后端仓要 postgres,
 * 前端仓要 puppeteer,而这件事换台机器也不会变。让它只能写在家目录里,等于每个人
 * clone 完都得重配一遍,而且没人知道该配什么。
 *
 * 所以两边都读,但**不是同一个文件**:项目里那份叫 `.alfa/mcp.json`,只管 MCP。
 * 不复用 `config.json` 这个名字是刻意的 —— 那个名字在 `/init` 生成的说明里标着
 * "路线图不是功能",而且模型已经因为它在项目里翻过一次不存在的文件(见 2fbc861)。
 * 一个只装一件事的新名字,比一个含义已经被占掉的旧名字便宜。
 *
 * ── ★ 项目里的文件能指定要跑的进程 ──
 * 这是这份配置和其它所有配置的根本区别:`command` 是一条**执行路径**。clone 一个
 * 陌生仓库、进去敲 alfa,它里面的 `.alfa/mcp.json` 就能让我们起一个进程。
 * 所以每个来自项目的 server 都带着 `origin: "project"`,由接线层在第一次连它之前
 * 当面问一次(见 manager.ts)。这一层只负责**如实标明来路**,不做放行决定 ——
 * 判断留给看得见用户的那一层,而来路一旦在这里丢掉,后面就再也补不回来了。
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** 项目里那份配置的位置。相对仓库根。 */
export const PROJECT_MCP_PATH = join(".alfa", "mcp.json")

export interface McpServerConfig {
  /** 要跑的可执行文件。stdio server 的唯一起法 */
  command: string
  args?: string[]
  /** 追加到子进程环境里的变量。值里可以写 ${NAME} 引用当前环境 */
  env?: Record<string, string>
  /** 工作目录。不写就是仓库根 */
  cwd?: string
  /** 写 false 就是"定义留着但这次不连"。删掉配置和暂时关掉是两件事 */
  enabled?: boolean
}

export interface McpServerEntry extends McpServerConfig {
  name: string
  /**
   * 这份定义是哪来的。**project 的那些要当面问过才连**。
   *
   * `library` 是货架上被项目点名的那些:定义写在用户自己的家目录里,项目文件
   * 只写下一个名字。所以它**不需要 trust** —— 要跑的那条命令是用户自己敲进
   * 全局配置的,一个陌生仓库最多点到一个他没装的名字,而那只是一条 problem。
   */
  origin: "global" | "project" | "library"
  /** 定义所在的文件,报错时要说得出是哪一份 */
  source: string
}

/** 读不出来的那些。**不抛** —— 一份写坏的配置不该让整个程序起不来 */
export interface McpProblem {
  /** 说得出是哪个 server 就说,说不出(整份文件坏了)就是 undefined */
  name?: string
  source: string
  why: string
}

export interface McpConfigResult {
  servers: McpServerEntry[]
  problems: McpProblem[]
  /**
   * 货架上**这次没被点名**的那些名字。
   *
   * 存在的意义只有一个:让"存着不生效"这层看得见。一个翻不到的货架和没有货架
   * 没区别 —— 用户会忘了自己往里放过什么,然后在第二个项目里重新写一遍定义。
   * (skills 那边同理,见 SkillSet.library。)
   */
  shelf: string[]
}

/**
 * 合并两处配置。
 *
 * 同名时**项目那份赢** —— 更具体的那个赢是配置系统的通例,而且反过来会很难解释:
 * 用户在仓库里明明写了一份,而生效的是家目录里那份看不见的。
 *
 * 顺序稳定(按名字排),因为工具定义是 prompt 里最靠前的缓存前缀之一,顺序一抖
 * 整个 prompt cache 就 miss(同 tool/registry.ts 的那条注释)。
 */
export function loadMcpConfig(input: {
  /** 全局配置里的 mcp.servers 段。由 config/config.ts 解析出来后传进来 */
  global?: Record<string, McpServerConfig>
  /**
   * 全局配置里的 `mcp.library` 段 —— **货架**:定义在这儿,但不连。
   *
   * 和 skills 的货架是同一个形状,理由也一样:攒下来的 server 未必每个项目都要
   * (一个连生产库的、一个只在某个客户仓库里用的),而"每个项目都连"的代价是
   * 每轮都发的一堆工具定义 + 一堆没必要起的进程。要用的项目在自己那份
   * `.alfa/mcp.json` 里 `use: ["名字"]` 点它一下。
   */
  library?: Record<string, McpServerConfig>
  globalSource: string
  /** 仓库根。不在仓库里(或者没有那份文件)就只有全局那半 */
  root?: string
  /** 当前环境,用来展开 ${NAME}。测试里可以顶掉 */
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
         * ★ 先点名、后定义 —— 顺序在这儿是有意义的。
         *
         * 项目自己定义的那些(`servers`)照旧要 trust,因为它们带着一条要跑的
         * 命令。从货架点名的(`use`)不要,因为那条命令是用户自己写的。同名时
         * 让 `servers` 赢:一个项目既点了名又自己写了一份,它想要的显然是自己
         * 写的那份 —— 而且那份**会**过 trust,不存在"用点名绕过审批"这条路。
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
 * 把 `use: [...]` 点到的那几个从货架上取下来。
 *
 * ★ **只能点名,不能定义** —— 这是货架这层唯一的安全论证。项目文件里出现的
 *   是一个字符串,不是一条命令;要跑什么由用户家目录里那份配置说了算。所以
 *   一个陌生仓库能造成的最坏结果是"点到一个你没有的名字",而那只是一行提示。
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
      // 说清楚"货架上没有"而不是"配置错了":这条最常见的成因是换了台机器,
      // 而修法是往全局配置里补一份定义,不是改仓库里这个文件
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

/** 只读项目那一份。整份文件坏掉时返回一句人话,不抛。 */
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
    // 用户手改这个文件是被支持的用法,所以报错要说人话(同 config/config.ts)
    return `is not valid JSON — ${(error as Error).message}`
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return `must be a JSON object`
  const servers = (data as { servers?: unknown }).servers
  const use = (data as { use?: unknown }).use
  // 两个键都可以单独出现:只点名的项目不写 servers,只自定义的不写 use
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

/** 一条定义本身对不对。返回字符串就是"哪儿不对"。 */
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
 * 展开 `${NAME}`。
 *
 * ── 为什么必须有 ──
 * 几乎每个 server 都要一把 token,而项目里那份配置是**要进 git 的**。没有这个,
 * 用户只有两条路:把 key 明文写进仓库,或者不用项目级配置。
 *
 * ── 为什么变量缺失是**错误**而不是空字符串 ──
 * 空字符串会让 server 正常起来、然后在第一次调用时报一个跟原因毫无关系的鉴权错误。
 * 在这里说"${GITHUB_TOKEN} 没有设"要便宜得多。
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
