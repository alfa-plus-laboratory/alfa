/**
 * 后台任务表。
 *
 * ── 为什么必须有这一层 ──
 * bash 工具是「起进程 → 站在那儿等 → 拿到全部输出」。这个形状挡住了三件每天
 * 都要做的事:
 *
 *   起一个 dev server 然后去访问它  —— server 不会自己退出,只会等到超时被杀
 *   跑 watch 模式                   —— 同上
 *   跑一个三分钟的构建               —— 撞 120 秒超时,它只知道"超时",不知道成没成
 *
 * 共同点是**进程的寿命和一次工具调用的寿命不一样长**。所以这里把进程从调用里
 * 拆出来:调用只负责"起"和"问",进程活在这张表上,跨轮、跨对话地活着。
 *
 * ── 游标是重点,不是附赠 ──
 * 每个任务记着"模型已经看到哪儿了"。没有游标的话,每次问输出都会把从头到尾
 * 重念一遍 —— 一个跑了十分钟的 server,第二次问就能把上下文撑爆,而其中 99%
 * 是它上一次已经读过的东西。
 *
 * ── 谁负责收尸 ──
 * 进程退出时不销毁记录:模型很可能在它退出之后才来问结果,而"任务不存在"和
 * "任务失败了"是两个完全不同的答案。记录留着,直到进程退出(见 killAll,
 * 挂在 CLI 的 shutdown 上)。
 *
 * ⚠ 这一层**不认识权限**。授权在 bash 工具里已经做过了(和前台命令走的是同一条
 *   路,同一张规则表),这里只管进程。
 */
import { spawn, type ChildProcess } from "node:child_process"
import type { Shell } from "../../env/shell.ts"
import { buildChildEnv } from "../../env/whitelist.ts"
import { streamDecoder } from "../../util/decode.ts"
import {
  __resetNamesForTest,
  reserveName,
  slugName,
  type JobReadResult,
  type JobSnapshot,
} from "../background.ts"
import { killGroup, type KillOutcome } from "./kill.ts"
import { OutputCollector } from "./output.ts"

export type { JobSnapshot }

/** 同时最多几个。防的是跑飞,不是省资源 —— 一个循环里起任务的模型能把机器压垮 */
export const MAX_JOBS = 8
/** 起完等多久再回话。见 start():这几百毫秒买的是"打错的命令当场就知道" */
const SETTLE_MS = 500
/** 停掉之后等多久再报状态。见 kill():这个数决定的是那句话准不准 */
const KILL_SETTLE_MS = 1_000
/** 单个任务在内存里最多留多少字符。完整输出照旧由 collector 落盘 */
const MAX_KEEP_CHARS = 200_000

interface Job {
  id: string
  command: string
  workdir: string
  owner?: string
  proc: ChildProcess
  collector: OutputCollector
  /** 已经产生的全部输出(受 collector 的环形缓冲上限约束) */
  seen: string
  /** 已经交给模型的长度。下次只给新的那一段 */
  cursor: number
  status: "running" | "exited"
  startedAt: number
  endedAt?: number
  exit?: number | null
  signal?: string
  /** 等新输出的人。有新输出或者进程退出时全部唤醒 */
  waiters: Array<() => void>
  /**
   * 等**退出**的人。必须和 waiters 分开:混在一起的话,进程刚打印一行日志就会
   * 把"等它退出"的人叫醒 —— 而 start() 正是靠这个区分"当场就死了"和"跑起来了"。
   */
  exitWaiters: Array<() => void>
}

const jobs = new Map<string, Job>()

/** 任务起落时通知界面。看不见的后台进程就是看不见的自动化 */
export type JobObserver = (event: { kind: "started" | "exited"; job: JobSnapshot }) => void
let observer: JobObserver | undefined

export function setJobObserver(fn: JobObserver | undefined): void {
  observer = fn
}

export class TooManyJobsError extends Error {
  constructor() {
    super(
      `Too many background jobs already running (${MAX_JOBS}). ` +
        `Stop one with the job tool (action "kill") before starting another.`,
    )
    this.name = "TooManyJobsError"
  }
}

export class UnknownJobError extends Error {
  constructor(id: string) {
    super(`No background job named "${id}". Use the job tool with action "list" to see the names.`)
    this.name = "UnknownJobError"
  }
}

export interface StartInput {
  command: string
  workdir: string
  /** 前台那条路解析出来的同一个 shell(见 env/shell.ts) */
  shell: Shell
  /** 是哪个子 agent 起的。主 agent 自己起的不传,见 JobSnapshot.owner */
  owner?: string
}

export type StartResult =
  /** 起来了,还活着 */
  | { kind: "started"; job: JobSnapshot; output: string }
  /**
   * 起是起了,但当场就退了。
   *
   * ★ 这条路必须和 started 分开。`npm run dvv`(打错一个字母)会在 50ms 内以
   *   exit 1 死掉,把它报成"任务 t1 已启动"的话,模型会安心地去干别的,过五分钟
   *   回来问才发现根本没起来 —— 而错误信息第一秒就在那儿了。
   */
  | { kind: "exited"; job: JobSnapshot; output: string }

export async function start(input: StartInput): Promise<StartResult> {
  if (running().length >= MAX_JOBS) throw new TooManyJobsError()

  const id = nameFor(input.command)
  const { env } = buildChildEnv()
  const proc = spawn(input.shell.file, input.shell.argsFor(input.command), {
    cwd: input.workdir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // 独立进程组。没有它就杀不干净进程树(见 kill.ts)—— 而后台任务比前台命令
    // 更需要这个:它活得久,fork 出来的东西更多。Windows 上没有这个概念(那边
    // detached 是"自己开一个控制台窗口"),交给 taskkill /T
    detached: input.shell.detached,
    windowsHide: true,
  })

  const job: Job = {
    id,
    command: input.command,
    workdir: input.workdir,
    ...(input.owner ? { owner: input.owner } : {}),
    proc,
    collector: new OutputCollector(`job_${id}`),
    seen: "",
    cursor: 0,
    status: "running",
    startedAt: Date.now(),
    waiters: [],
    exitWaiters: [],
  }
  jobs.set(id, job)

  // ★ 两条流各一个解码器,理由见 util/decode.ts
  const pump = (decode: (chunk: Buffer | string) => string) => (chunk: Buffer) => {
    const text = decode(chunk)
    job.collector.push(text)
    job.seen += text
    // 内存上限和 collector 的环形缓冲同一个量级。超了就从头砍,并把游标跟着挪 ——
    // 不挪的话,砍掉的那段会被当成"已经读过",而它其实谁都没看过
    if (job.seen.length > MAX_KEEP_CHARS) {
      const over = job.seen.length - MAX_KEEP_CHARS
      job.seen = job.seen.slice(over)
      job.cursor = Math.max(0, job.cursor - over)
    }
    wake(job)
  }
  proc.stdout?.on("data", pump(streamDecoder()))
  proc.stderr?.on("data", pump(streamDecoder()))

  const settle = (code: number | null, signal: NodeJS.Signals | null) => {
    if (job.status === "exited") return
    job.status = "exited"
    job.endedAt = Date.now()
    job.exit = code
    if (signal) job.signal = signal
    wake(job)
    observer?.({ kind: "exited", job: snapshot(job) })
  }
  proc.once("close", settle)
  // spawn 本身失败(shell 不在):当作退出,错误由 stderr 带出来
  proc.once("error", () => settle(null, null))

  // ── 等一下再回话 ──
  await Promise.race([exited(job), delay(SETTLE_MS)])

  const output = drain(job)
  if (job.status === "exited") return { kind: "exited", job: snapshot(job), output }

  observer?.({ kind: "started", job: snapshot(job) })
  return { kind: "started", job: snapshot(job), output }
}

/**
 * @param owner 只列这个子 agent 起的。**主 agent(不传)看得见全部** ——
 *   它要能回答"这台机器上现在还有什么在跑"。
 *
 * ★ 反过来不行:子 agent 看不到、也碰不了主 agent 的进程。共用一张表还共用
 *   一个读游标,所以一个子 agent 顺手 `job output dev` 就会把主 agent 还没读过的
 *   那段输出**取走**——主 agent 下次读到的是"没有新东西",而那段输出再也回不来了。
 */
export function list(owner?: string): JobSnapshot[] {
  return [...jobs.values()].filter((job) => owner === undefined || job.owner === owner).map(snapshot)
}

/** 这个任务归不归 owner 管。见 list():主 agent 管全部,子 agent 只管自己起的 */
export function ownedBy(id: string, owner?: string): boolean {
  const job = jobs.get(id)
  if (!job) return false
  return owner === undefined || job.owner === owner
}

export function get(id: string): JobSnapshot | undefined {
  const job = jobs.get(id)
  return job ? snapshot(job) : undefined
}

/** 和子 agent 那一侧同一个形状 —— `job` 工具因此不用为两种任务写两套分支 */
export type ReadResult = JobReadResult

/**
 * 读走新输出。
 *
 * waitMs > 0 时,没有新东西就等 —— 等到有输出、或者进程退出、或者超时。
 * 这一条把"起个 server 然后 curl 它"从「sleep 猜一个秒数」变成一次确定的调用。
 */
export async function read(id: string, waitMs = 0): Promise<ReadResult> {
  const job = jobs.get(id)
  if (!job) throw new UnknownJobError(id)

  let timedOut = false
  if (waitMs > 0 && job.cursor >= job.seen.length && job.status === "running") {
    timedOut = !(await waitForChange(job, waitMs))
  }
  return { job: snapshot(job), output: drain(job), timedOut }
}

export async function kill(id: string): Promise<ReadResult> {
  const job = jobs.get(id)
  if (!job) throw new UnknownJobError(id)
  let outcome: KillOutcome = { stopped: true }
  if (job.status === "running") outcome = await killGroup(job.proc)
  // killGroup 返回时 close 事件可能还没派发,等一会儿让 settle 跑完。
  // ★ 一秒而不是两百毫秒:这个数字决定的是**报出去的那句话准不准**,而
  //   `job kill` 是用户按出来的、一次会话里没几回 —— 为了省八百毫秒去报一句
  //   可能不成立的"停了",这笔账怎么算都不划算
  await Promise.race([exited(job), delay(KILL_SETTLE_MS)])
  return {
    job: snapshot(job),
    output: drain(job),
    timedOut: false,
    // 记录标成完成 ≠ 它真的没了。两者都不成立时才报原因
    ...(job.status === "exited" && outcome.detail === undefined ? {} : { detail: outcome.detail ?? "" }),
  }
}

/**
 * 全杀掉。进程退出前调用。
 *
 * 不杀的话,起在独立进程组里的 dev server 会被 init 收养继续跑 —— 用户以为
 * 自己退出了,实际留了一地进程,而且端口还占着。
 */
export async function killAll(owner?: string): Promise<number> {
  const alive = [...jobs.values()].filter(
    (job) => job.status === "running" && (owner === undefined || job.owner === owner),
  )
  await Promise.all(alive.map((job) => killGroup(job.proc)))
  return alive.length
}

/** 仅用于测试:清空这张表(不杀进程,调用方自己负责) */
export function __resetForTest(): void {
  jobs.clear()
  __resetNamesForTest()
  observer = undefined
}

// ─────────────────────────────────────────────── 起名字

/**
 * 拿命令给任务起个名字。
 *
 * ── 为什么不是 j1 j2 j3 ──
 * 序号要靠**记**才知道指的是谁。跑着三个的时候,「j2 挂了」这句话对人和对模型
 * 都得先回去查一遍 j2 是什么;而 `dev 挂了` 不用查。名字是这一栏里唯一会被
 * 反复引用的东西(读输出、停掉、报状态),它应该自己说清自己是谁。
 *
 * ── 取哪个词 ──
 * 跑的是什么比拿什么跑重要:`npm run dev` 的重点是 dev 不是 npm,
 * `cargo watch -x run` 的重点是 watch。所以遇到 npm/bun/cargo/go/docker 这类
 * **运行器**就再往后取一个词,遇到别的就取命令本身。
 *
 * ── 名字不回收,而且和子 agent 共用一本账 ──
 * 一个任务跑完之后,同名的新任务不会拿到同一个名字(拿到的是 dev-2)。模型手里
 * 可能还攥着上一个的名字,重名的话它会拿着旧结论去读新进程的输出 —— 而这种错
 * 不会报错,只会给出一个看起来合理的答案。分配在 tool/background.ts,因为
 * `job` 工具眼里进程和子 agent 是同一栏东西,名字不能各排各的。
 */
export function nameFor(command: string): string {
  return reserveName(slugName(pick(command)))
}

/** 拿这些东西跑别的东西 —— 它们自己不是重点,后面那个词才是 */
const RUNNERS = new Set([
  "npm", "pnpm", "yarn", "bun", "npx", "bunx", "deno", "node", "python", "python3", "ruby", "php",
  "go", "cargo", "make", "just", "task", "mvn", "gradle", "docker", "podman", "kubectl", "poetry",
  "uv", "pdm", "rake", "dotnet", "swift", "zig", "sudo", "env", "nohup", "time", "watch", "xargs",
])
/** 运行器后面这些词同样不是重点:`npm run dev` 的重点在第三个词上 */
const FILLER = new Set(["run", "exec", "x", "run-script", "start-script", "--"])

function pick(command: string): string {
  const tokens = command.trim().split(/\s+/).filter((token) => token.length > 0)
  let at = 0
  /** 最后一个认出来的运行器。后面全是垃圾时退回到它 */
  let runner = ""

  while (at < tokens.length) {
    const token = tokens[at]!
    // `FOO=bar cmd`:赋值不是命令
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      at++
      continue
    }
    if (token.startsWith("-") || FILLER.has(token)) {
      at++
      continue
    }
    const base = bare(token)
    if (RUNNERS.has(base) && at + 1 < tokens.length) {
      runner = base
      at++
      continue
    }
    // 引号、管道、代码片段之类:当不出名字,退回运行器
    if (!/^[A-Za-z0-9._:@\/-]+$/.test(token) || token.length > 24) return runner || base
    return base
  }
  return runner
}

/** 去掉路径和常见扩展名:`./scripts/deploy.sh` → `deploy` */
function bare(token: string): string {
  const last = token.split("/").filter((part) => part.length > 0).pop() ?? token
  return last.replace(/\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php|exe)$/i, "")
}

// ─────────────────────────────────────────────── 内部

function running(): Job[] {
  return [...jobs.values()].filter((job) => job.status === "running")
}

function snapshot(job: Job): JobSnapshot {
  return {
    id: job.id,
    kind: "process",
    command: job.command,
    ...(job.owner !== undefined ? { owner: job.owner } : {}),
    workdir: job.workdir,
    status: job.status,
    startedAt: job.startedAt,
    ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
    ...(job.exit !== undefined ? { exit: job.exit } : {}),
    ...(job.signal !== undefined ? { signal: job.signal } : {}),
    pending: Math.max(0, job.seen.length - job.cursor),
  }
}

/** 取走游标之后的部分并推进游标。 */
function drain(job: Job): string {
  const out = job.seen.slice(job.cursor)
  job.cursor = job.seen.length
  return out
}

function wake(job: Job): void {
  const waiters = job.waiters
  job.waiters = []
  for (const resolve of waiters) resolve()
  if (job.status !== "exited") return
  const leaving = job.exitWaiters
  job.exitWaiters = []
  for (const resolve of leaving) resolve()
}

/** @returns true = 有动静(新输出或退出),false = 等超时了 */
function waitForChange(job: Job, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), ms)
    timer.unref?.()
    job.waiters.push(() => finish(true))
  })
}

function exited(job: Job): Promise<void> {
  if (job.status === "exited") return Promise.resolve()
  return new Promise((resolve) => job.exitWaiters.push(resolve))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
