/**
 * 仓库快照 —— 告诉模型「这个仓库现在是什么样」:在哪条分支上、有什么没提交的
 * 改动、最近几次提交在做什么。
 *
 * ── 为什么它不在 <env> 里 ──
 * env 块进的是 system prompt,而 system 是整段请求里最长的那截可缓存前缀
 * (两个断点见 llm/to-model-messages.ts)。分支、工作区状态、最近的提交恰好是
 * 一场会话里变得最勤的三样东西 —— 模型自己 commit 一次就变一次。放进 system
 * 等于让每一次 commit 把 tools + system 几千 token 全部按原价重算,而换来的
 * 那点新鲜度,模型自己跑一条 `git status` 就有。
 *
 * 所以它走的是另一条路:和项目记忆一样,挂在一场会话第一句话上(见
 * agent/loop.ts)。历史只增不改 —— 挂上去的那段文本此后一个字都不会动,
 * 前缀稳定,缓存不受影响。
 *
 * ── 代价是它会过期,而且是模型自己动手让它过期的 ──
 * 所以块里第一句话就必须说清「这是快照、要准的自己去跑 git」。少了这一句,
 * 模型会拿着启动那一刻的 status 去回答"我改完了没" —— 那份 status 里根本
 * 没有它自己刚写的文件。
 */
import { isGitRepo } from "../fs/workspace.ts"

/** 最多列几行改动。再多就不是"这仓库什么状态",而是一份该自己去看的清单 */
const MAX_STATUS = 20
/** 最近几次提交。5 条足够看出这个分支在干什么,再多是在讲历史 */
const MAX_COMMITS = 5
/** 单行上限。提交标题偶尔会很长,而这里每一行都只是给个印象 */
const MAX_LINE = 120
/**
 * 单条 git 命令的时限。
 *
 * 一个巨大的仓库里 `git status` 能跑好几秒,而这段代码是在用户按下回车之后、
 * 请求发出之前跑的 —— 卡在这里的每一秒用户都在盯着一个没有反应的界面。
 * 超时就当没有:少一段背景不影响它干活,卡住会。
 */
const TIMEOUT_MS = 2000

export interface GitSnapshot {
  /** 分支名;detached 时是短 sha */
  head: string
  detached: boolean
  /** PR 的目标分支。推不出来就没有 —— 猜一个出来比不说更糟 */
  mainBranch?: string
  /** porcelain 的行,已经截到 MAX_STATUS */
  status: string[]
  /** 截断前一共几行。和 status.length 不等时要在块里说出来 */
  statusTotal: number
  commits: string[]
}

/**
 * 采一份快照。不是仓库、没装 git、命令超时 —— 一律返回 undefined,
 * 调用方据此整块不挂。
 */
export function collectGitSnapshot(root: string): GitSnapshot | undefined {
  // 先看一眼 .git 再动手:非仓库目录里跑四条 git 只为了拿四个失败,
  // 而 alfa 在非仓库目录里启动是常事(见 fs/workspace.ts 的兜底)
  if (!isGitRepo(root)) return undefined

  // symbolic-ref 而不是 rev-parse --abbrev-ref:后者在一个还没有任何提交的
  // 新仓库里直接报错,而"刚 git init 完"正是最需要有人说清现状的时刻
  const branch = run(["symbolic-ref", "--quiet", "--short", "HEAD"], root)
  const detached = branch === undefined
  const head = branch ?? run(["rev-parse", "--short", "HEAD"], root)
  if (head === undefined) return undefined // 两条都不成 = 这里不是能用的仓库

  const raw = run(["status", "--porcelain"], root) ?? ""
  const all = raw.split("\n").map(clip).filter((line) => line.length > 0)

  const log = run(["log", `--format=%h %s`, "-n", String(MAX_COMMITS)], root) ?? ""

  const main = mainBranch(root)
  return {
    head,
    detached,
    ...(main ? { mainBranch: main } : {}),
    status: all.slice(0, MAX_STATUS),
    statusTotal: all.length,
    commits: log.split("\n").map(clip).filter((line) => line.length > 0),
  }
}

/**
 * PR 该往哪儿开。
 *
 * 先问 origin/HEAD —— 那是远端自己说的默认分支,唯一权威的答案。它常常没有
 * (浅克隆、手动加的 remote 都不会设),再退回本地有没有 main / master。
 * 两条都没有就不写这一行:一个猜出来的目标分支会让模型把 PR 开到错的地方。
 */
function mainBranch(root: string): string | undefined {
  const remote = run(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], root)
  if (remote) return remote.replace(/^origin\//, "")
  for (const name of ["main", "master"]) {
    if (run(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], root)) return name
  }
  return undefined
}

/**
 * 拼成挂在第一句话上的那一段。
 *
 * 开头两句是**整块里最要紧的部分**:它是快照、它会过期、要准的自己去跑。
 * 剩下的都是可以被 git 重新问出来的事实,只有这两句不是。
 */
export function renderGitSnapshot(snapshot: GitSnapshot): string {
  const lines = [
    "<git-status>",
    "A snapshot of this repository, taken when the session started. It is never refreshed —",
    "your own edits and commits go straight past it. Run git yourself whenever the current",
    "state matters.",
    "",
    snapshot.detached
      ? `Current branch: (detached HEAD at ${snapshot.head})`
      : `Current branch: ${snapshot.head}`,
  ]
  if (snapshot.mainBranch) lines.push(`Main branch: ${snapshot.mainBranch}`)

  lines.push("")
  if (snapshot.statusTotal === 0) {
    lines.push("Working tree clean at that moment.")
  } else {
    lines.push(`Uncommitted changes (${snapshot.statusTotal}):`, ...snapshot.status)
    // 截掉的必须说出来。一份看着只有 20 个改动、实际有 300 个的 status,
    // 比没有 status 更容易让它下错判断("就这么点,一起提交了吧")
    const hidden = snapshot.statusTotal - snapshot.status.length
    if (hidden > 0) lines.push(`[... ${hidden} more file${hidden === 1 ? "" : "s"} not listed]`)
  }

  if (snapshot.commits.length > 0) {
    lines.push("", "Recent commits:", ...snapshot.commits)
  }
  lines.push("</git-status>")
  return lines.join("\n")
}

/** 采一份并拼好。没有仓库就返回 undefined —— 调用方整块不挂 */
export function gitContextBlock(root: string): string | undefined {
  const snapshot = collectGitSnapshot(root)
  return snapshot ? renderGitSnapshot(snapshot) : undefined
}

/**
 * 跑一条只读的 git,拿 trim 过的 stdout。非 0 退出、超时、没装 git 一律
 * undefined —— 这一整块都是加分项,任何一条不成都不该让会话起不来。
 *
 * ★ GIT_OPTIONAL_LOCKS=0:`git status` 默认会顺手刷新索引,那要拿
 *   .git/index.lock。用户很可能正在另一个终端里 rebase,而我们只是来看一眼 ——
 *   一次只读的一瞥不该和人抢锁,更不该往人家仓库里写东西。
 */
function run(args: string[], cwd: string): string | undefined {
  try {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
      timeout: TIMEOUT_MS,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    })
    if (!proc.success) return undefined
    // ★ 只削尾巴,**不能**削头。porcelain 的头两列是状态码,而 " M" 和 "M " 是
    //   两件事(改了没暂存 / 暂存了)—— 整串 trim 一下,第一行的那个前导空格就
    //   没了,于是列表里第一个文件永远显示成已暂存。这种错不会报错,只会让它
    //   在一个它以为已经 add 过的文件上直接 commit
    const text = proc.stdout.toString().trimEnd()
    return text.trim().length > 0 ? text : undefined
  } catch {
    return undefined
  }
}

function clip(line: string): string {
  const text = line.trimEnd()
  return text.length > MAX_LINE ? text.slice(0, MAX_LINE - 1) + "…" : text
}
