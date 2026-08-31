/**
 * 「后台还有什么在替我跑着」的共同词汇。
 *
 * ── 为什么进程和子 agent 是同一个东西 ──
 * 一个 `npm run dev` 和一个正在翻仓库的子 agent,在用户那里是同一件事:**我不用
 * 站在这儿等,但我得知道它还在不在、说了什么、怎么停掉**。它们的寿命都比一次
 * 工具调用长,都要跨轮活着,都要在退出时收干净。既然要回答的问题一样,就不该
 * 有两套名字、两块面板、两个「看一眼」的工具 —— 那样模型每次都要先想清楚
 * 「这个 id 是哪一种」,而这个问题对它毫无价值。
 *
 * 所以 `job` 工具管两种,`bash background:true` 和 `task` 各起一种。这个文件
 * 就是两边共用的那点东西:快照的形状、名字的分配、以及 agent 那一侧的接口。
 *
 * ── 为什么 AgentJobs 只是个接口 ──
 * 子 agent 要起一整个 Loop,而 `src/tool` 不认识循环(见 DESIGN.md 的架构边界)。
 * 实现住在 `src/agent/subagent.ts`,由 CLI 在造 ToolContext 时注入进来。
 * 这里只声明「它得能干什么」。
 */

export type JobKind = "process" | "agent"

export interface JobSnapshot {
  id: string
  /** 进程还是子 agent。界面和 `job list` 都要区分,别的地方一视同仁 */
  kind: JobKind
  /** 进程是命令原文,子 agent 是那份交代的头一行 */
  command: string
  /**
   * 这个后台进程是**谁起的**(子 agent 的名字);主 agent 自己起的没有这个。
   *
   * ★ 它决定这条进程的起落要不要写进主对话:一个子 agent 顺手起的
   *   `npm run dev`,报进用户正在读的那段对话里是**串味**——用户没让谁起它,
   *   而那段对话讲的是另一件事。面板上照旧看得见(那是状态,不是内容)。
   */
  owner?: string
  workdir: string
  /**
   * `queued` **只有子 agent 会有**:窗口满了、或者它在等别的任务跑完(见
   * agent/subagent.ts 的 pump)。进程那边没有队列,`bash background:true` 起了就是起了。
   *
   * ★ 排队的**不算 running**。这一栏一度只有两个值,于是排队的只能报成"在跑" ——
   *   而那句话是假的:它一个请求都还没发。「停了」这句话必须是真的,那这一句
   *   也一样(见 JobReadResult.detail 那颗星)。
   */
  status: "queued" | "running" | "exited"
  /** 排着队是在等这几个跑完(子 agent 专用)。见 StartAgentInput.after */
  after?: string[]
  /**
   * 谁在等**这一个**的报告(子 agent 专用)。
   *
   * ★ 它决定这份报告要不要送进主对话:有人等着的话,报告是拼进那个人的交代里的
   *   (见 subagent.ts 的 briefFor),再往主对话里塞一份就是把派子 agent 想省下的
   *   上下文又还回去了 —— 十二个侦察兵各交一份报告,主对话立刻就满了。
   *   派它出去的那个 agent 要看,照旧 `job output` 读得到。
   */
  feeds?: string[]
  startedAt: number
  endedAt?: number
  /** 退出码。被信号杀掉时为 null;子 agent 用 0 = 说完了,1 = 出错/被停 */
  exit?: number | null
  signal?: string
  /** 还没被读走的输出有多少字符 */
  pending: number
  /**
   * 它现在在干什么(子 agent 专用:最后一次工具调用的一句话)。
   *
   * 进程那边没有这个 —— 一行 `npm run dev` 已经说清它是什么了,而一个子 agent
   * 的 `command` 是十秒前派下去的活儿,「现在到哪一步了」得另说。
   */
  activity?: string
  /** 发出去过几轮请求(子 agent 专用) */
  steps?: number
  /**
   * 烧掉多少 token(子 agent 专用,计费口径,**边跑边涨**)。
   *
   * ★ 必须报出来,而且要**分进出**。子 agent 是这个程序里唯一「看不见地花钱」
   *   的东西:它跑在后台,没有卡片、没有流式文字,而它一趟可能比主对话整轮
   *   还贵。状态行上那个花费只算主会话(那个数同时是上下文占用的真值源,掺进来
   *   就全错了),所以这笔账只能在它自己那一行上还。
   *
   *   进和出分开是因为单价差一个数量级 —— 合成一个数的话,一个很便宜的子 agent
   *   和一个很贵的长得一模一样(和状态行上那格同一条理由,见 cli/context.ts)。
   */
  tokensIn?: number
  tokensOut?: number
}

export interface JobReadResult {
  job: JobSnapshot
  /** 上次之后的新输出。没有新东西就是空串 */
  output: string
  /** 等超时了(要过的话 waitMs 得大于 0) */
  timedOut: boolean
  /**
   * 停一个任务时没能确认它真的没了 —— 一句能照着查下去的话。
   *
   * ★ 有这一栏是因为「停了」曾经是**无条件**报的:调用方看到 "Stopped dev",
   *   而那句话讲的其实只是"我们的管理记录已经标成完成"。真机上撞见的是
   *   `job kill` 说停了、端口还占着(见 tool/bash/kill.ts 的 KillOutcome)。
   */
  detail?: string
}

export interface StartAgentInput {
  /**
   * 这是个什么 agent —— 按**性质**取,不是按这次的活儿:调查agent、分析agent、
   * audit。它成为这个任务的名字,重名的话后面挂 `-2`。
   *
   * 任何语言都行(见 slugName)。这一栏里的名字是给人看的第一眼,而
   * `job-2` / `job-5` 那种编号要靠记才知道指的是谁 —— 那正是这套命名要躲开的东西。
   */
  name: string
  /** 派给子 agent 的完整交代。它看不见主对话,所以这里得自成一体 */
  prompt: string
  /**
   * 等这几个跑完再起,并且把它们交回来的报告拼进它的交代里。
   *
   * ── 这一栏就是「编排」的全部 ──
   * 有了它,「十二个分头查 → 三个交叉验 → 一个汇总」是**一轮 turn 里摆出去的
   * 一张图**,程序按拓扑跑完。没有它,主 agent 得在每个阶段之间醒来一次充当
   * 调度器,而它每醒一次都要重发整段对话历史 —— 编排的成本会随阶段数翻倍,
   * 直到编排本身比它编排的活儿还贵。
   *
   * 名字必须是**这一场里已经派出去的**任务(见 resolveAfter)。因此新任务只能
   * 指向更早的任务,这张图天生无环。
   */
  after?: string[]
}

/**
 * 后台跑着的子 agent。实现见 agent/subagent.ts。
 *
 * 方法名和 bash/jobs.ts 那一侧**刻意一致**:`job` 工具拿到 id 之后先问进程表、
 * 再问这里,两边的返回形状一样,所以它不用为两种任务写两套分支。
 */
export interface AgentJobs {
  start(input: StartAgentInput): Promise<JobSnapshot>
  /**
   * 把一个**已经跑完**的子 agent 叫起来,再交代一句。
   *
   * ── 为什么它不该有死期 ──
   * 那一场会话完整躺在库里(见 agent/subagent.ts 的 parent_id),叫醒它的代价
   * 只是再跑一次循环 —— 而它手上还攥着上一轮读过的全部东西。给它安一个
   * "超过十分钟就算凉了"纯粹是实现图省事:用户偶尔真的需要追问那一个,
   * 而那时候唯一的替代是重派一个空白的,把背景再讲一遍。
   *
   * ★ 但**没有死期不等于跨得过会话**:能叫醒的只有**这一场自己派出去的**。
   *   `/clear` 之后是一场全新的对话,上一场那些对它来说根本不存在(见 owns)。
   *
   * 还在跑的不能叫(它正忙,而它的答案本来就会自己回来),不认识的名字也不能。
   */
  resume(id: string, prompt: string): Promise<JobSnapshot>
  list(): JobSnapshot[]
  has(id: string): boolean
  read(id: string, waitMs: number): Promise<JobReadResult>
  kill(id: string): Promise<JobReadResult>
  /**
   * 它最后交出来的那段话,**不含干活过程那些行**。还没结束就是 undefined。
   *
   * 和 read() 分开是因为两种用法要的东西不一样:要结论的只要结论(派它出去的
   * 全部意义就是那些过程不进主对话),而在后台跑的那些要的是"到哪一步了"。
   */
  report(id: string): string | undefined
  /**
   * 取走报告,并且**记下已经交过了**。
   *
   * ★ 报告有两条路可能同时到主 agent 手里:`task` 那次调用当场就发现它已经跑完
   *   (400 毫秒内结束的都会),以及结束时那条推送(见 cli/main.ts 的 deliverReport)。
   *   两条都发的话,模型会把同一份结论读两遍 —— 而它多半会当成两个子 agent 的
   *   结果去对账。这个函数让"谁先到谁负责",另一条拿到 undefined 就什么都不做。
   */
  claimReport(id: string): string | undefined
}

// ─────────────────────────────────────────────── 名字

/**
 * 用过的名字,**跑完了也不放回去**。
 *
 * ── 为什么两种任务共用一本账 ──
 * 一个叫 `audit` 的子 agent 和一个叫 `audit` 的脚本同时在跑,`job output audit`
 * 就只能靠运气。名字是这一栏里唯一会被反复引用的东西,它必须在整个程序范围内
 * 唯一,而不是"在它自己那张表里唯一"。
 *
 * ── 为什么不回收 ──
 * 模型手里可能还攥着上一个的名字。重名的话它会拿着旧结论去读新任务的输出 ——
 * 而这种错不会报错,只会给出一个看起来合理的答案。
 */
const used = new Set<string>()

/** 拿一个已经归一化过的词换一个全局唯一的名字:`dev` → `dev` / `dev-2` / `dev-3` */
export function reserveName(base: string): string {
  const name = base.length > 0 ? base : "job"
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  for (let n = 2; ; n++) {
    const candidate = `${name}-${n}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
}

/** 仅用于测试。 */
export function __resetNamesForTest(): void {
  used.clear()
}

/**
 * 一句话 → 一个能当名字的词。两边共用,免得 `dev` 和 `Dev` 被当成两个名字。
 *
 * ── 为什么不能只留 ASCII ──
 * 这里一度是 `[^a-z0-9]+` 全删,于是**任何一个中文名字都会变成空串**,兜底成
 * `job` / `job-2` / `job-5`。那恰恰是这套命名要躲开的东西(见 reserveName 上面
 * 那段:序号要靠记才知道指的是谁)。所以现在删的是**分隔符**,不是"非英文":
 * 空白、标点、控制字符去掉,字母数字和汉字假名谚文一律留着。
 *
 * ── 为什么按显示宽度截 ──
 * 名字要在面板上占一列,而中日韩一个字占**两列**。按字符数截的话,一个八个字的
 * 中文名字会画成十六列,把那一列后面所有东西挤出去。
 */
export function slugName(text: string): string {
  const out = text
    .toLowerCase()
    // 分隔符 → 连字符。\p{L} 是任何语言的字母,\p{N} 是数字
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
  return clampToColumns(out, NAME_COLUMNS) || "agent"
}

/** 名字最多占几列。再宽就把面板那一行的别的东西挤没了 */
const NAME_COLUMNS = 16

/**
 * 按**显示宽度**截断。
 *
 * 刻意不 import cli/width.ts:那是渲染层,而这里是工具层(见 DESIGN.md 的架构边界)。
 * 要判的东西也简单得多 —— 只有"中日韩算两列"这一条,不需要那边整套的
 * 组合字符/变体选择子处理。
 */
function clampToColumns(text: string, columns: number): string {
  let width = 0
  let out = ""
  for (const char of text) {
    const size = wide(char) ? 2 : 1
    if (width + size > columns) break
    width += size
    out += char
  }
  return out.replace(/-+$/g, "")
}

/**
 * 同一张宽字符表更粗的一份 —— 这里只要「够不够宽」,不需要 width.ts 那种精度。
 * 区段同样来自 Markus Kuhn 的 wcwidth.c(公有领域),见 NOTICE。
 */
function wide(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f)
  )
}
