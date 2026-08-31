/**
 * ask 工具:停下来问用户一句,给几个选项让他挑。
 *
 * ── 为什么这件事值一个工具 ──
 * 模型本来就能在回答里问问题,但那要**这一轮结束**才问得出口。于是遇到岔路口
 * 时它只有两种选择:猜一个往下做(错了就是十几步白干),或者停下来把整轮
 * 对话花在一句"你想要哪种?"上 —— 而用户回一句"第二种",它又得从头把上下文
 * 捡回来。工具化之后,问题发生在**它正在干活的中间**:问完拿着答案接着往下,
 * 一轮就够。
 *
 * ── 为什么给选项而不是让它自由发问 ──
 * "你希望怎么处理这个?"要用户自己组织一段话;"A 还是 B?"按一下就行。而模型
 * 真正卡住的地方九成能收敛成几个选项 —— 它已经把可能性想清楚了,缺的只是
 * **哪一个**。选项还有个副作用:一个列不出选项的问题,通常说明它自己也没想清楚,
 * 那种时候它该去多看两个文件,而不是来问人。
 *
 * ── 但选项永远不够,所以一定留一档自己打字 ──
 * 终端里最真实的情况是"你给的三个都不对"。界面上因此永远有一档
 * `[o] something else`,打进去的话按**新指令**回给模型,而不是当成第四个选项。
 *
 * ── 没人可问的时候必须立刻说,不许等 ──
 * `-p`、管道、CI 里没有人会按键。那种时候工具当场回一句"这里没人",让模型
 * 自己拿主意并说清它假设了什么 —— 挂在那儿等一个不会来的回答,是这类工具
 * 最糟糕的失败方式:它看起来像卡死,而且没有任何报错。
 */
import { z } from "zod"
import type { Answer, QuestionOption, ToolDef } from "./types.ts"

/** 最多几个选项。再多就该先收敛一轮 —— 终端里一屏摆不下,人也挑不动 */
const MAX_OPTIONS = 6
/**
 * 一次最多问几个。
 *
 * ── 为什么可以问好几个 ──
 * 一个问题一次工具调用的话,三个岔路口就是三次「工具结果 → 重发整段历史 →
 * 新一轮回答」。那三轮里模型什么活儿都没干,而每一轮都要把整个上下文再发一遍 ——
 * 三个问题的代价是三倍历史,不是三倍问题本身。攒在一次调用里,用户连着答三下,
 * 模型那边只当一次。
 *
 * ── 为什么是 4 而不是随便多少 ──
 * 一次弹四个框已经是打断的上限了。更要紧的是:能一次问出来的前提是这几个问题
 * **互不影响** —— 而真正互不影响的岔路口很少超过三四个,凑数的那些多半是
 * "第一个答完就不用问了"。
 */
const MAX_QUESTIONS = 4
/** 选项本身多长。它是一句"答案",不是一段说明 */
const MAX_LABEL = 80
/** 那行补充多长 */
const MAX_DESCRIPTION = 120

const Parameters = z.object({
  questions: z
    .array(
      z.object({
        question: z
          .string()
          .describe('The question, as one sentence. e.g. "Which database should the new service use?"'),
        options: z
          .array(
            z.object({
              label: z.string().describe("The answer itself, a few words. This is what comes back to you."),
              description: z
                .string()
                .optional()
                .describe("One line: what picking this means, or what it costs. Omit it rather than padding."),
            }),
          )
          .describe(`Between 2 and ${MAX_OPTIONS} options, best first.`),
        multiple: z
          .boolean()
          .optional()
          .describe("True if the user may pick several. Default false (exactly one)."),
      }),
    )
    .describe(
      `1 to ${MAX_QUESTIONS} questions, asked one after another in a single interruption. ` +
        `Only batch questions that are independent of each other.`,
    ),
})

type Args = z.infer<typeof Parameters>

const DESCRIPTION = `Asks the user up to ${MAX_QUESTIONS} multiple-choice questions and waits for the answers.

Use it when you are at a fork you cannot resolve from the code or the request, and picking wrong would waste real work: which of two designs to follow, which of three files they meant, whether to include something with a cost. The user answers with one keypress each, and you keep going in the same turn.

Ask everything you need in ONE call. Each separate call is another round trip that resends the whole conversation, so three calls cost three times the history for three keypresses.

Do NOT use it for:
- Anything you can answer yourself by reading the repository. Go read it.
- Permission to do something. That has its own path; just do the thing and the user will be asked if it needs approving.
- "Shall I continue?" / "Does this look right?" — say what you did and continue.
- A question with no real options, or where every option is the same to the user.

Usage rules:
- Batch only questions that are INDEPENDENT. If the answer to one decides whether another matters — or changes its options — ask that one alone and come back with the rest. Answering a question that turned out to be moot is worse than a second call.
- Order them the way you would say them out loud: the most consequential first.
- ${MAX_OPTIONS} options per question at most, and each must be a real answer, not a placeholder like "other" — the user always has a free-text choice of their own.
- The user may type something else entirely, or dismiss a question. Both come back to you as such: a typed answer outranks the options you offered, and a dismissed question means move on with your best judgement, not ask again.
- In a non-interactive run (piped input, -p) there is nobody to answer. You will be told so; decide yourself and state the assumption you made.`

export const AskTool: ToolDef<Args> = {
  id: "ask",
  description: DESCRIPTION,
  parameters: Parameters,

  async execute(args, ctx) {
    const asked = (args.questions ?? []).slice(0, MAX_QUESTIONS).map((raw) => ({
      question: (raw.question ?? "").replaceAll(/\s+/g, " ").trim(),
      options: normalize(raw.options ?? []),
      multiple: raw.multiple === true,
    }))
    if (asked.length === 0) throw new Error("questions is required: at least one question with its options.")
    for (const item of asked) {
      if (item.question.length === 0) throw new Error("Every question needs its text.")
      if (item.options.length < 2) {
        throw new Error(
          `"${item.question}" has fewer than 2 options. A question with one answer is not a question — ` +
            `just do it, or say what you are about to do.`,
        )
      }
    }

    // 走一遍门卫,理由和 todo 一样:这个工具没有副作用,但「它能被 deny」
    // 这件事得成立 —— 有人会想要一个从不打断自己的 agent
    await ctx.ask({ permission: "ask", patterns: ["*"] })
    ctx.metadata({ questions: asked.map((item) => item.question) })

    if (!ctx.inquire) return unavailable(asked.map((item) => item.question))

    // ★ 一个一个问,但**只算一次工具调用**。终端里同时摆三个框没法看,而省下来的
    //   是三轮「工具结果 → 重发整段历史 → 新一轮回答」—— 贵的从来不是问题本身
    //
    // ── 为什么是下标游标而不是 for-of ──
    // 因为可以**往回走**。答到第三个才想起来"刚才第一个我选的是啥",在这之前
    // 唯一的办法是把整组都取消掉重来一遍。界面上按 ← 回一题(见 cli/ask.ts),
    // 回来的那次带着上次的答案(previous),勾过的还勾着、打过的字还在。
    //
    // ★ 「回上一题」**永远不会流到模型那里**:它是一次导航,在这个循环里就被
    //   消化掉了。模型看到的只有最终那份答案 —— 用户改了几次主意不是它的事。
    const given: Array<Answer | undefined> = new Array(asked.length).fill(undefined)
    let at = 0
    while (at < asked.length) {
      const item = asked[at]!
      const previous = given[at]
      const answer = await ctx.inquire({
        question: item.question,
        options: item.options,
        multiple: item.multiple,
        position: { index: at + 1, total: asked.length },
        ...(previous ? { previous } : {}),
      })
      // 没人可问的话后面每一个的答案都会是同一句,别接着问
      if (answer.kind === "unavailable") {
        return unavailable(asked.slice(at).map((each) => each.question))
      }
      if (answer.kind === "back") {
        // 第一题上界面不会给这个键。真收到了也只是原地不动,不能变成负数
        at = Math.max(0, at - 1)
        continue
      }
      given[at] = answer
      at++
      // 用户中断了这一轮:剩下的不再弹。接着弹是在跟一个刚按了 Ctrl-C 的人较劲
      if (ctx.abortSignal.aborted) break
    }

    // 中断留下的洞按题号跳过(不是重新编号):模型要对得上是哪一题
    const answers = asked
      .map((item, index) => ({ question: item.question, answer: given[index], index }))
      .filter((each): each is { question: string; answer: Answer; index: number } => each.answer !== undefined)

    ctx.metadata({ answer: answers.map((each) => describe(each.answer)).join(" · ") })
    const answered = answers.some((each) => each.answer.kind === "picked" || each.answer.kind === "typed")

    return {
      output: [
        answers.length === 1 ? "The user answered:" : `The user answered ${answers.length} questions:`,
        "",
        ...answers.map((each) => renderAnswer(each.question, each.answer, each.index + 1, asked.length)),
        ...(answers.some((each) => each.answer.kind === "typed")
          ? ["", "An answer in their own words is an instruction: it replaces the options you offered for that question."]
          : []),
        ...(answers.some((each) => each.answer.kind === "cancelled")
          ? [
              "",
              "A dismissed question means: do not ask it again. Continue with the most reasonable option and " +
                "say which one you took and why.",
            ]
          : []),
      ].join("\n"),
      title: summarize(answers),
      metadata: { truncated: false, answered, questions: answers.length },
    }
  },
}

/** 一问一答两行。带编号是因为一次可能问了好几个,而模型得对得上是哪一个 */
function renderAnswer(question: string, answer: Answer, index: number, total: number): string {
  const mark = total > 1 ? `${index}. ` : ""
  switch (answer.kind) {
    case "picked":
      // 原样回选项文本,不回下标 —— 下标要模型自己再对一次表,而它对错的时候
      // 不会报错,只会照着另一个选项干活
      return `${mark}${question}\n   -> ${answer.choices.join(" / ")}`
    case "typed":
      return `${mark}${question}\n   -> (in their own words) ${answer.text}`
    default:
      return `${mark}${question}\n   -> (dismissed without answering)`
  }
}

/** 卡片标题:第一个答案 + 还有几个。整行摆不下三个答案,而第一个是最要紧的那个 */
function summarize(answers: Array<{ answer: Answer }>): string {
  const first = answers[0]?.answer
  const head =
    first?.kind === "picked" ? first.choices.join(", ") : first?.kind === "typed" ? first.text : "dismissed"
  return answers.length > 1 ? `${firstLine(head)} +${answers.length - 1}` : firstLine(head)
}

/** 没人可问。**不是错误** —— 报错会让模型以为自己用错了工具,然后再试一次 */
function unavailable(questions: string[]): {
  output: string
  title: string
  metadata: { truncated: boolean; answered: boolean; unavailable: boolean }
} {
  return {
    output:
      `There is nobody to answer this run (non-interactive: piped input, -p, or no terminal).\n` +
      `Decide it yourself, do the work, and state plainly which way you went and what you assumed.\n` +
      `Unanswered:\n${questions.map((question) => `- ${question}`).join("\n")}`,
    title: "nobody to ask",
    metadata: { truncated: false, answered: false, unavailable: true },
  }
}

/**
 * 收拾选项。
 *
 * 去重是必要的:模型偶尔会把同一个意思写两遍(措辞略有不同),而界面上两条
 * 一模一样的选项会让用户以为自己看错了。空的直接扔,不报错 —— 一次工具调用
 * 白跑的代价比"少一个明显是凑数的选项"大。
 */
function normalize(options: readonly { label: string; description?: string }[]): QuestionOption[] {
  const out: QuestionOption[] = []
  const seen = new Set<string>()
  for (const option of options) {
    const label = clamp(option.label ?? "", MAX_LABEL)
    if (label.length === 0) continue
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const description = clamp(option.description ?? "", MAX_DESCRIPTION)
    out.push(description.length > 0 ? { label, description } : { label })
    if (out.length >= MAX_OPTIONS) break
  }
  return out
}

function clamp(text: string, max: number): string {
  const flat = text.replaceAll(/\s+/g, " ").trim()
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? ""
  return line.length > 60 ? line.slice(0, 59) + "…" : line
}

/** 给 metadata 用的一句话。界面上的收据另有一条路,见 cli/ask.ts 的 answerLine */
function describe(answer: Answer): string {
  switch (answer.kind) {
    case "picked":
      return answer.choices.join(", ")
    case "typed":
      return answer.text
    default:
      return answer.kind
  }
}
