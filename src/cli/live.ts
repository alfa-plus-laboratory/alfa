/**
 * 钉在屏幕底部的活动区。
 *
 * ── 它不是全屏 TUI ──
 * 没有 alternate screen。已完成的输出照常提交进终端的滚动缓冲(所以你还能
 * 往上翻、能用鼠标选中复制、tmux 的 copy mode 也照常),只有最底下那几行是
 * 「活的」:每次变化就擦掉重画。输入框、状态行、spinner 都住在这几行里。
 *
 * 一帧的动作永远是三步:**擦掉活动区 → 往滚动区写 → 重画活动区**。
 * 任何绕过这个顺序直接往 stdout 写的代码,都会把画面从中间劈开。
 *
 * ── 为什么所有内容都折到 columns - 1 ──
 * 终端的自动换行有个「延迟换行」状态:写满最后一列时光标还停在那一列,
 * 等下一个字符才真的跳行。多数终端是这样,**但不是全部**。一旦某个终端选择
 * 立刻换行,同一行内容就占了两行,而我们按一行算 —— 擦除时往上退的行数就少
 * 了一行,于是活动区开始一帧一帧地往上啃已经打出去的输出,再也回不来。
 *
 * 永远不写到最后一列,这个歧义就根本不存在。代价是右边空一列,没人看得出来。
 */
import { displayWidth, truncateToWidth, wrapToWidth } from "./width.ts"

const HIDE_CURSOR = "\u001b[?25l"
const SHOW_CURSOR = "\u001b[?25h"
/** 同步输出:支持的终端会把这中间的写入攒成一帧,不支持的直接忽略。 */
const SYNC_BEGIN = "\u001b[?2026h"
const SYNC_END = "\u001b[?2026l"
const CLEAR_DOWN = "\u001b[0J"

/**
 * 渲染器只需要这么点能力。抽出来是为了让 Renderer 不必认识活动区 ——
 * 测试里塞一个收集字符串的假实现就行。
 */
export interface OutputSink {
  write(text: string): void
  /** 光标是不是停在行首(工具卡片必须从行首开始画) */
  readonly atLineStart: boolean
  /**
   * 提交若干整行,同时把「还没完成的那部分」**整个换成** tail(可以含换行)。
   *
   * markdown 要它:`**bo` 还不是粗体,`**bold**` 才是 —— 半行文本的样子会随着
   * 后面来的字符变,所以它不能一写下去就定死。而这件事本来就做得到:半行内容
   * 在两种 sink 里都是「每帧重画」的那部分,只是以前没人需要改它。
   *
   * 可选。没实现的 sink(纯管道)拿不到 markdown,直接走原样输出。
   */
  replaceTail?(committed: string[], tail: string): void
}

export interface LiveCursor {
  /** 在传进来的 lines 数组里的行号 */
  row: number
  /** 该行的显示列(不是 char 下标) */
  col: number
}

export interface LiveRegionOptions {
  output?: NodeJS.WriteStream
  /**
   * 关掉之后退化成「直接写 stdout」,一个转义序列都不发。
   * 管道、CI、--no-color 之外的非 TTY 场景都走这条 —— 那些地方发光标控制
   * 只会往日志里灌垃圾。
   */
  enabled?: boolean
  /**
   * 终端改大小时先叫一声。
   *
   * 光靠活动区自己重画不够 —— 它手上那几行是**上一个宽度**下折好的,原样
   * 重画等于把一个 100 列的框塞进 50 列的终端。真正要做的是让上层拿新宽度
   * 重新排一遍,所以这里必须回调出去。
   */
  onResize?(): void
}

export class LiveRegion {
  private readonly output: NodeJS.WriteStream
  private readonly enabled: boolean
  private readonly notifyResize: (() => void) | undefined

  /** 调用方给的活动区内容(已经由调用方按 width 折好) */
  private region: string[] = []
  private cursor: LiveCursor | undefined
  /** 滚动区里还没换行的半行 */
  private pending = ""

  /** 屏幕上当前这一帧的实际行数 */
  private painted: string[] = []
  /** 画完之后光标停在第几行(擦除时靠它算往上退多少) */
  private cursorRow = 0
  /** 以及第几列。只挪光标那种帧要靠它算增量 */
  private cursorCol = 0
  private suspended = false
  private closed = false

  constructor(options: LiveRegionOptions = {}) {
    this.output = options.output ?? process.stdout
    this.enabled = options.enabled ?? (this.output.isTTY === true)
    this.notifyResize = options.onResize
    if (this.enabled) this.output.on("resize", this.onResize)
  }

  get columns(): number {
    return Math.max(20, this.output.columns ?? 80)
  }

  get rows(): number {
    return Math.max(4, this.output.rows ?? 24)
  }

  /** 活动区内容可以用的宽度。留最后一列不写,见文件头。 */
  get width(): number {
    return this.columns - 1
  }

  get active(): boolean {
    return this.enabled && !this.suspended && !this.closed
  }

  // ───────────────────────────────────────────── 往滚动区写

  /**
   * 写进滚动区。可以是半行 —— 流式文本就是一个词一个词来的。
   *
   * 完整的行(以 \n 结尾的部分)提交进滚动缓冲,**从此不再重画**;剩下的
   * 半行留在 pending 里,跟活动区一起每帧重画,直到它等来自己的换行。
   */
  write(text: string): void {
    if (text.length === 0) return
    if (!this.active) {
      // 退化模式:直接写。pending 仍然要更新 —— atLineStart 靠它,
      // 而「工具卡片必须从行首开始画」这条规矩在管道输出里同样要守。
      this.output.write(text)
      const at = text.lastIndexOf("\n")
      this.pending = at === -1 ? this.pending + text : text.slice(at + 1)
      return
    }
    this.pending += text
    const parts = this.pending.split("\n")
    this.pending = parts.pop() ?? ""
    this.paint(parts)
  }

  /** 光标在不在行首。调用方要在这之前补换行时用得上。 */
  get atLineStart(): boolean {
    return this.pending.length === 0
  }

  /**
   * 见 OutputSink.replaceTail。
   *
   * 一次画完:提交 + 换半行合成一帧。拆成 write() 好几次的话,流式文本每来一个
   * token 就要全量重绘活动区好几遍,SSH 上肉眼可见地闪。
   */
  replaceTail(committed: string[], tail: string): void {
    if (!this.active) {
      // 退化模式(管道)下已经写出去的收不回来,所以半行只能等它定稿。
      // markdown 的缓冲留在上游,行凑齐了自然会作为 committed 送过来。
      for (const line of committed) this.output.write(line + "\n")
      this.pending = ""
      return
    }
    this.pending = tail
    this.paint(committed)
  }

  // ───────────────────────────────────────────── 活动区

  /**
   * 设置活动区内容并重画。
   *
   * `lines` 里的每一行**必须**已经折到不超过 this.width —— 这里不再折,
   * 因为光标坐标 (row, col) 是调用方按自己折出来的行算的,再折一次就对不上了。
   */
  set(lines: string[], cursor?: LiveCursor): void {
    if (!this.active) return
    this.region = lines
    this.cursor = cursor
    this.paint([])
  }

  clear(): void {
    if (!this.active) return
    this.region = []
    this.cursor = undefined
    this.paint([])
  }

  /**
   * 直接发一段控制序列(清屏这类)。先擦活动区,发完重画。
   * 发完之后屏幕状态由那段序列决定,所以要把「上一帧画了什么」忘掉。
   */
  passthrough(sequence: string): void {
    if (!this.active) return
    this.erase()
    this.pending = ""
    this.output.write(sequence)
    this.paint([])
  }

  /**
   * 暂时让出屏幕(权限确认框这类要自己接管画面的场景)。
   * 挂起期间 write() 直接落到滚动区,不再有活动区。
   */
  suspend(): void {
    if (!this.enabled || this.suspended) return
    this.erase()
    this.flushPending()
    this.suspended = true
  }

  resume(): void {
    if (!this.enabled || !this.suspended) return
    this.suspended = false
    this.paint([])
  }

  /**
   * 退出前必须调。擦掉活动区、把半行冲出去、把光标交还给 shell。
   * 漏了的话,用户回到提示符时上面还挂着一个画了一半的输入框。
   */
  close(): void {
    if (this.closed) return
    if (this.enabled) {
      this.output.off("resize", this.onResize)
      if (!this.suspended) this.erase()
      this.flushPending()
      this.output.write(SHOW_CURSOR)
    } else if (this.pending.length > 0) {
      this.output.write("\n")
      this.pending = ""
    }
    this.closed = true
  }

  // ───────────────────────────────────────────── 内部

  private flushPending(): void {
    if (this.pending.length === 0) return
    this.output.write(this.pending + "\n")
    this.pending = ""
  }

  /**
   * 一帧。committed 是这一帧要提交进滚动区的完整行。
   *
   * 内容没变就什么都不发 —— spinner 每 100ms 跑一次,不做这个判断的话
   * 每秒十次全量重绘,慢终端(SSH)上肉眼可见地闪。
   */
  private paint(committed: string[]): void {
    const block = this.buildBlock()
    const target = this.cursorTarget(block)

    if (committed.length === 0 && sameLines(block, this.painted)) {
      // ⚠ 去重不能只比内容。←/→ 一个字都不改,只挪插入点 —— 只比内容的话
      //   整帧被跳过,移动序列根本没发出去:逻辑光标动了,屏幕光标没动,
      //   于是下一个字"凭空"插到别处。这个 bug 平时看不出来,一用方向键就露。
      if (target.row === this.cursorRow && target.col === this.cursorCol) return
      // 内容既然没变就别重画整个框,发一小段增量移动就够了
      this.output.write(SYNC_BEGIN + this.moveWithin(target) + SYNC_END)
      this.cursorRow = target.row
      this.cursorCol = target.col
      return
    }

    let out = SYNC_BEGIN + HIDE_CURSOR + this.eraseSequence()
    for (const line of committed) out += line + "\n"

    out += block.join("\n")
    this.painted = block

    // 光标:优先放到调用方指定的位置(输入框里的插入点),
    // 没指定就留在最后一行末尾
    out += moveTo(block.length - 1, target)
    this.cursorRow = target.row
    this.cursorCol = target.col

    out += SHOW_CURSOR + SYNC_END
    this.output.write(out)
  }

  /**
   * 这一帧屏幕底部要显示的所有行:半行 + 活动区。
   *
   * 装不下时从**上面**开始丢。输入框必须完整可见,宁可看不到流式文本的开头 ——
   * 那部分马上就会提交进滚动区,往上翻就有。
   */
  private buildBlock(): string[] {
    const width = this.width
    const head = this.pending.length > 0 ? wrapToWidth(this.pending, width) : []
    // 兜底裁一刀。调用方本该保证每行都不超宽(见 set() 的注释),但漏一处的
    // 后果不是「难看一点」,是超出的部分被终端自动换行、行数算少、下一帧
    // 擦除往上退错 —— 界面从此开始烂。裁掉只是难看,那是划算得多的失败方式。
    const block = [...head, ...this.region.map((line) => truncateToWidth(line, width))]
    const max = this.rows - 1
    return block.length > max ? block.slice(block.length - max) : block
  }

  private cursorTarget(block: string[]): LiveCursor {
    const last = Math.max(0, block.length - 1)
    if (!this.cursor) return { row: last, col: displayWidth(block[last] ?? "") }
    // 活动区在 block 里的偏移 = 前面那些 pending 行
    const offset = block.length - this.region.length
    const row = Math.min(last, Math.max(0, offset + this.cursor.row))
    return { row, col: Math.min(this.cursor.col, this.width) }
  }

  private eraseSequence(): string {
    if (this.painted.length === 0) return ""
    let out = "\r"
    if (this.cursorRow > 0) out += `\u001b[${this.cursorRow}A`
    return out + CLEAR_DOWN
  }

  private erase(): void {
    const sequence = this.eraseSequence()
    if (sequence.length > 0) this.output.write(sequence)
    this.painted = []
    this.cursorRow = 0
    this.cursorCol = 0
  }

  /** 内容没变、只是光标挪了位置时发的那一小段。 */
  private moveWithin(target: LiveCursor): string {
    let out = ""
    const delta = target.row - this.cursorRow
    if (delta < 0) out += `\u001b[${-delta}A`
    else if (delta > 0) out += `\u001b[${delta}B`
    // 先回行首再往右数,别拿当前列做增量 —— 双宽字符会让两边的列算法不一致
    out += "\r"
    if (target.col > 0) out += `\u001b[${target.col}C`
    return out
  }

  /**
   * 终端改大小。
   *
   * 老内容已经被终端按新宽度重排过了,我们记的行数不再可信 —— 没有可移植的
   * 办法问出「刚才那几行现在占几行」。这里按记的行数尽力擦一次:多数情况下
   * 干净,极端情况(缩窄到内容翻倍)会留一帧残影,下一次输出就冲掉了。
   * 比起为它引入一个全屏 TUI,这个代价划算。
   */
  private readonly onResize = (): void => {
    if (!this.active) return
    this.erase()
    // 先让上层按新宽度重排(它会调 set(),那次调用顺带就画了)
    this.notifyResize?.()
    this.paint([])
  }
}

function moveTo(fromRow: number, target: LiveCursor): string {
  let out = "\r"
  const up = fromRow - target.row
  if (up > 0) out += `\u001b[${up}A`
  if (target.col > 0) out += `\u001b[${target.col}C`
  return out
}

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
