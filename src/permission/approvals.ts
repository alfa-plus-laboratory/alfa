/**
 * 「以后不再问」的落盘。
 *
 * ── 为什么第一版刻意不落盘,现在又落了 ──
 * 不落盘的理由是「进程退出即忘更安全」。半年下来这条的真实效果是:同一个仓库里
 * `npm test` 每天要重新批准一遍,而**每天点十次同一个 y,人就不再看那个框了**。
 * 一个被训练成条件反射的确认框,比一条记住了的规则危险得多。
 *
 * 所以落盘,但代价用三件事换回来:
 *   ① 按工作区分开存 —— 规则里的路径是**相对工作区**的(见 narrowAlways),
 *      混在一起的话,在 A 仓库批的 `src/*` 会在 B 仓库生效,而两个 src 毫无关系
 *   ② 只存 allow —— 文件里没有 action 字段,所以手改这个文件不可能造出一条
 *      deny,也不可能把一条 ask 变成别的东西
 *   ③ 看得见、删得掉 —— `/permission` 列出来,`/permission forget` 清空。
 *      一个存下来却查不到也撤不掉的安全决定,比不存更糟
 *
 * ── 为什么在 dataDir 不在 configDir ──
 * config.json 是「可以进 dotfiles 仓库、可以贴给同事」的东西(见 config.ts)。
 * 这份不是:它是这台机器上这几个目录的历史决定,跟着人走只会在别人机器上
 * 放行一些他没看过的命令。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { ensureDirSync } from "../fs/dir.ts"
import { dirname, join } from "node:path"
import { dataDir } from "../util/xdg.ts"
import type { Rule, Ruleset } from "./rules.ts"

/** 一条存下来的放行。action 恒为 allow,所以不进文件 —— 见文件头 ②。 */
export interface ApprovalRecord {
  permission: string
  pattern: string
  /** 批准的时刻。列出来时写「3 天前」用 */
  time: number
}

/** 每个工作区最多记这么多。超了丢最老的 —— 老到记不起是为什么批的,就该重问一次 */
const MAX_PER_WORKSPACE = 200
/** 一共记多少个工作区。超了丢最久没动的那个 */
const MAX_WORKSPACES = 64

export function approvalsPath(): string {
  return join(dataDir(), "approvals.json")
}

/**
 * 读这个工作区存下来的放行。
 *
 * 文件坏了 / 读不了一律返回空:丢掉几条放行的代价是再点几次 y,而为了一个
 * 缓存文件在启动时炸掉是完全不成比例的。
 */
export function loadApprovals(root: string, path = approvalsPath()): ApprovalRecord[] {
  const all = readFile(path)
  const list = all[root]
  if (!Array.isArray(list)) return []
  return list.filter(isUsable).slice(-MAX_PER_WORKSPACE)
}

/**
 * 追加几条并落盘。**失败不抛** —— 用户按的是「以后不再问」,不是「写文件」。
 * 数据目录只读(容器里挂只读卷是常见的)时,这一次照常放行,只是下次还会问。
 */
export function rememberApprovals(root: string, rules: Ruleset, path = approvalsPath()): void {
  const fresh = rules
    .filter((rule) => rule.action === "allow")
    .map((rule): ApprovalRecord => ({ permission: rule.permission, pattern: rule.pattern, time: Date.now() }))
    .filter(isUsable)
  if (fresh.length === 0) return

  try {
    const all = readFile(path)
    const kept = (all[root] ?? []).filter(isUsable).filter((old) => !fresh.some((one) => same(one, old)))
    all[root] = [...kept, ...fresh].slice(-MAX_PER_WORKSPACE)
    writeFile(path, evict(all))
  } catch {
    // 见上:记不住比中断当前操作好
  }
}

/** 清空这个工作区的全部放行,返回清掉了几条。 */
export function forgetApprovals(root: string, path = approvalsPath()): number {
  try {
    const all = readFile(path)
    const count = (all[root] ?? []).filter(isUsable).length
    if (count === 0) return 0
    delete all[root]
    writeFile(path, all)
    return count
  } catch {
    return 0
  }
}

/** 存下来的记录 → 门卫认识的规则。action 在这里补上,而且只可能是 allow。 */
export function toRuleset(records: readonly ApprovalRecord[]): Ruleset {
  return records.map((record): Rule => ({ permission: record.permission, pattern: record.pattern, action: "allow" }))
}

// ───────────────────────────────────────────── 私有

type Stored = Record<string, ApprovalRecord[]>

/**
 * 一条记录能不能用。
 *
 * `permission: "*"` 一律丢掉:它不可能是这个程序自己写出来的(permission 永远
 * 来自某个真实工具的 id),出现就说明是手改的 —— 而那一条会把**将来新加的
 * 每一个工具**都一并放行,包括用户从没见过的那些。
 */
function isUsable(record: unknown): record is ApprovalRecord {
  if (!record || typeof record !== "object") return false
  const value = record as Record<string, unknown>
  if (typeof value["permission"] !== "string" || value["permission"].length === 0) return false
  if (value["permission"] === "*") return false
  if (typeof value["pattern"] !== "string" || value["pattern"].length === 0) return false
  if (typeof value["time"] !== "number" || !Number.isFinite(value["time"])) return false
  return true
}

function same(a: ApprovalRecord, b: ApprovalRecord): boolean {
  return a.permission === b.permission && a.pattern === b.pattern
}

function readFile(path: string): Stored {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const workspaces = (parsed as Record<string, unknown>)["workspaces"]
    if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) return {}
    return workspaces as Stored
  } catch {
    return {}
  }
}

function writeFile(path: string, workspaces: Stored): void {
  ensureDirSync(dirname(path))
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify({ version: 1, workspaces }, null, 2) + "\n")
  renameSync(tmp, path)
}

/** 工作区太多时丢最久没动过的那些 —— 删掉的仓库不该永远占着位置。 */
function evict(all: Stored): Stored {
  const roots = Object.keys(all)
  if (roots.length <= MAX_WORKSPACES) return all
  const newest = (root: string) => (all[root] ?? []).reduce((max, one) => Math.max(max, one.time), 0)
  const kept = roots.sort((a, b) => newest(b) - newest(a)).slice(0, MAX_WORKSPACES)
  const out: Stored = {}
  for (const root of kept) out[root] = all[root] ?? []
  return out
}
