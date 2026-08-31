/**
 * 左栏:文件树。
 *
 * ── 懒加载 ──
 * 只在展开某个目录时才 readdir。一进来就递归整个仓库的话,node_modules 那种
 * 目录能让启动卡好几秒,而且绝大部分节点用户永远不会看。
 *
 * ── 忽略规则交给 git ──
 * 自己解析 .gitignore 是个无底洞(否定规则、目录锚定、嵌套 .gitignore)。
 * 这里跑一次 `git ls-files --others --ignored --exclude-standard --directory`,
 * 拿到的是**已折叠到目录**的忽略列表,通常几十行,一次就够。不是 git 仓库时
 * 退回一张写死的小名单。
 *
 * ── git 状态不在渲染路径上算 ──
 * 渲染每帧都跑,子进程不能在那儿起。状态是异步刷进来的一张表,画的时候只查表。
 */
import { readdirSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import { theme } from "../../cli/theme.ts"
import { displayWidth, truncateToWidth } from "../../cli/width.ts"
import { attachScrollbar, offsetForRow, scrollbarColumn } from "../scrollbar.ts"

/** 不是 git 仓库时的兜底名单。宁可少藏也别藏错,用户看不到文件会以为是 bug。 */
const ALWAYS_HIDE = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".DS_Store"])

export interface TreeNode {
  name: string
  /** 绝对路径 */
  path: string
  dir: boolean
  depth: number
  expanded: boolean
  /** undefined = 还没读过 */
  children?: TreeNode[]
}

export class TreePane {
  private readonly root: string
  private nodes: TreeNode[] = []
  private rows: TreeNode[] = []
  private selected = 0
  private scroll = 0
  private status = new Map<string, string>()
  /** 里面有改动的目录 */
  private dirty = new Set<string>()
  private ignored = new Set<string>()
  private error: string | undefined
  /**
   * 画的时候要不要把选中项拉回视野。
   *
   * 只有**键盘动过选中项**才为真。永远为真的话,滚轮和滚动条都等于没有:
   * 手滚到别处,下一帧又被拽回选中项那里 —— 而用户根本没动选中项。
   */
  private follow = true

  constructor(root: string) {
    this.root = root
    this.reload()
  }

  get selectedNode(): TreeNode | undefined {
    return this.rows[this.selected]
  }

  /** 整棵推倒重建。只有构造时用 —— 它会把展开状态全丢掉。 */
  reload(): void {
    try {
      this.nodes = this.read(this.root, 0)
      this.error = undefined
    } catch (cause) {
      this.nodes = []
      this.error = (cause as Error).message
    }
    this.flatten()
  }

  /**
   * 重新扫盘,**保住展开状态和选中项**。
   *
   * agent 写完一个新文件之后要能立刻在树里看到。之前这里直接走 reload(),
   * 结果是:用户展开着的 lib/ 当场collapse回去,新文件反而被藏进了刚收起来
   * 的目录里 —— 看上去就是"什么都没发生"。
   *
   * 而且**不能依赖 git**。之前刷新只挂在 refreshGit() 里、且只在 git 命令
   * 成功时才执行,于是在非 git 目录下这棵树从启动那一刻起就永久冻结。
   */
  refresh(): void {
    const keep = this.selectedNode?.path
    try {
      this.nodes = this.merge(this.root, 0, this.nodes)
      this.error = undefined
    } catch (cause) {
      this.error = (cause as Error).message
    }
    this.flatten()
    if (keep === undefined) return
    const at = this.rows.findIndex((node) => node.path === keep)
    if (at !== -1) this.selected = at
  }

  /** 新扫出来的一层,套上老的展开状态;展开着的目录递归往下合。 */
  private merge(dir: string, depth: number, previous: TreeNode[]): TreeNode[] {
    const fresh = this.read(dir, depth)
    const byPath = new Map(previous.map((node) => [node.path, node]))
    for (const node of fresh) {
      const old = byPath.get(node.path)
      if (!old?.dir || !node.dir || !old.expanded) continue
      node.expanded = true
      node.children = this.merge(node.path, depth + 1, old.children ?? [])
    }
    return fresh
  }

  /** 异步刷新 git 状态和忽略列表。启动时和每轮结束后各来一次。 */
  async refreshGit(): Promise<void> {
    const [status, ignored] = await Promise.all([
      run(["git", "status", "--porcelain=v1", "--untracked-files=normal"], this.root),
      run(["git", "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], this.root),
    ])

    if (status !== undefined) {
      const next = new Map<string, string>()
      for (const line of status.split("\n")) {
        if (line.length < 4) continue
        // porcelain v1:前两列是索引/工作区状态,第 4 列起是路径
        const mark = (line[0] !== " " && line[0] !== "?" ? line[0] : line[1]) ?? " "
        const path = line.slice(3).replace(/^"|"$/g, "")
        // 重命名是 "old -> new",要的是新名字
        const arrow = path.indexOf(" -> ")
        next.set(join(this.root, arrow === -1 ? path : path.slice(arrow + 4)), mark)
      }
      this.status = next
      // 祖先目录也标一下。目录收起来的时候,里面改了什么完全看不出来 ——
      // agent 刚写了个文件、而它在一个折叠的目录里,用户会以为没写成。
      this.dirty = new Set()
      for (const path of next.keys()) {
        let parent = dirname(path)
        while (parent.startsWith(this.root) && parent !== this.root) {
          this.dirty.add(parent)
          parent = dirname(parent)
        }
      }
    }

    if (ignored !== undefined) {
      this.ignored = new Set(
        ignored
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => join(this.root, line.replace(/\/$/, ""))),
      )
    }
    // 不管 git 在不在、成不成功,都要重扫一遍盘
    this.refresh()
  }

  // ───────────────────────────────────────────── 结构

  private read(dir: string, depth: number): TreeNode[] {
    const entries = readdirSync(dir, { withFileTypes: true })
    const out: TreeNode[] = []
    for (const entry of entries) {
      if (ALWAYS_HIDE.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (this.ignored.has(path)) continue
      out.push({ name: entry.name, path, dir: entry.isDirectory(), depth, expanded: false })
    }
    // 目录在前,各自按名字排 —— 混在一起找目录要一行行扫
    return out.toSorted((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  }

  private flatten(): void {
    const rows: TreeNode[] = []
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        rows.push(node)
        if (node.dir && node.expanded && node.children) walk(node.children)
      }
    }
    walk(this.nodes)
    this.rows = rows
    if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1)
  }

  toggle(node: TreeNode): void {
    if (!node.dir) return
    if (!node.expanded && node.children === undefined) {
      try {
        node.children = this.read(node.path, node.depth + 1)
      } catch {
        node.children = [] // 没权限的目录:展开成空,不要让整棵树炸掉
      }
    }
    node.expanded = !node.expanded
    this.flatten()
  }

  /** 把某个文件在树里定位出来:逐级展开并选中。找不到就不动。 */
  reveal(path: string): boolean {
    const rel = relative(this.root, path)
    if (rel.startsWith("..") || rel.length === 0) return false
    let nodes = this.nodes
    let walked = this.root
    for (const part of rel.split(sep)) {
      walked = join(walked, part)
      const node = nodes.find((n) => n.path === walked)
      if (!node) return false
      if (node.dir) {
        if (!node.expanded) this.toggle(node)
        nodes = node.children ?? []
      }
    }
    this.flatten()
    const at = this.rows.findIndex((n) => n.path === path)
    if (at === -1) return false
    this.selected = at
    this.follow = true
    return true
  }

  // ───────────────────────────────────────────── 交互

  move(delta: number): void {
    if (this.rows.length === 0) return
    this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + delta))
    this.follow = true
  }

  /** 返回要在右栏打开的文件路径(选中的是目录时返回 undefined)。 */
  activate(): string | undefined {
    const node = this.selectedNode
    if (!node) return undefined
    if (node.dir) {
      this.toggle(node)
      return undefined
    }
    return node.path
  }

  collapse(): void {
    const node = this.selectedNode
    if (!node) return
    this.follow = true
    if (node.dir && node.expanded) return this.toggle(node)
    // 已经收起来了(或本来就是文件)就跳到父目录 —— 这是树形控件的通行手感
    const parent = this.rows.findLastIndex((n, i) => i < this.selected && n.depth < node.depth)
    if (parent !== -1) this.selected = parent
  }

  /** 点在第几行(相对面板顶部)。返回是否命中。 */
  clickAt(row: number): boolean {
    const at = this.scroll + row
    if (at < 0 || at >= this.rows.length) return false
    this.selected = at
    return true
  }

  scrollBy(lines: number): void {
    // 手动滚了就别再把选中项拽回来 —— 那是用户在看别处
    this.follow = false
    this.scroll = Math.max(0, this.scroll + lines)
  }

  /** 在滚动条上点/拖到第 row 行(相对面板顶部)。 */
  scrubTo(row: number, height: number): void {
    this.follow = false
    this.scroll = offsetForRow(row, { total: this.rows.length, height })
  }

  // ───────────────────────────────────────────── 画

  render(width: number, height: number, focused: boolean): string[] {
    if (this.error) return [theme.red(truncateToWidth(`  ! ${this.error}`, width))]
    if (this.rows.length === 0) return [theme.dim("  (empty)")]

    // 键盘动过选中项才把它拉回视野;滚轮/滚动条滚出去的不算(见 follow)
    if (this.follow) {
      if (this.selected < this.scroll) this.scroll = this.selected
      if (this.selected >= this.scroll + height) this.scroll = this.selected - height + 1
      this.follow = false
    }
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.rows.length - height)))

    // 最右边那一列永远留给滚动条(见 scrollbar.ts:留着不画,才不会一滚就重排)
    const inner = Math.max(1, width - 1)
    const out: string[] = []
    for (let i = 0; i < height; i++) {
      const node = this.rows[this.scroll + i]
      if (!node) {
        out.push("")
        continue
      }
      out.push(this.row(node, this.scroll + i === this.selected && focused, inner))
    }
    return attachScrollbar(out, scrollbarColumn({ total: this.rows.length, height, offset: this.scroll }), width)
  }

  private row(node: TreeNode, selected: boolean, width: number): string {
    const indent = " ".repeat(Math.min(node.depth * 2, Math.max(0, width - 8)))
    const arrow = node.dir ? (node.expanded ? "▾ " : "▸ ") : "  "
    const mark = this.status.get(node.path) ?? (node.dir && !node.expanded && this.dirty.has(node.path) ? "•" : undefined)

    // 名字要给状态标记和左边的一格留位置
    const room = width - displayWidth(indent) - 2 - (mark ? 2 : 0) - 1
    const name = truncateToWidth(node.name, Math.max(1, room))

    const painted = node.dir ? theme.blue(name) : mark ? statusColor(mark)(name) : name
    const body = ` ${indent}${theme.dim(arrow)}${painted}`
    const pad = width - displayWidth(body) - (mark ? 2 : 0)
    const tail = mark ? statusColor(mark)(mark) + " " : ""
    const line = body + " ".repeat(Math.max(0, pad)) + tail
    return selected ? theme.inverse(line) : line
  }
}

function statusColor(mark: string): (text: string) => string {
  if (mark === "M") return theme.yellow
  if (mark === "A") return theme.green
  if (mark === "D") return theme.red
  if (mark === "?") return theme.dim
  return theme.cyan
}

/** 跑一条只读命令拿输出。失败(不是仓库、没装 git)一律返回 undefined。 */
async function run(command: string[], cwd: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const text = await new Response(proc.stdout).text()
    const code = await proc.exited
    return code === 0 ? text : undefined
  } catch {
    return undefined
  }
}
