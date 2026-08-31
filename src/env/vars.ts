/**
 * 自己的那几个环境变量叫什么。
 *
 * 前缀是 `ALFA_`,和命令名、配置目录、项目里的 `.alfa/` 对齐 —— 之前它是
 * `APCODE_`(更早是 `AGENTPLUS_CODE_`),现在**都不认了**。旧名不做兼容是有意的:
 * 一个只在某几台老机器上还留着旧变量的程序,等于同时存在两套事实,而两套事实
 * 迟早会有人踩到中间那条缝。
 * 认不出来的旧配置就当没配过,和第一次装是同一种状态。
 *
 * 前缀只在这里出现一次。散在各处的话,下次改名就又是一轮 grep。
 */

/** 现在该写哪个前缀。提示文本里印的就是它 */
export const ENV_PREFIX = "ALFA_"

export type EnvSource = Record<string, string | undefined>

/**
 * 读一个自己的环境变量。传后缀(`MODEL`、`KEY_MINIMAX`),不带前缀。
 *
 * 空串按没设算:`ALFA_MODEL=` 表达的是"我不要它",而不是"模型名是空字符串"。
 */
export function readEnv(name: string, source: EnvSource = process.env): string | undefined {
  return source[ENV_PREFIX + name] || undefined
}

/** 这个变量设了没有;设了就返回它的全名。给「记不住,因为它被环境变量盖了」那句话用 */
export function envNameInUse(name: string, source: EnvSource = process.env): string | undefined {
  return source[ENV_PREFIX + name] ? ENV_PREFIX + name : undefined
}
