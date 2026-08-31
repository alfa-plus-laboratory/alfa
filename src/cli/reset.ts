/**
 * `/reset` —— 把这台机器上属于 alfa 的东西全部删掉,回到刚装完的状态。
 *
 * ── 它是给「再走一遍第一次」用的 ──
 * 引导、`auth login`、模型发现这几条路,只有在**什么都没有**的时候才走得到。
 * 没有这条命令的话,想再试一次就得手敲两条 rm -rf 路径 —— 而那两条路径敲错一个
 * 字母的后果,比这条命令本身危险得多。
 *
 * ── 两段确认,不是一段 ──
 * 第一段只**列出**要删什么:每个目录、多大、里面有什么(那把 key、几场会话)。
 * 第二段才动手。理由是这件事**不可撤销**,而列表是唯一能让人在按下去之前发现
 * "等等,那里面还有我不想丢的东西"的机会 —— 一个 y/N 提示给不了这个机会。
 *
 * ── 为什么删完要退出 ──
 * 进程手里攥着已经解析好的模型、打开着的 sessions.db、装好的注册表。文件没了而
 * 这些还在,程序会进入一个"看起来正常、其实每一步都在对着不存在的东西操作"的
 * 状态 —— 那比直接退出难查得多。
 *
 * ── ★ 删除必须发生在 store.close() 之后 ──
 * SQLite 关库时会做 WAL checkpoint。库文件被删了它照写不误 —— 于是刚删掉的
 * sessions.db 又躺回原地,而用户以为自己重置干净了。所以这个模块只负责
 * "算出要删什么"和"删",**什么时候删由 main.ts 在收尾之后决定**。
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { ALFA_DIR } from "../prompt/init.ts"
import { configDir, dataDir } from "../util/xdg.ts"

export interface ResetTarget {
  path: string
  /** 给人看的一句话:这里面是什么 */
  what: string
  /** 占多少字节。目录就递归加起来 */
  bytes: number
  /** 里面有没有 API key。有的话确认那一屏要单独说 */
  hasCredentials?: boolean
}

export interface ResetScope {
  /** 全局:配置目录 + 数据目录 */
  global: ResetTarget[]
  /** 当前项目里的 .alfa/(便条、脚手架)。只有 `/reset all` 才碰 */
  project: ResetTarget[]
}

/**
 * 算出要删什么。**只看,不动**。
 *
 * 不存在的目录不列:一份写着"(不存在)"的清单会把真正要删的那两行淹掉。
 */
export function resetScope(root: string): ResetScope {
  const config = configDir()
  const data = dataDir()
  const project = join(root, ALFA_DIR)

  const global: ResetTarget[] = []
  if (existsSync(config)) {
    global.push({ path: config, what: "settings, and the global AGENTS.md if you wrote one", bytes: sizeOf(config) })
  }
  if (existsSync(data)) {
    global.push({
      path: data,
      what: "API keys, every session, input history, saved tool output",
      bytes: sizeOf(data),
      hasCredentials: existsSync(join(data, "auth.json")),
    })
  }

  const inProject: ResetTarget[] = []
  if (existsSync(project)) {
    inProject.push({ path: project, what: "notes this agent wrote about this project", bytes: sizeOf(project) })
  }
  return { global, project: inProject }
}

/**
 * 真删。返回删掉了哪几个。
 *
 * 单个失败不中断:删了一半又报错退出的话,用户处在一个比开始时更糟的状态,
 * 而且不知道糟在哪。哪个没删掉照实报出来,他自己 rm 一下就是了。
 */
export function performReset(targets: ResetTarget[]): { removed: string[]; failed: Array<{ path: string; why: string }> } {
  const removed: string[] = []
  const failed: Array<{ path: string; why: string }> = []
  for (const target of targets) {
    try {
      rmSync(target.path, { recursive: true, force: true })
      removed.push(target.path)
    } catch (error) {
      failed.push({ path: target.path, why: (error as Error).message })
    }
  }
  return { removed, failed }
}

/** 递归求和。算不动的当 0 —— 这个数只用来给人一个量级 */
function sizeOf(path: string): number {
  try {
    const stat = statSync(path)
    if (!stat.isDirectory()) return stat.size
    let total = 0
    for (const name of readdirSync(path)) total += sizeOf(join(path, name))
    return total
  } catch {
    return 0
  }
}
