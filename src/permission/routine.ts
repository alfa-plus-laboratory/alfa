/**
 * 「在项目里跑项目自己的脚本」——一档确定性的放行。
 *
 * ── 为什么这件事不能交给判官 ──
 * 用户说「写个 demo 玩玩」,agent 写出 `test/demo.py`(每一次改动都当面打了 diff),
 * 然后运行它 —— 判官答「未提供 demo.py 内容,无法判断其作用范围与风险」。
 * 这不是判官笨,是**这道题出错了**:让一个模型去读一段脚本然后预测它危不危险,
 * 是个很难的题,难题必然答得不稳。而「这条命令跑的文件在不在项目里」是个
 * 查一次 statSync 就能回答的题。
 *
 * 能确定的事就别去问一个会犹豫的东西。判官留给真说不清的:出网、项目外、
 * 发布、装包。
 *
 * ── 边界画在哪 ──
 * 只认「解释器 + 一个位于工作区内的现存文件」。任何 flag 都出局 ——
 * `python3 -c "…"` 的代码在命令行里而不在文件里,`-m` 跑的是装在系统上的模块,
 * 两者都不是「项目自己的脚本」。多于一个参数也出局:那时候第二个参数是什么
 * 我们并不知道。
 *
 * 这一档**压不过** scan.ts 的 force:命令里有子 shell、重定向、提权、出网时,
 * 危险不在命令名里而在它周围的结构里,照样要问。
 */
import { statSync } from "node:fs"
import { resolve, sep } from "node:path"

/** 拿脚本文件当参数跑的解释器。装在系统上的模块(-m)不算,见文件头。 */
const INTERPRETERS = new Set([
  "python",
  "python3",
  "node",
  "bun",
  "deno",
  "ruby",
  "perl",
  "php",
  "Rscript",
  "ts-node",
  "tsx",
])

export interface RoutineInput {
  /** 子命令原文(bash 拆句器给的每一段) */
  command: string
  /** 这条命令实际跑在哪 */
  workdir: string
  /** 工作区根 */
  root: string
}

/**
 * 这一段是不是「拿解释器跑一个工作区内的现存文件」。
 *
 * 判不出来一律 false —— 这一档是**加速器**,不是兜底。它错过一次的代价是
 * 多问一次,而它多认一次的代价是执行了不该执行的东西。
 */
export function runsProjectScript(input: RoutineInput): boolean {
  const tokens = input.command.trim().split(/\s+/).filter((token) => token.length > 0)
  const first = tokens[0]
  if (!first || !INTERPRETERS.has(first)) return false

  const rest = tokens.slice(1)
  // 任何 flag 都出局。-c / -e / --eval 的代码根本不在文件里,
  // -m 跑的是系统上的模块 —— 都不是「项目自己的脚本」
  if (rest.some((token) => token.startsWith("-"))) return false
  if (rest.length !== 1) return false

  const target = rest[0]!
  // 引号里的路径没被正确拆开时宁可放弃。判官会接着处理
  if (/["'`$]/.test(target)) return false

  const path = resolve(input.workdir, target)
  if (path !== input.root && !path.startsWith(input.root + sep)) return false

  try {
    return statSync(path).isFile()
  } catch {
    // 文件不存在:那这条命令本来也跑不起来,没必要为它放行
    return false
  }
}
