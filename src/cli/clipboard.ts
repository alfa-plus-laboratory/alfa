/**
 * 往系统剪贴板里写字。**只用 OSC 52,不起进程。**
 *
 * ── 为什么不是 pbcopy / wl-copy / clip.exe ──
 * 那条路在本机好用,而这个程序最需要复制功能的场合恰恰不是本机:全屏界面
 * 抓着鼠标,终端原生的拖选就被顶掉了,而**通过 SSH 用**的人连"回到本地窗口
 * 再选一次"这条退路都没有 —— 他选到的是远端那台机器的剪贴板。
 *
 * OSC 52 是把内容**沿着终端连接送回去**,所以它在 SSH 上和在本机上是同一条路。
 * 代价是终端得肯收(见下面那段),而这个代价换来的是不用 spawn 任何东西:
 * 一个会在界面线程上起子进程的复制键,失败方式包括挂住、僵尸、以及在没有
 * 那个命令的机器上抛一个没人接的异常。
 *
 * ── ⚠ 成功是**无法确认的** ──
 * 序列发出去之后终端收不收、允不允许,我们一个字都收不到。所以界面上那句
 * 提示只说"发了多少字节",不说"已复制到剪贴板" —— 后者是一句我们没有依据
 * 说出口的话。README 里写清了 tmux 要 `set -g set-clipboard on`。
 *
 * ── 长度上限 ──
 * xterm 默认只收 ~74k 的**整条序列**,而 base64 会把内容撑到 4/3。超了的
 * 下场不是截断,是整条被丢掉 —— 也就是"按了没反应"。所以在这一侧就先夹住,
 * 并且把"夹过了"如实报出去。
 */

/** 内容上限(字节,base64 **之前**)。48 KiB → base64 后 64 KiB,留足边框 */
export const MAX_CLIPBOARD_BYTES = 48 * 1024

const BEL = "\u0007"
const OSC = "\u001b]"
/** tmux 的透传:`ESC P tmux; …内层 ESC 全部翻倍… ESC \` */
const TMUX_START = "\u001bPtmux;"
const DCS_END = "\u001b\\"

/**
 * 往哪儿写。
 *
 * ⚠ 全屏界面里**不能**是裸的 stdout:合成器是 stdout 的持有者,绕过它直接写,
 *   它的前台缓冲仍以为屏幕没变(见 tui/screen.ts 的 passthrough)。所以那边
 *   传进来的是一个转发到 `Screen.passthrough` 的壳。
 */
export interface ClipboardSink {
  write(text: string): unknown
}

export interface ClipboardResult {
  /** 真正发出去的字节数(夹断之后) */
  bytes: number
  /** 太长,只发了前面一段 */
  clipped: boolean
}

/**
 * 发一条 OSC 52。
 *
 * @param env 用来认 tmux / screen。注入是为了能直接测出包装对不对 —— 而包装
 *   错了的现象是"在 tmux 里按了没反应",一个没有任何线索的现场。
 */
export function writeClipboard(
  text: string,
  output: ClipboardSink = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): ClipboardResult {
  const raw = Buffer.from(text, "utf8")
  const clipped = raw.byteLength > MAX_CLIPBOARD_BYTES
  const payload = clipped ? raw.subarray(0, MAX_CLIPBOARD_BYTES) : raw
  output.write(wrap(`${OSC}52;c;${payload.toString("base64")}${BEL}`, env))
  return { bytes: payload.byteLength, clipped }
}

/**
 * 按外面套着什么复用器来包。
 *
 * ★ tmux 那层里**内层的 ESC 必须翻倍**,否则 tmux 会在第一个 ESC 上把透传
 *   截断,剩下的 base64 原样打在屏幕上 —— 现象是"按一下复制,界面糊了一片
 *   乱码",而剪贴板里什么都没有。
 */
function wrap(sequence: string, env: NodeJS.ProcessEnv): string {
  if (env["TMUX"]) return TMUX_START + sequence.replaceAll("\u001b", "\u001b\u001b") + DCS_END
  // GNU screen 的 DCS 一条最多 768 字节,长内容要切片。切片本身没有分隔语义,
  // 拼起来就是原文
  if (env["STY"]) return chunk(sequence, 480).map((part) => `\u001bP${part}${DCS_END}`).join("")
  return sequence
}

function chunk(text: string, size: number): string[] {
  const out: string[] = []
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size))
  return out
}
