/**
 * 计划下面那一块:后台还有什么在跑。
 *
 * ── 为什么它值一块常驻的地方 ──
 * 后台任务是这个程序里唯一**跨轮活着**的东西。它不属于任何一条对话记录,
 * 滚动上去也找不到 —— 没有一块固定的地方写着它,「刚才那个 dev server 还在
 * 不在」就只能靠 `ps`。而一个要靠 ps 才能确认的自动化,就是看不见的自动化。
 *
 * ── 排在计划下面 ──
 * 计划是「接下来要干什么」,这里是「现在还有什么在替我跑着」。两件都是
 * **状态**不是**内容**,所以贴在一起、都钉在输入框上方;时间上计划在前,
 * 所以它在上。
 *
 * ── 跑完的留一会儿,然后自己走 ──
 * 当场撤掉的话,用户只会看到一行字凭空消失,永远不知道它是成了还是败了。
 * 留几秒钟,带着 `✓ exit 0` / `✗ exit 1` —— 那一眼就是这块地方最有信息量的一瞬。
 * 再久就没道理了:这一块回答的是「现在还有什么在跑」,而它已经不跑了;
 * 结束这件事在对话里另有一行收据(见 cli/main.ts 的 setJobObserver),
 * 想回头看那里有。
 *
 * ── 不写「跑了多久」──
 * 界面的重绘只在忙的时候按 100ms 走,空闲时是不动的(见 app.ts 的 startTimer)。
 * 一个停在 `2m14s` 不动的秒表比不写更糟:它看着像还在走,读到的却是几分钟前
 * 的数。要精确的时间有 job 工具。
 */
import { theme } from "../../cli/theme.ts"
import { displayWidth, padToWidth, truncateToWidth } from "../../cli/width.ts"
import { t } from "../../i18n/index.ts"
import type { JobSnapshot } from "../../tool/background.ts"

/**
 * 跑完之后再留多久。
 *
 * 几秒钟,刚好够扫一眼「它是成了还是败了」。和计划那边的 PLAN_LINGER_MS 不是
 * 同一个数:一份做完的计划是「这段活儿结束了」,值得多留一会儿;一个跑完的
 * 后台任务只是少了一个进程。
 */
export const JOB_LINGER_MS = 6_000

export class JobsPane {
  private jobs: readonly JobSnapshot[] = []

  set(jobs: readonly JobSnapshot[], now = Date.now()): void {
    this.jobs = jobs.filter(
      (job) => job.status === "running" || now - (job.endedAt ?? 0) < JOB_LINGER_MS,
    )
  }

  /**
   * 下一次「有东西该消失了」是什么时候。0 = 没有在倒计时的。
   *
   * 界面空闲时不重绘(见 tui/app.ts 的 startTimer),到点了得有人叫一声 ——
   * App 拿这个时间点安排一次一次性的重绘。
   */
  retireAt(now = Date.now()): number {
    let soonest = 0
    for (const job of this.jobs) {
      if (job.status === "running" || job.endedAt === undefined) continue
      const at = job.endedAt + JOB_LINGER_MS
      if (at > now && (soonest === 0 || at < soonest)) soonest = at
    }
    return soonest
  }

  get empty(): boolean {
    return this.jobs.length === 0
  }

  /** 挂在横线右端的那一格。数的是**还在跑的** —— 刚跑完那几秒不该让它变大 */
  get note(): string {
    const alive = this.jobs.filter((job) => job.status === "running").length
    return alive === 0 ? "" : String(alive)
  }

  /** 全画出来要几行。布局按它分高度 */
  rowsNeeded(): number {
    return this.jobs.length
  }

  render(width: number, height: number): string[] {
    if (height <= 0 || this.jobs.length === 0) return []
    // 装不下就留最后几条 + 顶上一行「还有 N 个」。截断的话被截掉的那几个
    // 彻底没有痕迹 —— 而"到底有几个在跑"正是这一块唯一要回答的问题
    if (this.jobs.length > height) {
      const shown = Math.max(0, height - 1)
      return [
        theme.dim(truncateToWidth(`  ${t.jobsMore(this.jobs.length - shown)}`, width)),
        ...this.jobs.slice(this.jobs.length - shown).map((job) => this.row(job, width)),
      ]
    }
    return this.jobs.map((job) => this.row(job, width))
  }

  /** 名字列对齐到最长那个。名字长度不再固定,写死几格就会参差不齐 */
  private get idWidth(): number {
    // 按显示宽度算 —— 名字可以是中文的,而一个汉字占两列(见 panes/agents.ts)
    return Math.min(18, Math.max(3, ...this.jobs.map((job) => displayWidth(job.id))))
  }

  /**
   * 一行。
   *
   * ⚠ 这一栏**只画进程**。子 agent 有自己那一块(见 panes/agents.ts):它要写的
   *   东西(秒表、进出多少 token)三倍于此,挤进来会把 `npm run dev` 那一行顶没。
   *   两者对**模型**仍然是同一栏东西(`job` 工具一起管),对用户不是。
   */
  private row(job: JobSnapshot, width: number): string {
    const running = job.status === "running"
    const ok = job.exit === 0
    const mark = running ? theme.green("▸") : ok ? theme.dim("✓") : theme.red("✗")
    // 结束的那几秒要写清是怎么结束的:`✓` 和 `✗` 之外还得有退出码,
    // 因为「跑完了」和「跑挂了」在一行里只差一个符号
    const note = running ? "" : job.signal ? ` ${job.signal}` : ` exit ${job.exit ?? "?"}`
    const pad = this.idWidth
    const head = ` ${mark} ${theme.dim(padToWidth(job.id, pad))} `
    const room = Math.max(4, width - 4 - pad - note.length)
    const body = truncateToWidth(job.command, room)
    const line = head + (running ? body : theme.dim(body)) + theme.dim(note)
    return truncateToWidth(line, width)
  }
}
