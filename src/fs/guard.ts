/**
 * 工作区越界守卫。
 *
 * M1 采取粗规则:不在工作区子树内一律拒绝,不做 opencode 那种
 * external_directory 二段授权。理由是本地开发机上没有任何沙盒兜底 ——
 * 同一台机器上有 ssh key、git 凭据、~/.aws,粗规则的误伤成本远低于漏放。
 *
 * fail closed:根目录推导失败时退化成 cwd,**绝不**退化成 "/"。
 */
import { realpathSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"

export class OutsideWorkspaceError extends Error {
  constructor(target: string, root: string) {
    super(
      `Refusing to access "${target}": outside the workspace root "${root}". ` +
        `Only paths inside the workspace are allowed.`,
    )
    this.name = "OutsideWorkspaceError"
  }
}

/**
 * 把路径解析成绝对路径并断言它在工作区内,返回解析后的绝对路径。
 *
 * 两道检查缺一不可:
 * 1. resolve 后的字面路径 —— 挡住 ../../etc/passwd
 * 2. realpath 后的真实路径 —— 挡住指向工作区外的符号链接
 *
 * 目标不存在时(要新建的文件)对**父目录**做 realpath 检查。
 */
export function assertInsideWorkspace(target: string, opts: { cwd: string; root: string }): string {
  const absolute = isAbsolute(target) ? resolve(target) : resolve(opts.cwd, target)
  const root = resolve(opts.root)

  if (!within(absolute, root)) throw new OutsideWorkspaceError(target, root)

  // 符号链接可能把路径指到工作区外面去
  const real = realpathOrParent(absolute)
  const realRoot = realpathSafe(root)
  if (!within(real, realRoot)) throw new OutsideWorkspaceError(target, root)

  return absolute
}

function within(path: string, root: string): boolean {
  if (path === root) return true
  const rel = relative(root, path)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * 目标存在就 realpath 目标;不存在就 realpath 它最近的存在的祖先,
 * 再把剩下的相对部分拼回去。
 */
function realpathOrParent(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // 向上找到第一个存在的祖先
    let probe = path
    const tail: string[] = []
    for (;;) {
      const parent = resolve(probe, "..")
      if (parent === probe) return path // 走到根都不存在,原样返回
      tail.unshift(probe.slice(parent.length + 1))
      probe = parent
      try {
        const realParent = realpathSync(probe)
        return resolve(realParent, ...tail)
      } catch {
        continue
      }
    }
  }
}
