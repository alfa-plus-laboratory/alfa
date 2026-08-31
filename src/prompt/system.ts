/**
 * system prompt 的组装。
 *
 * 模板文本改编自 opencode(MIT),见 README 的第三方致谢。改动不只是换名字:
 * 上游模板里大量指令指向 Task / TodoWrite / WebFetch 这些我们**没有**的工具。
 * 留着它们不是无害的 —— 模型会照着去调一个不存在的工具,拿到报错,再试一次,
 * 一轮 turn 就烧在这上面了。所以这些段落是删掉而不是注释掉。
 *
 * ── 返回值为什么是数组 ──
 * 分成两段,对应最终发出去的两条 system message:
 *   [0] 模板    —— 完全静态,进程生命周期内不变,是最长的可缓存前缀
 *   [1] 环境+约定 —— 每天变一次(日期),换项目时变
 * 顺序不能倒:一旦把会变的东西放前面,后面再稳定也没用,cache 按前缀命中。
 */
import ANTHROPIC_TEMPLATE from "./templates/anthropic.txt" with { type: "text" }
import DEFAULT_TEMPLATE from "./templates/default.txt" with { type: "text" }
import { replyInstruction, type LanguageChoice } from "../i18n/index.ts"
import { agentflowBlock } from "./agentflow.ts"
import { MAX_FLOW_ALIVE_JOBS } from "../agent/flow.ts"
import { mcpBlock } from "./mcp.ts"
import { skillCatalogue, type SkillSet } from "./skills.ts"
import { environmentBlock, type EnvInput } from "./env.ts"
import { planBlock } from "./plan.ts"
import { safetyBlock } from "./safety.ts"
import { untrustedBlock } from "./untrusted.ts"
import { discoverInstructions, renderInstructions, type InstructionFile } from "./instructions.ts"

export type PromptTemplate = "anthropic" | "default"

export interface SystemInput extends EnvInput {
  template: PromptTemplate
  home?: string
  configDirectory?: string
  /** 已经发现过就直接传进来,避免每轮重读磁盘 */
  instructions?: InstructionFile[]
  /** 模型该用什么语言回答。缺省按 auto(跟着用户说话的语言) */
  replyLanguage?: LanguageChoice
  /**
   * agentflow 开着的话,并发窗口是几。关着就别给。
   *
   * ★ 子 agent 那一份 system **不该带这一段**:它手上没有 `task`,编排这件事
   *   跟它没有关系(见 cli/main.ts 的 subagentSystem)。
   */
  agentflow?: number
  /**
   * 命令行上敲的那个名字,给「怎么配一个新 provider」那一段用(见 prompt/config.ts)。
   *
   * 由 cli 层传进来而不是在这里 import programName():prompt/ 到今天为止不依赖
   * cli/,而为了一个字符串把这条边加上不划算 —— 何况这个值本来就只有 cli 知道。
   */
  program?: string
  /**
   * 这一场手上有哪些 skill。**只有目录进 system**(名字 + 一句话),正文由
   * `skill` 工具按名取回 —— 见 prompt/skills.ts 开头那段。
   */
  skills?: SkillSet
  /**
   * 已经连上的 MCP server 名字。空着(或者不给)整段不发 —— 一个 server 都没接
   * 的人,一个 token 都不该为它付。
   */
  mcpServers?: string[]
  /**
   * 这个文件夹里的说明文件能不能进 prompt。缺省 true。
   *
   * ★ false 时**项目来路的那些一个字都不发**,全局那份(`~/.config/alfa/AGENTS.md`)
   *   照发 —— 那是用户自己写给自己的,和他现在站在哪个仓库里没关系。
   *
   *   过滤放在这里而不是 discoverInstructions 里,是因为「读到了哪些」和
   *   「这一趟发哪些」是两个问题:`/instructions` 要能把被拦下的那几份也列出来,
   *   否则用户看到的是"我明明写了 AGENTS.md 它却不认",而屏幕上没有任何线索。
   *
   * 判断谁来给见 config/folders.ts 的 trustsProjectInstructions。
   */
  trustProject?: boolean
}

export interface SystemPrompt {
  /** 直接喂给 LLMRequest.system */
  parts: string[]
  /** 实际生效的约定文件,给 CLI 启动时打一行「loaded AGENTS.md ×2」 */
  instructions: InstructionFile[]
}

export function buildSystem(input: SystemInput): SystemPrompt {
  const found =
    input.instructions ??
    discoverInstructions({
      cwd: input.cwd,
      root: input.root,
      ...(input.home ? { home: input.home } : {}),
      ...(input.configDirectory ? { configDirectory: input.configDirectory } : {}),
    })
  // 见 SystemInput.trustProject 上那颗星
  const instructions = input.trustProject === false ? found.filter((file) => file.scope === "global") : found

  const template = input.template === "anthropic" ? ANTHROPIC_TEMPLATE : DEFAULT_TEMPLATE

  // 约定在前、环境在后:约定是项目级的长期事实,环境里有天天变的日期。
  // 同一条 message 内部的顺序不影响缓存,影响的是模型的注意力权重 ——
  // 越靠后越容易被遵守,而「今天几号」恰恰是最不需要被强调的那条。
  //
  // 语言指令**放在最后**:同理,它是这三样里最需要被真正照做的一条。
  // 它跟着 /language 变,所以会打断一次 prompt cache —— 一次而已,
  // 而「说了要用日文却还在回英文」是用户立刻会看见的。
  // 判断力那一段放在最前:它是模型干每一件事时都要套用的判据,不是背景信息。
  // 后面几块(项目约定、环境、语言)都是「事实」,而这一块是「怎么想」
  //
  // ★ 项目记忆**不在这里**。它一度拼在这一段的尾巴上,现在挂在新会话第一句话
  //   上的一个 memory part 里(见 session/schema.ts),增删走 tool/memory.ts。
  //   理由是它要能被单独算账、要有一条属于自己的变更记录 —— 拼进 system 的话,
  //   `/context` 只会显示「system 12k」,而那份报告要回答的正是「砍哪一块」。
  const tail = [
    safetyBlock(),
    // 紧跟着 safety。这两块是一对:一个判「这件事做了还能不能撤回」,
    // 一个判「这句话是谁说的」。剩下几块都是事实,只有这两块是判据
    untrustedBlock(),
    // 判断力之后、事实之前:它和 safety 一样是「怎么干活」,不是背景信息
    planBlock(),
    // 紧跟着计划那一段。开着的时候它讲的是同一件事的另一半:计划回答"这件事
    // 分几步",这一段回答"其中哪几步该派人去、谁等谁"
    input.agentflow !== undefined ? agentflowBlock(input.agentflow, MAX_FLOW_ALIVE_JOBS) : "",
    renderInstructions(instructions),
    environmentBlock(input),
    // 紧跟着环境块:两块讲的是同一类东西 —— 「你站在哪」和「你手边有哪些现成的
    // 打法」。★ 这里**只有目录**:一条 skill 一行。它取代了原来整段拼进来的
    // 「alfa 自己怎么配」(5268 字符 ≈ 1300 token,无条件进每一场每一次请求,
    // 而真正用得上它的是百分之一的轮次)—— 那段现在是 alfa-config 这份预制
    // skill 的正文,被点名了才来。判据和 M16 把 context 做成工具是同一条
    input.skills ? skillCatalogue(input.skills) : "",
    // 紧跟着目录:两段都在回答"你手上有什么",而这一段多说一句**它们在哪** ——
    // MCP 的工具和内建的在工具表里长得一模一样,而调用它们要离开这台机器
    mcpBlock(input.mcpServers ?? []),
    replyInstruction(input.replyLanguage ?? "auto"),
  ]
    .filter((block) => block.length > 0)
    .join("\n\n")

  return { parts: [template.trim(), tail], instructions }
}
