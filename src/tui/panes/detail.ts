/**
 * 右栏:跟着最近一次工具调用走。
 *
 *   read        → 文件内容(带行号)
 *   edit/write  → diff
 *   bash        → 输出
 *   grep/glob   → 命中的行
 *   树里点文件  → 文件内容
 *
 * ── 一条规则,不做「智能」 ──
 * 永远显示**最后发生的那件事**。做成猜用户现在想看什么的话,它会在你正读到
 * 一半时自己跳走,而你不知道为什么。要停住就锁定,锁了就不再自动跟。
 *
 * ── diff 和中间栏共用一份上色 ──
 * 见 render.ts 的 diffLines。两处各写一遍迟早会在边角上分叉,而用户会以为
 * 那是两份不同的东西。
 */
import { readFileSync, statSync } from "node:fs"
import { relative } from "node:path"
import { Highlighter, languageFor } from "../../cli/highlight.ts"
import { diffLines } from "../../cli/render.ts"
import { theme } from "../../cli/theme.ts"
import { t } from "../../i18n/index.ts"
import { displayWidth, truncateToWidth, wrapToWidth } from "../../cli/width.ts"
import { attachScrollbar, offsetForRow, scrollbarColumn } from "../scrollbar.ts"

/** 超过这个大小不往右栏塞 —— 读一个 50MB 的日志会把界面卡死 */
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_LINES = 20_000
/**
 * 超过这么多行就不高亮了。
 *
 * 高亮是一次性的(结果进缓存),但一次也要花时间 —— 两万行的生成文件会让
 * 打开它的那一帧明显卡一下。真要读那种文件的人也不是靠颜色读的。
 */
const MAX_HIGHLIGHT_LINES = 5_000
/** 判定二进制看有没有 NUL。写成码位,别在源码里放裸字节 —— 那玩意在 diff 里是隐形的。 */
const NUL = String.fromCharCode(0)

export type Detail =
  | { kind: "empty" }
  | { kind: "file"; path: string }
  | { kind: "diff"; path: string; patch: string }
  | { kind: "text"; title: string; body: string; tone?: "plain" | "error" }

export class DetailPane {
  private readonly root: string
  private detail: Detail = { kind: "empty" }
  /** 锁住之后不再跟随工具调用 */
  private locked = false
  private scroll = 0
  /** 内容还在长的时候(bash 实时输出)把视口钉在底部 */
  private pinned = false
  /** 渲染结果按宽度缓存 —— 每帧重读文件重折行是不可接受的 */
  private cache: { key: string; width: number; lines: string[] } | undefined

  constructor(root: string) {
    this.root = root
  }

  get lockedToContent(): boolean {
    return this.locked
  }

  get title(): string {
    switch (this.detail.kind) {
      case "empty":
        return t.paneDetail
      case "file":
        return this.short(this.detail.path)
      case "diff":
        return `${this.short(this.detail.path)}  diff`
      case "text":
        return this.detail.title
    }
  }

  /** 工具调用推过来的。锁住时忽略。 */
  follow(detail: Detail): void {
    if (this.locked) return
    this.set(detail)
  }

  /** 用户主动要看的(点树、按键)。锁住也照切 —— 这是显式意图。 */
  set(detail: Detail): void {
    this.detail = detail
    this.scroll = 0
    this.pinned = false
    this.cache = undefined
  }

  /**
   * 还在长的内容(bash 的实时输出)。
   *
   * 和 set() 的区别只有一个:同一份内容持续追加时**视口钉在底部**。
   * 每次都 scroll = 0 的话,用户看到的永远是命令刚开始那几行,而真正在变的
   * 是末尾 —— 那等于没有实时输出。
   */
  stream(title: string, body: string): void {
    if (this.locked) return
    const same = this.detail.kind === "text" && this.detail.title === title
    this.detail = { kind: "text", title, body }
    this.cache = undefined
    if (same) {
      // 保持当前的跟随状态。无条件重新钉底的话,用户往上翻着看历史输出,
      // 下一个 chunk 一到就被拽回底部 —— 长命令跑起来时等于没法读。
      return
    }
    this.scroll = 0
    this.pinned = true
  }

  toggleLock(): void {
    this.locked = !this.locked
  }

  scrollBy(lines: number): void {
    // 用户一动手就取消自动跟随 —— 正翻着历史输出被拽回底部是最气人的
    this.pinned = false
    this.scroll = Math.max(0, this.scroll + lines)
  }

  scrollToTop(): void {
    this.pinned = false
    this.scroll = 0
  }

  /** 在滚动条上点/拖到第 row 行(相对面板顶部)。 */
  scrubTo(row: number, width: number, height: number): void {
    this.pinned = false
    this.scroll = offsetForRow(row, { total: this.lines(Math.max(1, width - 1)).length, height })
  }

  render(width: number, height: number): string[] {
    // 最右边那一列留给滚动条。**内容一开始就按窄一列排**,不是等滚动条出现
    // 才让位 —— 那样每次内容长过一屏,整块代码/diff 会重排一次
    const inner = Math.max(1, width - 1)
    const lines = this.lines(inner)
    const maxScroll = Math.max(0, lines.length - height)
    if (this.pinned) this.scroll = maxScroll
    if (this.scroll > maxScroll) this.scroll = maxScroll
    const slice = lines.slice(this.scroll, this.scroll + height)
    while (slice.length < height) slice.push("")
    return attachScrollbar(slice, scrollbarColumn({ total: lines.length, height, offset: this.scroll }), width)
  }

  /** 还有多少行在视野外(状态行要提示)。宽度按内容区算 —— 和 render 同一口径 */
  overflow(width: number, height: number): number {
    return Math.max(0, this.lines(Math.max(1, width - 1)).length - height)
  }

  // ───────────────────────────────────────────── 内容

  private lines(width: number): string[] {
    const key = cacheKey(this.detail)
    if (this.cache && this.cache.key === key && this.cache.width === width) return this.cache.lines
    const lines = this.build(width)
    this.cache = { key, width, lines }
    return lines
  }

  private build(width: number): string[] {
    switch (this.detail.kind) {
      case "empty":
        return [
          "",
          theme.dim(`  ${t.detailNothing}`),
          "",
          theme.dim(`  ${t.detailFollowsWhat}`),
          theme.dim(`    ${t.detailMapRead}`),
          theme.dim(`    ${t.detailMapEdit}`),
          theme.dim(`    ${t.detailMapBash}`),
          "",
          theme.dim(`  ${t.detailPickFile}`),
        ]
      case "file":
        return this.fileLines(this.detail.path, width)
      case "diff":
        return clip(diffLines(this.detail.patch, this.root), width)
      case "text": {
        const painted = this.detail.tone === "error" ? theme.red : (text: string) => text
        return stripMachineTrailer(this.detail.body)
          .split("\n")
          .flatMap((line) => wrapToWidth(painted(line), Math.max(1, width - 1)))
          .map((line) => " " + line)
      }
    }
  }

  private fileLines(path: string, width: number): string[] {
    let text: string
    try {
      const size = statSync(path).size
      if (size > MAX_FILE_BYTES) {
        return [theme.dim(`  ${t.detailTooLarge(this.short(path), (size / 1024 / 1024).toFixed(1))}`)]
      }
      text = readFileSync(path, "utf8")
    } catch (cause) {
      return [theme.red(truncateToWidth(`  ! ${(cause as Error).message}`, width))]
    }
    // 二进制糊在终端上会把光标状态搞乱,里面的字节还可能被当成转义序列执行
    if (text.includes(NUL)) return [theme.dim(`  ${t.detailBinary}`)]

    const rows = text.split("\n").slice(0, MAX_LINES)
    const gutter = String(rows.length).length
    // 高亮整份文件、而不是可见的那一屏:块注释和多行字符串跨行,只看窗口里那
    // 几行根本不知道自己在不在注释里。整份只算一次 —— 这里的结果按
    // (路径, mtime, 宽度) 缓存,滚动不会重算
    const painter = rows.length <= MAX_HIGHLIGHT_LINES ? new Highlighter(languageFor(path)) : undefined
    return rows.map((line, i) => {
      const number = theme.dim(String(i + 1).padStart(gutter))
      // 先展 tab 再高亮:高亮只加 SGR 不改宽度,顺序反了列号就对不上
      const body = line.replaceAll("\t", "  ")
      const painted = painter ? painter.line(body) : body
      return ` ${number} ${truncateToWidth(painted, Math.max(1, width - gutter - 3))}`
    })
  }

  private short(path: string): string {
    const rel = relative(this.root, path)
    return rel.length === 0 || rel.startsWith("..") ? path : rel
  }
}

/**
 * 去掉给模型看的机读尾巴。
 *
 * bash 工具的输出末尾会挂一行 `<meta exit="0" duration="…" />` —— 那是给模型
 * 读的,同样的信息在工具卡片上已经以人话写了一遍。留在右栏里纯属噪音,而且
 * 会让人以为命令真的输出了这么一行。
 */
function stripMachineTrailer(body: string): string {
  return body.replace(/\n*^<meta\b[^\n]*\/>\s*$/m, "")
}

function clip(lines: string[], width: number): string[] {
  return lines.map((line) => " " + (displayWidth(line) > width - 1 ? truncateToWidth(line, width - 1) : line))
}

/** 缓存键。文件被改过要重读,所以把 mtime 也带上。 */
function cacheKey(detail: Detail): string {
  switch (detail.kind) {
    case "empty":
      return "empty"
    case "file":
      try {
        return `file:${detail.path}:${statSync(detail.path).mtimeMs}`
      } catch {
        return `file:${detail.path}:missing`
      }
    case "diff":
      return `diff:${detail.path}:${detail.patch.length}`
    case "text":
      return `text:${detail.title}:${detail.body.length}`
  }
}
