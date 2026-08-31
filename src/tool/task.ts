/**
 * task 工具:派一个子 agent 出去,**立刻回来**,它干完了会有人通知你。
 *
 * ── 三版的来回,值得写下来 ──
 * 第一版:起完就返回,拿结果去 `job output`。真跑起来是模型派完人手上没事干,
 *   于是接着自己把同一件活儿又做了一遍 —— 因为没有人告诉它"等着就行"。
 * 第二版:改成站着等。这下它不重复干活了,但整整一轮 turn 被占住,用户在
 *   子 agent 跑完之前一句话都插不进来 —— 而"派出去"的意义本来就包含
 *   "我可以同时干别的",对用户也一样。
 * 第三版(现在这个):**起完就返回,但结果是推给它的,不是它去捞的**。
 *   子 agent 一说完,那份报告作为一条合成消息进主会话,主 agent 被叫醒接着干。
 *   于是三方各归各位:子 agent 在后台安静干活,主 agent 该等就等、该跟用户
 *   聊就聊,用户手里的提示符一直是自己的。
 *
 * ── 所以这个工具**不等**,而且模型也不该去轮询 ──
 * 说明里因此写死了两句:结果会自己回来(别去 `job output` 捞),以及派完之后
 * 如果没别的事可干,就说一句短的停下来 —— 停下来不是偷懒,是把对话还给用户。
 *
 * ── 说明书为什么只剩一半(M37) ──
 * `after` / `resume` 的**语义**在参数说明里已经写清楚了,而参数说明是常驻的。
 * 原来的 DESCRIPTION 又把同一件事换个说法讲了一遍 —— 光这两段就是一千多字符,
 * 每一场、每一次请求都在付,而真正要派一队人出去的是极少数轮次。
 *
 * 所以搬走的是「怎么用好」(链式的账、resume 的账、两个人写同一个文件会怎样),
 * 去处是 `alfa-subagents` 那份预制 skill;留下的是「什么时候用、用了之后该
 * 干什么」—— 后者是**行为塑造**,按需加载对它无效(见 prompt/builtin-skills.ts
 * 那颗星:模型不会主动去点开一份约束自己的 skill)。
 *
 * 判据就是这条:**参数说明已经说过的,别再说第二遍;调用之后才生效的,必须留下。**
 *
 * ── 跑完的那个还能叫醒(resume),而且**没有死期** ──
 * 它那场会话完整躺在库里,叫醒的代价只是再跑一次循环 —— 而它手上还攥着上一轮
 * 读过的全部东西。追问同一件事时,重派一个空白的等于把背景重讲一遍、再把同一批
 * 文件重读一遍。反过来说明里也写清了什么时候别用:接着聊意味着它那几万 token
 * 的历史每一轮都要重发,而派子 agent 的全部意义就是把那些烧在别处。
 */
import { z } from "zod"
import type { ToolDef } from "./types.ts"

const Parameters = z.object({
  name: z
    .string()
    .optional()
    .describe(
      'What KIND of agent this is, in a couple of words — by its nature, not by this particular job: ' +
        '"research agent", "test agent", "调查agent". Any language. It becomes the job\'s name, ' +
        "and a second one of the same kind gets -2 after it. Leave it out when you are using resume.",
    ),
  resume: z
    .string()
    .optional()
    .describe(
      "The name of a subagent that has already finished, to wake up and give more work to. It still has its " +
        "whole conversation, so you do not have to explain any of it again. Use this instead of name when you " +
        "are following up on what that same agent just did.",
    ),
  after: z
    .array(z.string())
    .optional()
    .describe(
      "Names of subagents this one has to wait for. It does not start until they have all finished, and their " +
        "reports are pasted into the top of its brief automatically — so the brief only needs to say what to DO " +
        "with them. Use it to build a whole pipeline in one turn: several finders, then one that checks their " +
        "findings, then one that writes them up. Only names you started earlier in this conversation.",
    ),
  prompt: z
    .string()
    .describe(
      "The whole brief, sent to the subagent word for word: what to do, where to look, and exactly what to " +
        "report back. For a new subagent it cannot see this conversation, so everything it needs has to be in " +
        "here; for a resumed one, it already remembers its own work, so say only what is new. Its first " +
        "line is what the user sees in the panel, so make that line say what this job is.",
    ),
})

type Args = z.infer<typeof Parameters>

const DESCRIPTION = `Hands one job to a subagent working in the background, and returns immediately.

A subagent is a full agent with its own context: your tools minus \`task\` and \`ask\`, the same permissions, its own conversation. Use it when the work would flood your own context with material you do not need to keep — finding where something lives in a large codebase, reading a directory to summarise it, digging out how one subsystem works. Only its final answer comes back to you, not the twenty files it read to get there. That is the point: you get the conclusion without paying for the search.

ITS ANSWER IS DELIVERED TO YOU AUTOMATICALLY when it finishes, as a new message in this conversation. You do not poll for it, and you do not need the job tool to collect it.

So after starting one:
- Do NOT start doing the same work yourself. It is being done.
- Start the other subagents too, if the job splits into independent parts. They run at the same time — and if more are started than there are slots, the rest queue up and start on their own as slots free.
- If there is nothing useful left to do until the answers arrive, say so in one short line and stop. Stopping hands the conversation back to the user, who can keep talking to you while the work runs — you will be woken up when each answer lands.
- If there IS something useful you can do meanwhile — work the user can use right now, or a question you can already answer — do it.

Do not use it for work you can finish in two or three tool calls yourself: a subagent costs a whole conversation of its own.

Usage rules:
- The brief must stand alone. The subagent cannot see this conversation, your instructions, or what the user said. Spell out the goal, where to start, and what "done" looks like.
- Say what to report back, and how much: "list every call site with file:line" gets you that; "look into X" gets you an essay.
- It cannot ask the user anything, and it cannot start subagents of its own. If the work needs a decision from the user, get that decision first (ask tool), then send it in the brief.
- **If a skill in your catalogue covers what you are sending out, name it in the brief** — "read the \`cut-a-release\` skill first". The subagent has the same catalogue and the same \`skill\` tool, but not the conversation that made that skill relevant, and a narrow brief gives it no reason to go looking. Naming it is enough; do not paste its text.
- It CAN edit files and run commands, through the same permission gate you do. Two of them editing one file at the same time produce a mess, and nothing merges anything for you.

Chaining several with \`after\`, waking a finished one with \`resume\`, or sending out a wave that writes: **open the \`alfa-subagents\` skill first.** What those cost, and how to split the work so they do not collide, is there rather than here — it is the difference between a fleet that pays for itself and one that does not.`

export const TaskTool: ToolDef<Args> = {
  id: "task",
  description: DESCRIPTION,
  parameters: Parameters,

  async execute(args, ctx) {
    if (!ctx.agents) {
      throw new Error(
        "Subagents are not available in this run. Do the work yourself, in this conversation.",
      )
    }

    const resume = args.resume?.trim()
    const name = args.name?.trim()
    const after = (args.after ?? []).map((id) => id.trim()).filter((id) => id.length > 0)
    // 两个一起给多半是它没想清楚要哪一个。挑一个执行下去的话,另一个的意图
    // 就被无声地丢掉了 —— 而那两种意图(新起一个 / 接着上一个)差得很远
    if (resume && name) {
      throw new Error(
        'Give either "name" (start a new subagent) or "resume" (wake one that already finished), not both.',
      )
    }
    if (!resume && !name) {
      throw new Error('name is required: what kind of agent this is. Use "resume" instead to wake a finished one.')
    }
    // ★ resume + after 是不许的,而且理由不是"没实现"。被叫醒的是一个**老节点**,
    //   让它去等一个更新的任务就能造出环 —— 而整张依赖图无环这件事,靠的正是
    //   "新的只能指向旧的"(见 agent/subagent.ts 的 AgentJob.after)
    if (resume && after.length > 0) {
      throw new Error(
        '"after" only works when starting a new subagent. One you are waking up has already done a round of ' +
          "work; if it needs to wait for something, wait for that yourself and then resume it with what came back.",
      )
    }

    // 门卫走一遍。子 agent 自己每一步照旧过门卫(它用的是同一张规则表),
    // 这里问的是另一件事:**要不要让它去**。一个不想让 agent 自己派活儿的人
    // 得有一个地方说不,而那个地方只能是这里
    await ctx.ask({
      permission: "task",
      patterns: ["*"],
      metadata: { preview: `${resume ? `${resume} (resumed)` : name}\n\n${args.prompt}` },
    })

    const job = resume
      ? await ctx.agents.resume(resume, args.prompt)
      : await ctx.agents.start({ name: name!, prompt: args.prompt, ...(after.length > 0 ? { after } : {}) })
    ctx.metadata({ job: job.id, description: job.command, ...(resume ? { resumed: true } : {}) })

    // 排着队的那些也要**当场说清在等什么**。只回一句"已经派出去了"的话,模型
    // 过一会儿会发现面板上它一动没动,然后去 `job output` 捞 —— 而它什么都没干
    if (job.status === "queued") {
      const behind = after.length > 0 ? `waiting for ${after.join(", ")}` : "waiting for a free slot"
      return {
        output:
          `Subagent "${job.id}" is queued (${behind}): ${job.command}\n\n` +
          `It starts on its own as soon as ${after.length > 0 ? "those have finished" : "a slot frees up"}` +
          `${after.length > 0 ? ", with their reports already in its brief" : ""}. Carry on laying out the rest ` +
          `of the work — you do not have to wait here, and you do not have to start it yourself later.`,
        title: `${job.id} queued`,
        metadata: { truncated: false, job: job.id, started: true, queued: true },
      }
    }

    // 起完那几百毫秒里就结束了的两种情况,**必须分开说**:
    //   exit 0  —— 活儿太小,它已经答完了。报成"失败"的话模型会重派一遍
    //   非 0    —— 凭据不对、模型名写错这类:照实报成失败,不是"已经派出去了"
    // 两种都要**当场把报告交出去**,并且用 claimReport 占住它 —— 否则结束时
    // 那条推送会把同一份结论再送一遍(见 AgentJobs.claimReport)
    if (job.status === "exited") {
      const report = ctx.agents.claimReport(job.id) ?? "It said nothing."
      const failed = job.exit !== 0
      return {
        output: failed
          ? `The subagent "${job.id}" stopped without doing the work:\n\n${report}`
          : `Subagent "${job.id}" was quick — it has already finished. Its answer:\n\n${report}`,
        title: failed ? `${job.id} failed to start` : `${job.id} · done`,
        metadata: { truncated: false, job: job.id, started: !failed, answered: !failed, ...(resume ? { resumed: true } : {}) },
      }
    }

    return {
      output:
        `Subagent "${job.id}" is ${resume ? "awake again and working on" : "working on"}: ${job.command}\n\n` +
        `Its answer will be delivered to you as a message when it is done — do not poll for it, and do not ` +
        `do this work yourself in the meantime. Start any other subagents you need now. If there is nothing ` +
        `else useful to do until the answers arrive, say so in one short line and stop; you will be woken up.`,
      title: `${job.id} started`,
      metadata: { truncated: false, job: job.id, started: true, ...(resume ? { resumed: true } : {}) },
    }
  },
}
