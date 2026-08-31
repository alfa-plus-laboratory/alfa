/**
 * 子进程环境变量白名单。
 *
 * ── 为什么必须有 ──
 * 这是路径门卫**完全管不到的旁路**。你 deny 了读 `~/.aws/credentials`,
 * 但 `printenv`、`echo $AWS_SECRET_ACCESS_KEY`、`node -p process.env` 一样能
 * 把凭据拿出来。opencode 是 `{...process.env}` 直接透传,等于门卫在这条路上
 * 完全不设防。
 *
 * ── 策略 ──
 * 默认只传「跑命令必需」的那一小撮,其余全砍。用户可以用
 * ALFA_ENV_ALLOW="FOO,BAR_*" 追加。
 *
 * ── 已知代价 ──
 * 会撞到「某个命令在 agent 里跑不通、在我自己终端里跑得通」这类问题。
 * 所以:(a) 白名单可扩展;(b) 被砍掉的变量名会记进 debug 日志,方便排查。
 */
import { logger } from "../util/log.ts"
import { readEnv } from "./vars.ts"

const log = logger("env")

/** 精确匹配的必需项。 */
const EXACT = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "TERM",
  "TZ",
  "TMPDIR",
  "LANG",
  "COLORTERM",
  "EDITOR",
  "PAGER",
])

/** 前缀匹配的必需项。 */
const PREFIXES = [
  "LC_", // 本地化
  "XDG_", // 目录规范
]

/**
 * Windows 上另外必需的那一批(名字按大写比,见 isAllowed)。
 *
 * ── 为什么单列一张表 ──
 * 上面那张表是照着 POSIX 写的,而 Windows 上同一件事换了个名字:PATH 是 `Path`、
 * 家目录是 `USERPROFILE`、临时目录是 `TEMP`。**而且 Windows 的环境变量名大小写
 * 不敏感**,`Set` 的精确匹配在那边本来就是个错误前提 —— `EXACT.has("Path")` 是
 * false,于是子进程连 PATH 都拿不到,任何命令都是"不是内部或外部命令"。这正是
 * 「模型说它几乎所有命令都不能用」的另一半原因(另一半见 env/shell.ts)。
 *
 * ── 有几个不给就跑不起来,不是"给了更方便" ──
 * SystemRoot / windir 少一个,凡是用了 winsock 的程序(git、npm、node 全在内)
 * 会以一句莫名其妙的初始化失败退出;PATHEXT 少了就找不到 .cmd 和 .exe;
 * PSModulePath 少了 PowerShell 连自己的内置命令都加载不出来。
 */
const WINDOWS_EXACT = new Set([
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "OS",
  "PSMODULEPATH",
  "DRIVERDATA",
  // Git for Windows 的 bash 靠这两个知道自己是哪一套 MSYS 环境
  "MSYSTEM",
  "MSYS",
])

/**
 * 常用开发工具链变量 —— 砍掉它们会造成大量「在我这跑得通」的困惑,
 * 而它们本身不含凭据。
 */
const TOOLCHAIN = [
  "NODE_", // NODE_OPTIONS / NODE_ENV(注意:不含 NODE_AUTH_TOKEN,见 DENY)
  "npm_config_", // npm 的配置注入
  "PYTHON",
  "VIRTUAL_ENV",
  "CONDA_",
  "JAVA_HOME",
  "GOPATH",
  "GOROOT",
  "GOFLAGS",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "BUN_INSTALL",
  "PNPM_HOME",
  "NVM_",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
]

/**
 * 黑名单优先于所有白名单 —— 哪怕名字撞上了 TOOLCHAIN 前缀也砍掉。
 * 这是「白名单里混进敏感项」的兜底。
 */
const DENY_SUBSTRINGS = ["TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "PRIVATE_KEY", "APIKEY", "API_KEY", "SESSION_KEY"]

const DENY_PREFIXES = ["AWS_", "GOOGLE_", "GCP_", "AZURE_", "GITHUB_", "GH_", "GITLAB_", "NPM_", "DOCKER_", "KUBE_", "OPENAI_", "ANTHROPIC_"]

export interface BuildEnvResult {
  env: Record<string, string>
  /** 被砍掉的变量名,给 debug 日志与 --verbose 用 */
  dropped: string[]
}

export function buildChildEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): BuildEnvResult {
  const windows = platform === "win32"
  const extra = parseExtraAllow(readEnv("ENV_ALLOW", source), windows)
  const env: Record<string, string> = {}
  const dropped: string[] = []

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (isAllowed(key, extra, windows)) env[key] = value
    else dropped.push(key)
  }

  if (dropped.length > 0) log.debug(`dropped ${dropped.length} env vars`, dropped)
  return { env, dropped }
}

/**
 * @param windows Windows 上一律**按大写比**。那边的环境变量名大小写不敏感,
 *   同一个 PATH 在不同进程里可能叫 `Path`、`PATH` 或 `path` —— 按原样比的话,
 *   放行与否取决于是谁起的这个进程,这不是一个白名单该有的行为。POSIX 上照旧
 *   区分大小写:那边 `path` 和 `PATH` 本来就是两个变量。
 */
function isAllowed(key: string, extra: { exact: Set<string>; prefixes: string[] }, windows: boolean): boolean {
  const upper = key.toUpperCase()
  const has = (set: Set<string>) => (windows ? set.has(upper) : set.has(key))
  const startsWithAny = (list: string[]) =>
    list.some((p) => (windows ? upper.startsWith(p.toUpperCase()) : key.startsWith(p)))

  // 用户显式追加的最优先(他自己知道在干什么)
  if (has(extra.exact)) return true
  if (startsWithAny(extra.prefixes)) return true

  // 黑名单压过所有内置白名单
  if (DENY_SUBSTRINGS.some((s) => upper.includes(s))) return false
  if (DENY_PREFIXES.some((p) => upper.startsWith(p))) return false

  if (has(EXACT)) return true
  if (windows && WINDOWS_EXACT.has(upper)) return true
  if (startsWithAny(PREFIXES)) return true
  if (startsWithAny(TOOLCHAIN)) return true
  return false
}

/**
 * ALFA_ENV_ALLOW="FOO,BAR_*"
 *
 * Windows 上把用户写的也折成大写:那边变量名大小写不敏感,而一个人写
 * `ALFA_ENV_ALLOW=Path` 却发现没生效,是没法自己查出原因的。
 */
function parseExtraAllow(raw: string | undefined, windows = false): { exact: Set<string>; prefixes: string[] } {
  const exact = new Set<string>()
  const prefixes: string[] = []
  if (!raw) return { exact, prefixes }
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const name = windows ? entry.toUpperCase() : entry
    if (name.endsWith("*")) prefixes.push(name.slice(0, -1))
    else exact.add(name)
  }
  return { exact, prefixes }
}
