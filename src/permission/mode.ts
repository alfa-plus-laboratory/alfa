/**
 * 权限模式:一条信任阶梯。
 *
 *   confirm  每件事都问   —— 不熟的仓库、不熟的模型、跑生产脚本
 *   default  按规则表     —— 平时
 *   trust    该问的都放行 —— 长任务,不想一直守着回车
 *
 * ── 为什么第三档叫 trust,不叫 auto ──
 * 它一度叫 auto,那时候门口站着一个判官模型,「自动」指的是**它替你判**。
 * 判官后来撤了(理由见 gate.ts 文件头:它只看得见一行命令,看不见为什么现在
 * 要做这件事),这一档就变成了纯粹的放空 —— 而 `auto` 这个名字还留着,
 * 于是它在骗人:用户读到「自动」会以为有东西在替他把关,实际上什么都没有。
 *
 * `trust` 说的是实话:**你信这个模型,所以不再问**。信任是用户给的,不是
 * 程序判出来的。等哪天真有一个判得准的 auto 了,再把 auto 加回来当第四档,
 * 那时候两个名字各说各的事,谁也不冒充谁。
 *
 * 老配置里的 `"permission": "auto"` 仍然认(见 normalizeMode),读成 trust ——
 * 一个升级之后启动不了的程序,比一个名字不准的模式糟糕得多。
 *
 * ── 两条不随模式变的事 ──
 * 1. **HARD_DENY 任何模式都拦得住。** 它在模式判断之前就短路了(见 gate.ts)。
 *    没有哪个模式能把 `rm -rf /` 放过去,trust 也不行。
 * 2. **自动放行必须留痕。** 每一条被 trust 放过的调用都会写进对话。看不见的
 *    自动化不是省事,是失控。
 */

import { t } from "../i18n/index.ts"

export type PermissionMode = "confirm" | "default" | "trust"

/** shift-tab 的循环顺序。从严到松,方向固定,肌肉记忆才建立得起来。 */
export const MODES: readonly PermissionMode[] = ["confirm", "default", "trust"] as const

export const DEFAULT_MODE: PermissionMode = "default"

/**
 * 已经不再出现在任何界面上、但还得认的老名字。
 *
 * 只读不写:存下去的永远是新名字,所以这张表只会越用越少。
 */
const ALIASES: Record<string, PermissionMode> = { auto: "trust" }

interface ModeInfo {
  /** 状态栏上的短标签 */
  label: string
  /** 一句话说明,切换时闪在状态栏上 */
  hint: string
}

/**
 * 模式的显示文字。
 *
 * **每次现取**,不做成模块级常量:界面语言可以在运行时被 /language 改掉,
 * 而一个在 import 那一刻就定死的常量表不会跟着变 —— 那种漏网只会在切完语言
 * 之后的某一行上冒出来,而且很难对上号。
 *
 * 模式名(confirm/default/trust)本身不翻译:它是 `/permission <mode>` 的参数,
 * 翻译过去用户就打不出来了。
 */
export function modeInfo(mode: PermissionMode): ModeInfo {
  switch (mode) {
    case "confirm":
      return { label: t.modeConfirm, hint: t.modeConfirmHint }
    case "default":
      return { label: t.modeDefault, hint: t.modeDefaultHint }
    case "trust":
      return { label: t.modeTrust, hint: t.modeTrustHint }
  }
}

export function isPermissionMode(value: string): value is PermissionMode {
  return (MODES as readonly string[]).includes(value)
}

/**
 * 用户敲的 / 配置里写的字 → 模式。认老名字,认不出来返回 undefined。
 *
 * 和 isPermissionMode 分成两个函数是刻意的:那个回答「这是不是一个现役模式名」
 * (提示信息里要列的那几个),这个回答「这串字该当成哪个模式」。合并的话,
 * `auto` 就会从某个「可选值有哪些」的提示里重新冒出来。
 */
export function normalizeMode(value: string): PermissionMode | undefined {
  const trimmed = value.trim().toLowerCase()
  if (isPermissionMode(trimmed)) return trimmed
  return ALIASES[trimmed]
}

/** 下一个模式。到头回到开头。 */
export function nextMode(mode: PermissionMode): PermissionMode {
  const at = MODES.indexOf(mode)
  return MODES[(at + 1) % MODES.length]!
}
