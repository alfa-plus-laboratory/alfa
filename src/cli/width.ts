/**
 * 显示宽度。
 *
 * 手写 TUI 基本都死在这里。底部活动区靠「这块内容占几行」决定重绘时往上退
 * 几行,行数算错一行,界面就开始往上啃已经打出去的输出,再也回不来。
 *
 * 行数 = ceil(显示宽度 / 终端列数),所以显示宽度必须准。三件事让它不准:
 *   1. ANSI 转义序列不占列(`\u001b[31m` 是 5 个 char、0 列)
 *   2. **中日韩字符占 2 列** —— 对这个项目是常态,不是边角料
 *   3. 组合符号(声调、变体选择符、ZWJ)占 0 列
 *
 * ── 算错时要往哪边错 ──
 * emoji 的 ZWJ 序列(👨‍👩‍👧)在会连字的终端里是一个 2 列字形,不会连字的终端
 * 里是三个。没有可移植的判断办法。这里一律**按不连字算**,也就是宽度偏大:
 * 偏大只会提前折行、右边多留一点空;偏小会溢出,行数少算,界面直接烂掉。
 * 宁可难看,不可错位。
 */

/**
 * 所有 ANSI 转义序列:CSI(`\u001b[…`)、OSC(`\u001b]…BEL/ST`)、以及双字符型。
 * 不只匹配 SGR —— 光标移动之类的序列同样不占宽度。
 *
 * ESC 一律写 `\u001b`,不写裸控制字符:裸的在 diff、grep、编辑器里都是隐形的,
 * 被改坏了看不出来(这个仓库栽过一次)。
 */
const ANSI = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g

/** 只保留 SGR(颜色),折行时要靠它把颜色续到下一行。 */
const SGR = /^\u001b\[[0-9;]*m$/

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "")
}

/**
 * East Asian Wide / Fullwidth 区段,已排序,二分查找。
 *
 * 这张表覆盖 CJK、假名、谚文、全角符号和常用 emoji 区。不是 Unicode 全量 ——
 * 全量表几百行且每个版本都在动;漏掉的冷僻区段按 1 列算,那是「偏小」方向,
 * 但那些字符在终端里出现的概率远低于维护一张全量表的成本。
 *
 * 区段本身不是自己数出来的:BMP 那半取自 Markus Kuhn 的 wcwidth.c(公有领域),
 * emoji 那半照抄 Unicode 的 EastAsianWidth.txt 里 EAW=W 的区段。见 NOTICE。
 */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo 初声
  [0x231a, 0x231b], // ⌚⌛
  [0x2329, 0x232a], // 〈〉
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653], // 星座
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e], // CJK 部首 / 康熙部首 / CJK 符号标点
  [0x3041, 0x33ff], // 平假名 → 片假名 → 注音 → 谚文兼容字母 → 封闭式 CJK
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 基本区
  [0xa000, 0xa4cf], // 彝文
  [0xa960, 0xa97f], // Hangul Jamo 扩展 A
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容表意
  [0xfe10, 0xfe19], // 竖排标点
  [0xfe30, 0xfe6f], // CJK 兼容形式 / 小写变体
  [0xff00, 0xff60], // 全角 ASCII
  [0xffe0, 0xffe6], // 全角符号
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18aff], // 西夏文 / 契丹小字
  [0x1b000, 0x1b16f], // 假名补充
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1fa7c],
  [0x1fa80, 0x1fa88],
  [0x1fa90, 0x1fabd],
  [0x1fac0, 0x1fac5],
  [0x1fad0, 0x1fadb],
  [0x1fae0, 0x1fae8],
  [0x1faf0, 0x1faf8],
  [0x20000, 0x2fffd], // CJK 扩展 B–F
  [0x30000, 0x3fffd], // CJK 扩展 G–
]

/** 零宽:组合记号(Mn/Me)、格式字符(Cf,含 ZWJ 与零宽空格)、变体选择符。 */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u

function isWide(code: number): boolean {
  let low = 0
  let high = WIDE.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const range = WIDE[mid]!
    if (code < range[0]) high = mid - 1
    else if (code > range[1]) low = mid + 1
    else return true
  }
  return false
}

/** 单个码位占几列。 */
export function charWidth(char: string): number {
  const code = char.codePointAt(0)
  if (code === undefined) return 0
  if (code === 0x00) return 0
  // 控制字符:不该出现在这里,真出现了按 0 算 —— 它们不推进光标(除了 \n\t,
  // 由调用方在更上层处理)
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0
  if (ZERO_WIDTH.test(char)) return 0
  return isWide(code) ? 2 : 1
}

/** 一段文本的显示宽度(先剥 ANSI)。 */
export function displayWidth(text: string): number {
  let total = 0
  for (const char of stripAnsi(text)) total += charWidth(char)
  return total
}

/**
 * 按显示宽度硬折行,**保留颜色**。
 *
 * 硬折(按字符,不按词)是刻意的:终端自己的自动换行就是硬折,我们和它保持
 * 一致,这样同一段文字在活动区里预览、提交进滚动区之后由终端重排,看起来
 * 是同一个样子。
 *
 * 两个必须做对的地方:
 *   - **双宽字符不能劈开**。塞不下就整个推到下一行,当前行末尾留一列空 ——
 *     终端遇到同样的情况也是这么干的。
 *   - **颜色要续行**。行尾补 reset、下一行开头把之前累积的 SGR 重发一遍,
 *     否则折过一次颜色就断在半路。
 */
export function wrapToWidth(text: string, width: number): string[] {
  if (width < 1) return [text]

  const lines: string[] = []
  let current = ""
  let used = 0
  /** 当前生效的 SGR 序列,折行时要在新行开头重放 */
  let active: string[] = []

  const flush = () => {
    lines.push(active.length > 0 ? current + RESET : current)
    current = active.join("")
    used = 0
  }

  ANSI.lastIndex = 0
  let index = 0
  while (index < text.length) {
    ANSI.lastIndex = index
    const match = ANSI.exec(text)
    if (match && match.index === index) {
      const sequence = match[0]
      current += sequence
      if (SGR.test(sequence)) {
        if (sequence === RESET || sequence === "\u001b[m") active = []
        else active.push(sequence)
      }
      index += sequence.length
      continue
    }

    const char = String.fromCodePoint(text.codePointAt(index)!)
    index += char.length

    if (char === "\n") {
      flush()
      continue
    }
    const w = charWidth(char)
    if (used + w > width && used > 0) flush()
    current += char
    used += w
  }
  lines.push(active.length > 0 ? current + RESET : current)
  return lines
}

const RESET = "\u001b[0m"

/** 空 SGR,等价于 reset。从 RESET 推出来,免得再写一遍裸转义序列。 */
const RESET_SHORT = RESET.slice(0, 2) + "m"

/**
 * 在指定显示列处切成两段,**颜色不断**。
 *
 * 悬挂缩进要用:第一行保留原本的「缩进 + 项目符号」,后面每一行换成等宽空格。
 * 直接 slice 会把 ANSI 序列拦腰截断(前半段留半条转义,后半段丢掉颜色),
 * 所以前段结尾补 reset、后段开头把还生效的 SGR 重发一遍 —— 和折行同一套办法。
 *
 * 切点落在双宽字符中间时整个字符归后段,前段宁可短一列。
 */
export function splitAtWidth(text: string, columns: number): [string, string] {
  if (columns <= 0) return ["", text]

  let head = ""
  let used = 0
  let active: string[] = []

  ANSI.lastIndex = 0
  let index = 0
  while (index < text.length) {
    ANSI.lastIndex = index
    const match = ANSI.exec(text)
    if (match && match.index === index) {
      const sequence = match[0]
      head += sequence
      if (SGR.test(sequence)) {
        if (sequence === RESET || sequence === RESET_SHORT) active = []
        else active.push(sequence)
      }
      index += sequence.length
      continue
    }

    const char = String.fromCodePoint(text.codePointAt(index)!)
    const w = charWidth(char)
    if (used + w > columns) break
    head += char
    used += w
    index += char.length
  }

  const rest = text.slice(index)
  if (active.length === 0 || rest.length === 0) return [head, rest]
  return [head + RESET, active.join("") + rest]
}

/** 右侧补空格到指定显示宽度。超宽不截断 —— 截断该由调用方明确决定。 */
export function padToWidth(text: string, width: number): string {
  const pad = width - displayWidth(text)
  return pad > 0 ? text + " ".repeat(pad) : text
}

/**
 * 截到指定显示宽度,超了就用省略号。
 *
 * 省略号本身占 1 列,要算进预算里,否则「截断后正好塞满」再加省略号又溢出。
 */
export function truncateToWidth(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return ""
  if (displayWidth(text) <= width) return text
  // ⚠ 必须保住颜色。以前这里是「剥掉 ANSI 再逐字截」,于是一行高亮过的代码
  //   只要放不下就整行变成白的 —— 而右栏里放不下才是常态。
  const [head] = splitAtWidth(text, width - displayWidth(ellipsis))
  return head + ellipsis
}

/**
 * 反过来截:从**左边**扔,保住结尾。给路径用。
 *
 * 路径的区分度全在尾巴上 —— `~/code/alfa-labs/subtools/alfa-workspace` 截右边
 * 得到的是 `~/code/alfa-…`,那正好把唯一能认出"这是哪个项目"的部分丢了。
 *
 * 断点优先落在 `/` 上:`…/subtools/alfa-workspace` 一眼是条路径,而
 * `…tools/alfa-workspace` 只是半个词。整段末节都塞不下时才逐字硬截。
 *
 * 只接受不带 ANSI 的纯文本(路径本来就是),所以不做续色那一套。
 */
export function elideLeft(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return ""
  if (displayWidth(text) <= width) return text
  const room = width - displayWidth(ellipsis)
  if (room <= 0) return ellipsis

  const parts = text.split("/")
  // 从最长的尾巴往短了试:第一个塞得下的就是最多能留的那段
  for (let at = 1; at < parts.length; at++) {
    const tail = "/" + parts.slice(at).join("/")
    if (displayWidth(tail) <= room) return ellipsis + tail
  }
  return ellipsis + takeRight(text, room)
}

/**
 * 状态行里一条路径能占几列:约三分之一,夹在 12–36 之间。
 *
 * 全屏和 --plain 两条状态行共用同一条规矩 —— 同一个东西在两种形态下宽窄不一,
 * 用户只会以为是自己看错了。上限是因为再长也认不出更多东西,下限是因为
 * 再短连末节都放不下。
 */
export function pathBudget(width: number): number {
  return Math.max(12, Math.min(36, Math.floor(width / 3)))
}

/** 从结尾往回收,收满 columns 列为止。双宽字符不劈开,宁可少一列。 */
function takeRight(text: string, columns: number): string {
  const chars = [...text]
  let used = 0
  let at = chars.length
  while (at > 0) {
    const w = charWidth(chars[at - 1]!)
    if (used + w > columns) break
    used += w
    at -= 1
  }
  return chars.slice(at).join("")
}
