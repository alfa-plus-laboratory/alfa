/**
 * 预制 skills —— alfa 关于**它自己**的知识。
 *
 * ── 为什么这些东西住在 skill 里,而不是 system prompt 里 ──
 * 它们有一个共同的形状:**用到的时候不可替代,而九成的轮次里一个字都用不上**。
 * "两个配置文件在哪、provider 怎么写"是没法从项目里读出来的(它只存在于这个程序
 * 自己的约定里),但一场改代码的会话从头到尾都不会碰到它。量过一次:那一段是
 * 5268 字符 ≈ 1300 token,而它原来无条件进每一场、每一次请求。
 *
 * ★ 但这把尺子**只对「知识」有效,对「行为塑造」无效**。safety / untrusted /
 *   plan / agentflow 那几段留在 system 里不是因为没量过,是因为模型不会主动去
 *   点开一份约束自己的 skill —— 按需加载等于关掉它们。
 *
 * ── 为什么正文是 .md 文件,不是这里的一段字符串 ──
 * 内置的和用户写的必须是同一种东西:同一份 frontmatter 解析器、同一套字段。
 * 于是 `skills/*.md` 顺带成了「一份 skill 该怎么写」的活样本,而加一份内置知识
 * 的门槛是写一份 skill,不是改代码。文件在编译时嵌进二进制(`type: "text"`),
 * 所以单文件分发照旧。
 *
 * 加一份新的:在 `skills/` 下写一份 `.md`,然后在下面的数组里加一行。
 */
import type { BuiltinSkill } from "./skills.ts"
import alfaConfig from "./skills/alfa-config.md" with { type: "text" }
import alfaMcp from "./skills/alfa-mcp.md" with { type: "text" }
import alfaPermissions from "./skills/alfa-permissions.md" with { type: "text" }
import alfaSkills from "./skills/alfa-skills.md" with { type: "text" }
import alfaSubagents from "./skills/alfa-subagents.md" with { type: "text" }

export function builtinSkills(): BuiltinSkill[] {
  return [
    { text: alfaConfig, source: "built in (skills/alfa-config.md)" },
    // 这两份是**净增**的:权限那套怎么回事、怎么接一个 server,在此之前
    // 一个字都不在 prompt 里 —— 用户问起来它只能猜,而猜出来的答案听起来
    // 一样自信。它们从来不适合每轮都发,所以在 skills 之前也确实没法加
    { text: alfaPermissions, source: "built in (skills/alfa-permissions.md)" },
    { text: alfaMcp, source: "built in (skills/alfa-mcp.md)" },
    // 怎么写一份 skill 本身也是一份 skill。少了它,用户说"把这个流程记下来"时
    // 模型只能猜目录、猜文件名、猜 frontmatter —— 而猜错的表现是那份 skill
    // **根本不出现**(没有 description 就不收),用户手里只有"我明明写了"
    { text: alfaSkills, source: "built in (skills/alfa-skills.md)" },
    // 这一份不是「alfa 怎么回事」,是**从 task 的说明里搬出来的**那一半:
    // 链式编排的机制、resume 的账、两个人写同一个文件会怎样。搬得动的判据是
    // 参数说明里已经说过它是什么了(`after` / `resume` 的 describe 常驻),
    // 说明书里那一段只是换个说法再讲一遍 —— 而"怎么用好"这件事,只有真的
    // 要派一队人出去的那几轮里用得上
    { text: alfaSubagents, source: "built in (skills/alfa-subagents.md)" },
  ]
}
