/**
 * 权限 pattern 的规范形式。
 *
 * ⚠ 这是个容易写错的地方,写错了规则会**静默失效**(不报错,只是永远不命中)。
 *
 * 规则:文件类 permission 的 pattern 一律用**工作区相对路径**,不是绝对路径。
 * 两个理由:
 *   1. 通配匹配是拿整条 pattern 去比的。用绝对路径的话,`*.env` 这种规则必须
 *      写成 `*​/*.env` 才命中,而 `.envrc`、`id_rsa*` 这类不带前导 `*` 的规则
 *      **永远不会命中** —— 静默失效,最危险的一类 bug。
 *   2. 用户写配置时 `src/*` 才符合直觉,不用关心仓库在磁盘哪儿。
 *
 * 绝对路径仍然要传给 UI 展示,放在 metadata 里,不要放进 patterns。
 */
import { isAbsolute, relative } from "node:path"

/** 绝对路径 → 工作区相对路径。越界的(理论上已被守卫拦掉)退回绝对路径。 */
export function workspacePattern(absolute: string, root: string): string {
  const rel = relative(root, absolute)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return absolute
  return rel
}
