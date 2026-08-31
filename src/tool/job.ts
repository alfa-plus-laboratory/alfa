/**
 * job 工具:看/等/停后台跑着的东西 —— 进程,以及子 agent。
 *
 * ── 为什么是一个工具三个动作,不是三个工具 ──
 * 它们回答的是同一个问题的三段:「现在有什么在跑」→「它说了什么」→「停掉」。
 * 拆成三个工具会让工具表长一半,而工具表是**每一轮都要发一遍**的东西 ——
 * 见 agent/context.ts 里那份占用报告。
 *
 * ── 为什么进程和子 agent 归同一个工具 ──
 * 见 tool/background.ts 开头。要点:对模型来说这两种东西要问的问题完全一样,
 * 分两套只会逼它每次先想「这个 id 是哪一种」—— 而这个问题对它毫无价值。
 * 进程表是模块单例(bash 起的),子 agent 那张表是**注入**进来的(它要起一整个
 * 循环,而 src/tool 不认识循环)。两边形状一致,所以下面基本没有分支。
 *
 * ── 只给新的那一段 ──
 * output 拿走的是「上次之后」的输出(游标在两边各自的表上)。不这样的话,
 * 一个跑了十分钟的 server,第二次问就能把窗口撑爆,而其中 99% 是它已经读过的。
 *
 * ── wait 是这个工具存在的一半理由 ──
 * 「起个 server 然后访问它」如果只能轮询,模型会写成 `sleep 3 && curl`——
 * 一个猜出来的秒数,快了就失败,慢了就白等。wait 让它变成一次确定的调用:
 * 等到有输出、或者进程退出、或者超时,三者哪个先来都说得清。子 agent 更是
 * 只能这么用 —— 它要跑几十秒,而它出结果的那一刻没有别的信号。
 */
import { z } from "zod"
import type { AgentJobs, JobReadResult, JobSnapshot } from "./background.ts"
import { kill, list, ownedBy, read, UnknownJobError } from "./bash/jobs.ts"
import type { ToolDef, ToolContext } from "./types.ts"

/** wait 的上限。再长就该让它去干点别的了 —— 一个 agent 不该整轮都耗在等待上 */
const MAX_WAIT_SECONDS = 120

const Parameters = z.object({
  action: z.enum(["list", "output", "kill"]).describe("What to do"),
  id: z.string().optional().describe('The job name, e.g. "dev". Required for "output" and "kill".'),
  wait: z
    .number()
    .min(0)
    .max(MAX_WAIT_SECONDS)
    .optional()
    .describe(
      `Only for "output", and only for PROCESSES: if there is no new output yet, wait up to this many seconds ` +
        `for some (or for the process to exit). Default 0 = return immediately. It is ignored for subagents — ` +
        `their answers are delivered to you on their own, so there is never anything to wait for.`,
    ),
})

type Args = z.infer<typeof Parameters>

const DESCRIPTION = `Inspects and controls background work: processes started with the bash tool (background: true), and subagents started with the task tool.

Actions:
- list: everything this session started, running or finished. A running job shows how long it has been going and what it is doing right now.
- output: what has been produced since you last read it, plus whether it is still alive. Output is incremental — each read gives you only what is new, so reading repeatedly is cheap and never repeats itself. For a PROCESS you may pass wait to block until there is something new: start a server, then read with wait: 10 until it prints that it is listening, instead of guessing with sleep.
- kill: stop a job and collect whatever it produced last. **Read what it tells you.** It confirms the process actually ended; when it could not, it says so and the job is still running. Never report something as stopped on the strength of having called kill — on Windows in particular, a tree can survive it and keep holding its port.

Jobs are named after what they are: "npm run dev" becomes "dev", "cargo watch -x run" becomes "watch", a subagent auditing the auth flow becomes "audit". Use that name as the id; names are never reused, even after a job finishes. A job that ended is still listed, with its exit code — "not found" and "failed" are different answers.

Do NOT sit in a loop of reads waiting for a subagent to finish. Nothing in this tool blocks for a subagent, and its answer is delivered to you on its own the moment it is done. When the user asks what one is doing, "list" already answers it: read it once, say it in a line, and stop — every read is a step in which you are not talking to the user, who is still there and can send you something at any moment. When reading a subagent's output is worth it at all is in the \`alfa-subagents\` skill.

Stop the jobs you started once you no longer need them. Everything left running is stopped when the session ends, but a forgotten dev server holds its port for the rest of the session.`

export const JobTool: ToolDef<Args> = {
  id: "job",
  description: DESCRIPTION,
  parameters: Parameters,

  async execute(args, ctx) {
    // 权限:看和停自己起的东西不再问一次。真正的那两道关在别处 —— 命令是在
    // bash 那边被授权的,派活儿是在 task 那边被授权的,这里碰不到任何新的东西
    if (args.action === "list") {
      // 子 agent 只看得见自己起的进程(见 bash/jobs.ts 的 list):共用一张表还
      // 共用一个游标,它顺手读一下就把主 agent 没读过的输出取走了
      const jobs = [...list(ctx.owner), ...(ctx.agents?.list() ?? [])].toSorted(
        (a, b) => a.startedAt - b.startedAt,
      )
      const running = jobs.filter((job) => job.status === "running").length
      const queued = jobs.filter((job) => job.status === "queued").length
      return {
        output: jobs.length === 0 ? "Nothing running in the background." : jobs.map(describe).join("\n"),
        title: `${running} running${queued > 0 ? ` · ${queued} queued` : ""}`,
        metadata: { truncated: false, jobs: jobs.length },
      }
    }

    const id = args.id?.trim()
    if (!id) throw new Error(`id is required for action "${args.action}". Use action "list" to see the ids.`)
    const agents = agentOwning(ctx, id)
    // 不是自己起的进程,对它来说就是不存在 —— 报"没这个任务"而不是"不许碰",
    // 后者只会让它开始找绕过去的办法
    if (!agents && !ownedBy(id, ctx.owner)) throw new UnknownJobError(id)

    if (args.action === "kill") {
      const result = agents ? await agents.kill(id) : await kill(id)
      // ★ 「停了」不能无条件报。
      //
      // 这句话曾经是写死的,而它讲的其实只是"我们的管理记录已经标成完成" ——
      // 真机上撞出来的是 `job kill` 回一句 Stopped dev,而那个 dev server
      // 还占着端口。一个不可信的成功消息比一个失败消息糟得多:模型会拿着它
      // 往下走(去起同一个端口、去报"已经收拾干净了"),而每一步都建立在
      // 一件没有发生的事情上。
      const stopped = result.job.status === "exited"
      ctx.metadata({ job: id, killed: stopped })
      const why = result.detail
      const head = stopped
        ? why
          ? `Stopped ${id} — but: ${why}. Check for yourself before you rely on it (is the port free? is the process gone?).`
          : `Stopped ${id}.`
        : `Could NOT stop ${id}${why ? ` — ${why}` : ""}. It is still running. Do not report it as stopped: ` +
          `find it yourself (by port or by name) and say plainly what you did.`
      return {
        output: [head, tailBlock(result.output)].join("\n\n"),
        title: stopped ? `${id} stopped` : `${id} still running`,
        metadata: { truncated: false, job: id, killed: stopped, exit: result.job.exit ?? null },
      }
    }

    // ★ 子 agent 身上的 wait **一律当 0**。
    //
    // ── 为什么是"做不到",而不是"不鼓励" ──
    // 说明里写了三处"它的答案会自己送到、别等",而真机上模型照旧会在用户问一句
    // 「那个子 agent 在干嘛」的时候去 `wait: 120`。代价不是它多花一步:那两分钟里
    // 主 agent 是**死的** —— 用户插的话要等这一步的工具调用返回才被看见,而他
    // 刚问的那个问题本身就说明他正想说话。
    //
    // 而对子 agent 来说 wait 从来就没有正当用途:它出结果的那一刻会有一条消息
    // 推给主 agent(见 tool/task.ts 的第三版),站着等的那一份是纯粹的重复。
    // wait 留给进程 —— 「起个 server 然后等它说 listening」那件事只能这么干。
    const waitMs = agents ? 0 : Math.round((args.wait ?? 0) * 1000)
    const ignoredWait = agents !== undefined && (args.wait ?? 0) > 0
    const result: JobReadResult = agents ? await agents.read(id, waitMs) : await read(id, waitMs)
    ctx.metadata({ job: id })
    const head = describe(result.job)
    const body =
      result.output.length > 0
        ? tailBlock(result.output)
        : result.job.status === "queued"
          ? "(it has not started yet — nothing to read)"
          : result.job.status === "running"
            ? result.timedOut
              ? `(nothing new in the last ${args.wait}s — it is still going)`
              : "(nothing new since your last read — it is still going)"
            : "(no further output)"
    // 它要过 wait 就必须知道那一下**没有发生**:不说的话它会以为自己已经等过了,
    // 于是"什么都没等到"变成"它卡住了",然后再等一次
    const note =
      ignoredWait && result.job.status !== "exited"
        ? `\n\n(wait does not apply to a subagent — nothing was waited for. Its answer will be delivered to you ` +
          `as a message when it is ready. Say one short line to the user and stop; you will be woken up.)`
        : ""
    return {
      output: [head, body].join("\n\n") + note,
      title: `${id} · ${result.output.length > 0 ? "new output" : result.job.status}`,
      metadata: {
        truncated: false,
        job: id,
        alive: result.job.status !== "exited",
        exit: result.job.exit ?? null,
      },
    }
  },
}

/**
 * 这个 id 是不是一个子 agent。
 *
 * 名字在两种任务之间是唯一的(见 tool/background.ts 的 reserveName),所以
 * 问一句就够,不会两边都命中。都不认识时**退回进程那条路** —— 让它抛
 * UnknownJobError,那句话里写着「用 list 看看有哪些」。
 */
function agentOwning(ctx: ToolContext, id: string): AgentJobs | undefined {
  return ctx.agents?.has(id) ? ctx.agents : undefined
}

/** 一行状态。给模型的,不是给界面的 —— 界面那份在 tui/panes/jobs.ts */
function describe(job: JobSnapshot): string {
  const ran = elapsed((job.endedAt ?? Date.now()) - job.startedAt)
  // 谁起的也要写:一条你没起过的进程突然出现在列表里,不说是哪个子 agent 起的
  // 话,模型只能猜 —— 而它多半会猜成"我起的,忘了"
  const by = job.owner ? ` (started by subagent ${job.owner})` : ""
  const what = (job.kind === "agent" ? `subagent: ${job.command}` : job.command) + by
  if (job.status === "queued") {
    // 在等谁,要写清楚。只说一句"排队中"的话,模型下一步就会去问"为什么不跑" ——
    // 而答案(它在等 scout 和 scout-2)本来就在手边
    const behind = job.after && job.after.length > 0 ? `waiting for ${job.after.join(", ")}` : "waiting for a free slot"
    return `${job.id}  queued (${behind})  ${what}`
  }
  if (job.status === "running") {
    const pending = job.pending > 0 ? `, ${job.pending} chars unread` : ""
    const doing = job.activity ? `, now: ${job.activity}` : ""
    return `${job.id}  running ${ran}${pending}${doing}  ${what}`
  }
  const how = job.signal ? `stopped by ${job.signal}` : `exit ${job.exit ?? "?"}`
  const cost = job.kind === "agent" ? ` after ${job.steps ?? 0} steps` : ""
  return `${job.id}  finished after ${ran} (${how})${cost}  ${what}`
}

/**
 * 时长。**刻意不复用 cli/render.ts 那个**:src/tool 不该反过来依赖渲染层,
 * 而且两边要的东西本来就不一样 —— 那个是给六列宽的终端格子用的,这个是给
 * 模型读的散文,`2m14s` 比 `134.0s` 好懂。
 */
function elapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m${Math.round((ms % 60_000) / 1000)}s`
}

function tailBlock(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : "(no output)"
}
