/**
 * 工作区根推导。
 *
 * fail closed:找不到 git 仓库时退化成 cwd,**绝不**退化成 "/" 或 home。
 * 这个返回值直接就是越界守卫的边界,退化错方向等于把整台机器打开。
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve, sep } from "node:path"

/** 从 start 向上找 .git,找到就返回那一层;找不到返回 resolve(start)。 */
export function findWorkspaceRoot(start: string): string {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir
    const parent = resolve(dir, "..")
    if (parent === dir) return resolve(start) // 走到文件系统根都没找到
    dir = parent
  }
}

export function isGitRepo(dir: string): boolean {
  return existsSync(join(resolve(dir), ".git"))
}

/**
 * 工作区在界面上的两种叫法。
 *
 * 全屏界面里一度**没有任何一处常驻**写着"这是哪":启动横幅写了 cwd,但它进的
 * 是瀑布流 —— session 视图下根本不显示,stream 视图下也会被对话顶走。同时开着
 * 三个终端的时候,"我这句话要落在哪个仓库上"只能靠猜,而猜错的代价是 agent
 * 在错的仓库里动手。
 */
export interface WorkspaceLabel {
  /** 根目录名。给文件树标题用 —— 那棵树画的就是它。根是 "/" 时为空串 */
  name: string
  /** 完整路径,home 折成 `~`。给状态行用 */
  path: string
}

/**
 * root 给名字,cwd 给路径。
 *
 * 路径取 cwd 而不是 root:两者不同的时候(在子目录里启动),cwd 才是"我在哪",
 * 而 root 那一段本来就是这条路径的前缀 —— 树的标题正好指出它是哪一节。
 */
export function workspaceLabel(root: string, cwd: string = root): WorkspaceLabel {
  return { name: basename(root), path: homePath(cwd) }
}

/**
 * home 底下的路径折成 `~/…`。
 *
 * 状态行只有一行,而 `/Users/someone` 这一截在同一台机器上每个路径都一样 ——
 * 它挤掉的全是真正能区分出"这是哪个项目"的部分。
 */
export function homePath(path: string): string {
  const home = homedir()
  if (home.length === 0) return path
  if (path === home) return "~"
  return path.startsWith(home + sep) ? "~" + path.slice(home.length) : path
}
