/**
 * 把存下来的会话画回屏幕上。
 *
 * ── 为什么是造事件而不是自己排版 ──
 * 渲染的规矩全在 Renderer 里:markdown 的流式定稿、`◆ agent` 署名、工具卡片的
 * `●` / `↳`、并行调用时结果行怎么挂。这里再写一遍排版,就等于承认「同一段话
 * 在恢复之后长得不一样」——而那正好是最容易被当成"恢复错了"的东西。
 * 所以这里只做一件事:把落库的 part 翻回**当初那串事件**,交给同一个渲染器。
 *
 * ── 哪些不重放 ──
 * 思考过程(reasoning):它是草稿,当时都只在活动区闪一下,没进过滚动记录。
 * step-finish 的用量统计:那是"刚才这一步花了多少",隔一天再看没有意义,
 * 而且它会把重放出来的历史撑得到处都是数字。
 * 半截没跑完的工具(pending / running):进程都换了,它们不可能再有结果 ——
 * 画一个永远转着的圈比不画更糟。
 */
import type { UIEvent } from "../agent/events.ts"
import type { TurnDigest } from "../agent/summarize.ts"
import { t } from "../i18n/index.ts"
import type { MessageWithParts, ToolPart } from "../session/schema.ts"
import { outcomeLine, summarize as toolTarget, userLines } from "./render.ts"
import { theme } from "./theme.ts"

export interface ReplaySink {
  /** 往滚动记录里写一行(用户说的话)。 */
  line(text: string): void
  /** 模型那一侧的事件,交给渲染器。 */
  handle(event: UIEvent): void
}

/**
 * 重放整段历史。返回画了几条消息 —— 调用方要拿它写那句「恢复了 N 条」。
 */
export function replay(history: MessageWithParts[], sink: ReplaySink): number {
  let count = 0
  for (const message of history) {
    if (message.info.role === "user") {
      // 压缩点。**必须画出来** —— 它上面那一大段模型已经看不见了,而用户看着
      // 一份完整的记录会以为它还记得。摘要本身不铺开:它是给模型的交接,
      // 想读全文有 `/context`
      const folded = message.parts.find((part) => part.type === "compact")
      if (folded?.type === "compact") {
        sink.line("")
        sink.line(theme.dim(`  ⌦ ${t.compactedMarker(folded.folded)}`))
        continue
      }
      const text = textOf(message)
      if (text.length === 0) continue
      for (const line of userLines(text)) sink.line(line)
      count += 1
      continue
    }

    // assistant:先报到(署名靠它),再按落库顺序把 part 交出去
    sink.handle({ type: "message.start", message: message.info })
    let spoke = false
    for (const part of message.parts) {
      if (part.type === "text") {
        if (part.text.length === 0) continue
        // 一次性给完整段。Renderer 的 markdown 是流式的,但"一次一大块"
        // 也是合法的流 —— 它按行定稿,不按 chunk
        sink.handle({ type: "part.delta", part, delta: part.text })
        sink.handle({ type: "part.end", part })
        spoke = true
      } else if (part.type === "tool" && isFinished(part)) {
        sink.handle({ type: "tool.state", part })
        spoke = true
      }
    }
    sink.handle({ type: "message.end", message: message.info })
    if (spoke) count += 1
  }
  return count
}

/** 跑完了的才重放。pending / running 在新进程里永远不会有下文。 */
function isFinished(part: ToolPart): boolean {
  return part.state.status === "completed" || part.state.status === "error"
}

/** session 视图那三段的接收端。写成结构类型,免得这里去 import 一个界面类。 */
export interface TurnSink {
  beginTurn(prompt: string): void
  handle(event: UIEvent): void
}

/**
 * 把**最后一轮**装回 session 视图。
 *
 * 光重放进滚动记录是不够的:默认视图是三段式(摘要 / 你说的话 / 现在),
 * 而滚动记录只在 `/view stream` 下看得见。只填瀑布流的话,接回来之后默认
 * 屏幕上一个字都没变 —— 用户看到的就是"它说恢复了,但什么都没恢复"。
 *
 * 走的是**和当初一模一样的那串事件**:提问进 beginTurn,正文和工具行由
 * ChatModel 自己按事件消化。这样接回来的那一轮和刚跑完的那一轮长得一样。
 */
export function restoreLastTurn(history: MessageWithParts[], sink: TurnSink): boolean {
  // 往回找**真的说过话**的那一条:压缩点也是 user 消息,但它没有正文 ——
  // 撞上它就 return false 的话,压缩过的会话接回来会是一片空白
  const at = history.findLastIndex((message) => message.info.role === "user" && textOf(message).length > 0)
  if (at === -1) return false
  const prompt = textOf(history[at]!)
  sink.beginTurn(prompt)

  for (const message of history.slice(at + 1)) {
    // ★ 用户消息不算边界,跳过就是了。at 已经是**最后一条有正文的** user 消息,
    //   所以后面出现的只可能是合成注入(自动检查那段提醒)或者压缩点 —— 它们
    //   都属于同一轮。撞上就停的话,接回来看到的是验证之前那句"改好了",
    //   而它后面明明还有一句"这回真好了"
    if (message.info.role !== "assistant") continue
    for (const part of message.parts) {
      // 正文只补**最后一段**,和活动区的规矩一致 —— part.start 会把上一段丢掉
      if (part.type === "text" && part.text.length > 0) {
        sink.handle({ type: "part.start", part })
        sink.handle({ type: "part.delta", part, delta: part.text })
        sink.handle({ type: "part.end", part })
      } else if (part.type === "tool" && isFinished(part)) {
        sink.handle({ type: "tool.state", part })
      }
    }
  }
  return true
}

/**
 * 整段历史 → 一轮一条的浓缩,喂给补摘要的那个 agent。
 *
 * 用的是**界面攒浓缩时用的同两个函数**(工具目标、结果一行)。摘要 agent 一直
 * 在读那种格式的材料,补出来的摘要才和它自己滚出来的是同一种东西。
 */
export function digests(history: MessageWithParts[], root: string): TurnDigest[] {
  const turns: TurnDigest[] = []
  for (const message of history) {
    if (message.info.role === "user") {
      const prompt = textOf(message)
      if (prompt.length > 0) turns.push({ prompt, reply: "", tools: [] })
      continue
    }
    const turn = turns[turns.length - 1]
    if (!turn) continue // 没有提问的 assistant(理论上不该有),跳过
    const reply = textOf(message)
    if (reply.length > 0) turn.reply = turn.reply.length > 0 ? `${turn.reply}\n${reply}` : reply
    for (const part of message.parts) {
      if (part.type !== "tool" || !isFinished(part)) continue
      turn.tools.push({
        tool: part.tool,
        target: toolTarget(part, root),
        outcome: outcomeLine(part, root),
        ...(part.state.status === "error" ? { failed: true } : {}),
      })
    }
    if (message.info.finish === "error") turn.error = message.info.error?.message ?? "error"
    if (message.info.finish === "interrupted") turn.interrupted = true
  }
  return turns
}

/**
 * 一条消息里**人写的 / 模型说的**那部分文字。
 *
 * ★ 合成注入的文本(自动检查塞回去的那段提醒、环境块)一律不算。这个函数是
 *   三件事的共同判据:重放画不画、接会话时哪一句算"你说的话"、摘要 agent
 *   把哪一句当成一轮的开头。漏掉 synthetic 的话,三处会同时把一段
 *   `<system-reminder>` 当成用户的原话 —— 而用户从来没说过那句。
 */
function textOf(message: MessageWithParts): string {
  return message.parts
    .filter((part) => part.type === "text" && !part.synthetic)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim()
}
