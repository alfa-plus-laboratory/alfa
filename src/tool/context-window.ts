/**
 * context 工具:让模型看一眼自己的上下文窗口。
 *
 * ── 为什么模型需要这个 ──
 * 它对「还剩多少」是**完全瞎的**。窗口满了的表现不是一条报错,是 provider 那边
 * 一个 400,或者一次静默的截断 —— 而在那之前,它一直在按「无限」的假设干活:
 * 整份读三万行的文件、把一坨构建日志原样贴回来、一轮里开八个后台任务。
 *
 * 界面上那条渐变量表回答的是**用户**的这个问题(见 cli/context.ts),而用户看到
 * 之后能做的事(`/compact`)恰恰是模型做不了的。所以这两边不是同一份信息的两个
 * 拷贝:用户那份用来决定按不按压缩,模型这份用来决定**接下来怎么干活** ——
 * 是整份读还是先 grep 定位,是把日志贴回来还是只贴报错那几行,是继续往下挖还是
 * 先把手上的结论说出来。
 *
 * ── 为什么是工具,不是每轮塞进去 ──
 * 每轮塞的话,每一轮都要为一个九成用不上的数字付钱,而且它会**天天在那儿**,
 * 于是被当成背景噪音。做成工具,它在模型真的开始犹豫「这个文件要不要整份读」
 * 的时候才被调用一次 —— 那一刻这个数字才有决策价值。
 *
 * ── 边界 ──
 * `src/tool` 不认识循环(见 DESIGN.md 的架构边界),所以这里不自己算报告:形状在
 * types.ts 上声明,值由 CLI 层在造 ToolContext 时注入(见 cli/main.ts)。
 */
import { z } from "zod"
import type { ContextView, ToolDef } from "./types.ts"

const Parameters = z.object({})

type Args = z.infer<typeof Parameters>

/** 到这条线以上就该主动说出来了。和界面上黄线同一个值(见 cli/context.ts 的 WARN_AT) */
const CROWDED = 0.8

const DESCRIPTION = `Reports how much of your context window is in use right now, and what is taking up the space.

You cannot feel the window filling up — it does not warn you, it just fails or silently truncates. Call this when the answer would change what you do next:

- Before reading something big. If space is tight, locate with grep/glob and read with offset/limit instead of pulling in a whole file.
- Before pasting a large command output, build log or dump back into your answer.
- Partway through a long task, to decide whether to keep digging or to land what you already have.
- When the user asks what is filling the context, or why you are running out.

You cannot compact the history yourself — only the user can, with /compact. If the window is nearly full, say so plainly and suggest it, rather than quietly working around it.

Do not call this on every turn. It costs a step and the number rarely moves enough between calls to change any decision.`

export const ContextTool: ToolDef<Args> = {
  id: "context",
  description: DESCRIPTION,
  parameters: Parameters,

  async execute(_args, ctx) {
    // 只读一个进程内的数字,盘上和网上什么都不碰。列在权限表里和 todo 同理:
    // 想把它关掉的人得有个地方写得下(见 permission/rules.ts)
    await ctx.ask({ permission: "context", patterns: ["*"] })

    const view = ctx.context?.()
    if (!view) {
      // 一次性模式 / 测试夹具里可能没接。说清是"这里没有",不是"窗口是空的"
      return {
        output: "Context reporting is not available in this run.",
        metadata: { truncated: false, available: false },
      }
    }

    const percent = view.budget > 0 ? Math.round((view.used / view.budget) * 100) : 0
    const lines = [
      `Context: ${num(view.used)} of ${num(view.budget)} used (${percent}%), ${num(Math.max(0, view.budget - view.used))} free.`,
      `The window is ${num(view.limit)}; ${num(view.budget)} of it counts as full — the rest is held back for your reply.`,
      view.estimated
        ? "These numbers are estimated locally; the provider has not reported usage yet this session."
        : "Total reported by the provider; the split below is estimated locally.",
      view.folded > 0
        ? `${view.messages} messages in context, ${view.folded} more already folded into a summary by an earlier /compact.`
        : `${view.messages} messages in context.`,
      "",
      "What is filling it:",
    ]

    // 只列有分量的。一份写着十行「0」的报告,要读的人自己去找哪一行是重点
    const shown = view.slices.filter((slice) => slice.tokens > 0).sort((a, b) => b.tokens - a.tokens)
    if (shown.length === 0) lines.push("  (nothing yet)")
    for (const slice of shown) {
      const share = view.used > 0 ? Math.round((slice.tokens / view.used) * 100) : 0
      lines.push(`  ${label(slice.key).padEnd(18)}${num(slice.tokens).padStart(6)}  ${String(share).padStart(3)}%`)
    }

    if (percent >= CROWDED * 100) {
      lines.push(
        "",
        "This is nearly full. Say so and suggest /compact — you cannot run it yourself. Until then, read narrowly (grep first, offset/limit) and keep tool output out of your replies.",
      )
    }

    ctx.metadata({ used: view.used, budget: view.budget, percent })
    return {
      output: lines.join("\n"),
      title: `${percent}% of ${num(view.budget)}`,
      metadata: { truncated: false, available: true, used: view.used, budget: view.budget, percent },
    }
  },
}

/**
 * 分项的名字。
 *
 * 不复用界面那份(i18n 目录里那几条):那些跟着 `/language` 走,而这段文本是
 * **发给模型**的 —— 用户把界面切成日文,不该让模型收到日文的字段名。
 */
function label(key: string): string {
  switch (key) {
    case "system":
      return "system prompt"
    case "tools":
      return "tool definitions"
    case "summary":
      return "compacted summary"
    case "memory":
      return "project memory"
    case "user":
      return "user messages"
    case "reply":
      return "your replies"
    case "thinking":
      return "your thinking"
    case "call":
      return "tool calls"
    case "result":
      return "tool results"
    default:
      return key
  }
}

/**
 * `306k`、`1.2M`。
 *
 * 自己写一个而不是用 cli/render.ts 那个:`src/tool` 不 import `src/cli`
 * (见 DESIGN.md 的架构边界)。而且这两处受众不同 —— 那个要挤进一格状态行,
 * 这个是给模型读的一行字,以后各自改各自的。
 */
function num(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(value)
}
