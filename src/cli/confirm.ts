/**
 * 权限确认交互。
 *
 * ── 这是整个程序里唯一一处「用户来不及看清就按下去」代价最高的地方 ──
 * 所以有三条硬规矩:
 *
 * 1. **没人回答就是拒绝。** Esc、Ctrl-C、Ctrl-D、读不到 TTY —— 一律 reject。
 *    回车是个例外,它按用户的要求改成了「放行一次」(见 tui/panes/prompt.ts
 *    的说明)—— 那是一次**明确表态**,而不是"没表态就当同意";没人在的时候
 *    (管道、CI)根本不会有回车进来,那条路照旧一律拒绝。
 *
 * 2. **要执行什么必须完整显示。** bash 的每条子命令分行列出,而不是把
 *    `a && b && rm -rf c` 挤成一行让人扫一眼就按 y。
 *
 * 3. **forbidAlways 时不显示 always 选项。** 不是显示了再拒绝 —— 拆句器
 *    不确定的时候,连"以后不再问"这个念头都不该给用户。
 */
import type { AskDecision } from "../tool/types.ts"
import type { PromptRequest } from "../permission/gate.ts"
import type { Keyboard } from "./keyboard.ts"
import type { Key } from "./keys.ts"
import { t } from "../i18n/index.ts"
import { truncate } from "./render.ts"
import { theme } from "./theme.ts"

/** 只用到这两个方法,写成结构类型省得测试里造一个真的活动区。 */
export interface Suspendable {
  suspend(): void
  resume(): void
}

export interface ConfirmDeps {
  /** stdin 的持有者。没有(或不是 TTY)就一律拒绝。 */
  keyboard?: Keyboard
  /** 默认 process.stdout */
  output?: NodeJS.WriteStream
  /** 问话期间让出屏幕的底部活动区 */
  region?: Suspendable
  /** 中断时立刻返回 reject */
  signal?: AbortSignal
}

/** 一次询问。返回 once / always / reject。 */
export async function confirm(request: PromptRequest, deps: ConfirmDeps = {}): Promise<AskDecision> {
  const output = deps.output ?? process.stdout

  // 输入框要先让开。它是每帧重画的,而问话这几行是要留在滚动记录里的 ——
  // 不让开的话重画会把问题本身擦掉,用户看着一个没有问题的 [y/a/N]。
  deps.region?.suspend()
  try {
    output.write(renderRequest(request))

    // 非交互(管道、CI、-p 模式)下没有人可以回答。这里必须拒绝而不是放行:
    // 一个跑在 CI 里的 agent 拿到的应该是"没有权限",不是"没人看着所以随便来"。
    if (!deps.keyboard?.usable) {
      output.write(theme.red("  no TTY — automatically rejected\n\n"))
      return "reject"
    }

    const answer = await readKey(deps.keyboard, output, request.forbidAlways, deps.signal)
    output.write("\n")
    return answer
  } finally {
    deps.region?.resume()
  }
}

export function renderRequest(request: PromptRequest): string {
  return ["", ...requestLines(request).map((line) => "  " + line), "", "  " + optionsLine(request)].join("\n") + " "
}

/**
 * 这次授权是**哪个子 agent**要的。主 agent 自己要的返回 undefined。
 *
 * ── 为什么是一个函数,而不是两处各读一次 metadata ──
 * 读它的有两个地方,而它们要做的事正好相反:问框要把这一行**写出来**(用户
 * 得知道是谁在要),trust 那条自动放行的收据则要把这一行**吞掉** —— 它属于
 * 后台那一场,写进用户正看着的对话里就是串味(见 cli/main.ts 的 onTrusted)。
 * 一个约定被两处相反地使用,那它就该只有一个出处。
 */
export function askingJob(request: PromptRequest): string | undefined {
  const job = request.metadata?.["job"]
  return typeof job === "string" && job.length > 0 ? job : undefined
}

/**
 * trust 模式下没问就放行的那张收据。**返回 undefined = 这一条不写进对话。**
 *
 * ── 为什么自动放行一定要留痕 ──
 * 看不见的自动化不是省事,是失控。trust 模式的意思是"规则本来要问的一律放行",
 * 那至少要让人事后能数出来它放行了什么。
 *
 * ── 为什么子 agent 的那些反而不写 ──
 * 它是后台的一场。它跑的每条命令都记在自己的输出里(`job output` 读得到),
 * 面板上那一行也写着它此刻在干什么。写进用户正看着的这一场,他会看到一串
 * 自己没让谁干的 `bash — 未询问直接放行` 凭空冒出来 —— 和子 agent 的进程
 * 记录混进主会话是同一种串味(见 agent/subagent.ts)。
 *
 * ⚠ 和问框那一侧**刚好相反**:那个必须写清是谁要的(用户当时正在跟主 agent
 *   说话,不说来路的话,他看到的是一条自己没让谁干的事在请求授权)。同一个
 *   约定被两处相反地使用,所以 askingJob 只有一个出处。
 */
export function trustNote(request: PromptRequest): { line: string; summary: string } | undefined {
  if (askingJob(request)) return undefined
  const what = `${request.permission} — ${t.trustAllowed}`
  return {
    // ★ 不上绿色。绿色在别处是「成功了」,而「没人看着就过了」不是一件成功的事。
    //   ⚡ 留一点黄(和授权框同一个颜色),其余压暗:trust 模式下这行每次调用都
    //   会出现,一直喊等于没喊
    line: theme.yellow("  ⚡ ") + theme.dim(what + reasonTail(request)),
    // 同一张收据在看板上的样子。行首的符号归看板管(它按 tone 上色),这里不带
    summary: theme.dim(what),
  }
}

/** 拆句器给的风险标记(子 shell、重定向、出网、提权)。工具卡片上没有这个。 */
function reasonTail(request: PromptRequest): string {
  const reasons = request.reasons ?? []
  if (reasons.length === 0) return ""
  return ` · ${truncate(reasons.join("; "), 60)}`
}

/**
 * 问题本身,一行一条,**不带**选项行和缩进。
 *
 * 拆出来是因为全屏界面要把它画进一个模态框里,而不是往 stdout 吐 ——
 * 在 alternate screen 里直接 write 会盖穿合成器画好的面板,而且合成器的前台
 * 缓冲还以为屏幕没变,之后每一帧的差分都对着错的基准算,画面再也回不来。
 * 两边共用这一份内容,才不会出现"两种界面问的不是同一件事"。
 */
export function requestLines(request: PromptRequest): string[] {
  const lines: string[] = []
  lines.push(theme.yellow(theme.bold(`⚠ permission required: ${request.permission}`)))

  const metadata = request.metadata ?? {}
  // 后台的子 agent 要的授权。**必须写在最前面** —— 用户当时正在跟主 agent 说话,
  // 一个突然弹出来的框如果不说是谁要的,他看到的就是一条自己没让谁干的事
  // (见 agent/subagent.ts)
  const job = askingJob(request)
  if (job) lines.push(theme.cyan(`asked by subagent ${job}`))
  const command = typeof metadata["command"] === "string" ? metadata["command"] : undefined
  const segments = Array.isArray(metadata["segments"]) ? (metadata["segments"] as unknown[]) : undefined

  if (command !== undefined) {
    // 整条原文 + 逐条子命令。只给其中一个都不够:
    // 只给原文 → 长命令里藏的东西看不清;只给子命令 → 看不出它们的连接方式。
    lines.push(theme.dim("command:"))
    for (const line of command.split("\n")) lines.push("  " + theme.bold(line))
    // 工作目录只在不是仓库根时才有(见 bash.ts)。同一条 `rm -rf build`
    // 在仓库根和在别处是两件事,而命令文本本身看不出这个区别
    const workdir = metadata["workdirLabel"]
    if (typeof workdir === "string" && workdir.length > 0) {
      lines.push(theme.dim("in: ") + theme.cyan(workdir))
    }
    if (segments && segments.length > 1) {
      lines.push(theme.dim(`runs ${segments.length} commands:`))
      for (const segment of segments) lines.push("  " + theme.cyan("• " + String(segment)))
    }
  } else {
    for (const pattern of request.patterns) lines.push("  " + theme.bold(pattern))
  }

  if (metadata["parseOk"] === false) {
    lines.push(theme.red(`! ${t.promptParseUnsure}`))
  }

  const reasons = request.reasons ?? []
  if (reasons.length > 0) {
    lines.push(theme.dim("flagged:"))
    for (const reason of reasons) lines.push("  " + theme.yellow("• " + reason))
  }

  // auto 模式看过了还要问 —— 说清是判官拿不准还是它根本没答上来,
  // 否则用户会以为 auto 没生效

  const preview = metadata["preview"]
  if (typeof preview === "string" && preview.length > 0) {
    lines.push("")
    for (const line of preview.split("\n")) lines.push(line)
  }
  return lines
}

export function optionsLine(request: PromptRequest): string {
  // 大写的那个 = 回车会选的那个,这是终端交互的通行约定。所以回车改成放行
  // 之后,大写必须跟着从 N 挪到 Y —— 不挪的话,这一行就在骗人
  // ★ 方括号里的**键名不译**(Y / a / n / esc)—— 它们是要按下去的东西,
  //   翻过去用户按不出来。翻的只是后面那几个词。见 i18n 那条「按键名一律不译」
  const parts = [theme.green(`[Y] ${t.promptAllowOnce}`)]
  if (!request.forbidAlways) {
    const scope = request.alwaysPatterns[0]
    parts.push(theme.cyan(`[a] ${t.promptAlways}${scope ? ` (${scope})` : ""}`))
  }
  parts.push(theme.dim(`[n] ${t.promptReject}  esc`))
  return parts.join("  ") + theme.dim("  › ")
}

/**
 * 读一个键,不需要回车。
 *
 * 键盘的接管必须在**所有**退出路径上归还,包括抛异常和中断 —— 漏一条,
 * 底下的输入框就再也收不到按键,只能关窗口。所以用 keyboard.push 返回的
 * dispose,而不是自己去 on/off stdin。
 */
function readKey(
  keyboard: Keyboard,
  output: NodeJS.WriteStream,
  forbidAlways: boolean,
  signal?: AbortSignal,
): Promise<AskDecision> {
  return new Promise((resolve) => {
    let settled = false
    let release: (() => void) | undefined

    const finish = (decision: AskDecision, echo: string) => {
      if (settled) return
      settled = true
      output.write(echo)
      signal?.removeEventListener("abort", onAbort)
      release?.()
      resolve(decision)
    }

    const onKey = (key: Key) => {
      if (key.ctrl && (key.name === "c" || key.name === "d")) return finish("reject", theme.dim("^C"))
      // 回车 = 放行一次,和全屏那个模态框同一条规矩 —— 同一个键在两种形态下
      // 意思相反,是这个程序最不该有的东西
      if (key.name === "enter") return finish("once", theme.green("y"))
      if (key.name === "escape") return finish("reject", theme.dim("n"))
      // 粘贴、功能键、带修饰符的组合一律无视 —— 别让误触决定文件系统的命运
      if (key.ctrl || key.meta || [...key.name].length !== 1) return
      switch (key.name.toLowerCase()) {
        case "y":
          return finish("once", theme.green("y"))
        case "a":
          if (forbidAlways) return // 明确忽略,不给任何"按了有反应"的暗示
          return finish("always", theme.cyan("a"))
        case "n":
          return finish("reject", theme.dim("n"))
        default:
          return
      }
    }

    const onAbort = () => finish("reject", theme.dim("^C"))

    release = keyboard.push(onKey)
    // raw 模式拿不到就别硬来 —— 逐行读会把用户的下一句输入当成答案
    if (!keyboard.attached) return finish("reject", theme.red(`n (${t.promptNoKeyboard})`))
    if (signal?.aborted) return onAbort()
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
