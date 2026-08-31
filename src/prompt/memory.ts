/**
 * 项目记忆的**存取层**:`.alfa/memory/` 下一条便条一个文件。
 *
 * ── 和 AGENTS.md 的分工 ──
 * AGENTS.md 是**人写的**:这个项目怎么 build、怎么测、哪些约定不能破。它稳定、
 * 权威、改起来是一次有意识的动作。
 *
 * 便条是**模型写的**:用户第三次说「别自动 commit」、那台机器上的服务得先起
 * 起来才跑得通测试、这个仓库的 lint 只有从根目录跑才认路。这些东西没人会专门
 * 去写进 AGENTS.md,但每一场重新踩一遍的代价是实打实的。
 *
 * ── 还有第三类:**这个项目做过什么决定,做到哪儿了** ──
 * 「什么时候该记」那张单子一度只有前两类(用户的规矩 + 环境的坑),于是每一场
 * 新会话开头,模型对这个项目的了解等于零 —— 它知道你不喜欢什么,不知道这里
 * 已经定过什么。而代码只说得出"它现在是这样",说不出"为什么不是那样"、
 * "什么已经试过了不行"、"哪一段是半截的、下一步本来要干什么"。这几件事重新
 * 推一遍的代价,是把整个仓库再读一遍,或者把同一个错再犯一次。
 *
 * ⚠ 这一类的纪律和前两类不一样:**一条线只准有一条便条,随着进展覆盖同一个
 *   名字**。一场一条的话它就成了变更日志 —— 而 git 已经有一份,再往每一场
 *   会话的开头塞一份只会把窗口吃光。见 tool/memory.ts 的说明。
 *
 * ── 它不进 system prompt ──
 * 一度是拼在 system prompt 尾巴上的。那样有三处不对:`/context` 里它混在
 * 「system 12k」那一坨里没法单独算账;system 每轮重发,而记忆装进来一次就够;
 * 最要紧的是**增删只能靠模型自己去 write 文件**,于是「它记住了什么」这件事
 * 没有一条属于自己的记录。
 *
 * 现在:内容由新会话第一句话上挂的一个 memory part 带进去(见 session/schema.ts),
 * 增删走一个显式的工具(见 tool/memory.ts)。这个文件只管文件系统那一半。
 *
 * ── 上限是必须的 ──
 * 便条只增不减的话,它会一直长到把上下文吃光,而且是**每一场**都吃。所以有三道
 * 闸:单条 4KB、合计 16KB、最多 24 条。撞上了要说出来 —— 一份悄悄少了几条的
 * 记忆,比没有记忆更难查。
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { noteRead } from "../fs/freshness.ts"
import { ALFA_DIR } from "./init.ts"

/** 相对项目根。`.alfa/` 是谁建的见 init.ts */
export const MEMORY_DIR = `${ALFA_DIR}/memory`

/** 单条上限。一条便条超过这个长度,它多半已经不是便条,而是该进 AGENTS.md 的东西 */
export const MAX_MEMO_BYTES = 4 * 1024
/** 全部便条合计上限 */
export const MAX_MEMORY_BYTES = 16 * 1024
/** 最多装几条 */
export const MAX_MEMOS = 24

export interface Memo {
  /** 相对项目根,形如 `.alfa/memory/no-auto-commit.md`。模型要照着它改 */
  name: string
  content: string
}

export interface MemorySet {
  memos: Memo[]
  /** 撞上限被挡在外面的条数。0 以外都要说出来 */
  dropped: number
}

/**
 * 读 `<root>/.alfa/memory/*.md`。
 *
 * 按文件名排序,不按时间:同样的一组文件每次拼出同样的一段文本 —— 一份会随
 * 读盘顺序抖动的历史,连 `/resume` 出来都可能不一样。
 */
/**
 * @param sessionID 装进**哪一场**的上下文。给了才记"读过"那一笔 —— 而那笔账
 *   是按会话分的(见 fs/freshness.ts 那颗星:读过没有问的是**谁**读过)。
 *   只是想数一数有几条(启动横幅、`memory list`)时不传。
 */
export function discoverMemories(root: string, sessionID?: string): MemorySet {
  const dir = join(root, MEMORY_DIR)
  let names: string[]
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .sort()
  } catch {
    return { memos: [], dropped: 0 } // 没这个目录 = 还没记过东西,不是错
  }

  const memos: Memo[] = []
  let dropped = 0
  let budget = MAX_MEMORY_BYTES
  for (const name of names) {
    if (memos.length >= MAX_MEMOS || budget <= 0) {
      dropped++
      continue
    }
    const path = join(dir, name)
    const file = readCapped(path, Math.min(MAX_MEMO_BYTES, budget))
    if (file === undefined) {
      // 空文件不算数,也不算被挡掉的 —— 它本来就没有内容可给
      continue
    }
    // ★ 装进上下文就是**读过了**:整份内容此刻就在模型眼前,而这正是改前先读
    //   那道闸要的东西(见 fs/freshness.ts)。不记账的话,模型用 edit 改自己的
    //   便条会被自己的闸拦下来,而它手里明明拿着当前内容。
    //   截断过的不记:它手里少了尾巴,照着写回去就是把尾巴删了。
    if (!file.truncated && sessionID !== undefined) noteRead(sessionID, path, file.stamp)
    budget -= Buffer.byteLength(file.content, "utf8")
    memos.push({ name: `${MEMORY_DIR}/${name}`, content: file.content })
  }
  return { memos, dropped }
}

interface CappedFile {
  content: string
  truncated: boolean
  /** 读**之前**取的。反过来的话,读和 stat 之间被改掉的那一次会被记成新的 */
  stamp: { mtimeMs: number; size: number }
}

function readCapped(path: string, cap: number): CappedFile | undefined {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return undefined
    const stamp = { mtimeMs: stat.mtimeMs, size: stat.size }
    const raw = readFileSync(path, "utf8").trim()
    if (raw.length === 0) return undefined
    // 截尾部:便条的要点在开头,而超长的那条本来就该被拆掉
    if (Buffer.byteLength(raw, "utf8") <= cap) return { content: raw, truncated: false, stamp }
    return { content: raw.slice(0, cap) + "\n[... truncated ...]", truncated: true, stamp }
  } catch {
    return undefined
  }
}

/**
 * 拼成挂在新会话第一句话上的那一段。没有便条就返回空串 —— 一段写着「(没有)」
 * 的文字每一场都在花钱讲一件不存在的事。
 *
 * 每条都带路径:模型要改一条的时候得知道改哪个。开头那句话必须说清**这是它
 * 自己写的** —— 它得敢改自己的便条,同时不敢动用户的 AGENTS.md。
 */
export function renderMemories(set: MemorySet): string {
  if (set.memos.length === 0) return ""
  const blocks = set.memos.map((memo) => `--- ${memo.name}\n${memo.content}`)
  const head = [
    "<project-memory>",
    "Notes you wrote about this project in earlier sessions, loaded automatically at the start of this one.",
    "They are yours: correct one the moment it turns out to be wrong, and delete one that has stopped being true.",
    "Use the memory tool to add, change or remove them.",
  ].join("\n")
  // 被挡掉的必须说。悄悄少几条的记忆比没有记忆更难查 —— 现象是「它上周还记得」
  const tail =
    set.dropped > 0
      ? `\n\n[${set.dropped} more note${set.dropped === 1 ? "" : "s"} not loaded — the folder is over its size limit. Merge or delete some with the memory tool.]`
      : ""
  return `${head}\n\n${blocks.join("\n\n")}${tail}\n</project-memory>`
}
