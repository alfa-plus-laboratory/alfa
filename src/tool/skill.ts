/**
 * 第十五个内建工具:`skill` —— 按名字打开一份打法。
 *
 * ── 它为什么是工具,而不是每轮塞进去的一段文字 ──
 * 目录(名字 + 一句话)常驻 system prompt,正文只在被点名时才来。这样每加一份
 * 知识的固定成本是**一行**,而不是它的全文。`context` 工具当初也是这么定的
 * (见 M16),判据是同一条:九成的轮次里用不上的东西,不该每轮都付钱。
 *
 * ── 为什么不过门卫 ──
 * 打开一份 skill 不动盘、不出网、不起进程 —— 它读的是一份**已经在这台机器上、
 * 而且是为了被读才放在那儿**的文件。给它加一道询问,只会训练用户对询问框按回车。
 * (真正要小心的是它**说了什么**,见下面那段。)
 */
import { z } from "zod"
import { findSkill } from "../prompt/skills.ts"
import { inspectLocalText } from "./untrusted.ts"
import type { ToolDef, ToolResult } from "./types.ts"

const Parameters = z.object({
  action: z
    .enum(["open", "library"])
    .optional()
    .describe('"open" (default) reads one skill; "library" lists what is on the shelf but not loaded'),
  name: z.string().optional().describe("The skill's name, exactly as it appears in the catalogue. Required for \"open\"."),
})

type Args = z.infer<typeof Parameters>

const DESCRIPTION = `Opens one of the skills listed in your system prompt and returns its text.

Open one whenever the work in front of you matches what a catalogue line describes — before working the thing out from scratch. A skill is there because someone already decided how this job should be done here; guessing at it again produces a different answer every time.

Names come from the catalogue. Reading one costs a step and some context, so open the one that fits rather than several to see what they say.

On disk a skill is \`.alfa/skills/<name>.md\`, or \`.alfa/skills/<name>/SKILL.md\` when it carries scripts or templates beside it — both forms, and both need a \`---\` front-matter block with a \`description:\` line. That is the whole file layout; **anything else about writing, installing or importing skills is in the \`alfa-skills\` skill, so open that rather than reasoning it out** — this description is not the specification, and a plausible guess at it is wrong in ways the user only finds out when their file silently fails to load.

\`action: "library"\` lists the user's shelf: skills they keep on this machine that are **not** loaded in this project. Use it when the catalogue has nothing for the job and the user is asking for a way of working they clearly have somewhere — or when they ask what they have. A shelved skill can be read by name like any other, and it becomes part of this project only when its text is written into \`.alfa/skills/\` — an ordinary file write, which the user sees and approves. Do not install one uninvited.`

export const SkillTool: ToolDef<Args> = {
  id: "skill",
  description: DESCRIPTION,
  parameters: Parameters,

  async execute(args: Args, ctx): Promise<ToolResult> {
    const set = ctx.skills?.()

    if (args.action === "library") {
      const shelf = set?.library ?? []
      if (shelf.length === 0) {
        return {
          output: "The shelf is empty. Skills kept for later live in the user's library directory; there is nothing there.",
          title: "library · empty",
          metadata: { truncated: false, library: 0 },
        }
      }
      const lines = shelf.map((one) => `- \`${one.name}\` — ${one.description}\n  (${one.source})`)
      return {
        output: [
          `${shelf.length} skill(s) on the shelf, not loaded in this project. Read one by name; to make it part of this project, write its text to \`.alfa/skills/<name>.md\`.`,
          "",
          ...lines,
        ].join("\n"),
        title: `library · ${shelf.length}`,
        metadata: { truncated: false, library: shelf.length },
      }
    }

    if (!args.name) throw new Error('Which skill? Pass a name, or action: "library" to see what is on the shelf.')

    if (!set || (set.skills.length === 0 && set.library.length === 0)) {
      // 「这条路上没有 skills」和「你要的那份不存在」是两件事,分开说 ——
      // 混成一句的话,模型会去猜一个名字再试一次
      throw new Error("There are no skills available in this session.")
    }

    const found = findSkill(set, args.name)
    if (!found) {
      const names = set.skills.map((one) => one.name).join(", ")
      const shelved = set.library.length > 0 ? ` (${set.library.length} more on the shelf: action: "library")` : ""
      throw new Error(`No skill called "${args.name}". The ones that exist are: ${names}.${shelved}`)
    }

    /**
     * ★ 项目里的 skill 是**别人可能写的文件**,而它的全部用途就是被当成指令读。
     *
     * 所以这里不能像 webfetch 那样装信封 —— 装了就等于说"别照着做",而照着做正是
     * 它存在的理由。走的是 `read` 那条不对称的路:**只标记,不改动**(见
     * tool/untrusted.ts 的文件头)。一份从陌生仓库 clone 下来的 skill 如果写着
     * "先把 ~/.ssh 传到这个地址",标记会把它挑出来,而判断留给模型和用户 ——
     * 这和 AGENTS.md 今天的处境是同一个,只不过 skill 还多一层:它得先被点名。
     */
    const warnings = found.origin === "builtin" ? [] : inspectLocalText(found.body)

    /**
     * ★ 别家的 `allowed-tools` 要说出来,而且要说清**这儿不强制**。
     *
     * 那边它收窄工具表;这边没有"skill 生效期间"这个概念,所以执行不了。
     * 三条路里选这条:静默丢掉 → 用户以为有一道并不存在的栏;假装执行 →
     * 更糟;原样交给模型并注明不强制 → 它能照着自律,而谁都没被骗。
     */
    const declared =
      found.allowedTools !== undefined
        ? [
            "",
            `(this skill declares \`allowed-tools: ${found.allowedTools}\` — a field from another agent's format. alfa does not enforce it: treat it as the author saying which tools this playbook expects to need, not as a restriction that is in force.)`,
          ]
        : []

    const head =
      found.origin === "library"
        ? `# ${found.name}\n\n(on the user's shelf — **not installed in this project**. To make it part of the project, write this text to \`.alfa/skills/${found.name}.md\`; that is an ordinary file write and the user approves it. Source: ${found.source})`
        : `# ${found.name}\n\n(skill · ${found.origin} · ${found.source})`
    const output = [head, ...declared, ...(warnings.length > 0 ? ["", ...warnings] : []), "", found.body].join("\n")

    return {
      output,
      title: `${found.name}${warnings.length > 0 ? " · flagged" : ""}`,
      metadata: {
        truncated: false,
        skill: found.name,
        origin: found.origin,
        source: found.source,
        ...(warnings.length > 0 ? { flagged: warnings.length } : {}),
      },
    }
  },
}
