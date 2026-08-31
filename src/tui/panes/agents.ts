/**
 * 子 agent 自己那一块。
 *
 * ── 为什么它不和后台进程挤在一起 ──
 * 对**模型**来说两者是同一类东西(都用 `job` 看/等/停,见 tool/background.ts),
 * 但对用户不是。一个 dev server 只要回答"还在不在";一个子 agent 要回答的是
 * 「它查到哪一步了、跑了多久、花了多少钱」—— 三个数,而且**都在变**。挤进
 * 后台那一栏的话,那三样要么写不下,要么把 `npm run dev` 那一行挤没。
 *
 * ── 为什么这里敢写秒表,而后台那一栏不写 ──
 * 后台任务那一栏刻意不写时长,理由是"一个停住不动的秒表比不写更糟"。这里的
 * 区别在于:这一块**只在这一趟还没散场的时候存在**,而只要它存在,retireAt()
 * 就至少每秒要一次重绘 —— 秒表因此一定是走的。散场之后整块消失,也就不存在
 * 一个停在那儿的旧数字。
 *
 * ── 钱要分进出写 ──
 * 单价差一个数量级。合成一个数的话,一个读了三十个文件的侦察兵和一个写了
 * 三千字报告的长工看起来一样贵(和状态行上那格同一条理由,见 cli/context.ts)。
 *
 * ── 两种画法,门槛在第八个 ──
 * 一行一个是给"分头看三个模块"那种规模用的:名字、秒表、账单、它此刻在动哪只手,
 * 四样都写得下。到了十几个,这个画法**装不下**——这一栏统共分到三成高度,
 * 十六行会被截成"还有 N 个",而"到底有几个在跑"正是它要回答的第一个问题。
 * 所以第八个开始换成方格:一格一个 agent,`░` 排队 `▒▓` 在跑 `█` 完了,
 * 十六个占四行,外加一行总进度和总花费。
 *
 * ★ 换画法的门槛按**格子数**判,不按 agentflow 开没开。模式决定的是能不能凑够
 *   那么多个,不是凑够了之后怎么画 —— 两件事绑在一起的话,同样的十个 agent
 *   会因为一个和显示无关的开关画成两个样子。
 */
import { theme } from "../../cli/theme.ts"
import { displayWidth, padToWidth, truncateToWidth } from "../../cli/width.ts"
import { compact } from "../../cli/render.ts"
import { t } from "../../i18n/index.ts"
import type { JobSnapshot } from "../../tool/background.ts"

/**
 * 这一趟散场之后再留多久。
 *
 * 比后台进程那边(6 秒)长一点:散场那一下是这一块唯一一次把总账摆出来的机会
 * (跑了多久、一共多少钱),眼睛得来得及扫到。
 */
export const AGENT_LINGER_MS = 10_000

/** 第几个开始换成方格。见文件头 —— 七个还画得下,八个开始画不下 */
export const GRID_AT = 8

/** 方格几列。八个正好两行四列 */
const GRID_COLS = 4

/** 一格至少多宽,不够就减列。挤到只剩记号的方格是没有意义的 */
const MIN_CELL = 14

/** 进度条几格 */
const BAR_CELLS = 12

/**
 * 在跑的那格多久换一次底纹。
 *
 * ── 为什么要动 ──
 * 十六个格子里有三个在跑,而"在跑"和"排队"如果都是静止的,这块面板看上去就
 * 和一张截图一样。会动的那三个是这一屏唯一说明"它真的在替你干活"的东西。
 *
 * ── 为什么只有两帧,而且只在方格模式下要这个重绘 ──
 * 动效的代价是每 450 毫秒全屏重画一次。一行一个的时候没有这个开销(那边一秒
 * 一次就够),而两帧之间只差一格底纹 —— 再花哨一点就成了会呼吸的圣诞树,
 * 而这一栏要的是"看得出哪些在动",不是好看。
 */
const BREATH_MS = 450

export class AgentsPane {
  private agents: readonly JobSnapshot[] = []
  /**
   * 这一趟里出现过的。
   *
   * ── 为什么不能只按"刚跑完 N 秒内"留 ──
   * 那条规则下,一趟十六个的编排会边跑边把先跑完的那些丢掉:第一个在第 10 秒
   * 消失,于是屏幕上写的永远是"3/5 done",而真实进度是 9/16。**总进度这个数
   * 只有在记得住已经完成的那些时才成立** —— 总花费同理,那笔账会边跑边往下掉。
   *
   * 所以按"趟"留:只要还有人在跑或者在排队,这一趟里的全都留着;全部停下来
   * 之后一起过 AGENT_LINGER_MS,然后整块消失。
   */
  private batch = new Set<string>()
  /** 全部停下来是什么时候。0 = 还有在跑的 */
  private idleSince = 0

  set(agents: readonly JobSnapshot[], now = Date.now()): void {
    // ★ 进这一趟的条件是**此刻还活着,或者刚跑完**。不能把 list() 给的全收下 ——
    //   那张表里躺着这一场从头到尾派过的每一个,半小时前那些会跟着一起复活
    for (const agent of agents) {
      if (agent.status !== "exited" || now - (agent.endedAt ?? 0) < AGENT_LINGER_MS) this.batch.add(agent.id)
    }
    if (agents.some((agent) => agent.status !== "exited")) {
      this.idleSince = 0
    } else if (this.batch.size > 0) {
      if (this.idleSince === 0) this.idleSince = now
      else if (now - this.idleSince >= AGENT_LINGER_MS) {
        this.batch.clear()
        this.idleSince = 0
      }
    }
    this.agents = agents.filter((agent) => this.batch.has(agent.id))
  }

  /**
   * 下一次必须重绘是什么时候。
   *
   * 三件事要它:秒表(有人在跑就每秒一次)、方格模式下的底纹、以及"该散场了"。
   * 界面空闲时本来是不动的,没有这一声,时长会停在你上次按键的那一刻。
   */
  retireAt(now = Date.now()): number {
    let soonest = 0
    const at = (when: number) => {
      if (when > now && (soonest === 0 || when < soonest)) soonest = when
    }
    // 方格模式下在跑的那几格要呼吸。**只在这个模式下、而且真有格子在动的时候**
    // 才多要这些帧 —— 一屏全在排队的方阵是静止的,给它每秒两帧是白烧(见 BREATH_MS)
    const breathing = this.agents.some((agent) => agent.status === "running")
    if (breathing && this.agents.length >= GRID_AT) at(now + (BREATH_MS - (now % BREATH_MS)))
    for (const agent of this.agents) {
      if (agent.status === "running") {
        // 下一个整秒。每秒重绘一次就够 —— 这一栏里没有比秒更快的东西
        at(now + (1000 - ((now - agent.startedAt) % 1000)))
        continue
      }
      // 排队的那格上没有秒表(它还没开始干活),所以它自己不要重绘 ——
      // 让它动起来的是别人跑完那一下
      if (agent.status === "queued") continue
      if (agent.endedAt === undefined) continue
      at(agent.endedAt + AGENT_LINGER_MS)
    }
    // 整趟散场
    if (this.idleSince > 0) at(this.idleSince + AGENT_LINGER_MS)
    return soonest
  }

  get empty(): boolean {
    return this.agents.length === 0
  }

  /**
   * 这一趟的三个数。给输入框那块牌子用(见 tui/app.ts 的 flowChip)。
   *
   * 单开一个取数口而不是让调用方自己去 filter,是因为「这一趟」是**这一栏
   * 说了算**的(它记得住已经跑完的那些,见 batch)—— 外面拿到的那份快照里
   * 混着这一场从头到尾派过的每一个,自己数出来的数和这里画出来的对不上。
   */
  get counts(): { total: number; running: number; done: number } {
    return {
      total: this.agents.length,
      running: this.agents.filter((agent) => agent.status === "running").length,
      done: this.doneCount,
    }
  }

  /**
   * 挂在横线右端那一格。
   *
   * 一行一个的时候是**还在跑的**有几个(刚跑完那几秒不该让它变大);方格模式下
   * 换成 `9/16` —— 那时候"一共有多少"和"到了第几个"才是这一栏的主题。
   */
  get note(): string {
    if (this.agents.length >= GRID_AT) return `${this.doneCount}/${this.agents.length}`
    const alive = this.agents.filter((agent) => agent.status === "running").length
    return alive === 0 ? "" : String(alive)
  }

  rowsNeeded(width = 80): number {
    if (this.agents.length < GRID_AT) return this.agents.length
    // 一行总进度 + 方格
    return 1 + Math.ceil(this.agents.length / this.columns(width))
  }

  render(width: number, height: number, now = Date.now()): string[] {
    if (height <= 0 || this.agents.length === 0) return []
    if (this.agents.length >= GRID_AT) return this.grid(width, height, now)
    // 装不下就留最后几条 + 顶上一行「还有 N 个」。截断的话被截掉的那几个
    // 彻底没有痕迹 —— 而"到底有几个在跑"正是这一块要回答的第一个问题
    if (this.agents.length > height) {
      const shown = Math.max(0, height - 1)
      return [
        theme.dim(truncateToWidth(`  ${t.agentsMore(this.agents.length - shown)}`, width)),
        ...this.agents.slice(this.agents.length - shown).map((agent) => this.row(agent, width, now)),
      ]
    }
    return this.agents.map((agent) => this.row(agent, width, now))
  }

  // ───────────────────────────────────────────── 一行一个

  /**
   * 名字列对齐到最长那个。
   *
   * ★ 按**显示宽度**算,不是字符数:名字可以是中文的(调查agent),而一个汉字
   *   占两列。按 length 算的话那一列会参差不齐,后面所有东西跟着错位。
   */
  private get idWidth(): number {
    return Math.min(18, Math.max(3, ...this.agents.map((agent) => displayWidth(agent.id))))
  }

  /**
   * 一行。挤的时候**从右边开始丢**:先丢那句活儿,再丢账单。
   *
   * 顺序是按"丢了之后还认不认得出这一行是谁"排的:名字和状态永远留着,时长
   * 是这一块存在的理由之一,而那句活儿在对话里还能翻到。
   */
  private row(agent: JobSnapshot, width: number, now: number): string {
    const queued = agent.status === "queued"
    const running = agent.status === "running"
    const ok = agent.exit === 0
    const mark = queued ? theme.dim("░") : running ? theme.cyan("▸") : ok ? theme.dim("✓") : theme.red("✗")
    // 排队的那个不写秒表:它一个请求都还没发,而一个从排进队列就开始走的钟
    // 讲的是"它等了多久",看上去却像"它干了多久"
    const time = queued ? "—" : elapsed((agent.endedAt ?? now) - agent.startedAt)
    const cost = t.ctxSpentShort(compact(agent.tokensIn ?? 0), compact(agent.tokensOut ?? 0))
    const pad = this.idWidth

    const head = ` ${mark} ${theme.dim(padToWidth(agent.id, pad))} ${time.padStart(6)} `
    // 4 = 记号 + 两个空格 + 一格余量;7 = 时长那一列(6 + 一个空格)
    let room = width - 4 - pad - 7
    const bits: string[] = []
    // ★ 按显示宽度,不是 .length:中文界面下 `进 3k · 出 1k` 是 12 个字符、
    //   14 列,按字符数算会多给出去两列,而这一整个文件的规矩就是显示宽度
    const costWidth = displayWidth(cost)
    if (!queued && room > costWidth + 6) {
      bits.push(theme.dim(cost))
      room -= costWidth + 2
    }
    // 排队的写它在等谁,而不是那句活儿 —— 「为什么它不动」是这一格唯一的问题
    const what = truncateToWidth(queued ? this.waitingFor(agent) : agent.command, Math.max(0, room))
    if (what.length > 0) bits.push(running ? what : theme.dim(what))
    return truncateToWidth(head + bits.join("  "), width)
  }

  private waitingFor(agent: JobSnapshot): string {
    const after = agent.after ?? []
    return after.length > 0 ? `queued — waiting for ${after.join(", ")}` : "queued — waiting for a slot"
  }

  // ───────────────────────────────────────────── 方格

  private columns(width: number): number {
    return Math.max(1, Math.min(GRID_COLS, Math.floor((width - 1) / MIN_CELL)))
  }

  private get doneCount(): number {
    return this.agents.filter((agent) => agent.status === "exited").length
  }

  private grid(width: number, height: number, now: number): string[] {
    const cols = this.columns(width)
    const cellWidth = Math.floor((width - 1) / cols)
    const rows: string[] = [this.progress(width, now)]

    // 高度不够就**从后面截**,并且把截掉的算进头一行那个数里 —— 头一行写的是
    // 总数,所以它永远是对的,少的只是看得见几格
    const room = Math.max(0, height - 1)
    const shown = this.agents.slice(0, Math.max(0, room * cols))
    for (let at = 0; at < shown.length; at += cols) {
      const cells = shown.slice(at, at + cols).map((agent, n) => this.cell(agent, at + n, cellWidth, now))
      rows.push(" " + cells.join(""))
    }
    return rows
  }

  /**
   * 头一行:进度条 + 到第几个 + 还有几个在跑 + 走了多久 + 一共多少钱。
   *
   * 挤的时候从右往左丢,但**前两样永远留着** —— 一格一格的方阵本身说不出
   * "9/16",而那正是换成方阵之后唯一丢掉的信息。
   */
  private progress(width: number, now: number): string {
    const total = this.agents.length
    const done = this.doneCount
    const running = this.agents.filter((agent) => agent.status === "running").length
    const queued = total - done - running

    const filled = total === 0 ? 0 : Math.round((done / total) * BAR_CELLS)
    const bar = theme.green("█".repeat(filled)) + theme.dim("░".repeat(BAR_CELLS - filled))

    let tokensIn = 0
    let tokensOut = 0
    let from = Number.POSITIVE_INFINITY
    let until = 0
    for (const agent of this.agents) {
      tokensIn += agent.tokensIn ?? 0
      tokensOut += agent.tokensOut ?? 0
      from = Math.min(from, agent.startedAt)
      until = Math.max(until, agent.endedAt ?? now)
    }
    // 还有人在跑的话钟走到现在,全停了就停在最后一个结束的那一刻
    const span = elapsed((running + queued > 0 ? now : until) - (Number.isFinite(from) ? from : now))

    const head = ` ${bar}  ${theme.bold(`${done}/${total}`)} ${theme.dim(t.agentsDone)}`
    let room = width - 1 - BAR_CELLS - 2 - displayWidth(`${done}/${total}`) - 1 - displayWidth(t.agentsDone)
    const bits: string[] = []
    const add = (text: string) => {
      const need = displayWidth(text) + 3
      if (need > room) return
      room -= need
      bits.push(text)
    }
    // 丢的顺序:先丢"还有几个在跑"(方阵上数得出来),再丢秒表,账单最后丢 ——
    // 一趟十六个的编排里,那笔钱是用户最想知道、也最看不见的东西
    add(t.ctxSpentShort(compact(tokensIn), compact(tokensOut)))
    add(span)
    if (running > 0 || queued > 0) add(queued > 0 ? t.agentsRunningQueued(running, queued) : t.agentsRunning(running))
    return truncateToWidth(head + theme.dim(bits.reverse().map((bit) => ` · ${bit}`).join("")), width)
  }

  /**
   * 一格。
   *
   * 底纹就是状态,而且是**填充度**:`░` 还没开始 → `▒▓` 正在填 → `█` 满了。
   * 用户在这一屏上要读的第一件事是"还剩多少没做完",而一片方阵里深浅的分布
   * 一眼就答了 —— 名字是第二眼才看的东西(哪一个卡住了)。
   */
  private cell(agent: JobSnapshot, index: number, width: number, now: number): string {
    const running = agent.status === "running"
    const queued = agent.status === "queued"
    const ok = agent.exit === 0

    // 相邻两格的相位差一拍,于是整片方阵是**波动**的而不是齐刷刷闪 ——
    // 齐刷刷那种看着像界面在抽搐
    const phase = (Math.floor(now / BREATH_MS) + index) % 2
    const glyph = queued
      ? theme.dim("░")
      : running
        ? theme.cyan(phase === 0 ? "▒" : "▓")
        : ok
          ? theme.green("█")
          : theme.red("█")

    const right = queued ? theme.dim("—") : running ? theme.dim(short(now - agent.startedAt)) : ok ? theme.green("✓") : theme.red("✗")
    const rightWidth = displayWidth(queued ? "—" : running ? short(now - agent.startedAt) : "✓")
    // 1 记号 + 1 空格 + 名字 + 1 空格 + 右边那个 + 1 格间距
    const nameWidth = Math.max(1, width - 4 - rightWidth)
    const name = truncateToWidth(agent.id, nameWidth)
    const label = running ? name : theme.dim(name)
    return `${glyph} ${label}${" ".repeat(Math.max(0, nameWidth - displayWidth(name)))} ${right} `
  }
}

/**
 * 秒表的写法。**刻意不复用 cli/render.ts 的 duration**:那个给的是 `1.2s`
 * 这种带小数的,读的是"这次调用花了多久";这里要的是一个每秒跳一格的钟,
 * 小数位每 100 毫秒变一次,看着像在抖。
 */
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`
}

/** 方格里那个更短的钟。一格统共十来列,`1m02s` 得压成 `1m` */
function short(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`
}
