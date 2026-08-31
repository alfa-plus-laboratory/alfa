/**
 * 对话缓冲。
 *
 * ── 为什么存「逻辑行」而不是「屏幕行」 ──
 * 全屏之后终端的滚动缓冲没了,折行得我们自己做。存屏幕行的话,一改窗口大小
 * 或者一折叠侧栏,历史就全按旧宽度僵在那儿。所以存的是没折过的逻辑行,
 * 折行发生在画的那一刻,按当时的宽度算。
 *
 * ── render.ts 一行都不用改 ──
 * 它对外只依赖 OutputSink(write + atLineStart)。这里就实现这个接口,
 * 于是「模型流式文本、工具卡片、diff、步骤统计」那一整套渲染逻辑原样复用。
 *
 * ── 折行结果要缓存 ──
 * 上千行 × 每帧重折 = 打字都卡。宽度没变时复用上一次的结果,只对新追加的
 * 那几行做增量。
 */
import type { OutputSink } from "../cli/live.ts"
import { theme } from "../cli/theme.ts"
import { displayWidth, splitAtWidth, stripAnsi, wrapToWidth } from "../cli/width.ts"

export class Transcript implements OutputSink {
  /**
   * 内容变了。宿主挂上它去要一帧。
   *
   * ★ 这个回调是**空闲时零重绘**的前提。原来界面靠一个 20Hz 的定时器无脑重画,
   *   理由正是"渲染器往这里写完没人通知" —— 于是一个整夜开着没人碰的窗口,
   *   也在一秒钟合成二十次完全一样的画面。谁改了内容谁喊一声,那个定时器就
   *   可以整个删掉(见 cli/main.ts 的 fullscreen_)。
   */
  onChange: (() => void) | undefined

  /** 没折过的逻辑行,一条对应一次 `write` 里的一段 \n 分隔内容 */
  private readonly logical: string[] = []
  /** 还没等到换行的半行 */
  private tail = ""

  private cacheWidth = -1
  private cache: string[] = []
  /** 缓存已经覆盖到第几条逻辑行(含 tail 时为 -1,表示尾部要重算) */
  private cachedCount = 0

  /** 从底部往上滚了多少屏幕行。0 = 跟着最新内容走。 */
  private scroll = 0
  private lastViewport = 0

  get atLineStart(): boolean {
    return this.tail.length === 0
  }

  get following(): boolean {
    return this.scroll === 0
  }

  /** 从底部往上翻了多少屏幕行。滚动条要靠它算滑块在哪。 */
  get offset(): number {
    return this.scroll
  }

  write(text: string): void {
    if (text.length === 0) return
    this.tail += text
    const parts = this.tail.split("\n")
    this.tail = parts.pop() ?? ""
    for (const line of parts) this.logical.push(line)
    this.onChange?.()
  }

  /**
   * 见 OutputSink.replaceTail。
   *
   * tail 可以是多行(markdown 攒表格的时候)。存的仍然是逻辑行,折行照旧
   * 发生在画的那一刻 —— 所以预览里的表格也会跟着窗口宽度重排。
   */
  replaceTail(committed: string[], tail: string): void {
    for (const line of committed) this.logical.push(line)
    this.tail = tail
    this.onChange?.()
  }

  /** 一整段直接进来(用户那句话、分隔线之类)。 */
  push(line: string): void {
    if (this.tail.length > 0) {
      this.logical.push(this.tail)
      this.tail = ""
    }
    this.logical.push(line)
    this.onChange?.()
  }

  clear(): void {
    this.logical.length = 0
    this.tail = ""
    this.cachedCount = 0
    this.cache = []
    this.scroll = 0
    this.onChange?.()
  }

  /** 当前宽度下一共有多少屏幕行。 */
  totalRows(width: number): number {
    return this.wrapped(width).length
  }

  /**
   * 取要显示的那一屏。
   *
   * 不够一屏时**顶在上面**而不是撑到底部 —— 刚开始聊两句就让它们悬在屏幕
   * 中间以下,看着像是上面丢了东西。
   */
  view(width: number, height: number): string[] {
    const rows = this.wrapped(width)
    this.lastViewport = height
    if (rows.length <= height) {
      this.scroll = 0
      return rows
    }
    const maxScroll = rows.length - height
    if (this.scroll > maxScroll) this.scroll = maxScroll
    const end = rows.length - this.scroll
    return rows.slice(end - height, end)
  }

  // ───────────────────────────────────────────── 滚动

  scrollBy(lines: number): void {
    this.scroll = Math.max(0, this.scroll + lines)
  }

  scrollPage(direction: -1 | 1): void {
    this.scrollBy(direction * Math.max(1, this.lastViewport - 1))
  }

  scrollToBottom(): void {
    this.scroll = 0
  }

  /** 直接滚到某个位置。参数仍然是「从底部往上翻了多少行」。 */
  scrollTo(offset: number): void {
    this.scroll = Math.max(0, offset)
  }

  scrollToTop(): void {
    // 具体上限在下一次 view() 里夹住,这里给个足够大的数就行
    this.scroll = Number.MAX_SAFE_INTEGER
  }

  // ───────────────────────────────────────────── 折行缓存

  private wrapped(width: number): string[] {
    if (width !== this.cacheWidth) {
      this.cacheWidth = width
      this.cache = []
      this.cachedCount = 0
    }
    // 只折新增的那些。tail 每来一个 token 就变,所以它不进缓存,每次单折
    for (let i = this.cachedCount; i < this.logical.length; i++) {
      this.cache.push(...wrapLine(this.logical[i]!, width))
    }
    this.cachedCount = this.logical.length

    if (this.tail.length === 0) return this.cache
    const tail: string[] = []
    // tail 可能是多行(markdown 攒着的表格),按逻辑行分别折
    for (const line of this.tail.split("\n")) tail.push(...wrapLine(line, width))
    return [...this.cache, ...tail]
  }
}

/**
 * 折一条逻辑行。
 *
 * 空行要保留成一行,不能被折行函数吃掉 —— 段落之间的呼吸全靠它,
 * 少了之后整片输出会糊成一坨。
 *
 * ── 悬挂缩进 ──
 * 一条长列表项折到第二行如果顶到第 0 列,读起来就不再是「一项」而是两段。
 * 所以续行统一缩进到内容的起始列。这件事放在**折行的时候**做而不是渲染的
 * 时候做,是因为只有这里知道当前宽度 —— 改窗口、收侧栏都会重来一遍。
 *
 * **导出**是因为活动区(chat/speech.ts)要折的是同一种东西 —— 同一个
 * markdown 渲染器的输出。两处各写一遍的话,同一段话在两个视图里会缩进得
 * 不一样,而用户会以为那是两份不同的内容。
 */
export function wrapLine(line: string, width: number): string[] {
  if (line.length === 0) return [""]
  if (displayWidth(line) <= width) return [line]

  const hang = hanging(line)
  // 缩进超过半个宽度就别悬挂了 —— 剩下的空间还不够放几个字,对齐的好处
  // 抵不过每行只剩两三个字符的难看
  if (!hang || hang.columns > Math.max(4, Math.floor(width / 2))) return wrapToWidth(line, width)

  const [head, rest] = splitAtWidth(line, hang.columns)
  const rows = wrapToWidth(rest, width - hang.columns)
  return rows.map((row, i) => (i === 0 ? head + row : hang.pad + row))
}

/**
 * 续行该缩进到哪一列、开头补什么。
 *
 * 只认**自己渲染出来的**那几种前缀,不去猜 markdown 原文:项目符号、序号、
 * 引用/代码块的竖线,以及纯缩进。diff 的 `-`/`+` 故意不在名单里 —— 它们和
 * 列表符号长得太像,而把一行 diff 当列表缩进会让人以为那行内容变了。
 */
function hanging(line: string): { columns: number; pad: string } | undefined {
  const plain = stripAnsi(line)
  const match = /^([ \t]*)(?:([•◦▪‣☐☑])[ ]|(\d{1,9}[.)])[ ]|((?:│[ ])+))?/.exec(plain)
  if (!match) return undefined
  const columns = displayWidth(match[0])
  if (columns === 0) return undefined

  const indent = " ".repeat(displayWidth(match[1] ?? ""))
  // 引用和代码块的竖线要在每一续行上接着画,不然折下来的那半段像是掉出了块外
  const bars = match[4]
  const pad = bars === undefined ? " ".repeat(columns) : indent + theme.dim("│ ".repeat(bars.length / 2))
  return { columns, pad }
}
