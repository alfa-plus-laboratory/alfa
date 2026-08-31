/**
 * 「这个文件夹怎么用 alfa」—— 读、写、以及信任那一格。
 *
 * ── 为什么单独一个文件 ──
 * config.ts 只管**这份 JSON 长什么样**(解析、报错说人话)。这里管的是
 * **它对一次运行意味着什么**:第一次来吗、面板开不开、这个目录该不该让它
 * 里面的说明文件对模型说话。两件事混在一起的话,config.ts 会慢慢变成一个
 * 什么都知道的东西 —— 而它现在是全程序唯一能被用户手改的文件的守门人。
 *
 * ── ★ 键是工作区根,不是 cwd ──
 * 在 `repo/src/api` 里启动和在 `repo/` 里启动是**同一个仓库**,偏好和信任
 * 都该是同一条。按 cwd 存的话,一个仓库能攒出十几条互相矛盾的记录,而用户
 * 只会觉得"它有时候有文件树有时候没有"。
 *
 * ── 信任判断在这里 fail closed ──
 * `checking`(还没看完)按**不信任**算。反过来的话,那几秒钟里项目的
 * AGENTS.md 已经进了 system prompt —— 而那正是我们要看一眼的东西。
 */
import { readdirSync } from "node:fs"
import { resolve } from "node:path"
import {
  loadConfig,
  saveConfig,
  configPath,
  type Config,
  type FolderConfig,
  type TrustState,
  type ViewMode,
} from "./config.ts"

/** 今天。`YYYY-MM-DD` —— 存下来是给人看的,不参与判断 */
export function today(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/**
 * 这个文件夹在配置里的键。
 *
 * 只做 resolve,**不做 realpath**:一个 symlink 进去的工作区在用户眼里就是
 * 他敲的那个路径,把它换成解析后的真路径,他在配置文件里就再也找不到自己
 * 那一条了。而这张表是给人读、给人手改的。
 */
export function folderKey(root: string): string {
  return resolve(root)
}

export function folderConfig(root: string, config: Config): FolderConfig | undefined {
  return config.folders?.[folderKey(root)]
}

/** 开场那张卡片问过了没有。见 cli/folder-setup.ts */
export function isFirstVisit(root: string, config: Config): boolean {
  return folderConfig(root, config)?.seenAt === undefined
}

/**
 * 这一趟中间栏画什么。
 *
 * 文件夹自己的 > 全局的 > session。三层是因为它们回答的是三个不同的问题:
 * 「这个仓库要什么」「我一般要什么」「没人说过话时要什么」。
 */
export function viewFor(root: string, config: Config): ViewMode {
  return folderConfig(root, config)?.view ?? config.view ?? "session"
}

/**
 * 左右两栏开不开。
 *
 * ★ 缺省 **false**,但只对**问过的文件夹**成立 —— 没有记录的那些走 `fallback`。
 *   这个区分是为了升级:这个功能上线之前所有人的界面都是三栏的,而
 *   「装了个新版本,文件树没了」是一次没人要过的改动。第一次进来那张卡片
 *   会问,问过之后就按他自己说的算。
 */
export function panelsFor(root: string, config: Config, fallback = true): boolean {
  const folder = folderConfig(root, config)
  if (!folder) return fallback
  return folder.panels ?? false
}

/** 信任状态。没记录 = 还没问过,按信任走(见文件头) */
export function trustFor(root: string, config: Config): TrustState {
  return folderConfig(root, config)?.trust ?? "trusted"
}

/**
 * 项目里的说明文件(AGENTS.md / CLAUDE.md …)这一趟能不能进 system prompt。
 *
 * ⚠ `checking` 算**不能**。那几秒钟里正好是我们派人去读那些文件的时候,
 *   一边看一边已经照着做了的话,这道检查等于没有。
 */
export function trustsProjectInstructions(root: string, config: Config): boolean {
  return trustFor(root, config) === "trusted"
}

/**
 * 落盘。**失败不抛** —— 和 config.ts 里那一串 remember* 同一条理由:
 * 用户按的是「用这个排布」,不是「写配置文件」。
 */
function update(root: string, mutate: (folder: FolderConfig) => void, path = configPath()): void {
  try {
    const config = loadConfig(path)
    const key = folderKey(root)
    const folder = { ...config.folders?.[key] }
    mutate(folder)
    config.folders = { ...config.folders, [key]: folder }
    saveConfig(config, path)
  } catch {
    // 记不住比中断当前操作好
  }
}

export interface FolderChoice {
  view: ViewMode
  panels: boolean
  trust: TrustState
}

/** 开场那张卡片的答案。`seenAt` 就是「问过了」的标记 —— 见 isFirstVisit */
export function rememberFolder(root: string, choice: FolderChoice, path = configPath()): void {
  update(
    root,
    (folder) => {
      folder.view = choice.view
      folder.panels = choice.panels
      folder.trust = choice.trust
      folder.seenAt = today()
      if (choice.trust === "trusted") folder.trustedAt = today()
      else delete folder.trustedAt
    },
    path,
  )
}

/**
 * 打上(或撤掉)信任标记。
 *
 * 日期跟着一起写。这个日期不参与任何判断,它存在只为了回答一个问题:
 * **这是我什么时候放行的?** 一条没有日期的许可,一年之后没有人说得清它是
 * 当初想清楚了给的,还是某天手滑按出来的。
 */
export function markTrust(root: string, trust: TrustState, path = configPath()): void {
  update(
    root,
    (folder) => {
      folder.trust = trust
      if (trust === "trusted") folder.trustedAt = today()
      else delete folder.trustedAt
    },
    path,
  )
}

/** `/view` 换过之后记在这个文件夹名下 —— 它问的是"这个仓库要什么" */
export function rememberFolderView(root: string, view: ViewMode, path = configPath()): void {
  update(root, (folder) => void (folder.view = view), path)
}

export function rememberFolderPanels(root: string, panels: boolean, path = configPath()): void {
  update(root, (folder) => void (folder.panels = panels), path)
}

/**
 * 这个目录是不是「空的」。空的就不问信任 —— 里面没有任何东西能对模型说话。
 *
 * ★ 判据是**目录项**,不是"有没有 AGENTS.md"。后者看着更准,其实更糟:
 *   一个装满源码、只是恰好没写 AGENTS.md 的陌生仓库会被当成空的,而它的
 *   `.alfa/mcp.json`、构建脚本、README 里的注入照样在那儿。
 *
 * `.git` 不算 —— `git init` 完的新目录在用户眼里就是空的,而它确实是。
 * 读不动(权限、目录不存在)时返回 false:**不确定就当它不空**,那一侧
 * 多问一句,另一侧是悄悄放行。
 */
export function isEmptyFolder(root: string, readdir: (dir: string) => string[] = readdirSync): boolean {
  try {
    return readdir(root).filter((name) => name !== ".git").length === 0
  } catch {
    return false
  }
}
