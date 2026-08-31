/**
 * 启动时的"有新版了"提示。
 *
 * ── 三条自我约束 ──
 *
 * 1. **绝不拖慢启动。** 检查是后台跑的,横幅不等它。等回来时横幅早画完了,
 *    所以那一行是**补在后面**的一条收据,而不是横幅的一部分。一个为了报喜
 *    而让每次启动多花两秒的功能,净值是负的。
 *
 * 2. **一天最多问一次。** 结果缓存在数据目录里。一个人一天开二十次终端,
 *    二十次网络请求换来的是同一句话。
 *
 * 3. **只说,不装。** 自动更新意味着"我今天用的还是不是昨天那个程序"这件事
 *    没有答案,而这是个会动用户文件的工具。什么时候换由用户敲 `alfa upgrade`。
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { dataDir } from "../util/xdg.ts"
import { isNewer, latestRelease, VERSION } from "./release.ts"

const CACHE_FILE = "update-check.json"
/** 两次询问之间至少隔多久 */
const INTERVAL_MS = 24 * 60 * 60 * 1000

interface Cache {
  /** 上次问的时间 */
  at: number
  /** 上次问到的版本 */
  version: string
}

/**
 * 问一次(或者用缓存里的答案)。有更新就返回版本号,否则 undefined。
 *
 * @param now 注入用,测试里固定住
 */
export async function checkForUpdate(options: { now?: number; force?: boolean } = {}): Promise<string | undefined> {
  const now = options.now ?? Date.now()
  const path = join(dataDir(), CACHE_FILE)
  const cached = read(path)

  if (!options.force && cached && now - cached.at < INTERVAL_MS) {
    return isNewer(cached.version, VERSION) ? cached.version : undefined
  }

  const latest = await latestRelease()
  // 问不到就**更新时间戳**:网络不通的时候每次启动都去撞一下,是在给一个
  // 已经很糟的处境(离线)再加一份延迟
  write(path, { at: now, version: latest?.version ?? cached?.version ?? VERSION })
  if (!latest) return undefined
  return isNewer(latest.version, VERSION) ? latest.version : undefined
}

function read(path: string): Cache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Cache>
    if (typeof parsed.at !== "number" || typeof parsed.version !== "string") return undefined
    return { at: parsed.at, version: parsed.version }
  } catch {
    return undefined
  }
}

function write(path: string, cache: Cache): void {
  try {
    writeFileSync(path, JSON.stringify(cache))
  } catch {
    // 写不进去(只读的家目录、磁盘满)—— 那就每次都问,不值得为它报错
  }
}
