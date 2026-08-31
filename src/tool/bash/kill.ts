/**
 * 进程树终止。
 *
 * ── 为什么不能只 proc.kill() ──
 * `npm test` 会 fork 出一堆子进程,`sleep 60 &` 更是直接脱离。只杀直接子进程
 * 的话,Ctrl-C 之后 `pgrep` 还能看到一片孤儿,它们继续占 CPU、继续写文件。
 * 所以子进程必须 `detached: true` 起在**独立进程组**里,kill 时用负 pid 杀整组。
 *
 * ── ★ 直接子进程退出 ≠ 进程组空了 ──
 * 这是实测抓出来的逃生路径:
 *
 *   bash -c 'trap "" TERM; exec sleep 60' >/dev/null 2>&1 </dev/null & wait
 *
 * 外层 shell 不 trap,收到 SIGTERM 就死;孙进程 trap 住 TERM(而且 SIG_IGN
 * 会**跨 fork/exec 继承**,所以 sleep 也一起免疫),又把 stdio 重定向掉不再
 * 持有父进程的管道 —— 于是 ChildProcess 的 'close' 立刻触发,旧实现 2ms 就
 * 返回并宣布成功,而进程组里那个 sleep 一直活着。
 *
 * 所以等到直接子进程退出之后,还必须**再问一次进程组在不在**,在的话升级到
 * SIGKILL。SIGKILL 无法被忽略,这是最后一道。
 *
 * ── 退化路径必须有 ──
 * 某些容器 / PID namespace 下 detached 会失败,这时 `process.kill(-pid)` 抛
 * ESRCH。catch 住退化成只杀直接子进程 —— 杀不干净好过整个工具崩掉。
 * 这条退化路径是有测试覆盖的,不是聊胜于无的 try/catch。
 */
import { spawn, type ChildProcess } from "node:child_process"

/**
 * SIGTERM 到 SIGKILL 的宽限期。
 *
 * 取 300ms 而不是常见的 3s:验收标准要求 Ctrl-C 后 200ms 内回到提示符。
 * 正经程序收到 SIGTERM 后 300ms 足够收尾;赖着不走的本来也不会在 3s 内走。
 */
const SIGKILL_GRACE_MS = 300
/** SIGKILL 之后确认进程组消失的轮询上限。 */
const REAP_POLL_MS = 20
const REAP_MAX_POLLS = 10

/**
 * 这一次终结的结果。**必须有** —— 见 tool/job.ts:
 * 之前这里返回 void,于是"停了"是无条件报的,而它讲的其实只是
 * 「我们的管理记录已经标成完成」。用户真机上撞见的正是这个:
 * `job kill` 说 Stopped,端口还占着。
 */
export interface KillOutcome {
  /** 直接子进程真的没了(或者本来就没了) */
  stopped: boolean
  /** 没杀干净时,一句能照着查下去的话。杀干净了就没有 */
  detail?: string
}

export async function killGroup(proc: ChildProcess): Promise<KillOutcome> {
  const pid = proc.pid
  if (pid === undefined) return { stopped: true }

  // Windows 上没有进程组这回事,负 pid 也不是"整组"的意思 —— 上面那一整套
  // (SIGTERM → 等 → 确认组还在 → SIGKILL)在那边一句都不成立。见 killTree
  if (process.platform === "win32") return killTree(proc, pid)

  /**
   * 是否成功地对**进程组**发过信号。
   *
   * 只有这个为真时才允许后面用 -pid 发 SIGKILL:它证明了刚才那一刻 -pid 确实
   * 是一个我们有权限操作的进程组。没有这个证据就朝 -pid 开枪,万一 detached
   * 没生效、而这个数字恰好撞上别人的进程组,就是误杀无关进程。
   */
  let groupSignalled = false

  if (proc.exitCode === null && proc.signalCode === null) {
    groupSignalled = send(proc, pid, "SIGTERM")
    await raceExit(proc, SIGKILL_GRACE_MS)
  }

  // detached 没生效(已退化成只杀直接子进程),或者进来时进程就没了 —— 到此为止。
  // ★ 退化那条路上**我们并不知道杀干净没有**:只朝直接子进程发过信号,而它
  //   fork 出来的那些够不着。照实说,别报一个查不下去的"停了"
  if (!groupSignalled) {
    return gone(proc)
      ? { stopped: true }
      : { stopped: false, detail: "only the direct child could be signalled (no process group here)" }
  }
  if (!groupAlive(pid)) return { stopped: true }

  // 组里还有活的。SIGKILL 不可被捕获、不可被忽略。
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    return gone(proc) ? { stopped: true } : { stopped: false, detail: "SIGKILL to the process group failed" }
  }

  if (proc.exitCode === null && proc.signalCode === null) {
    await raceExit(proc, SIGKILL_GRACE_MS)
  }
  // 确认组真的空了再返回 —— Runner 的 drain() 靠这个保证"退出时没有孤儿"
  for (let i = 0; i < REAP_MAX_POLLS && groupAlive(pid); i++) {
    await delay(REAP_POLL_MS)
  }
  if (groupAlive(pid)) {
    return { stopped: false, detail: "the process group survived SIGKILL (a stuck uninterruptible child?)" }
  }
  return { stopped: true }
}

/** 直接子进程已经不在了吗 */
function gone(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null
}

/**
 * Windows 的那一半:`taskkill /T /F`。
 *
 * ── 为什么不能只 proc.kill() ──
 * 和 POSIX 那边同一个理由,只是手段不同:Node 在 Windows 上的 kill 只终结直接
 * 子进程,而 `cmd /c npm test` 里真正在跑的是它孙子那一层。`/T` 是"连同子孙"、
 * `/F` 是强制 —— 那边没有 SIGTERM 那种"先礼后兵",一个正在等 stdin 的控制台
 * 程序收不到任何可以优雅退出的信号。
 *
 * taskkill 自己起不来(PATH 被改过、精简版系统)就退化成只杀直接子进程 ——
 * 杀不干净好过整个工具崩掉,和 POSIX 那边的退化路径是同一条立场。
 */
async function killTree(proc: ChildProcess, pid: number): Promise<KillOutcome> {
  if (gone(proc)) return { stopped: true }
  // ★ taskkill 的退出码**必须看**。之前这里是 `once("close", () => resolve())`,
  //   成功和"拒绝访问"长得一模一样 —— 而上层照旧报"停了"。1 = 拒绝访问
  //   (提权进程、别人的会话),128 = 找不到这个 pid(那多半是它已经没了)
  let why: string | undefined
  try {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    const code = await new Promise<number | null>((resolve) => {
      killer.once("close", (value) => resolve(value))
      killer.once("error", () => resolve(null))
    })
    if (code === null) why = "taskkill could not be started"
    else if (code !== 0 && code !== 128) why = `taskkill exited with ${code}`
  } catch {
    why = "taskkill could not be started"
  }
  if (!gone(proc)) {
    try {
      proc.kill()
    } catch {
      // 已经没了
    }
    await raceExit(proc, SIGKILL_GRACE_MS)
  }
  if (gone(proc)) {
    // ⚠ 直接子进程没了**不等于**那棵树没了:taskkill /T 失败时,`cmd /c npm run dev`
    //   里真正在监听端口的是它孙子那一层,而 Node 的 kill 够不着。所以这里照旧
    //   把 taskkill 的失败原因带上去
    return why ? { stopped: true, detail: `${why} — its child processes may still be running` } : { stopped: true }
  }
  return { stopped: false, detail: why ?? "the process did not exit" }
}

/** @returns 是否成功对整个进程组发出信号(false = 已退化成只杀直接子进程) */
function send(proc: ChildProcess, pid: number, signal: NodeJS.Signals): boolean {
  try {
    // 负 pid = 整个进程组。detached 成功时这是唯一能杀干净的方式。
    process.kill(-pid, signal)
    return true
  } catch {
    // detached 没生效(某些容器 / PID namespace),退化成只杀直接子进程
    try {
      proc.kill(signal)
    } catch {
      // 进程已经没了
    }
    return false
  }
}

/** 信号 0 只做存在性与权限检查,不真的送信号。 */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

function raceExit(proc: ChildProcess, ms: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.off("close", onClose)
      resolve(false)
    }, ms)
    const onClose = () => {
      clearTimeout(timer)
      resolve(true)
    }
    proc.once("close", onClose)
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
