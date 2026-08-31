/**
 * 原始字节 → 按键事件。
 *
 * raw 模式下 stdin 给的是没加工过的字节流,方向键是 `ESC [ A` 三个字符,
 * Ctrl-A 是 0x01,Alt-B 是 `ESC b`。要自己认。
 *
 * ── 这里唯一真正难的地方:一条序列可能被切成两块 ──
 * 终端不保证一次 read 给一个完整序列。按住方向键、或者往里粘一大段文本时,
 * `ESC [` 和 `A` 落在两个 chunk 里是常事。所以解码器是**增量**的:能认全的
 * 吐出来,认不全的原样退回 `rest`,等下一块拼上。
 *
 * 漏了这一条的表现很有迷惑性 —— 平时都对,只在快速操作和粘贴时冒出几个乱码
 * 字符,看起来像是终端的问题。
 */

export interface Key {
  /**
   * 归一化的键名。普通字符键就是字符本身(可能是多字节的「中」),
   * 功能键是 "up" / "home" / "enter" / "backspace" 这样的小写词,
   * 粘贴块是 "paste"。
   */
  name: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  /** name === "paste" 时的原文 */
  text?: string
  /** name === "mouse" 时的位置与动作(列行都是 0 起) */
  mouse?: MouseEvent
}

export interface MouseEvent {
  x: number
  y: number
  /** left/middle/right 是按键,wheel-up/down 是滚轮,move 是纯移动 */
  button: "left" | "middle" | "right" | "wheel-up" | "wheel-down" | "none"
  action: "press" | "release" | "drag"
  ctrl: boolean
  meta: boolean
  shift: boolean
}

export interface DecodeResult {
  keys: Key[]
  /** 没认全的尾巴,原样退回 */
  rest: string
  /**
   * 尾巴是一个孤零零的 ESC。
   *
   * 它有歧义:可能是用户按了 Esc 键,也可能是一条序列的开头刚到。区分不了 ——
   * 只能等一小会儿看后面有没有跟东西来(见 keyboard.ts 的 ESC 超时)。
   */
  pendingEscape: boolean
}

const ESC = "\u001b"
const PASTE_START = "\u001b[200~"
const PASTE_END = "\u001b[201~"

/** CSI 的最后一个字节决定语义;`~` 型还要看第一个参数。 */
const CSI_FINAL: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  E: "clear",
  F: "end",
  H: "home",
  Z: "tab", // Shift-Tab
}

const CSI_TILDE: Record<string, string> = {
  "1": "home",
  "2": "insert",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
  "7": "home",
  "8": "end",
}

/**
 * xterm 的修饰符编码:参数值 - 1 是位掩码。1=Shift 2=Alt 4=Ctrl。
 * 例:`ESC [ 1 ; 5 C` = Ctrl-Right(5-1 = 4)。
 */
function modifiers(param: string | undefined): { ctrl: boolean; meta: boolean; shift: boolean } {
  const mask = param ? Number(param) - 1 : 0
  if (!Number.isFinite(mask) || mask <= 0) return { ctrl: false, meta: false, shift: false }
  return { shift: (mask & 1) !== 0, meta: (mask & 2) !== 0, ctrl: (mask & 4) !== 0 }
}

function plain(name: string): Key {
  return { name, ctrl: false, meta: false, shift: false }
}

export function decodeKeys(input: string): DecodeResult {
  const keys: Key[] = []
  let index = 0

  while (index < input.length) {
    const rest = input.slice(index)

    // ── 括号粘贴。整块原文,里面的回车是文本不是提交 ──
    if (rest.startsWith(PASTE_START)) {
      const end = rest.indexOf(PASTE_END)
      // 收不全就整块退回等下一片 —— 粘 200 行代码时必然会分多次到达
      if (end === -1) return { keys, rest, pendingEscape: false }
      keys.push({ ...plain("paste"), text: rest.slice(PASTE_START.length, end) })
      index += end + PASTE_END.length
      continue
    }
    // ⚠ 长度 1 的 rest(就一个 ESC)也是 PASTE_START 的前缀,但它必须落到下面
    //   的孤立 ESC 分支去,否则 pendingEscape 永远是 false,Esc 键就彻底失灵了
    if (rest.length >= 2 && isPrefixOf(rest, PASTE_START)) return { keys, rest, pendingEscape: false }

    const char = rest[0]!

    if (char === ESC) {
      // 孤零零的 ESC:歧义,交给上层用超时决定
      if (rest.length === 1) return { keys, rest, pendingEscape: true }

      const second = rest[1]!

      // ── 老式(X10 / 1000)鼠标上报:ESC [ M 后面跟三个原始字节 ──
      //
      // ⚠ 必须认它,哪怕我们请求的是 SGR。开启鼠标追踪的是 `?1000h`,
      //   `?1006h` 只是**请求**换成 SGR 格式 —— 终端不认 1006 时照样上报,
      //   用的就是这个老格式。而它长得像一条普通 CSI(`ESC [ M`),
      //   被当成 CSI 吃掉之后,**后面那三个字节会被当成可见字符打进输入框**。
      //   用户看到的现象:点一下聊天框,冒出一串乱码。
      //
      //   坐标是 (字节 - 32)。超过 223 列时这个编码本身就不可靠,那种情况
      //   宁可当成「点在最后一列」也不能把字节漏出去。
      if (second === "[" && rest[2] === "M") {
        // 三个字节还没到齐就等 —— 半条序列吐出去就是乱码
        if (rest.length < 6) return { keys, rest, pendingEscape: false }
        keys.push(legacyMouse(rest.charCodeAt(3), rest.charCodeAt(4), rest.charCodeAt(5)))
        index += 6
        continue
      }

      // SGR 1006 鼠标上报:ESC [ < b ; x ; y M|m
      //
      // 必须在普通 CSI 之前认。1006 用 `<` 开头正是为了和别的 CSI 分开。
      if (second === "[" && rest[2] === "<") {
        const match = /^\u001b\[<([0-9;]+)([Mm])/.exec(rest)
        if (!match) {
          // 参数没收全,等下一片
          if (/^\u001b\[<[0-9;]*$/.test(rest)) return { keys, rest, pendingEscape: false }
          index += 3
          continue
        }
        const key = mouse(match[1] ?? "", match[2] === "M")
        if (key) keys.push(key)
        index += match[0].length
        continue
      }

      // CSI:ESC [ 参数 最终字节
      if (second === "[") {
        const match = /^\u001b\[([0-9;]*)([A-Za-z~u])/.exec(rest)
        if (!match) {
          // 参数还没收全(`ESC [ 1 ;` 这种),等
          if (/^\u001b\[[0-9;]*$/.test(rest)) return { keys, rest, pendingEscape: false }
          // 认不出来的序列:整条丢掉,总比把它当成一串可见字符打进输入框好
          index += 2
          continue
        }
        keys.push(csi(match[1] ?? "", match[2]!))
        index += match[0].length
        continue
      }

      // SS3:应用键盘模式下的方向键,ESC O A
      if (second === "O") {
        if (rest.length === 2) return { keys, rest, pendingEscape: false }
        const name = CSI_FINAL[rest[2]!]
        keys.push(plain(name ?? "unknown"))
        index += 3
        continue
      }

      // Alt + 键。Alt-Backspace(ESC DEL)是删词,很常用
      if (second === "\u007f" || second === "\b") {
        keys.push({ name: "backspace", ctrl: false, meta: true, shift: false })
        index += 2
        continue
      }
      if (second === "\r" || second === "\n") {
        // Alt-Enter / Shift-Enter 的老编码 —— 插入换行而不是提交
        keys.push({ name: "enter", ctrl: false, meta: true, shift: false })
        index += 2
        continue
      }
      keys.push({ name: second.toLowerCase(), ctrl: false, meta: true, shift: second !== second.toLowerCase() })
      index += 1 + second.length
      continue
    }

    // ── 单字节控制键 ──
    const code = char.charCodeAt(0)
    if (code === 0x0d) {
      keys.push(plain("enter"))
      index += 1
      continue
    }
    if (code === 0x0a) {
      // Ctrl-J。终端上它和 LF 同码,拿来当「插入换行」正好
      keys.push({ name: "j", ctrl: true, meta: false, shift: false })
      index += 1
      continue
    }
    if (code === 0x09) {
      keys.push(plain("tab"))
      index += 1
      continue
    }
    if (code === 0x7f || code === 0x08) {
      keys.push(plain("backspace"))
      index += 1
      continue
    }
    if (code >= 1 && code <= 26) {
      keys.push({ name: String.fromCharCode(code + 96), ctrl: true, meta: false, shift: false })
      index += 1
      continue
    }
    // ── Ctrl 加上这四个符号 ──
    //
    // 它们的码位在字母那一段**后面**(0x1c–0x1f),不在 1..26 里。少了这一段,
    // `ctrl-]` 打进来是 0x1d,被下面那条「其它控制字符无视」吃掉 —— 而界面上
    // 那条「ctrl-] 开关右栏」照样写着,按了没反应也不报错。
    // (0x1b 是 ESC,前面已经单独处理过了。)
    const SYMBOL: Record<number, string> = { 0x1c: "\\", 0x1d: "]", 0x1e: "^", 0x1f: "_" }
    const symbol = SYMBOL[code]
    if (symbol !== undefined) {
      keys.push({ name: symbol, ctrl: true, meta: false, shift: false })
      index += 1
      continue
    }
    if (code < 0x20) {
      index += 1 // 其它控制字符无视
      continue
    }

    // ── 普通字符。按码位取,别按 UTF-16 单元 ──
    const point = rest.codePointAt(0)!
    // 高代理项落单 = 一个字符被切成两半,等下一片
    if (point >= 0xd800 && point <= 0xdbff && rest.length === 1) {
      return { keys, rest, pendingEscape: false }
    }
    const literal = String.fromCodePoint(point)
    keys.push(plain(literal))
    index += literal.length
  }

  return { keys, rest: "", pendingEscape: false }
}

function csi(params: string, final: string): Key {
  const parts = params.split(";")
  const mods = modifiers(parts[1])

  if (final === "~") {
    const name = CSI_TILDE[parts[0] ?? ""] ?? "unknown"
    return { name, ...mods }
  }
  // CSI-u(kitty 协议):ESC [ 13;2 u = Shift-Enter。现代终端用它区分
  // Enter / Shift-Enter / Ctrl-Enter,而这正是「换行还是提交」要分的
  if (final === "u") {
    const point = Number(parts[0])
    if (point === 13) return { name: "enter", ...mods }
    if (Number.isFinite(point) && point > 0) return { name: String.fromCodePoint(point), ...mods }
    return { name: "unknown", ...mods }
  }
  const name = CSI_FINAL[final]
  if (name === "tab") return { name: "tab", ctrl: false, meta: false, shift: true }
  return { name: name ?? "unknown", ...mods }
}

/**
 * 老式上报(ESC [ M 之后三个字节)。按钮位的含义和 SGR 一样,只是三个数
 * 都偏移了 32,而且**没有单独的释放事件** —— 低两位是 3 表示「某个键松开了」,
 * 但不说是哪个。
 *
 * 存在的唯一理由是**不让那三个字节漏进输入框**。功能上它比 SGR 差一截
 * (223 列以上的坐标就不可靠了),但漏字节是会当场看见的乱码,而坐标偏一点
 * 只是点歪。
 */
function legacyMouse(rawButton: number, rawX: number, rawY: number): Key {
  const b = rawButton - 32
  const wheel = (b & 64) !== 0
  const low = b & 3
  const released = !wheel && low === 3

  const button: MouseEvent["button"] = wheel
    ? (b & 1) === 0
      ? "wheel-up"
      : "wheel-down"
    : low === 0
      ? "left"
      : low === 1
        ? "middle"
        : low === 2
          ? "right"
          : "none"

  const mods = { ctrl: (b & 16) !== 0, meta: (b & 8) !== 0, shift: (b & 4) !== 0 }
  return {
    name: "mouse",
    ...mods,
    mouse: {
      // 终端报的是 1 起、再 +32;越界时夹住而不是让它变成负数
      x: Math.max(0, rawX - 33),
      y: Math.max(0, rawY - 33),
      button,
      action: wheel ? "press" : released ? "release" : (b & 32) !== 0 ? "drag" : "press",
      ...mods,
    },
  }
}

/**
 * SGR 1006 的按钮位:低两位是键号,4/8/16 是修饰符,32 是拖动,64 是滚轮。
 */
function mouse(params: string, pressed: boolean): Key | undefined {
  const [b, x, y] = params.split(";").map(Number)
  if (b === undefined || x === undefined || y === undefined) return undefined
  if (!Number.isFinite(b) || !Number.isFinite(x) || !Number.isFinite(y)) return undefined

  const wheel = (b & 64) !== 0
  const drag = (b & 32) !== 0
  const low = b & 3

  const button: MouseEvent["button"] = wheel
    ? low === 0
      ? "wheel-up"
      : "wheel-down"
    : low === 0
      ? "left"
      : low === 1
        ? "middle"
        : low === 2
          ? "right"
          : "none"

  return {
    name: "mouse",
    ctrl: (b & 16) !== 0,
    meta: (b & 8) !== 0,
    shift: (b & 4) !== 0,
    mouse: {
      // 终端报的是 1 起的行列,内部一律 0 起
      x: x - 1,
      y: y - 1,
      button,
      action: wheel ? "press" : drag ? "drag" : pressed ? "press" : "release",
      ctrl: (b & 16) !== 0,
      meta: (b & 8) !== 0,
      shift: (b & 4) !== 0,
    },
  }
}

/** text 是不是 prefix 的一个真前缀(用来判断「序列才到一半」)。 */
function isPrefixOf(text: string, prefix: string): boolean {
  return text.length < prefix.length && prefix.startsWith(text)
}
