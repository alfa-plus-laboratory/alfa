/**
 * 活动区里「它正在说的话」。
 *
 * ── 为什么是 OutputSink ──
 * 这样正文就能原样走 render.ts 那条流式 markdown 的路:定稿的整行提交、
 * 没写完的半行每帧重画。自己再实现一遍 markdown 的话,同一段回答在瀑布流里
 * 和在这里会长得不一样 —— 而它们是同一段话。
 *
 * ── 它不是 Transcript ──
 * Transcript 存整场会话,这里只存**最后那一段**:模型每开一条新的正文,前面
 * 的就被丢掉(思考是接在后面的,见 ChatModel)。上限那个环形缓冲只是兜底 ——
 * 真正的清空来自 reset()。
 *
 * ── 为什么带上限 ──
 * 一段回答理论上能有几千行(模型贴一整个文件),思考更能一口气写上百行。
 * 全留着的话,每帧都要按当前宽度折那几千行才能取出末尾十行。留够「屏幕再高
 * 也够用」的量就行。
 */
import type { OutputSink } from "../../cli/live.ts"
import { wrapLine } from "../transcript.ts"

/** 留多少条逻辑行。比任何终端都高 —— 再往上翻不是这个区域的职责。 */
const MAX_LINES = 400

export class SpeechBuffer implements OutputSink {
  private logical: string[] = []
  private tail = ""

  get atLineStart(): boolean {
    return this.tail.length === 0
  }

  get empty(): boolean {
    return this.logical.length === 0 && this.tail.length === 0
  }

  write(text: string): void {
    if (text.length === 0) return
    this.tail += text
    const parts = this.tail.split("\n")
    this.tail = parts.pop() ?? ""
    for (const line of parts) this.push(line)
  }

  replaceTail(committed: string[], tail: string): void {
    for (const line of committed) this.push(line)
    this.tail = tail
  }

  /**
   * 保证末尾**正好空一行**,用来把接上来的那段和前面隔开(思考用它)。
   *
   * 已经空着就什么都不做 —— 连着调两次不该攒出两行空白,而每一行空白都是从
   * 正文那儿抢来的。整个缓冲是空的时候也不做:开头顶一行空的,看着像上面
   * 丢了东西。
   */
  blank(): void {
    if (this.empty) return
    if (this.tail.length > 0) {
      this.push(this.tail)
      this.tail = ""
    }
    if (this.logical.at(-1) !== "") this.push("")
  }

  /** 新的一段话开始了。上一段整个丢掉 —— 这个区域只显示最后那一段。 */
  reset(): void {
    this.logical = []
    this.tail = ""
  }

  private push(line: string): void {
    this.logical.push(line)
    if (this.logical.length > MAX_LINES) this.logical.splice(0, this.logical.length - MAX_LINES)
  }

  /**
   * 取末尾能塞下的那几行。
   *
   * 永远贴着**底部**,和 Transcript 顶着上面正相反:那边是可以往回翻的历史,
   * 这边是正在长出来的话,眼睛要跟的是最新那一行。
   *
   * @param scroll 从底部往上翻了多少行。0 = 跟着最新的走
   */
  view(width: number, height: number, scroll = 0): string[] {
    if (height <= 0) return []
    const want = height + Math.max(0, scroll)
    const rows: string[] = []
    // 从后往前折,够了就停 —— 模型贴一整个文件时,没必要为了显示十行而折四百行
    const source = this.source()
    for (let i = source.length - 1; i >= 0 && rows.length < want; i--) {
      rows.unshift(...wrapLine(source[i]!, width))
    }
    const end = Math.max(height, rows.length - Math.max(0, scroll))
    return rows.slice(Math.max(0, end - height), end)
  }

  /**
   * 当前宽度下有多少行,数到 cap 就停。
   *
   * 带上限不是优化洁癖:调用方要的只是「够不够填满这一栏」,而缓冲里可能躺着
   * 模型贴进来的四百行。为了回答一个「够了吗」的问题去折四百行,每帧都做一次,
   * 打字就会开始卡。
   */
  rowCount(width: number, cap = Number.MAX_SAFE_INTEGER): number {
    let total = 0
    const source = this.source()
    for (let i = source.length - 1; i >= 0 && total < cap; i--) {
      total += wrapLine(source[i]!, width).length
    }
    return Math.min(total, cap)
  }

  private source(): string[] {
    return this.tail.length > 0 ? [...this.logical, ...this.tail.split("\n")] : this.logical
  }
}
