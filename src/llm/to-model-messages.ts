/**
 * LLMMessage → AI SDK ModelMessage。
 *
 * ⚠ 一条硬约束:**每个 tool-call 必须有配对的 tool result**。
 * 少一个,Anthropic 直接 400,而且错误信息完全看不出是哪一条。中断发生在
 * 工具执行中途时最容易触发 —— 所以未完成的工具调用在回灌时必须补一条
 * 错误结果,而不是原样丢弃。这条由 agent 层保证,这里只做形状转换。
 */
import type { ModelMessage } from "ai"
import type { ReasoningReplay } from "./registry.ts"
import type { LLMContent, LLMMessage } from "./types.ts"

type SystemMessage = Extract<ModelMessage, { role: "system" }>

/**
 * system 段压成**恰好两条** —— 第一条是稳定的模板头,其余合并成第二条。
 *
 * 这不是洁癖:prompt cache 按前缀命中,system 分成 N 条且条数会变的话,
 * 缓存边界跟着变,命中率直接归零。
 *
 * ⚠ AI SDK v7 起,system 消息**不能**放进 messages(会抛 InvalidPromptError),
 *   必须走 streamText 的 instructions 选项。v6 不是这样 —— 照着 v6 的代码
 *   移植会在第一次真实请求时炸,而 typecheck 完全看不出来。
 *
 * ── 两个缓存断点,不是一个 ──
 * Anthropic 的 cache 是**显式**的:不打 cache_control 就一次都不命中,每轮
 * 按全价重算 tools + system。请求里的前缀顺序是 tools → system → messages,
 * 所以断点打在 system 上,连带把工具定义一起缓住(工具定义几千 token,
 * 而且我们已经排过序保证稳定)。
 *
 * 打两个是分层:
 *   断点 1(模板)  —— 进程内永不变,日期翻篇也照样命中
 *   断点 2(环境+约定)—— 每天午夜失效一次,失效那次退回断点 1,不是全丢
 * 只打一个在末尾的话,每天第一轮对话会连模板一起重算。
 *
 * 对不认这个字段的 provider(OpenAI 兼容端点)是死数据,会被忽略,无副作用 ——
 * **但那条路上要连拆分一起撤掉**,理由见下面 single 那个参数。
 */
const CACHE_BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral" } } } as const

/**
 * @param single 只发一条(把两段并起来)。见 registry.ts 的 ResolvedModel.singleSystem。
 *
 *   拆两条唯一服务的是上面那两个断点,而断点在 OpenAI 兼容端点上是死数据 ——
 *   于是那条路上拆分收益为零,代价却是本地推理服务器直接 500:模型自己的
 *   Jinja chat template 绝大多数只允许一条 system,第二条一来就是
 *   `raise_exception('System message must be at the beginning.')`。
 *
 * ★ 并起来用的是和 parts.slice(1) 同一个 "\n\n",所以**内容一个字都不差**,
 *   变的只是它躺在一条还是两条 message 里。
 */
export function toInstructions(system: string[], single = false): SystemMessage[] {
  const parts = system.filter((s) => s.trim().length > 0)
  if (parts.length === 0) return []
  const head: SystemMessage = {
    role: "system",
    content: single ? parts.join("\n\n") : parts[0]!,
    providerOptions: CACHE_BREAKPOINT,
  }
  if (single || parts.length === 1) return [head]
  return [
    head,
    { role: "system", content: parts.slice(1).join("\n\n"), providerOptions: CACHE_BREAKPOINT },
  ]
}

/**
 * @param replay 思考块怎么回灌,由 provider 决定(见 registry.ts 的 ReasoningReplay)。
 *   缺省 "signed" —— 最保守的那一档,新接的 provider 忘了填也不会炸。
 */
/**
 * 断点向前**最多回溯 20 个 content block**去找上一次的缓存条目。超过就找不到,
 * 静默 miss —— 而 agent 循环里一轮轻松产生十几对 tool-call / tool-result。
 *
 * 取 18 留一点余量。两个断点串起来,能覆盖单轮新增约 36 个 block;再长就断链,
 * 那一轮退回从 system 断点重算。没有更好的办法 —— 一个请求总共只有 4 个断点,
 * system 占了 2 个。
 */
const LOOKBACK_BLOCKS = 18

/**
 * 消息历史上的两个断点:一个钉在末尾,一个往回 18 个 block。
 *
 * ── 为什么 system 上那两个不够 ──
 * Anthropic 只缓到断点为止。断点全在 system 上,就意味着 tools + system 缓住了,
 * 而**后面整段对话每轮按全价重算** —— 而那才是 agent 会话里真正大的那一块:
 * 跑上一阵之后历史十几万 token,system 才几千。
 *
 * ★ 对不认这个字段的 provider 是死数据(和 system 上那两个同理)。MiniMax 那种
 *   自动前缀缓存的端点根本不看它 —— 那边整条前缀本来就自动缓,这几个断点
 *   加不加都一样。这段是给**官方 Anthropic** 准备的。
 */
function markHistoryBreakpoints(out: ModelMessage[]): void {
  // 只有数组形态的 content 能挂 providerOptions,字符串形态挂不上
  const blocks: Array<Record<string, unknown>> = []
  for (const message of out) {
    if (Array.isArray(message.content)) blocks.push(...(message.content as Array<Record<string, unknown>>))
  }
  if (blocks.length === 0) return

  /**
   * 在 at 或它**再往前**第一个挂得住断点的 block 上打一个。
   *
   * ── ★ 为什么不能直接写 blocks[at] ──
   * 原来这里是一句 `block["providerOptions"] = CACHE_BREAKPOINT` —— 一次**覆盖**。
   * 而 thinking 块的 providerOptions 里装着它的**签名**(见 toAssistantContent),
   * 那是 Anthropic 收下这段思考的唯一凭据。覆盖掉之后是双输:
   *
   *   · 签名没了 → provider 认不出这是个思考块,整段丢掉,外加一条
   *     "unsupported reasoning metadata" 告警。历史里每有一段就每轮告警一次。
   *   · 断点也没了 → thinking 块本来就 `canCache: false`,provider 收到
   *     cache_control 只会写一句"忽略"。
   *
   * 也就是说旧写法既毁了思考,又没换来任何缓存。开着扩展思考的会话里,
   * 每个 assistant 消息都以 reasoning 开头,往回数第 18 个 block 落在它上面
   * 是常事。
   *
   * 所以:挂不住的往前跳过,挂得住的**合并**而不是覆盖。
   */
  const mark = (at: number): void => {
    for (let i = at; i >= 0; i--) {
      const block = blocks[i]
      // thinking / redacted_thinking 是 provider 明写着不可缓存的那一类
      if (!block || block["type"] === "reasoning") continue
      const existing = block["providerOptions"] as Record<string, Record<string, unknown>> | undefined
      block["providerOptions"] = existing
        ? { ...existing, anthropic: { ...existing["anthropic"], ...CACHE_BREAKPOINT.anthropic } }
        : CACHE_BREAKPOINT
      return
    }
  }
  mark(blocks.length - 1)
  // 短对话不用第二个:它会落在第一个上,白占一个额度
  if (blocks.length > LOOKBACK_BLOCKS) mark(blocks.length - 1 - LOOKBACK_BLOCKS)
}

export function toModelMessages(messages: LLMMessage[], replay: ReasoningReplay = "signed"): ModelMessage[] {
  const out: ModelMessage[] = []

  for (const message of messages) {
    switch (message.role) {
      case "system":
        // 历史里不该再有 system —— 真出现了就并进 instructions 会更对,
        // 但那要改调用方契约。这里退而求其次,转成 user 保证不炸。
        out.push({ role: "user", content: [{ type: "text", text: message.content }] })
        break
      case "user":
        out.push({ role: "user", content: toUserContent(message.content) })
        break
      case "assistant":
        out.push({ role: "assistant", content: toAssistantContent(message.content, replay) })
        break
      case "tool":
        out.push({
          role: "tool",
          content: message.content.map((result) => ({
            type: "tool-result" as const,
            toolCallId: result.callID,
            toolName: result.tool,
            output: result.isError
              ? ({ type: "error-text" as const, value: result.output })
              : ({ type: "text" as const, value: result.output }),
          })),
        })
        break
    }
  }

  markHistoryBreakpoints(out)
  return out
}

type UserContent = Extract<ModelMessage, { role: "user" }>["content"]
type AssistantContent = Extract<ModelMessage, { role: "assistant" }>["content"]

function toUserContent(content: LLMContent[]): UserContent {
  const parts: Exclude<UserContent, string> = []
  for (const item of content) {
    if (item.type === "text") parts.push({ type: "text", text: item.text })
    else if (item.type === "file") parts.push({ type: "file", mediaType: item.mediaType, data: item.data })
  }
  return parts.length > 0 ? parts : [{ type: "text", text: "" }]
}

function toAssistantContent(content: LLMContent[], replay: ReasoningReplay): AssistantContent {
  const parts: Exclude<AssistantContent, string> = []
  for (const item of content) {
    switch (item.type) {
      case "text":
        // 空 text part 会让某些 provider 报错,直接丢
        if (item.text.length > 0) parts.push({ type: "text", text: item.text })
        break
      case "reasoning":
        // 走到这里的只剩当前这趟工具循环里的思考(更早的在 agent 层就切了),
        // 而它在循环里是**必须**带回的:模型每做一个工具决策之前都先想一段,
        // 少了那段,它下一步只能从"我调过什么工具"倒推当时的判断。
        if (replay === "none") break
        if (item.text.length === 0) break
        if (replay === "text") {
          // 兼容端点:纯文本发回去,SDK 序列化成 `reasoning_content`。
          // 没有签名这一说 —— 这条路上的思考本来就是从 content 里抠出来的
          parts.push({ type: "reasoning", text: item.text })
          break
        }
        // ★ "signed":没有签名的**不回灌**。Anthropic 那边一个没签名的 thinking 块
        //   本来就收不了:SDK 会把它整块丢掉,再吐一条 "unsupported reasoning
        //   metadata" 告警 —— 历史里有几段思考就吐几条,而告警默认是打到 stderr 的,
        //   全屏界面正画在那儿。丢在这里结果一样,少一条每轮重复的噪音。
        //   签名是怎么拿到的见 stream.ts 里 pendingSignature 那段。
        if (item.signature) {
          parts.push({
            type: "reasoning",
            text: item.text,
            // 签名必须原样回传,否则 Anthropic 拒收带 thinking 的历史
            providerOptions: { anthropic: { signature: item.signature } },
          })
        }
        break
      case "tool-call":
        parts.push({
          type: "tool-call",
          toolCallId: item.callID,
          toolName: item.tool,
          input: item.input,
        })
        break
      default:
        break
    }
  }
  return parts.length > 0 ? parts : [{ type: "text", text: "" }]
}
