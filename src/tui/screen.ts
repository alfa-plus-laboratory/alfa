/**
 * 全屏合成器。字符网格 + 差分刷新。
 *
 * ── 为什么必须差分 ──
 * 三栏 200x50 是一万个单元格。流式输出时每来一个 token 就全量重画一次,
 * 每帧几十 KB —— 本地勉强,SSH 上直接爬。所以这里维护上一帧的网格,
 * 只把变了的那几段发出去。静止画面下一个字节都不发。
 *
 * ── 面板不认识网格 ──
 * 面板只管产出「一行行带颜色的字符串」,由 blit() 负责裁剪、补齐、拆成单元格。
 * 这样面板代码和之前写活动区时长得一模一样,width.ts / theme.ts 全都能直接用。
 *
 * ── 宽字符占两格 ──
 * 「中」占两个单元格,后一格是延续格。差分时任何一半变了都要从前半格重画,
 * 否则会画出半个字 —— 那之后整行的列都是错位的。
 *
 * ── 退出必须还原 ──
 * alternate screen 进去了没出来,用户回到 shell 时屏幕是花的,而且看不到自己
 * 敲的字。所以 leave() 挂在所有退出路径上,包括未捕获异常和信号。
 */
import { charWidth } from "../cli/width.ts"

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface Cell {
  ch: string
  style: string
  /** 宽字符的后半格。它自己不画,重画时要连着前半格一起 */
  cont: boolean
}

const BLANK: Cell = { ch: " ", style: "", cont: false }

const ENTER_ALT = "\u001b[?1049h"
const LEAVE_ALT = "\u001b[?1049l"
const HIDE_CURSOR = "\u001b[?25l"
const SHOW_CURSOR = "\u001b[?25h"
const SYNC_BEGIN = "\u001b[?2026h"
const SYNC_END = "\u001b[?2026l"
const CLEAR_ALL = "\u001b[2J"
const RESET = "\u001b[0m"
/** 把滚动区还原成整屏。外部程序设歪过它的话,我们的行号从此全是错的 */
const RESET_SCROLL = "\u001b[r"

export class Screen {
  private readonly output: NodeJS.WriteStream
  private front: Cell[][] = []
  private back: Cell[][] = []
  private cursor: { x: number; y: number } | undefined
  private lastCursor: { x: number; y: number } | undefined
  private entered = false
  /** 下一帧全画,不做差分(进场、清屏、改大小之后) */
  private dirty = true

  width = 0
  height = 0

  constructor(output: NodeJS.WriteStream = process.stdout) {
    this.output = output
    this.resize()
  }

  enter(): void {
    if (this.entered) return
    this.entered = true
    this.output.write(ENTER_ALT + HIDE_CURSOR + CLEAR_ALL)
    this.dirty = true
  }

  leave(): void {
    if (!this.entered) return
    this.entered = false
    this.output.write(RESET + SHOW_CURSOR + LEAVE_ALT)
  }

  /** 重新读终端尺寸。变了返回 true。 */
  resize(): boolean {
    const width = Math.max(20, this.output.columns ?? 80)
    const height = Math.max(6, this.output.rows ?? 24)
    if (width === this.width && height === this.height && this.back.length > 0) return false
    this.width = width
    this.height = height
    this.front = grid(width, height)
    this.back = grid(width, height)
    // 尺寸变了之后 front 完全不可信 —— 终端自己怎么重排的我们不知道
    this.dirty = true
    return true
  }

  /** 清掉后台缓冲,准备画新一帧。 */
  begin(): void {
    for (const row of this.back) {
      for (let x = 0; x < row.length; x++) row[x] = BLANK
    }
    this.cursor = undefined
  }

  /**
   * 把一组带颜色的行画进一块矩形。超出的裁掉,不够的用空格补满 ——
   * 补满是必须的,否则上一帧留在那儿的字会从新内容底下露出来。
   */
  blit(rect: Rect, lines: string[]): void {
    for (let row = 0; row < rect.height; row++) {
      const y = rect.y + row
      if (y < 0 || y >= this.height) continue
      this.writeRow(y, rect.x, rect.width, lines[row] ?? "")
    }
  }

  private writeRow(y: number, x0: number, width: number, line: string): void {
    const row = this.back[y]!
    let x = x0
    const limit = Math.min(x0 + width, this.width)

    for (const [ch, style] of styledChars(line)) {
      if (x >= limit) break
      const w = charWidth(ch)
      if (w === 0) continue
      if (x + w > limit) break // 双宽字符塞不下就整个不画,不画半个
      row[x] = { ch, style, cont: false }
      if (w === 2) row[x + 1] = { ch: "", style, cont: true }
      x += w
    }
    for (; x < limit; x++) row[x] = BLANK
  }

  /** 光标最终停在哪。不设就藏起来。 */
  setCursor(x: number, y: number): void {
    this.cursor = { x, y }
  }

  /**
   * 把后台缓冲和屏幕的差异发出去。
   *
   * 一行里挨得近的两段改动合并成一段一起发 —— 光标定位序列本身要 6-8 字节,
   * 为了跳过三个没变的字符而发一次定位是亏的。
   */
  end(): void {
    let out = SYNC_BEGIN
    let emittedStyle: string | undefined
    let cursorAt: { x: number; y: number } | undefined
    let painted = false

    if (this.dirty) out += CLEAR_ALL
    out += HIDE_CURSOR

    for (let y = 0; y < this.height; y++) {
      const back = this.back[y]!
      const front = this.front[y]!
      for (const [from, to] of runs(front, back, this.dirty, this.width)) {
        // 定位。同一行紧接着上一段就不用重新定位了
        if (!cursorAt || cursorAt.y !== y || cursorAt.x !== from) {
          out += `\u001b[${y + 1};${from + 1}H`
        }
        for (let x = from; x < to; x++) {
          const cell = back[x]!
          if (cell.cont) continue
          if (cell.style !== emittedStyle) {
            out += styleToSGR(cell.style)
            emittedStyle = cell.style
          }
          out += cell.ch
        }
        cursorAt = { x: to, y }
        painted = true
      }
    }

    // 交换缓冲
    const swap = this.front
    this.front = this.back
    this.back = swap
    this.dirty = false

    const cursorMoved =
      this.cursor?.x !== this.lastCursor?.x || this.cursor?.y !== this.lastCursor?.y
    if (!painted && !cursorMoved) return // 完全没变,一个字节都不发

    if (emittedStyle !== undefined && emittedStyle !== "") out += RESET
    if (this.cursor) {
      out += `\u001b[${this.cursor.y + 1};${this.cursor.x + 1}H` + SHOW_CURSOR
    }
    this.lastCursor = this.cursor
    out += SYNC_END
    this.output.write(out)
  }

  /** 下一帧强制全画。清屏、外部程序弄脏过屏幕之后要调。 */
  invalidate(): void {
    this.dirty = true
  }

  /**
   * 一段**不画东西**的转义序列,原样送到终端。
   *
   * ── 为什么必须走这里 ──
   * 这个合成器是 stdout 的持有者:绕过它直接 write,前台缓冲仍以为屏幕没变,
   * 之后每一帧的差分都对着一个错的基准算(见 DESIGN.md「四条规矩」第 2 条)。
   *
   * ⚠ 所以这道门只对**一个可见字符都不产出、光标一格都不动**的序列开。
   *   今天只有一个用户:OSC 52 剪贴板写入(见 cli/clipboard.ts)。要往这儿送
   *   别的东西之前,先问一句"它会不会在屏幕上留下任何痕迹" —— 会的话答案是
   *   不走这里,走 blit。
   *
   * 名字和 LiveRegion.passthrough 一样:两个宿主,同一件事。
   */
  passthrough(sequence: string): void {
    this.output.write(sequence)
  }

  /**
   * 画面花了,从头来过(ctrl-l 走这条)。
   *
   * ── 为什么光 invalidate 不够 ──
   * 撕裂分两种。一种是我们**记错了屏幕现在长什么样**:某个字符的实际显示宽度
   * 和 charWidth 算的不一样(带肤色的 emoji、组合符、终端把 ambiguous 当双宽),
   * 那一行往后的列就整体错位。这种错位会**永久留下来** —— 差分永远拿一份错的
   * front 去比,于是那几格再也不会被重画。invalidate 治的是这一种。
   *
   * 另一种是终端自己的状态被弄歪了:SGR 没关、滚动区被设成了半屏。这时候
   * front/back 都是对的,重画一遍照样是花的。所以这里在 invalidate 之外还要
   * 把终端按我们的样子重新摆一遍。
   *
   * ★ 刻意**不重进 alternate screen**。真要走到"连 alt screen 都掉了"那一步,
   *   1049 会把光标位置再存一次,退出时还原到的就是错的地方 —— 为一个我们
   *   根本不启动交互式子程序的场景,换一个每次按 ctrl-l 都在累积的副作用,
   *   不划算。
   */
  resync(): void {
    this.dirty = true
    if (!this.entered) return
    this.output.write(RESET + RESET_SCROLL + HIDE_CURSOR + CLEAR_ALL)
    // front 也一并作废:上面那一下 CLEAR_ALL 之后屏幕是空的,而 front 还记着
    // 满屏内容 —— 不清的话 dirty 那一帧过后,差分的基准仍然是脏的
    this.front = grid(this.width, this.height)
    this.lastCursor = undefined
  }
}

function grid(width: number, height: number): Cell[][] {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => BLANK))
}

/** 一行里需要重画的区间。间隔小于 GAP 的两段合并。 */
const GAP = 4
function runs(front: Cell[], back: Cell[], all: boolean, width: number): Array<[number, number]> {
  if (all) return [[0, width]]
  const out: Array<[number, number]> = []
  let start = -1
  let lastChanged = -1
  for (let x = 0; x < width; x++) {
    const a = front[x]!
    const b = back[x]!
    const changed = a.ch !== b.ch || a.style !== b.style || a.cont !== b.cont
    if (!changed) continue
    if (start === -1) {
      start = x
    } else if (x - lastChanged > GAP) {
      out.push([start, lastChanged + 1])
      start = x
    }
    lastChanged = x
  }
  if (start !== -1) out.push([start, lastChanged + 1])

  // 区间两端都要对齐到完整的宽字符上。
  //
  // 左边:改动落在后半格,得连前半格一起重画,否则画出半个字。
  // 右边:前半格变了而后半格没变(同色不同字就会这样),区间会停在两半中间 ——
  //   写出那个宽字符时光标实际前进 2 列,记账只记了 1 列,同一行后面那一段
  //   就会往左错一格。这个 off-by-one 只在特定内容下出现,现场极难复现。
  return out.map(([from, to]) => [
    back[from]?.cont && from > 0 ? from - 1 : from,
    to < width && back[to]?.cont ? to + 1 : to,
  ])
}

// ───────────────────────────────────────────── SGR

const SGR_RE = /\u001b\[([0-9;]*)m/y
const ANY_ESC_RE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u001b]*|[@-Z\\-_])/y

/**
 * 逐字符吐出 (字符, 归一化后的样式)。
 *
 * 样式必须**归一化**,不能把转义序列原样攒起来:picocolors 的 red 是
 * `[31m …[39m`,关闭码是 39 不是 0。原样累积的话「红完之后」这个状态
 * 会记成 `[31m[39m`,和「一开始就没上色」这个状态字符串不相等 ——
 * 于是差分永远认为它俩不同,每帧都重画,差分就白做了。
 */
function* styledChars(line: string): Generator<[string, string]> {
  let style = ""
  let index = 0
  while (index < line.length) {
    if (line[index] === "\u001b") {
      SGR_RE.lastIndex = index
      const sgr = SGR_RE.exec(line)
      if (sgr) {
        style = applySGR(style, sgr[1] ?? "")
        index = SGR_RE.lastIndex
        continue
      }
      ANY_ESC_RE.lastIndex = index
      const other = ANY_ESC_RE.exec(line)
      if (other) {
        index = ANY_ESC_RE.lastIndex // 光标控制之类的:面板里不该有,忽略
        continue
      }
      index += 1
      continue
    }
    const point = line.codePointAt(index)!
    const ch = String.fromCodePoint(point)
    index += ch.length
    if (ch === "\n" || ch === "\r" || ch === "\t") continue
    yield [ch, style]
  }
}

/** 样式状态用「分号连起来的规范化参数」表示,空串 = 默认。 */
function applySGR(current: string, params: string): string {
  const state = parseStyle(current)
  const codes = params.length === 0 ? [0] : params.split(";").map((p) => (p === "" ? 0 : Number(p)))

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!
    if (code === 0) {
      state.fg = ""
      state.bg = ""
      state.flags.clear()
    } else if (code === 39) state.fg = ""
    else if (code === 49) state.bg = ""
    else if (code === 22) {
      state.flags.delete(1)
      state.flags.delete(2)
    } else if (code === 23) state.flags.delete(3)
    else if (code === 24) state.flags.delete(4)
    else if (code === 27) state.flags.delete(7)
    else if (code === 1 || code === 2 || code === 3 || code === 4 || code === 7) state.flags.add(code)
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) state.fg = String(code)
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) state.bg = String(code)
    else if (code === 38 || code === 48) {
      // 38;5;n 或 38;2;r;g;b
      const kind = codes[i + 1]
      const take = kind === 5 ? 2 : kind === 2 ? 4 : 0
      if (take === 0) continue
      const value = codes.slice(i, i + take + 1).join(";")
      if (code === 38) state.fg = value
      else state.bg = value
      i += take
    }
  }
  return serializeStyle(state)
}

interface StyleState {
  fg: string
  bg: string
  flags: Set<number>
}

function parseStyle(text: string): StyleState {
  const state: StyleState = { fg: "", bg: "", flags: new Set() }
  if (text.length === 0) return state
  for (const part of text.split("|")) {
    if (part.startsWith("f")) state.fg = part.slice(1)
    else if (part.startsWith("b")) state.bg = part.slice(1)
    else if (part.startsWith("a")) for (const f of part.slice(1).split(",")) state.flags.add(Number(f))
  }
  return state
}

function serializeStyle(state: StyleState): string {
  const parts: string[] = []
  if (state.fg) parts.push("f" + state.fg)
  if (state.bg) parts.push("b" + state.bg)
  if (state.flags.size > 0) parts.push("a" + [...state.flags].toSorted((a, b) => a - b).join(","))
  return parts.join("|")
}

/** 归一化样式 → 真正发给终端的序列。自带 reset,所以每段互不影响。 */
function styleToSGR(style: string): string {
  if (style === "") return RESET
  const state = parseStyle(style)
  const codes = [0, ...[...state.flags].toSorted((a, b) => a - b).map(String)]
  if (state.fg) codes.push(state.fg)
  if (state.bg) codes.push(state.bg)
  return `\u001b[${codes.join(";")}m`
}

export const __test = { styledChars, applySGR, styleToSGR, runs }
