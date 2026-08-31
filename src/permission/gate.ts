/**
 * 权限门卫本体。
 *
 * 流程(顺序不能改):
 *   1. HARD_DENY 前置检查 —— 独立一步,config、always、模式都碰不到
 *   2. 逐 pattern evaluate,任一条 deny 立即短路
 *   3. 全 allow 直接放行(confirm 模式下这一步会被降级成「要问」)
 *   4. 确定性的「在项目里跑项目自己的脚本」一档(见 routine.ts)
 *   5. trust 模式:剩下的全部放行;其它模式:await 注入的 prompt()
 *
 * ── 模式只能加锁,不能解锁 ──
 * 第 1、2 步的结论任何模式都改不动。trust 唯一的权力是替用户回答第 5 步那个
 * 问题;confirm 唯一的权力是把第 3 步的放行拉回来问一遍。这样一来「换个模式
 * 试试」永远不可能绕过硬名单或者显式的 deny。
 *
 * ── 第三档为什么是「放空」而不是「让一个模型替你判」(以及它为什么改名叫 trust) ──
 * 门口站过一个判官模型。它失败的方式非常一致:它只看得见一行命令,看不见
 * 为什么现在要做这件事。`python3 demo.py`(agent 十秒前刚写、用户看着 diff
 * 出来的)被判成「无法判断风险」;用户答「确认」被判成「回复较为模糊」。
 * 信息不在它手里,再怎么调措辞都只是逼它瞎猜 —— 而那些信息全在**干活的那个
 * 模型**手里。
 *
 * 所以判断力搬到了 system prompt 里(见 prompt/safety.ts):按「东西还能不能
 * 回来」判,而不是按命令长得吓不吓人判。门卫退回它本来的样子 —— 一张静态表
 * 加一份硬名单,零延迟、零变数、看得懂。
 *
 * 判官撤掉之后,那一档就不再有任何「自动判断」可言,所以它也跟着改了名:
 * auto → trust。名字得说实话,见 permission/mode.ts。
 *
 * 将来真需要外部意见的(比如要不要信一段从网上抓回来的内容),那应该是 agent
 * **自己决定去调用**的一个工具,而不是站在门口拦所有人的收费站。
 */
import { dirname } from "node:path"
import { alwaysPattern } from "./arity.ts"
import { DEFAULT_MODE, type PermissionMode } from "./mode.ts"
import { runsProjectScript } from "./routine.ts"
import { DEFAULTS, evaluate, matchesHardDeny, type Action, type Ruleset } from "./rules.ts"
import type { AskDecision, AskInput } from "../tool/types.ts"
import { PermissionDeniedError } from "../tool/types.ts"

export interface PromptRequest {
  permission: string
  patterns: string[]
  /** 用户选 always 时会被写入的规则,提前算好给 UI 展示「以后不再问 X」 */
  alwaysPatterns: string[]
  forbidAlways: boolean
  metadata?: Record<string, unknown>
  /** 触发询问的原因(bash 拆句器给的风险标记) */
  reasons?: string[]
  /** 这次询问属于哪次工具调用。界面拿它把结论画回那张卡片上,见 AskInput.callID */
  callID?: string
  /** 这次询问跟着谁死。见 AskInput.signal —— 后台来的问题不该挂在用户这一轮上 */
  signal?: AbortSignal
}

export type PromptFn = (request: PromptRequest) => Promise<AskDecision>

export class HardDenyError extends Error {
  readonly ruleID: string
  constructor(ruleID: string, reason: string, pattern: string) {
    super(
      `Blocked by a hard safety rule (${ruleID}): ${reason}.\n` +
        `Target: ${pattern}\n` +
        `This rule cannot be overridden by configuration or by approving it. Do not retry; find another approach or ask the user to do it manually.`,
    )
    this.name = "HardDenyError"
    this.ruleID = ruleID
  }
}

export interface GateOptions {
  /**
   * trust 模式自动放行了什么。**必须接** —— 看不见的自动化不是省事,是失控。
   *
   * 它是唯一一处「本来要问你、但没问」的记录,所以两个视图都要留痕。
   */
  onTrusted?(request: PromptRequest): void
  /** 工作区根。判「这个脚本在不在项目里」要用,见 routine.ts */
  root?: string
  /**
   * 用户选了 always,把这几条存起来。不接就只在本进程内生效。
   *
   * 存哪儿、怎么存不归门卫管(见 permission/approvals.ts)—— 它只负责在
   * 该记的那一刻说一声。测试里因此可以完全不碰文件系统。
   */
  remember?(rules: Ruleset): void
}

export class PermissionGate {
  /** 用户配置(M1 还没有配置文件,预留) */
  private userRules: Ruleset = []
  /**
   * 生效中的 always。进程内一份,同时由 options.remember 落盘。
   *
   * ⚠ 它排在 evaluate 的**最后一个** ruleset,所以能盖过 DEFAULTS ——
   *   但盖不过 HARD_DENY:那张表在 ask() 的第一步就短路了,不参与叠加。
   */
  private approved: Ruleset = []
  private mode: PermissionMode = DEFAULT_MODE
  private readonly options: GateOptions

  constructor(
    private prompt: PromptFn,
    options: GateOptions = {},
  ) {
    this.options = options
  }

  setUserRules(rules: Ruleset): void {
    this.userRules = rules
  }

  get permissionMode(): PermissionMode {
    return this.mode
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode
  }

  /** 当前生效的 always 规则,给 UI / 调试看。 */
  listApproved(): Ruleset {
    return [...this.approved]
  }

  /**
   * 把上次存下来的 always 装回来。**只接受 allow** —— 存档里不该有别的东西,
   * 有也当没有:一条从文件里读出来的 deny 会静默改变门卫的结论,而用户
   * 完全看不出是哪来的。
   */
  restoreApproved(rules: Ruleset): void {
    this.approved = rules.filter((rule) => rule.action === "allow")
  }

  /** 用户说不要记了。落盘那一份由调用方清 —— 门卫不认识文件。 */
  forgetApproved(): number {
    const count = this.approved.length
    this.approved = []
    return count
  }

  async ask(input: AskInput): Promise<void> {
    // ── 1. 硬名单前置 ──
    const hit = matchesHardDeny(input.permission, input.patterns)
    if (hit) throw new HardDenyError(hit.rule.id, hit.rule.reason, hit.pattern)

    // ── 2. 逐 pattern 求值 ──
    const decisions = input.patterns.map((pattern) => ({
      pattern,
      action: evaluate(input.permission, pattern, DEFAULTS, this.userRules, this.approved),
    }))

    const denied = decisions.find((d) => d.action === "deny")
    if (denied) {
      throw new PermissionDeniedError(
        input.permission,
        denied.pattern,
        `Permission denied by rule: ${input.permission} on "${denied.pattern}" is set to deny. ` +
          `Do not retry; tell the user what you wanted to do and why.`,
      )
    }

    // force:规则说 allow 也要问。危险不在命令名里,在它周围的结构里
    // (管道 / 子 shell / 提权)。注意 force 只影响 allow→ask,deny 上面已经短路了。
    // confirm 模式同理 —— 它把所有还活着的 decision 都拉回来问一遍。
    const askAll = input.force === true || this.mode === "confirm"
    const needsAsk = askAll ? decisions : decisions.filter((d) => d.action === "ask")
    if (needsAsk.length === 0) return

    // ── 2b. 确定性的一档:在项目里跑项目自己的脚本 ──
    //
    // 放在判官之前,而且是**查文件系统**不是问模型。见 routine.ts:
    // 「这条命令跑的文件在不在项目里」是个查一次 statSync 就能回答的题,
    // 而「读一段脚本预测它危不危险」不是。判官留给真说不清的。
    //
    // 注意它在 askAll 之后:force(子 shell / 重定向 / 提权 / 出网)和 confirm
    // 模式都压得过它 —— 危险不在命令名里,在它周围的结构里。
    if (!askAll && input.permission === "bash" && this.routine(input, needsAsk)) return

    // ── 3. 组装问题 ──
    const alwaysPatterns = input.patterns.map((p) => narrowAlways(input.permission, p))
    const request: PromptRequest = {
      permission: input.permission,
      patterns: input.patterns,
      alwaysPatterns,
      forbidAlways: input.forbidAlways ?? false,
      metadata: input.metadata,
      reasons: (input.metadata?.["reasons"] as string[] | undefined) ?? undefined,
      ...(input.callID ? { callID: input.callID } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    }

    // ── 5a. trust:放行 ──
    //
    // 到这里说明:硬名单没拦、规则表没说 deny、也不是「跑项目自己的脚本」那一档。
    // trust 的含义就是**这一档也放行**,不再问用户,也不再问任何模型。
    // 留痕是强制的 —— 它是唯一一处「本来要问你、但没问」的地方。
    if (this.mode === "trust") {
      this.options.onTrusted?.(request)
      return
    }

    // ── 5b. 问 ──
    const decision = await this.prompt(request)

    if (decision === "reject") {
      throw new PermissionDeniedError(input.permission, needsAsk[0]!.pattern)
    }
    if (decision === "always" && !input.forbidAlways) {
      const added: Ruleset = alwaysPatterns.map((pattern) => ({
        permission: input.permission,
        pattern,
        action: "allow" as Action,
      }))
      this.approved.push(...added)
      // 落盘放在**加进内存之后**:存不下去(只读的数据目录)时这一次照样放行,
      // 只是下次还会问 —— 而不是因为写不了文件就把用户刚做的决定丢掉
      this.options.remember?.(added)
    }
  }

  /** 这一批要问的子命令,是不是全都只是「跑项目自己的脚本」。 */
  private routine(input: AskInput, needsAsk: Array<{ pattern: string }>): boolean {
    const root = this.options.root
    if (!root) return false
    const workdir = input.metadata?.["workdir"]
    if (typeof workdir !== "string" || workdir.length === 0) return false
    // 有一段不是就整条不放 —— 一条命令里混着别的东西时,放行的是整条
    return needsAsk.every((d) => runsProjectScript({ command: d.pattern, workdir, root }))
  }

  /**
   * 工具可见性剪枝:某个工具如果被整体 deny,就别发给模型 —— 省掉模型
   * 「调用 → 被拒 → 换个说法再调」的无效轮次。
   */
  disabled(toolID: string): boolean {
    return evaluate(toolID, "*", DEFAULTS, this.userRules, this.approved) === "deny"
  }
}

/**
 * 收窄 always 的作用域。
 *
 * opencode 的 always 一律是 `*` —— 点一次等于该权限本进程全放开。对 read
 * 还能接受,对 edit 很危险(配合 webfetch 就是完整的数据外泄通道)。
 *
 * ⚠ 注意通配语义:这套实现里 `*` 就是 `.*`,**会跨 `/`**。所以 `src/foo/*`
 *   实际上也匹配 `src/foo/a/b/c.ts`。这比字面直觉宽,但仍远比 `*` 窄。
 */
export function narrowAlways(permission: string, pattern: string): string {
  switch (permission) {
    case "edit":
    case "write":
      // 收窄到该文件所在目录
      return dirname(pattern) + "/*"
    case "bash":
      // 用 arity 字典归约成命令前缀:git commit -m "..." → git commit *
      return alwaysPattern(pattern.trim().split(/\s+/))
    case "webfetch":
      // 收窄到一个来源。整条 URL 存下来等于没存(下一页又要问),而 `*` 是
      // 「以后随便去哪儿」—— 用户点头的是「这个站可以看」,不是「网随便上」
      return webOrigin(pattern)
    default:
      return "*"
  }
}

/** `https://docs.example.com/a/b?x=1` → `https://docs.example.com/*`。解析不了就退回原文。 */
function webOrigin(pattern: string): string {
  try {
    const url = new URL(pattern)
    return `${url.protocol}//${url.host}/*`
  } catch {
    return pattern
  }
}
