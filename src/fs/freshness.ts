/**
 * 「读过没有、读完之后变了没有」的账本。
 *
 * ── 它挡的是一类**不报错**的失败 ──
 * edit 的匹配是带模糊级联的(见 tool/edit/replace.ts):精确匹配不中就退到
 * 去缩进匹配、锚点匹配……这套级联的存在意义是容忍模型抄错几个空格,代价是
 * 它**很能凑合**。于是两件事会变成静默的数据损坏:
 *
 *   1. 模型压根没读过这个文件 —— 压缩之后手里只剩一段摘要,或者干脆凭上一场
 *      的记忆,构造出一段「看起来像」的 oldString,级联给它匹配到了一个相似
 *      但不是那处的地方。
 *   2. 读过,但读完之后文件被别人改了 —— 另一个窗口、formatter、git checkout、
 *      它自己刚跑的一条 `sed -i`。它按旧内容构造的 oldString 落在新内容上。
 *
 * 两种情况的共同点是**没有任何东西会报错**:文件被改坏了,diff 看起来还挺
 * 合理,单测下一次跑才炸,而那时候已经隔了十几步。所以这道闸门不是「严格
 * 一点更好」,它是把一类无声的错误换成一条会说话的错误。
 *
 * ── 为什么是 stat 不是内容哈希 ──
 * read 是**流式按行**读的,还可能中途撞上 50KB 字节上限提前停 —— 拿不到
 * 「整个文件的字节」来算哈希。而 stat 只要一次 syscall,edit/write 那边本来
 * 就要 stat 一次判目录。
 *
 * 代价是 `touch` 一下(内容没变)也会被判过期。误伤的方向是安全的:多读一遍
 * 文件而已,而提示里写清楚了该干什么。反过来漏放一次就是改坏一个文件。
 *
 * ── 部分读也算读过 ──
 * offset/limit 读了一段、或者撞上限被截断,一样记账。不然超过 2000 行的文件
 * 就永远改不了 —— 而「大文件不能改」比「凭半个文件改」更常见也更难绕过。
 * 真正兜底的是 edit 那边的唯一匹配要求:oldString 在整个文件里必须只命中一处。
 *
 * ── 状态在进程里,换会话要显式清 ──
 * 和 fs/mutex.ts 一样是模块级的 Map。它记的是「模型脑子里有什么」,所以
 * `/clear`、`/resume`、`/compact` 之后都要 forgetReads() —— 那三下之后,
 * 文件内容确实已经不在它的上下文里了。
 *
 * ── ★ 账本按**会话**分,不是按路径一本大账 ──
 * 「读过没有」问的是**谁**读过。子 agent 有自己的一场会话、自己的上下文
 * (见 agent/subagent.ts),它读过 foo.ts 跟主 agent 手里有没有 foo.ts 的内容
 * 毫无关系。一本大账的后果是:后台一个侦察兵读过的文件,主 agent 可以不读
 * 直接改 —— 而这道闸门防的正是"没读过就改"时模糊匹配落在错的地方那种
 * **不报错**的损坏。反过来也一样:主 agent 读过不该让子 agent 蒙混过关。
 */
import { statSync } from "node:fs"

export interface FileStamp {
  mtimeMs: number
  size: number
}

/** 没读过 / 读完又变了。单独一个类型,便于上层区分「模型的错」和「工具坏了」。 */
export class StaleFileError extends Error {
  readonly path: string
  constructor(path: string, message: string) {
    super(message)
    this.name = "StaleFileError"
    this.path = path
  }
}

/** sessionID → (path → 印记)。见文件头那颗星:读过没有问的是**谁**读过 */
const ledgers = new Map<string, Map<string, FileStamp>>()

function ledgerOf(sessionID: string): Map<string, FileStamp> {
  let ledger = ledgers.get(sessionID)
  if (!ledger) {
    ledger = new Map<string, FileStamp>()
    ledgers.set(sessionID, ledger)
  }
  return ledger
}

/** 取一份印记。文件不在 / 读不了时返回 undefined,由调用方决定怎么办。 */
export function stampOf(path: string): FileStamp | undefined {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return undefined
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return undefined
  }
}

/**
 * 记一笔「这个文件现在长这样,而且模型看过了」。
 *
 * ⚠ read 那边要传**读之前**取的印记:文件如果在流式读的过程中被改了,记下
 * 新印记就等于宣称「它看到的是新内容」,而它看到的其实是新旧各一半。记旧的
 * 印记,下一次 edit 会判过期让它重读 —— 又是往安全的方向偏。
 */
export function noteRead(sessionID: string, path: string, stamp = stampOf(path)): void {
  if (!stamp) return
  ledgerOf(sessionID).set(path, stamp)
}

/**
 * 改之前的闸门。没读过、或者读完之后盘上的东西变了,就抛。
 *
 * 调用方必须已经确认过文件存在(edit/write 都在自己的存在性检查之后调)——
 * 这里 stat 不到就直接放行,那种情况下紧接着的读盘会自己报出更准确的错。
 */
export function assertFresh(
  sessionID: string,
  path: string,
  label: string,
  verb: "edit" | "overwrite",
): void {
  const now = stampOf(path)
  if (!now) return

  const seen = ledgerOf(sessionID).get(path)
  if (!seen) {
    throw new StaleFileError(
      path,
      `Refusing to ${verb} ${label}: you have not read it yet. Call read on it first, then retry — ` +
        `a copy from an earlier session, a summary, or memory is not good enough, because the file may have changed since.`,
    )
  }
  if (seen.mtimeMs !== now.mtimeMs || seen.size !== now.size) {
    throw new StaleFileError(
      path,
      `Refusing to ${verb} ${label}: it changed on disk after you read it ` +
        `(another window, another tool, or a command you ran). ` +
        `Read it again, then redo this change against the current content.`,
    )
  }
}

/**
 * 忘掉全部。换会话(`/clear`、`/resume`)和压缩(`/compact`)之后调。
 *
 * 压缩那下容易被当成过度谨慎,其实是这三下里最必要的一次:压完之后模型手里
 * 只剩一段交接说明,而交接说明里常常写着「下一步:把 foo.ts 里的 X 改成 Y」。
 * 不清账本的话,它会照着那句话直接 edit —— 正是这个模块存在的理由。
 * 代价是一次重读,而且压缩的那段提示本来就写着「文件要重新读」。
 */
export function forgetReads(sessionID?: string): void {
  // 不给 id = 全清。`/clear` 和 `/resume` 走这条:换一场之后,连同那些子 agent
  // 的账一起作废(它们本来也已经被停掉了,见 cli/main.ts 的 stopAgents)
  if (sessionID === undefined) ledgers.clear()
  else ledgers.delete(sessionID)
}

/** 仅用于测试。 */
export function __ledgerSizeForTest(sessionID?: string): number {
  if (sessionID !== undefined) return ledgers.get(sessionID)?.size ?? 0
  let total = 0
  for (const ledger of ledgers.values()) total += ledger.size
  return total
}
