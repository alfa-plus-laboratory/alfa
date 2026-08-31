/**
 * 子 agent:派一个自己出去干活,不站着等它。
 *
 * ── 为什么它长在后台任务上,而不是自成一套 ──
 * 一个正在翻仓库的子 agent 和一个 `npm run dev`,对用户和模型是同一件事:
 * 我不用等着它,但我得知道它还在不在、说了什么、怎么停掉。既然要回答的问题
 * 一样,就该是同一栏东西 —— 同一张表、同一块面板、同一个 `job` 工具(见
 * tool/background.ts 开头)。`task` 只负责起,剩下三件事一个新工具都不用加。
 *
 * ── 它解决的是**上下文**问题,不是并发问题 ──
 * 「这个仓库里 X 是在哪儿实现的」这种活儿,自己干要读七八个文件,而七八个
 * 文件的内容会永远留在主对话的窗口里 —— 真正有用的只有最后那句结论。派出去
 * 之后,那些字都烧在子 agent 自己的会话里,回来的只有结论。并行只是顺带的好处。
 *
 * ── 每个子 agent 一场自己的会话 ──
 * 它必须落库:主循环每轮都从 store 重读全量历史(见 loop.ts 开头),没有一场
 * 自己的会话就没有它能读的历史。但那几场**不该出现在 `/resume` 里** —— 用户
 * 要接着聊的是自己那场,不是十分钟前派出去数了三个文件的那个小活儿。所以
 * session 表上有一列 parent_id,列会话时按它筛掉(见 session/store.ts)。
 *
 * ── 它不能干的两件事,都是刻意的 ──
 * 1. **不能再起子 agent。** 工具表里没有 `task`。递归展开的代价是指数级的
 *    token,而且一个跑飞的第三层没有任何人在看着。
 * 2. **不能问用户。** 工具表里没有 `ask`。它跑在后台,用户当时正在跟主 agent
 *    说话;一个突然弹出来的、没有上下文的问题,用户根本无从判断该怎么答。
 *    要问也该是主 agent 拿着它的结论来问 —— 那时候上下文是全的。
 *
 * ⚠ 但**权限照旧**。它和主 agent 走同一个门卫、同一张规则表、同一份"以后不再问",
 *   所以它一样能改文件、一样会在动别人的东西时弹框(框上写着是哪个 job 在问)。
 *   后台不是绕开门卫的方式,它只是不站着等 —— 和 `bash background:true` 一个道理。
 */
import { forgetReads } from "../fs/freshness.ts"
import { killAll as killProcessJobs } from "../tool/bash/jobs.ts"
import { newSessionID } from "../session/id.ts"
import type { Store } from "../session/store.ts"
import type { MessageWithParts, ToolPart } from "../session/schema.ts"
import type { LLMStreamFn, ModelInfo, ModelRef, Tokens } from "../llm/types.ts"
import type { ToolContext, ToolDef } from "../tool/types.ts"
import {
  reserveName,
  slugName,
  type AgentJobs,
  type JobReadResult,
  type JobSnapshot,
  type StartAgentInput,
} from "../tool/background.ts"
import { Emitter, type UIEvent } from "./events.ts"
import { MAX_AGENT_JOBS, MAX_ALIVE_JOBS, MAX_FLOW_ALIVE_JOBS } from "./flow.ts"
import { contextTokens } from "./tokens.ts"
import { Loop } from "./loop.ts"

/**
 * 窗口和总量都在 agent/flow.ts —— 配置校验和 `/agentflow` 那条命令也要读它们,
 * 而那两个模块都不该为了几个常数把整台调度器拖进来(见那个文件的开头)。
 *
 * ★ MAX_AGENT_JOBS 是**窗口**不是总量:第五个不报错,它排队(见 pump)。
 */
export { MAX_AGENT_JOBS } from "./flow.ts"

/** 依赖跑完之后,拼给下家的那份报告最多带多少字 */
const HANDOFF_CHARS = 8_000

/** 起完等多久再回话。见 start():这几百毫秒买的是「凭据不对当场就知道」 */
const SETTLE_MS = 400

/** 一个子 agent 的输出在内存里最多留多少字符 */
const MAX_KEEP_CHARS = 200_000

/**
 * 报告和过程之间那道线。
 *
 * 增量读的人(`job output`)会先看到一串"它去了哪儿",然后看到这一行,
 * 后面才是结论。没有这道线的话,最后那段话和前面那些工具行糊成一片,
 * 而它们的价值差着一个数量级。
 */
const REPORT_MARK = "--- report ---"


export interface SubagentDeps {
  store: Store
  stream: LLMStreamFn
  /** 现取:`/model` 换过之后,下一个子 agent 该用新模型 */
  model(): ModelRef
  /**
   * 那个模型的口径。算花费要用 —— 缓存命中算不算进 input 是**按 provider 分**的
   * (见 agent/tokens.ts 的 contextTokens)。自己相加的话,OpenAI 兼容那一侧会
   * 把缓存那部分重复计一遍,一趟能虚报出一倍
   */
  info(): ModelInfo
  /**
   * 把子 agent 花掉的记进**这一场的总账**。
   *
   * 可选:子 agent 也能在没有主界面的地方跑(测试、-p),那时候没有仪表盘
   * 要更新。给了就必须是「只记账不改占用」的那条路 —— 见 ContextMeter.bill。
   */
  bill?(tokens: Tokens): void
  /**
   * 子 agent 这一轮能用的工具。
   *
   * ★ **剔除 `task` 和 `ask` 是调用方的事**,这里不替它做 —— 那两条边界的
   *   理由写在文件头,而剔除动作发生在 CLI 那一层(它才知道工具表长什么样)。
   */
  tools(): ToolDef<any>[]
  /** 子 agent 的 system。静态的 —— 活儿本身走第一条 user 消息,别拼进来毁缓存 */
  system(): string[]
  /**
   * @param job 这次调用属于哪个子 agent。**不只是 sessionID** —— 权限框上要写清
   *   是谁在问:一个框在用户正跟主 agent 说话时弹出来,不说是哪个后台任务要的话,
   *   他只能看到一条自己没让谁干的事在请求授权
   */
  makeToolContext(
    job: { id: string; sessionID: string },
    call: { messageID: string; callID: string; abortSignal: AbortSignal },
  ): ToolContext
  /** 新会话的第一句话上挂什么(和主会话同一份,见 loop.ts 的 memory / gitContext) */
  memory?(sessionID: string): { text: string; notes: number } | undefined
  gitContext?(): string | undefined
  /** 这一场开在哪个目录。会话按目录归属,子会话得跟着父的走 */
  directory: string
  /**
   * 现在是哪一场。**现取** —— `/clear` 会在跑着的时候把它换掉,而一个子 agent
   * 属于**派它出去的那一场**,不是它回来时正好开着的那一场(见 deliverReport)
   */
  session(): string
  /** 起落留痕。看不见的后台就是看不见的自动化 —— 和进程那边同一条理由 */
  observer?(event: { kind: "started" | "exited"; job: JobSnapshot }): void
  /** 有动静了(面板要重画)。空闲时界面是不重绘的,没有这一声就一直停在旧状态 */
  onChange?(): void
  /**
   * 它刚动完一次工具,盘上可能变了(文件树要重扫)。
   *
   * ── 为什么单独一条,不并进 onChange ──
   * onChange 每记一次花费都要响(step.finish),而重扫是要 readdir 所有展开着的
   * 目录的。这一条只在**工具收尾**时响,和主 agent 那边同一个时机、同一个防抖。
   *
   * ⚠ 这是子 agent 的事件流唯一一处接进主界面的地方,而且**只接这一条**。
   *   预览、右栏详情、对话里的收据都刻意不接:那些是"这个 agent 正在干什么"
   *   的现场,接过去就会把后台那一场的经过混进用户正看着的这一场里。文件树
   *   不一样 —— 它画的是**盘上的现状**,而盘只有一份,谁改的都算。
   */
  onFilesChanged?(): void
  /**
   * agentflow 开着吗,开着的话窗口多大。**现取** —— `/agentflow` 下一个 task
   * 就该生效,而且它改的是调度,不是已经跑起来的那些。
   *
   * 返回 false / 不给 = 没开:窗口 MAX_AGENT_JOBS,总量 MAX_ALIVE_JOBS。
   */
  flow?(): number | false
}

export class TooManyAgentsError extends Error {
  constructor(limit: number, flow: boolean) {
    super(
      `Too many subagents already queued or running (${limit}). ` +
        `Their answers arrive on their own — wait for some of them, or stop the ones you no longer need ` +
        `(job tool, action "kill").` +
        (flow ? "" : ` If this job really does split into more parts than that, ask the user to turn on agentflow.`),
    )
    this.name = "TooManyAgentsError"
  }
}

export class UnknownAgentError extends Error {
  constructor(id: string) {
    super(`No subagent named "${id}". Use the job tool with action "list" to see what is running.`)
    this.name = "UnknownAgentError"
  }
}

interface AgentJob {
  id: string
  /** 交代的头一句。面板和收据上写的就是它 —— 名字说不清"这次在干什么" */
  description: string
  sessionID: string
  /** 它开在哪个目录。和父会话同一个 —— 派出去的活儿是这个仓库里的活儿 */
  workdir: string
  controller: AbortController
  status: "queued" | "running" | "exited"
  /**
   * 派给它的那段话。**排着队的时候先攥在这儿** —— 真正发出去的那一份还要在
   * 前面拼上它等的那几个交回来的东西(见 briefFor),而那些东西现在还不存在。
   */
  prompt: string
  /**
   * 等这几个跑完才起。
   *
   * ── 为什么不需要查环 ──
   * 一条边只能指向**已经登记过**的任务(见 resolveAfter:不认识的名字当场报错),
   * 而新任务永远比它指向的那些晚。晚的指向早的,这张图天生是 DAG —— 环是构造
   * 不出来的。这也正是 resume 不收 after 的原因:被叫醒的那个是个老节点,
   * 让它指向新节点就能绕过这条不变式(见 AgentJobs.resume)。
   */
  after: string[]
  /** 排进队列的时刻。秒表按 startedAt 走,而排队那段不算它干活的时间 */
  queuedAt: number
  /**
   * 它真的跑起来过吗。
   *
   * ★ 只为一件事存在:**没跑起来过的那些不写收据**。一个排着队就被取消的任务
   *   从来没有过"▸ 起来了"那一行,配一行"· 它结束了"的话,用户读到的是一件
   *   自己没见过开头的事情结束了 —— 而一次连坐能一口气写出十行这种。模型那边
   *   照旧知道(`job kill` 当场回一句"顺带收掉了这几个",见 kill)
   */
  ran?: boolean
  startedAt: number
  endedAt?: number
  exit?: number | null
  signal?: string
  steps: number
  /** 边跑边涨。见 JobSnapshot.tokensIn —— 这笔账只有这里还得了 */
  tokensIn: number
  tokensOut: number
  activity?: string
  /** 它最后交出来的那段话。见 AgentJobs.report —— 要结论的只要这个 */
  report?: string
  /** 报告已经交到主 agent 手里了。见 AgentJobs.claimReport:两条路,只许交一次 */
  reported?: boolean
  /** 派它出去的**是哪一场**。换会话之后那份结论没有地方可去了,见 deliverReport */
  parentSessionID: string
  /** 已经产生的全部输出 */
  seen: string
  /** 已经交给模型的长度。下次只给新的那一段 —— 和进程那边同一条游标语义 */
  cursor: number
  waiters: Array<() => void>
  exitWaiters: Array<() => void>
}

export class SubagentJobs implements AgentJobs {
  private readonly jobs = new Map<string, AgentJob>()

  constructor(private readonly deps: SubagentDeps) {}

  async start(input: StartAgentInput): Promise<JobSnapshot> {
    const limit = this.maxAlive()
    if (this.alive().length >= limit) throw new TooManyAgentsError(limit, this.deps.flow?.() !== false)

    const name = input.name.trim()
    const prompt = input.prompt.trim()
    if (name.length === 0) throw new Error("name is required: a few words for what kind of agent this is.")
    if (prompt.length === 0) throw new Error("prompt is required: the whole brief for the subagent.")
    // ★ 依赖要在**占名字之前**校验。反过来的话,一次写错依赖名的调用会白白烧掉
    //   一个名字(用过的名字不回收,见 background.ts),下一个同类 agent 平白变成 -2
    const after = this.resolveAfter(input.after ?? [])

    // 名字按**性质**取(调查agent / 分析agent),重名挂 -2。面板上那一行写的是
    // 交代的头一句 —— 名字回答"这是个什么",那一句回答"它这次在干什么"
    const id = reserveName(slugName(name))
    const headline = firstLine(prompt).slice(0, 120)
    const sessionID = newSessionID()
    // ★ parentID 一填,这一场就不再出现在 `/resume` 和 `--continue` 里。见文件头。
    //   填的是**派它出来的那一场**,不是它自己的 id —— 两者都能让筛选成立,
    //   但只有前者事后还答得出"这是谁派的"
    this.deps.store.createSession(sessionID, this.deps.directory, this.deps.session())
    this.deps.store.setSummary(sessionID, headline)

    const now = Date.now()
    const job: AgentJob = {
      id,
      description: headline,
      sessionID,
      parentSessionID: this.deps.session(),
      workdir: this.deps.directory,
      controller: new AbortController(),
      status: "queued",
      prompt,
      after,
      queuedAt: now,
      startedAt: now,
      steps: 0,
      tokensIn: 0,
      tokensOut: 0,
      seen: "",
      cursor: 0,
      waiters: [],
      exitWaiters: [],
    }
    this.jobs.set(id, job)

    // 依赖没齐、或者窗口满了,就先排着 —— 而且**当场就看得见**:面板上那一格是
    // 空心的,`job list` 里写着 queued。悄悄排队和悄悄丢弃在用户那里长得一模一样
    if (!this.admits(job)) {
      this.deps.onChange?.()
      return snapshot(job, this.feedsOf(id))
    }
    return this.launch(job, this.briefFor(job))
  }

  /**
   * 叫醒一个已经跑完的,再交代一句。见 AgentJobs.resume。
   *
   * ── 它便宜在哪儿 ──
   * 那一场会话原封不动躺在库里,而循环每轮都从库里重读全量历史 —— 所以"接着
   * 聊"这件事这里一个字都不用搬:把新的一句 append 进去,它醒来时手上还攥着
   * 上一轮读过的全部东西。重派一个空白的则要把背景整个重讲一遍,而它读到的
   * 又是同一批文件。
   *
   * ── 它贵在哪儿(所以工具说明里要写清什么时候别用) ──
   * 接着聊意味着它那几万 token 的历史**每一轮都要重发**。而派子 agent 的全部
   * 意义就是把那些烧在别处 —— 一个被反复唤醒的子 agent 会慢慢变成第二个主对话。
   * 追问同一件事用它,换一件事就该派个新的。
   */
  async resume(id: string, prompt: string): Promise<JobSnapshot> {
    const job = this.mine(id)
    if (!job) throw new UnknownAgentError(id)
    if (job.status !== "exited") {
      throw new Error(
        job.status === "queued"
          ? `Subagent "${id}" has not started yet — it is queued behind ${job.after.join(", ") || "the ones already running"}. ` +
            `It will do the job it was given, and its answer will be delivered to you on its own.`
          : `Subagent "${id}" is still working. Its answer will be delivered to you on its own — ` +
            `wait for it, then follow up if you still need to.`,
      )
    }
    const text = prompt.trim()
    if (text.length === 0) throw new Error("prompt is required: what you want it to do now.")
    const limit = this.maxAlive()
    if (this.alive().length >= limit) throw new TooManyAgentsError(limit, this.deps.flow?.() !== false)

    job.description = firstLine(text).slice(0, 120)
    job.controller = new AbortController()
    job.status = "queued"
    job.prompt = text
    job.queuedAt = Date.now()
    // ★ 上一轮那几条依赖要清掉。它们早就跑完了,内容也已经在它自己的会话里了 ——
    //   留着的话,一个被停掉的老依赖会在这一轮把它连坐取消(见 gateOf)
    job.after = []
    job.endedAt = undefined
    job.exit = undefined
    job.signal = undefined
    job.activity = undefined
    // 上一份报告已经交过了,这一轮要重新攒一份
    job.report = undefined
    job.reported = false
    // 缓冲接着往下写,不清 —— `job output` 是增量读的(见 tool/job.ts),
    // 清掉的话游标就指到了缓冲外面
    this.append(job, `\n--- woken up: ${job.description} ---`)
    if (!this.admits(job)) {
      this.deps.onChange?.()
      return snapshot(job, this.feedsOf(id))
    }
    return this.launch(job, text)
  }

  /**
   * 真正跑起来那一段。**起和唤醒共用** —— 两边各写一遍的话,迟早出现
   * "起的时候收了尾、唤醒的时候忘了收"这种只在第二轮才现形的错。
   */
  private async launch(job: AgentJob, prompt: string): Promise<JobSnapshot> {
    const { id, sessionID } = job
    // ★ 这两行必须在**第一个 await 之前**。pump() 是一个个往外放的,它靠
    //   running() 的数目判断窗口还剩几格 —— 状态晚一步落地,同一轮就会把
    //   整个队列一次性全放出去
    job.status = "running"
    job.ran = true
    // 秒表这时候才起步:排队那几分钟不是它在干活。花费**不清零**(被叫醒过的
    // 那个),那笔账问的是"这个 agent 一共花了我多少",而它确实还是那一个
    job.startedAt = Date.now()
    // 之前那几轮一共跑了多少步。跑的过程中 observe() 会边跑边往上加(面板要
    // 看得见它在动),而这一轮结束时以循环报的那个数为准 —— 两边一相加就翻倍了
    const stepsBefore = job.steps
    const emitter = new Emitter<UIEvent>()
    const unsubscribe = emitter.on((event) => this.observe(job, event))

    const loop = new Loop({
      store: this.deps.store,
      emitter,
      stream: this.deps.stream,
      tools: this.deps.tools,
      system: this.deps.system,
      makeToolContext: (call) => this.deps.makeToolContext({ id, sessionID }, call),
      ...(this.deps.memory ? { memory: this.deps.memory } : {}),
      ...(this.deps.gitContext ? { gitContext: this.deps.gitContext } : {}),
      // ★ 刻意**不接** verify:那条检查(tsc / cargo check)是全项目的,主 agent
      //   收口时本来就会跑一次。后台再并发跑几遍,既互相抢机器,又会把一个"还改了
      //   一半"的中间态报成失败 —— 而那份失败没人看得见,只会让子 agent 在后台
      //   自己跟自己较劲
    })

    const run = loop
      .run({
        sessionID,
        model: this.deps.model(),
        text: prompt,
        abortSignal: job.controller.signal,
      })
      .then((result) => {
        // 累加而不是覆盖:被叫醒过的那个,步数是它这辈子一共跑了多少
        job.steps = stepsBefore + result.steps
        // 报告要在**收尾之前**追进缓冲:等 status 变成 exited 之后再追的话,
        // 一个正好在这一刻醒来的 read() 会看到"它结束了"但一个字都没有
        job.report = this.finalAnswer(job, result.error, result.interrupted, result.hitStepLimit)
        this.append(job, `\n${REPORT_MARK}\n${job.report}`)
        this.settle(
          job,
          result.error ? 1 : result.interrupted ? null : 0,
          result.interrupted ? "stopped" : undefined,
        )
      })
      .catch((error: unknown) => {
        job.report = describe(error)
        this.append(job, `\n${REPORT_MARK}\n${job.report}`)
        this.settle(job, 1)
      })
      .finally(() => unsubscribe())

    // 起完等一下再回话:凭据不对、模型名写错这类错误在几百毫秒内就会回来,
    // 报成"已经派出去了"的话,模型会安心去干别的,几分钟后才发现它根本没起来
    await Promise.race([exited(job), delay(SETTLE_MS)])
    void run

    if (job.status === "running") this.deps.observer?.({ kind: "started", job: this.snap(job) })
    return this.snap(job)
  }

  list(): JobSnapshot[] {
    return [...this.jobs.values()].filter((job) => this.owns(job)).map((job) => this.snap(job))
  }

  has(id: string): boolean {
    return this.mine(id) !== undefined
  }

  async read(id: string, waitMs = 0): Promise<JobReadResult> {
    const job = this.mine(id)
    if (!job) throw new UnknownAgentError(id)

    let timedOut = false
    // 排队中的也能等 —— 它一开跑就会有输出。等一个还没起步的任务不是错,
    // 是这条队列存在之后必然会有的用法
    if (waitMs > 0 && job.cursor >= job.seen.length && job.status !== "exited") {
      timedOut = !(await waitForChange(job, waitMs))
    }
    return { job: this.snap(job), output: drain(job), timedOut }
  }

  async kill(id: string): Promise<JobReadResult> {
    const job = this.mine(id)
    if (!job) throw new UnknownAgentError(id)
    // 停掉它 = 等它的那几个永远等不到了。**连坐要当场做,而且要说出来** ——
    // 不做的话它们会一直挂在队列里(gateOf 判 cancel 之后照样得有人去执行),
    // 不说的话模型看到的是三个任务凭空消失
    const cascade = job.status !== "exited" ? this.cancelDependents(id, `${id} was stopped`) : []
    if (job.status === "queued") {
      this.cancelQueued(job, "you stopped it before it started")
    } else if (job.status === "running") {
      job.controller.abort()
      // ★ 连它起的后台进程一起收。不收的话,一个子 agent 起的 dev server 会在
      //   它自己被停掉之后继续占着端口 —— 而它的起落**不写进对话**(那是刻意的),
      //   于是屏幕上没有任何一处解释那个端口是谁占的
      void killProcessJobs(id)
      // 中断要走完一条链(见 agent/runner.ts):流断开 → 工具收到信号自己收尾 →
      // 没落地的 tool part 改写成 error。等它一下,拿到的才是收拾干净的状态
      await Promise.race([exited(job), delay(1_000)])
    }
    if (cascade.length > 0) {
      this.append(job, `— also cancelled, they were waiting on this one: ${cascade.join(", ")}`)
    }
    return { job: this.snap(job), output: drain(job), timedOut: false }
  }

  /**
   * 立刻叫停,**不等它们收尾**。返回停掉了几个。
   *
   * `/clear` 和 `/resume` 走这条:换了一场对话之后,那些子 agent 交回来的
   * 结论已经没有地方可去了(派它出去的那场对话不在了),而它们还在烧钱。
   * 不等收尾是因为这两条命令是**按一下就该有反应**的 —— 界面上那几行会跟着
   * 变成"停了",而库里的收尾在后台自己走完。
   */
  abort(): number {
    const alive = this.alive()
    for (const job of alive) {
      // 还没起步的那些直接划掉:没有流可断,也没有进程要收 —— 但它们照样占着
      // 一个"待办",不划掉的话 `/clear` 之后队列还会自己往下跑
      if (job.status === "queued") {
        this.cancelQueued(job, "the conversation moved on")
        continue
      }
      // 上一轮划掉的那些会连坐掉一批(settle 里的 pump),所以这份名单跑到一半
      // 就可能有人已经收了 —— 对一个收完的任务再 abort 一次是无害的,但那正是
      // 「无害所以不管」慢慢变成真 bug 的那种地方
      if (job.status === "exited") continue
      job.controller.abort()
      // 它起的进程跟着走。见 kill() 里那颗星
      void killProcessJobs(job.id)
    }
    return alive.length
  }

  /**
   * 全停掉。进程退出前调用。
   *
   * 不停的话,一个还在跑的子 agent 会在主程序关库之后继续往 store 里写 ——
   * 那不是留一地进程,是往一个已经关掉的 SQLite 句柄上写。
   */
  async killAll(timeoutMs = 2_000): Promise<number> {
    const alive = this.alive()
    const running = this.running()
    this.abort()
    if (running.length > 0) {
      await Promise.race([Promise.all(running.map((job) => exited(job))), delay(timeoutMs)])
    }
    return alive.length
  }

  // ───────────────────────────────────────────── 调度

  private running(): AgentJob[] {
    return [...this.jobs.values()].filter((job) => job.status === "running")
  }

  /** 排着队的 + 在跑的。总量那道栏按它算 —— 队里那些迟早也要花钱 */
  private alive(): AgentJob[] {
    return [...this.jobs.values()].filter((job) => job.status !== "exited")
  }

  /** 现在的并发窗口。flow 模式开着就是它给的那个数 */
  private window(): number {
    const flow = this.deps.flow?.()
    return typeof flow === "number" ? flow : MAX_AGENT_JOBS
  }

  private maxAlive(): number {
    return typeof this.deps.flow?.() === "number" ? MAX_FLOW_ALIVE_JOBS : MAX_ALIVE_JOBS
  }

  /** 这个排着队的现在能放出去吗:依赖齐了,而且窗口还有空 */
  private admits(job: AgentJob): boolean {
    return this.gateOf(job) === "go" && this.running().length < this.window()
  }

  /**
   * 它在等什么。
   *
   *   go     —— 等的那些都跑完了(**包括跑挂的**)
   *   wait   —— 还有没跑完的
   *   cancel —— 等的那个被停掉了,所以它永远等不到了
   *
   * ── 为什么"跑挂了"照样放行,而"被停掉"要连坐 ──
   * 一个失败的依赖照样有话说(它为什么失败、它走到哪一步),而下家拿着那句话
   * 往往还能干活 —— 至少能把"上一环没成"照实报上来。而**被停掉**是用户的意思:
   * 他按下去的时候要停的是这条线,不是"这一个"。悄悄接着跑下去,他会看到一串
   * 自己刚叫停过的活儿又冒出来。
   */
  private gateOf(job: AgentJob): "go" | "wait" | "cancel" {
    for (const id of job.after) {
      const dep = this.jobs.get(id)
      if (!dep) continue
      if (dep.status !== "exited") return "wait"
      if (dep.signal !== undefined) return "cancel"
    }
    return "go"
  }

  /**
   * 有空位就往外放,一个一个放。
   *
   * 按**登记顺序**放(Map 的迭代顺序就是插入顺序),所以先派的先跑 —— 一个
   * "谁先谁后看运气"的队列,在用户那里表现为同一份活儿每次跑出不一样的顺序。
   */
  private pump(): void {
    for (const job of [...this.jobs.values()]) {
      if (job.status !== "queued") continue
      const gate = this.gateOf(job)
      if (gate === "wait") continue
      if (gate === "cancel") {
        const blocker = job.after.find((id) => this.jobs.get(id)?.signal !== undefined)
        this.cancelQueued(job, `${blocker ?? "what it was waiting on"} was stopped`)
        continue
      }
      // 窗口满了就到此为止。**不是 continue** —— 后面那些排得更晚,没有理由
      // 越过前面这个先跑
      if (this.running().length >= this.window()) return
      void this.launch(job, this.briefFor(job))
    }
  }

  /**
   * 登记依赖。不认识的名字**当场报错**,而不是当它已经满足了。
   *
   * 模型写错一个依赖名的后果,是那个本该等着的任务立刻开跑、拿到一份空手的
   * brief,然后交出一份看起来很像样的错答案 —— 而这种错不报错。
   */
  private resolveAfter(ids: readonly string[]): string[] {
    const out: string[] = []
    for (const raw of ids) {
      const id = raw.trim()
      if (id.length === 0) continue
      if (!this.mine(id)) throw new UnknownAgentError(id)
      if (!out.includes(id)) out.push(id)
    }
    return out
  }

  /** 谁在等这一个。见 JobSnapshot.feeds —— 报告该交给它们而不是主对话 */
  private feedsOf(id: string): string[] {
    return [...this.jobs.values()]
      .filter((job) => job.status === "queued" && job.after.includes(id))
      .map((job) => job.id)
  }

  /** 划掉一个还没起步的。已经跑起来或者已经收了的不动 —— 那两种要走 abort */
  private cancelQueued(job: AgentJob, why: string): void {
    if (job.status !== "queued") return
    job.report = `(cancelled: ${why})`
    this.append(job, `\n${REPORT_MARK}\n${job.report}`)
    this.settle(job, null, "stopped")
  }

  /**
   * 等这一个的那些全部取消,返回取消了谁 —— **整条线**,不只是直接下家。
   *
   * ★ 先把整条线**算出来**,再一个个收。边收边算的话,settle 里的 pump 会抢在
   *   递归到达之前把下游取消掉(它自己判得出"等的那个被停了"),于是那些任务
   *   **确实被取消了、却不出现在返回值里** —— 而返回值正是要告诉调用方"我还
   *   顺手收掉了这几个"的那句话。一件做了却没说出口的事,比没做更难查。
   */
  private cancelDependents(id: string, why: string): string[] {
    const doomed: AgentJob[] = []
    const front = [id]
    while (front.length > 0) {
      const from = front.shift()!
      for (const job of this.jobs.values()) {
        if (job.status !== "queued" || !job.after.includes(from) || doomed.includes(job)) continue
        doomed.push(job)
        front.push(job.id)
      }
    }
    for (const job of doomed) this.cancelQueued(job, why)
    return doomed.map((job) => job.id)
  }

  /**
   * 真正发出去的那份交代:等到的东西 + 它自己的活儿。
   *
   * ── 为什么依赖的报告是**拼进 brief**,而不是让它自己去 `job output` 捞 ──
   * 子 agent 手上没有 `task`,也没有理由知道这场编排长什么样。给它一份读完就能
   * 干活的交代,它就只是个普通的子 agent —— 编排这件事只存在于调度器里,
   * 而不是变成每个子 agent 都要理解的一套协议。
   */
  private briefFor(job: AgentJob): string {
    if (job.after.length === 0) return job.prompt
    const blocks: string[] = []
    for (const id of job.after) {
      const dep = this.jobs.get(id)
      if (!dep) continue
      const text = (dep.report ?? "(it finished without saying anything)").slice(0, HANDOFF_CHARS)
      const failed = dep.exit !== 0 ? " — THIS ONE FAILED, take it into account" : ""
      blocks.push(`## ${id}${failed}\nIt was asked to: ${dep.description}\n\n${text}`)
    }
    if (blocks.length === 0) return job.prompt
    return (
      `You were waiting on ${job.after.length === 1 ? "another subagent" : `${job.after.length} other subagents`}. ` +
      `${job.after.length === 1 ? "It has" : "They have"} finished, and this is what ` +
      `${job.after.length === 1 ? "it" : "they"} reported:\n\n` +
      `${blocks.join("\n\n")}\n\n---\n\nNow, your own job:\n\n${job.prompt}`
    )
  }

  private snap(job: AgentJob): JobSnapshot {
    return snapshot(job, this.feedsOf(job.id))
  }

  // ───────────────────────────────────────────── 内部

  /**
   * 这个子 agent 是**这一场**派出去的吗。
   *
   * ── 为什么整张表要按会话切 ──
   * 子 agent 跟着派它出去的那一场走。`/clear` 之后是一场全新的对话,它对上一场
   * 派出去的那些一无所知 —— 而不切的话,那个全新的 agent 一跑 `job list` 就会
   * 看见一堆自己没派过的活儿,能读它们的输出、能停掉它们、甚至能把一场十分钟前
   * 的调查叫醒接着聊。这和"子 agent 起的进程不进主对话"是同一条规矩,只是
   * 那一条切的是**谁起的**,这一条切的是**谁派的**。
   *
   * ★ 它也让 `/resume` 接回旧会话时那几个自动回来:归属记在 job 上,
   *   而"现在是哪一场"是现取的 —— 接回去那一刻,它们就又属于眼下这一场了。
   */
  private owns(job: AgentJob): boolean {
    return job.parentSessionID === this.deps.session()
  }

  /** 这一场的那个。别人的一律当成不存在 —— 报"不许碰"只会让它去找绕过去的办法 */
  private mine(id: string): AgentJob | undefined {
    const job = this.jobs.get(id)
    return job && this.owns(job) ? job : undefined
  }

  /**
   * 子 agent 的事件 → 缓冲里的一行。
   *
   * ── 为什么只记工具,不记它说的话 ──
   * 它中途说的那些("我先看看 X")是给自己听的推理,而这份缓冲是**给主 agent 读**
   * 的:每一行都要进主对话的上下文。只留一行一次工具调用(它去了哪儿、动了什么),
   * 加上最后那份报告 —— 那才是派它出去的理由。
   */
  private observe(job: AgentJob, event: UIEvent): void {
    switch (event.type) {
      case "message.start":
        job.steps++
        return
      // ★ 花费**边跑边记**,不是等它结束再算总账。一个跑了五分钟的子 agent,
      //   在结束之前是这个程序里唯一一个「正在花钱但屏幕上没有数」的东西
      case "step.finish": {
        const tokens = event.part.tokens
        job.tokensIn += contextTokens(tokens, this.deps.info())
        job.tokensOut += tokens.output
        // ★ 同一笔账要记两个地方,两边问的不是同一个问题:
        //     job 上那份 —— 「**这个**子 agent 花了多少」,给 agents 面板
        //     bill() ——   「**这一场**总共花了多少」,给状态行和 /context
        //   只记前者的后果:agentflow 下主 agent 是领班基本不动手,主账那个数
        //   就永远是一小截,而真正的钱全花在这儿。
        //
        //   ⚠ 走 bill() 不能走 observe():后者会把主对话的上下文占用改成这个
        //     子 agent 的占用(见 ContextMeter.bill 那段)
        this.deps.bill?.(tokens)
        this.deps.onChange?.()
        return
      }
      case "tool.state": {
        const part = event.part
        if (part.state.status === "running") {
          job.activity = callLabel(part)
          this.deps.onChange?.()
          return
        }
        if (part.state.status === "pending") return
        // 收尾了就抖一下文件树。哪个工具都算 —— write/edit 显然,bash 更是
        // 什么都能干;失败的那次也算,它可能已经写了一半才炸的
        this.deps.onFilesChanged?.()
        if (part.state.status === "completed") return this.append(job, `· ${callLabel(part)}`)
        return this.append(job, `✗ ${callLabel(part)} — ${firstLine(part.state.error)}`)
      }
      case "error":
        return this.append(job, `✗ ${firstLine(event.error.message)}`)
      default:
        return
    }
  }

  report(id: string): string | undefined {
    return this.mine(id)?.report
  }

  claimReport(id: string): string | undefined {
    const job = this.mine(id)
    if (!job || job.reported || job.report === undefined) return undefined
    job.reported = true
    return job.report
  }

  /** 这个任务是哪一场派出去的。见 AgentJob.parentSessionID */
  parentOf(id: string): string | undefined {
    return this.jobs.get(id)?.parentSessionID
  }

  /** 最后交回来的那段话。取的是**落库的那一份**,不是流式攒的 —— 中断改写过的以库为准 */
  private finalAnswer(
    job: AgentJob,
    error: Error | undefined,
    interrupted: boolean,
    hitStepLimit = false,
  ): string {
    if (error) return `It stopped with an error: ${describe(error)}`
    const history = this.deps.store.listAll(job.sessionID)
    const text = lastAssistantText(history)
    // ★ 撞上步数上限的那一份必须**标出来**。它照旧会写一段收尾的话(MAX_STEPS_PROMPT
    //   逼它写的),读起来和一份跑完的报告一模一样 —— 而它其实是半截的。不标的话,
    //   主 agent 会拿一份没查完的调查当结论用,而这种错不报错
    const clipped = hitStepLimit
      ? "\n\n(It ran out of steps before finishing — this answer may be incomplete.)"
      : ""
    if (text.length > 0) return text + clipped
    if (interrupted) return "(stopped before it said anything)"
    return "(it finished without a final answer)"
  }

  private append(job: AgentJob, text: string): void {
    if (text.length === 0) return
    job.seen += text.endsWith("\n") ? text : text + "\n"
    if (job.seen.length > MAX_KEEP_CHARS) {
      const over = job.seen.length - MAX_KEEP_CHARS
      job.seen = job.seen.slice(over)
      // 砍掉的那段游标要跟着挪 —— 不挪的话,被砍的部分会被当成"已经读过"
      job.cursor = Math.max(0, job.cursor - over)
    }
    wake(job)
    this.deps.onChange?.()
  }

  private settle(job: AgentJob, exit: number | null, signal?: string): void {
    if (job.status === "exited") return
    job.status = "exited"
    job.endedAt = Date.now()
    job.exit = exit
    if (signal) job.signal = signal
    job.activity = undefined
    // 它那本"读过什么"的账跟着走 —— 这一场结束了,那本账再也不会被查
    // (账本按会话分,见 fs/freshness.ts)
    forgetReads(job.sessionID)
    // ★ 快照要在 pump() **之前**取。它带着 feeds(谁在等这份报告),而报告要不要
    //   进主对话正是按它判的(见 cli/main.ts 的 deliverReport)—— pump 一跑,
    //   等它的那个就从 queued 变成 running,feeds 当场变空,那份报告于是既没交给
    //   下家、又被当成"没人等"塞进了主对话
    const snap = this.snap(job)
    wake(job)
    // 没跑起来过的不写收据。见 AgentJob.ran
    if (job.ran) this.deps.observer?.({ kind: "exited", job: snap })
    this.deps.onChange?.()
    // 空出一格,而且等它的那些可能齐了
    this.pump()
  }
}

// ─────────────────────────────────────────────── 小工具

function snapshot(job: AgentJob, feeds: string[] = []): JobSnapshot {
  return {
    id: job.id,
    kind: "agent",
    command: job.description,
    workdir: job.workdir,
    status: job.status,
    startedAt: job.startedAt,
    ...(job.after.length > 0 ? { after: [...job.after] } : {}),
    ...(feeds.length > 0 ? { feeds } : {}),
    ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
    ...(job.exit !== undefined ? { exit: job.exit } : {}),
    ...(job.signal !== undefined ? { signal: job.signal } : {}),
    ...(job.activity !== undefined ? { activity: job.activity } : {}),
    pending: Math.max(0, job.seen.length - job.cursor),
    steps: job.steps,
    tokensIn: job.tokensIn,
    tokensOut: job.tokensOut,
  }
}

function drain(job: AgentJob): string {
  const out = job.seen.slice(job.cursor)
  job.cursor = job.seen.length
  return out
}

function wake(job: AgentJob): void {
  const waiters = job.waiters
  job.waiters = []
  for (const resolve of waiters) resolve()
  if (job.status !== "exited") return
  const leaving = job.exitWaiters
  job.exitWaiters = []
  for (const resolve of leaving) resolve()
}

/** @returns true = 有动静(新输出或结束了),false = 等超时了 */
function waitForChange(job: AgentJob, ms: number): Promise<boolean> {
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

function exited(job: AgentJob): Promise<void> {
  if (job.status === "exited") return Promise.resolve()
  return new Promise((resolve) => job.exitWaiters.push(resolve))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * 一次工具调用写成一行。
 *
 * 刻意**不复用 cli/render.ts 那套**:那是画给人看的卡片(带颜色、按栏宽截断),
 * 这一行是写给模型读的散文,而且 src/agent 不该反过来依赖渲染层。
 */
function callLabel(part: ToolPart): string {
  const input = "input" in part.state ? (part.state.input as unknown) : undefined
  const hint = firstHint(input)
  return hint ? `${part.tool} ${hint}` : part.tool
}

/** 从工具参数里挑一个最能说明"它在动什么"的字段 */
function firstHint(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  for (const key of ["filePath", "command", "pattern", "path", "url", "query", "description"]) {
    const value = record[key]
    if (typeof value === "string" && value.length > 0) return firstLine(value).slice(0, 80)
  }
  return undefined
}

/** 最后一条 assistant 说的话。合成消息不算 —— 那是塞回去的提醒,不是它的结论 */
function lastAssistantText(history: MessageWithParts[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!
    if (entry.info.role !== "assistant") continue
    const text = entry.parts
      .filter((part) => part.type === "text" && !part.synthetic)
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim()
    if (text.length > 0) return text
  }
  return ""
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? ""
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
