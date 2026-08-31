/**
 * ★ 工具注册边界。
 *
 * 这个文件是一条硬约束线:src/tool/** 下的任何文件都**不许** import "ai" 或
 * "@ai-sdk/*"。工具只认这里的 ToolDef / ToolContext,由 registry 负责翻译成
 * 具体 SDK 的形状。
 *
 * 为什么第一天就要立:后期要往里加自有能力(记忆层、远端主机纳管、自有工具
 * 生态),那些工具的执行环境跟本地工具完全不同。如果工具直接长在 SDK 的
 * tool() 上,加一类工具就要动循环。
 */
import type { ZodType } from "zod"
import type { SkillSet } from "../prompt/skills.ts"
import type { AgentJobs } from "./background.ts"

/** 权限询问的结果。 */
export type AskDecision = "once" | "always" | "reject"

export interface AskInput {
  /** 权限键,通常等于工具名(edit/write 共用 "edit")。 */
  permission: string
  /** 具体目标:路径、命令、URL。一次可以问多个(bash 拆句后每条一个)。 */
  patterns: string[]
  /** 给 UI 渲染用的附加信息,比如 edit 的 diff。 */
  metadata?: Record<string, unknown>
  /** 为 true 时禁止用户选 "always"(比如命令里有子 shell,归约不可信)。 */
  forbidAlways?: boolean
  /**
   * 压过 allow 规则,强制询问。
   *
   * 给「规则看起来允许,但这次调用本身有风险」的场景用:bash 拆句器发现
   * 子 shell / 重定向 / 提权 / 出网时,即使 `git *` 被配成 allow 也必须问 ——
   * 因为危险不在命令名里,在它周围的结构里。
   * (管道**不在**此列:每一段各自过规则表,见 bash/scan.ts 里那段说明。)
   * 注意:force **不能**把 deny 变成 ask,deny 永远短路。
   */
  force?: boolean
  /**
   * 这次询问属于哪一次工具调用。
   *
   * ★ **由 ToolContext 填,工具自己不要传**(见 tool/context.ts)。造 context
   *   的那一刻就知道 callID,而工具不该关心界面怎么把"问了什么"和"哪张卡片"
   *   对上 —— 那是渲染的事。
   *
   * 界面拿它把授权的结论**画回那次调用本身**,而不是在下面再起一行。多条工具
   * 可能同时在跑(SDK 会并发执行同一步里的多个调用),所以这里不能靠"最后一条
   * 正在跑的"去猜。
   */
  callID?: string
  /**
   * 这次询问跟着谁死。
   *
   * ★ 不给的话,界面会把它挂在**当前这一轮**上 —— 对主 agent 是对的,对子 agent
   *   是错的:它跑在后台,它的死活和用户手上这一轮毫无关系。不接这条的后果很具体 ——
   *   子 agent 被 `/clear` 停掉之后,它那个框还排在队里;用户过一会儿按了"允许",
   *   一个**已经死了的** agent 的 edit / 命令照样会落地。
   */
  signal?: AbortSignal
}

/**
 * 向用户提的一个问题。见 tool/ask.ts。
 *
 * ★ 它和 AskInput **不是**一回事,别放在一起想:AskInput 是「我要动这个东西,
 *   准不准」,答案只有三种、由门卫定义;这里是「这件事你想怎么办」,选项是
 *   模型自己列的。前者是安全边界,后者是对话的一部分 —— 唯一的共同点是
 *   都要停下来等人,所以两者在界面上共用同一个模态队列(见 tui/app.ts)。
 */
export interface Question {
  /** 问题本身。一句话,别写成一段。 */
  question: string
  options: QuestionOption[]
  /** 复选:用户可以勾好几个。 */
  multiple: boolean
  /**
   * 这次提问属于哪次工具调用。
   *
   * ★ 和 AskInput.callID 同一条规矩:**由 ToolContext 填,工具自己不要传**。
   */
  callID?: string
  /**
   * 一次问好几个时,这是第几个。
   *
   * 界面上必须写出来:一个人答完一题,屏幕上又冒出一个框 —— 不写「2/3」的话,
   * 他不知道这是"还有两个"还是"它又想起来一个"。总共只有一个时不给。
   */
  position?: { index: number; total: number }
  /**
   * 上一次这道题答的是什么(只有**回头改**的时候有)。
   *
   * 界面拿它把状态摆回去:勾过的还勾着,打过的字还在。不摆回去的话,"回上一题
   * 看看我刚才选了什么"这件事根本做不到 —— 回去看到的是一张空白的题,而用户
   * 想确认的正是自己当时选了哪个。
   */
  previous?: Answer
}

export interface QuestionOption {
  /** 选项本身。答案原样回给模型,所以它得能独立成话 */
  label: string
  /** 一行补充:为什么选它、代价是什么。没有就别编 */
  description?: string
}

/**
 * 用户的回答。
 *
 * ★ 四种**必须**分开,合并任何两种都会让模型做错事:
 *   picked      挑了给定选项 —— 照着做
 *   typed       都不对,自己打了一段 —— 那是新指令,比问题本身优先
 *   cancelled   看见了但不想答 —— 别再问同一遍,换个方式往下走
 *   unavailable 这条路上根本没有人(-p / 管道 / CI)—— 自己拿主意,并说清假设了什么
 */
export type Answer =
  | { kind: "picked"; choices: string[] }
  | { kind: "typed"; text: string }
  | { kind: "cancelled" }
  | { kind: "unavailable" }
  /**
   * 「我要回上一题」。**不是一个答案**,是一次导航 —— 它只在一次问好几个的
   * 时候出得来,而且永远由 ask 工具自己消化掉,不会回到模型那里(见 tool/ask.ts)。
   *
   * 放在 Answer 里而不是另开一条返回通道:提问这条路上下四层(工具 → 宿主 →
   * 模态队列 → 状态机)传的都是它,多一条通道就是四层各加一个分支。
   */
  | { kind: "back" }

export interface ToolContext {
  /** 当前工作目录。工具解析相对路径的基准。 */
  cwd: string
  /** 工作区根(git worktree 根,推导失败时退化成 cwd)。越界守卫的边界。 */
  root: string
  sessionID: string
  messageID: string
  /** provider 给的 toolCallId。 */
  callID: string
  /** 中断信号。长时间操作必须自己检查或转发给子进程。 */
  abortSignal: AbortSignal
  /**
   * 向用户请求授权。被拒绝时 throw,工具不用自己处理拒绝分支 ——
   * 抛出的错误会作为 tool result 回给模型,让它换个做法。
   */
  ask(input: AskInput): Promise<void>
  /**
   * 停下来问用户一句(见 tool/ask.ts)。
   *
   * 没接就是**这条路上没有界面**(测试夹具、将来的非交互宿主),工具那边要
   * 当 unavailable 处理 —— 而不是当成"用户不理我"挂在那儿等。真正的
   * 「没人可问」由实现自己回 unavailable:-p 和管道模式下键盘是不可用的,
   * 但那时函数照旧接得上,只是立刻回一句"这里没人"。
   */
  inquire?(question: Question): Promise<Answer>
  /**
   * 这次调用发生在**哪个子 agent 里**(它的名字)。主 agent 自己跑的时候没有。
   *
   * 用处只有一个:它起的后台进程要记在它头上(见 tool/background.ts 的
   * JobSnapshot.owner)—— 一个子 agent 顺手起的 dev server,起落报进用户正在读的
   * 那段对话里是串味,用户没让谁起它。
   */
  owner?: string
  /**
   * 后台跑着的子 agent(见 agent/subagent.ts)。
   *
   * ★ 它是**注入**进来的,不是 import 进来的 —— 子 agent 要起一整个 Loop,
   *   而 src/tool 不认识循环(见 DESIGN.md 的架构边界)。这里只认接口。
   *   没接 = 这个宿主起不了子 agent,`task` 工具会照实说。
   */
  agents?: AgentJobs
  /** 推送中间进度给 UI(不进模型上下文)。 */
  onProgress(text: string): void
  /** 累积写入本次调用的 metadata,UI 和存储都能看到。 */
  metadata(patch: Record<string, unknown>): void
  /**
   * 这一场手上有哪些 skill(见 prompt/skills.ts)。
   *
   * ★ **注入**而不是让工具自己去扫盘:目录是 system prompt 里那一段,正文由这个
   *   工具取 —— 两边各扫一遍的话,迟早出现"目录里列着、点开说没有"。同一份东西
   *   只该被找出来一次。
   *
   * 没接 = 这条路上没有 skills(测试夹具),工具那边照实说。
   */
  skills?(): SkillSet | undefined
  /**
   * 现在上下文窗口里装着什么。见 tool/context-window.ts。
   *
   * 没接就是 undefined —— 那是「这里没有这个能力」(一次性模式、测试夹具),
   * 不是「窗口是空的」,工具那边要分开说。
   */
  context?(): ContextView | undefined
}

/**
 * 上下文占用的**形状**。
 *
 * 只声明形状、不 import `src/agent/context.ts` 的 ContextReport:`src/tool`
 * 不认识循环(见 DESIGN.md 的架构边界)。值由 CLI 层在造 ToolContext 时注入。
 */
export interface ContextView {
  /** 现在占了多少 token */
  used: number
  /** 算作 100% 的那条线。比 limit 小 —— 回答和压缩本身要留地方 */
  budget: number
  /** 模型的上下文窗口 */
  limit: number
  /** 这个数是本地估的(provider 还没报过) */
  estimated: boolean
  /** 会发给模型的消息条数 */
  messages: number
  /** 被压缩折叠掉、不再发出去的条数 */
  folded: number
  slices: Array<{ key: string; tokens: number }>
}

export interface ToolResult {
  /** 回给模型的文本。 */
  output: string
  /** 给 UI / 存储的结构化附加信息。truncated 是约定字段,必填。 */
  metadata: Record<string, unknown> & { truncated: boolean }
  /** 一行摘要,终端渲染工具卡片标题用。 */
  title?: string
}

export interface ToolDef<Args = unknown> {
  id: string
  /**
   * 给模型看的工具说明。可以是惰性函数 —— bash 要按当前 shell 与上限常量
   * 动态渲染。刻意不给它 ToolContext:描述是**每轮请求一份**的,而 context
   * 是**每次调用一份**的,把两者绑在一起会让描述随调用变化,直接毁掉
   * prompt cache。
   */
  description: string | (() => string)
  parameters: ZodType<Args>
  /**
   * 直接交给 provider 的 JSON Schema。给**参数形状不是我们定的**那些工具用
   * (今天只有 MCP:server 报什么形状就是什么形状)。
   *
   * ── 为什么不把它转成 zod ──
   * JSON Schema → zod → 再转回 JSON Schema 是一趟有损的往返:anyOf、$ref、
   * 自定义 format、嵌套的 oneOf,每一样都得有对应的 zod 写法,没有的就只能丢。
   * 而丢掉的那部分不会报错 —— 它表现为模型收到一份比 server 实际要求更宽松的
   * 形状,然后在调用时被 server 拒掉,报错还指向参数本身。原样透传是唯一不会
   * 悄悄改变契约的做法。
   *
   * 给了它,`parameters` 就只用于本地那道校验(见 llm/adapt-tools.ts),
   * 对这类工具是一道宽松的兜底 —— 真正的校验在 server 那边,它本来就得做。
   */
  rawSchema?: unknown
  execute(args: Args, ctx: ToolContext): Promise<ToolResult>
}

/**
 * 权限被拒时抛这个,便于上层区分「用户拒绝」和「工具本身失败」。
 *
 * ★ 末尾那句指路是**故意**的:这一刻正是模型最需要 alfa-permissions 的时候
 *   —— 它撞了墙,而用户接下来多半要问"为什么会问我"或者"怎么让它别再问"。
 *   而它偏偏最不会去开那份 skill:它刚拿到一个看起来很完整的解释。
 *   一句"你以为你知道的那部分在别处"值这十几个 token,而且它只在被拒时才出现。
 */
export class PermissionDeniedError extends Error {
  readonly permission: string
  readonly pattern: string
  constructor(permission: string, pattern: string, reason?: string) {
    super(
      reason ??
        `Permission denied: ${permission} on "${pattern}". The user rejected this action. Do not retry the same action; ask the user what to do instead. If they want to change what gets asked, open the \`alfa-permissions\` skill rather than guessing at the settings.`,
    )
    this.name = "PermissionDeniedError"
    this.permission = permission
    this.pattern = pattern
  }
}

/** 工具参数校验失败时抛这个,消息会原样回给模型让它自纠。 */
export class InvalidArgumentsError extends Error {
  constructor(toolID: string, detail: string) {
    super(`Invalid arguments for tool "${toolID}": ${detail}`)
    this.name = "InvalidArgumentsError"
  }
}
