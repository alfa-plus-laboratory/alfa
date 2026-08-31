/**
 * stdin 的唯一持有者。
 *
 * 和 render.ts 是 stdout 的唯一持有者对称。理由也一样但更硬:同时有两处
 * `stdin.on("data")` 时,一次按键会被两边各收一份,而 raw 模式是全局开关 ——
 * 谁先 `setRawMode(false)` 谁就把还在读键的另一方废掉。
 *
 * 所以这里做成一个**处理器栈**:输入框在栈底,权限确认框临时压上去接管,
 * 弹出后自动还给输入框。栈空的时候才真正退出 raw 模式。
 *
 * ── ESC 的歧义 ──
 * 一个孤立的 ESC 可能是用户按了 Esc 键,也可能是 `ESC [ A` 才到了第一个字节。
 * 唯一的区分办法是等一下:超时之内没有后续,就是 Esc 键。25ms 是经验值 ——
 * 短到人感觉不出延迟,长到本地终端的续包一定能到。
 */
import fs from "node:fs"
import tty from "node:tty"
import { decodeKeys, type Key } from "./keys.ts"

/** 栈顶的处理器独占按键,不往下传,所以不需要返回值。 */
export type KeyHandler = (key: Key) => void

const ESCAPE_TIMEOUT_MS = 25

/**
 * 多久看一眼终端还在不在。
 *
 * 只在终端已经没了之后才有意义,所以慢一点无所谓 —— 代价是最多白转一秒。
 * 快到几十毫秒反而是在正常会话里白掏一整天的系统调用。
 */
const HANGUP_POLL_MS = 1000

/**
 * 终端**曾经在、现在没了**。
 *
 * 两个条件缺一不可,因为单看哪个都会认错人:
 *   · `isTTY` 是启动那一刻的判断,pty 主端关闭后它**仍然是 true** —— 只看它
 *     永远发现不了终端已经没了;
 *   · `isatty(0)` 在管道里本来就是 false —— 只看它会把 `echo x | alfa`
 *     这种正当用法当成掉线杀掉。
 *
 * 合起来才是"本来有个终端,后来没了"。这是唯一该走人的情况。
 */
export function terminalGone(input: NodeJS.ReadStream = process.stdin): boolean {
  if (input.isTTY === true) return input.destroyed || !tty.isatty(0)
  // ── 终端在我们**启动之前**就没了 ──
  //
  // 这时候上面那条判不出来:进程初始化时 isatty(0) 已经是 false,于是 isTTY
  // 也是 false —— 和一根普通管道长得一模一样。
  //
  // 唯一分得开的是往 fd 1 写:管道、文件、/dev/null 都写得进去,而一个主端
  // 已经关闭的 pty 给 EIO。写 0 个字节,不留任何痕迹。
  try {
    fs.writeSync(1, "")
    return false
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EIO"
  }
}

/** 开启/关闭括号粘贴。没有它,粘 40 行代码 = 提交 40 次。 */
const PASTE_ON = "\u001b[?2004h"
const PASTE_OFF = "\u001b[?2004l"

/**
 * 鼠标上报。**只开 1006(SGR)**,不开 X10。
 *
 * X10 那套把坐标编码成三个原始字节跟在 `ESC [ M` 后面,超过 223 列就溢出,
 * 而且那些字节和普通可打印字符没法区分 —— 认错了就会往输入框里塞乱码。
 * 1006 是纯十进制参数,认得干净,现在的终端都支持。
 *
 * 代价:开了之后终端原生的拖选复制会被接管。多数终端按住 Shift 可以绕过,
 * 另外 app 层给了开关能整个关掉。
 */
/**
 * 1000 = 按下/松开,1002 = **按着不放时的移动**,1006 = 换成 SGR 格式。
 *
 * 1002 是拖滚动条的前提:没有它,按住滑块拖动时终端一个字节都不发,
 * 用户看到的是"按下去了,但拖不动"。两个都发是因为不认 1002 的终端会把它
 * 整条忽略 —— 只发 1002 的话,那些终端上鼠标直接全废了。
 */
const MOUSE_ON = "\u001b[?1000h\u001b[?1002h\u001b[?1006h"
const MOUSE_OFF = "\u001b[?1006l\u001b[?1002l\u001b[?1000l"

export class Keyboard {
  private readonly input: NodeJS.ReadStream
  private readonly output: NodeJS.WriteStream
  private readonly stack: KeyHandler[] = []
  private buffer = ""
  private escapeTimer: ReturnType<typeof setTimeout> | undefined
  private listening = false
  private wasRaw = false
  private mouseOn = false
  private hangupTimer: ReturnType<typeof setInterval> | undefined

  /**
   * 终端没了。
   *
   * ★ 不接的话进程会**永远**留下来:没有界面、没有人、100% 占一个核。
   *   见 attach() 里的看门狗。
   */
  onHangup: (() => void) | undefined

  constructor(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout) {
    this.input = input
    this.output = output
  }

  get usable(): boolean {
    return this.input.isTTY === true
  }

  /** 已经真的接管了 stdin。raw 模式拿不到时是 false —— 那种情况下按键永远不会来。 */
  get attached(): boolean {
    return this.listening
  }

  /**
   * 提前接管。
   *
   * 交互模式必须在**画输入框之前**知道 raw 模式到底拿不拿得到:拿不到就该
   * 退回逐行读,而不是画一个永远收不到按键的框在那儿。
   */
  open(): boolean {
    this.attach()
    return this.listening
  }

  /**
   * 压一个处理器上去,返回弹出它的函数。
   *
   * 弹出函数是幂等的,而且**只弹自己** —— 用 indexOf 而不是 pop。异常路径下
   * 顺序可能乱,盲目 pop 会把别人的处理器摘掉。
   */
  push(handler: KeyHandler): () => void {
    this.stack.push(handler)
    this.attach()
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const at = this.stack.indexOf(handler)
      if (at !== -1) this.stack.splice(at, 1)
      if (this.stack.length === 0) this.detach()
    }
  }

  private attach(): void {
    if (this.listening || !this.usable) return
    this.listening = true
    this.wasRaw = this.input.isRaw ?? false
    try {
      this.input.setRawMode?.(true)
    } catch {
      this.listening = false
      return
    }
    this.input.setEncoding("utf8")
    this.input.resume()
    this.input.on("data", this.onData)
    this.output.write(PASTE_ON)
    if (this.mouseOn) this.output.write(MOUSE_ON)
    this.watchHangup()
  }

  /**
   * 终端消失的唯一察觉手段是**自己去看**。
   *
   * 按说这里该挂 `input.on("end"/"error"/"close")`,但 Bun 在 pty 主端关闭后
   * 一条都不发 —— 实测:事件全程不来,而同一时刻 `stdin.destroyed` 已经是
   * true 了。也就是说它内部知道,只是没往外说。
   *
   * ★ 而 `isTTY` 这时候**仍然是 true** —— 代码里到处拿它当"有没有终端"的判据,
   *   在这个场景下全是错的。真正会翻的是下面这两个。
   *
   * 后果不是少收几个按键那么轻:终端一没,读 fd 0 立刻返回 EIO,事件循环
   * 马上重试下一轮 —— 一个满转的孤儿进程。用 setsid 起的(自动化测试就是)
   * 收不到 SIGHUP,于是能这么转到天荒地老。真实代价:一批这样的进程烧掉过
   * 四百多个 CPU 小时,直到有人去看 btop 才发现。
   */
  private watchHangup(): void {
    if (this.hangupTimer !== undefined) return
    this.hangupTimer = setInterval(() => {
      if (!terminalGone(this.input)) return
      this.clearHangupTimer()
      const notify = this.onHangup
      // 先把终端还原(此时多半是空操作,反正也没人看了),再叫人来收
      this.close()
      notify?.()
    }, HANGUP_POLL_MS)
    // 看门狗自己不该拖着进程不退出
    this.hangupTimer.unref?.()
  }

  private clearHangupTimer(): void {
    if (this.hangupTimer === undefined) return
    clearInterval(this.hangupTimer)
    this.hangupTimer = undefined
  }

  /**
   * 开关鼠标上报。App 进出场时调。
   *
   * 退出时**必须关掉**:留着的话用户回到 shell,每点一下都会吐出一串
   * 上报序列 —— 那是一个看起来像终端坏了的收尾。
   */
  setMouse(enabled: boolean): void {
    if (this.mouseOn === enabled) return
    this.mouseOn = enabled
    if (!this.listening) return
    this.output.write(enabled ? MOUSE_ON : MOUSE_OFF)
  }

  /**
   * 把终端模式重新宣告一遍(ctrl-l 走这条,和 Screen.resync 一起)。
   *
   * 撕裂常常不只是画面的事:raw 模式、括号粘贴、鼠标上报里任何一样被外力
   * 关掉之后,现象是"界面看着好了但按键不对了" —— 而用户按 ctrl-l 想修的
   * 正是"整个不对劲",不是"只有像素不对劲"。
   *
   * 三样都是**幂等的开**,重复写一遍没有副作用,所以不去判断当前状态 ——
   * 判断本身就要问终端,而这条路存在的前提正是"终端的状态我们已经不确定了"。
   */
  reassert(): void {
    if (!this.listening) return
    try {
      this.input.setRawMode?.(true)
    } catch {
      // 终端已经没了。watchHangup 会收拾
    }
    this.output.write(PASTE_ON)
    if (this.mouseOn) this.output.write(MOUSE_ON)
  }

  private detach(): void {
    if (!this.listening) return
    this.listening = false
    this.clearEscapeTimer()
    this.clearHangupTimer()
    this.input.off("data", this.onData)
    if (this.mouseOn) this.output.write(MOUSE_OFF)
    this.output.write(PASTE_OFF)
    try {
      if (!this.wasRaw) this.input.setRawMode?.(false)
    } catch {
      // 终端已经没了
    }
    if (!this.wasRaw) this.input.pause()
    this.buffer = ""
  }

  /**
   * 退出前必须调,而且必须在**任何**退出路径上调 —— 漏一条,用户回到 shell
   * 时终端还在 raw 模式:打字不回显、Ctrl-C 没反应,只能关窗口。
   */
  close(): void {
    this.stack.length = 0
    this.detach()
  }

  private readonly onData = (chunk: string): void => {
    this.clearEscapeTimer()
    this.buffer += chunk

    const { keys, rest, pendingEscape } = decodeKeys(this.buffer)
    this.buffer = rest
    for (const key of keys) this.dispatch(key)

    if (pendingEscape) {
      // 等一小会儿。真是 Esc 键的话没有后续会来,超时后按 Esc 处理
      this.escapeTimer = setTimeout(() => {
        this.escapeTimer = undefined
        // 缓冲里剩下的必须正好是那个 ESC。不是就说明后续字节已经到了 —— onData
        // 会先清掉这个定时器,只有竞态能走到这儿 —— 交给下一轮解码。
        if (this.buffer !== "\u001b") return
        this.buffer = ""
        this.dispatch({ name: "escape", ctrl: false, meta: false, shift: false })
      }, ESCAPE_TIMEOUT_MS)
      // 定时器不该拖着进程不退出
      this.escapeTimer.unref?.()
    }
  }

  private dispatch(key: Key): void {
    const handler = this.stack[this.stack.length - 1]
    if (!handler) return
    try {
      handler(key)
    } catch {
      // 一个按键处理出错不该让整个键盘失灵。真错误会在别处冒出来。
    }
  }

  private clearEscapeTimer(): void {
    if (this.escapeTimer === undefined) return
    clearTimeout(this.escapeTimer)
    this.escapeTimer = undefined
  }
}
