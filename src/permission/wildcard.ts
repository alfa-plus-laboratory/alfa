/**
 * 权限规则的通配匹配。
 *
 * 移植自 opencode packages/core/src/util/wildcard.ts(MIT,Copyright (c) 2025 opencode)。
 *
 * ⚠ 语义与 glob/gitignore **不同**,别混着写:
 *   - `*` 就是正则的 `.*`,**会跨 `/`**。所以 `src/*` 能匹配 `src/a/b/c.ts`。
 *   - `**` 与 `*` 完全等价(没有单独实现)。文档里写 `**` 只是给人看的。
 *
 * 尾部 " *" 的特判:`"git status *"` 应该也能匹配裸的 `"git status"`,
 * 否则用户批准了 `git status *` 之后,下一次不带参数的 `git status` 还要再问一遍。
 */

const ESCAPE = /[.+^${}()|[\]\\]/g

export function match(pattern: string, value: string): boolean {
  // 路径 pattern 用户可能写反斜杠,统一成正斜杠
  const normalizedPattern = pattern.replaceAll("\\", "/")
  const normalizedValue = value.replaceAll("\\", "/")

  let source = normalizedPattern.replace(ESCAPE, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")

  // "xxx .*" → "xxx( .*)?" ,让「带参数」和「不带参数」都命中
  if (source.endsWith(" .*")) source = source.slice(0, -3) + "( .*)?"

  return new RegExp(`^${source}$`, "s").test(normalizedValue)
}
