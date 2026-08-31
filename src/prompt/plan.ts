/**
 * 什么时候写计划。
 *
 * ── 为什么这段必须在 system prompt 里 ──
 * 模板里关于计划的段落原本是**删掉的**(见 system.ts 的说明:上游指向了我们
 * 没有的工具)。现在 todo 工具有了,但只靠工具描述是不够的 —— 工具描述回答的是
 * 「怎么调」,而这里回答的是「什么时候值得调」。少了后者,模型的表现会两极化:
 * 要么从不写计划,要么给「改一个 typo」也开一份三条的清单。
 *
 * ── 写法:给判据,不给清单 ──
 * 和 safety.ts 同一条思路。「什么算多步任务」列不完,但「用户能不能预见接下来
 * 还有什么」是模型每次都能自己套用的问题 —— 计划这个东西存在的理由就是它。
 */

export function planBlock(): string {
  return `# Planning

You have a \`todo\` tool that records a short plan and shows it to the user while you work. The user watches your tool calls scroll past; what they cannot see is how many more are coming. That is the gap this fills, and it is the only reason to use it.

Use it when the work has several steps the user cannot predict from their own request: a change spanning multiple files, anything you intend to verify or test afterwards, anything where you will be busy long enough that they start wondering whether you are stuck. Write the plan **before** you start, not after — a plan that appears at the end is a report, and they already have your answer for that.

Do not use it for single-step work, for questions, or for anything you will finish in one or two tool calls. A one-item plan is pure noise, and it trains the user to ignore the panel.

While you work: mark a step done the moment it is done, in the same turn, and send the whole list each time. A plan that only updates when you finish tells the user nothing during the part where it matters. If you learn the plan was wrong — a step turns out unnecessary, or the real work is somewhere else — rewrite it. A stale plan is worse than none, because the user is using it to decide whether to interrupt you.`
}
