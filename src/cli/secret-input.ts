/**
 * 不回显地读一行(粘贴 API key 用)。
 *
 * 不能用 readline:它会把密钥原样回显到终端,然后留在滚动缓冲区里、留在
 * tmux 的 history 里、被 screenshot 拍进去。所以走 raw 模式自己收字符。
 *
 * raw 模式必须在**每一条**退出路径上还原,包括异常和 Ctrl-C —— 漏一条,
 * 用户的终端就变成打字不回显、Ctrl-C 没反应,只能关窗口。
 */
const CTRL_C = "\u0003"
const CTRL_D = "\u0004"
const BACKSPACE = "\u007f"
const BACKSPACE_ALT = "\u0008"

export class InputCancelled extends Error {
  constructor() {
    super("cancelled")
    this.name = "InputCancelled"
  }
}

export interface SecretInputDeps {
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
}

/**
 * @param mask 每个字符回显成什么。给空串就完全不回显(默认),
 *             给 "•" 则显示长度 —— 长度本身也是信息,默认不给。
 */
export async function readSecret(prompt: string, deps: SecretInputDeps = {}, mask = ""): Promise<string> {
  const input = deps.input ?? process.stdin
  const output = deps.output ?? process.stdout

  // 管道输入:读一行就好,没有终端可以关回显,也没必要
  if (!input.isTTY) return readLineFromPipe(input)

  output.write(prompt)

  return new Promise<string>((resolve, reject) => {
    const wasRaw = input.isRaw ?? false
    let buffer = ""
    let settled = false

    const cleanup = () => {
      input.off("data", onData)
      try {
        if (!wasRaw) input.setRawMode?.(false)
      } catch {
        // 终端已经没了
      }
      if (!wasRaw) input.pause()
    }

    const finish = (value: string) => {
      if (settled) return
      settled = true
      cleanup()
      output.write("\n")
      resolve(value)
    }

    const cancel = () => {
      if (settled) return
      settled = true
      cleanup()
      output.write("\n")
      reject(new InputCancelled())
    }

    const onData = (chunk: Buffer | string) => {
      // 粘贴会一次给一大块,要逐字符走,不能整块当一个键
      for (const char of chunk.toString()) {
        if (char === CTRL_C) return cancel()
        if (char === CTRL_D) return buffer.length === 0 ? cancel() : finish(buffer)
        if (char === "\r" || char === "\n") return finish(buffer)
        if (char === BACKSPACE || char === BACKSPACE_ALT) {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1)
            if (mask) output.write("\b \b")
          }
          continue
        }
        // 丢掉其它控制字符(方向键等转义序列的残片),它们不该进密钥
        if (char < " ") continue
        buffer += char
        if (mask) output.write(mask)
      }
    }

    try {
      input.setRawMode?.(true)
    } catch {
      settled = true
      return reject(new Error("cannot disable echo on this terminal; refusing to read a secret with echo on"))
    }
    input.resume()
    input.on("data", onData)
  })
}

function readLineFromPipe(input: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve) => {
    let buffer = ""
    input.setEncoding("utf8")
    const onData = (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf("\n")
      if (newline === -1) return
      input.off("data", onData)
      input.off("end", onEnd)
      resolve(buffer.slice(0, newline).trim())
    }
    const onEnd = () => resolve(buffer.trim())
    input.on("data", onData)
    input.once("end", onEnd)
    input.resume()
  })
}

/** 普通的一行输入(有回显),用于 provider 名、baseURL 这些非密钥字段。 */
export async function readLine(prompt: string, deps: SecretInputDeps = {}): Promise<string> {
  const input = deps.input ?? process.stdin
  const output = deps.output ?? process.stdout
  if (!input.isTTY) return readLineFromPipe(input)
  output.write(prompt)
  return readSecretEcho(input, output)
}

/**
 * 一次读里**没用完**的那几个字符。
 *
 * ── ★ 为什么必须留着 ──
 * raw 模式下一次 `data` 事件常常带来不止一个字符:粘贴、SSH 上的合包、
 * 敲得快一点都会。原来的做法是读到换行就 resolve,而**同一个 chunk 里换行
 * 后面的字符直接丢掉** —— 于是连着两问的地方(引导、第一次进一个文件夹那
 * 张卡片),把两个答案一起粘进去时,第二问收到的是空,静默取默认值。
 *
 * ⚠ 在那张卡片上,第二问正是「要不要信任这个文件夹」,而它的默认是"信任" ——
 *   也就是说这个丢字符的 bug 在一道安全提问上是 fail open 的。
 *
 * 终端本来就有 type-ahead(还没轮到你答的时候先打),留着才是对的行为。
 */
let typeAhead = ""

function readSecretEcho(input: NodeJS.ReadStream, output: NodeJS.WriteStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw ?? false
    let buffer = ""
    let settled = false

    const cleanup = () => {
      input.off("data", onData)
      try {
        if (!wasRaw) input.setRawMode?.(false)
      } catch {
        /* 终端已经没了 */
      }
      if (!wasRaw) input.pause()
    }

    const onData = (chunk: Buffer | string) => {
      const chars = [...chunk.toString()]
      for (const [at, char] of chars.entries()) {
        if (char === CTRL_C) {
          if (settled) return
          settled = true
          // 取消的时候把剩下的丢掉:用户按的是"不弄了",而不是"这几个字给下一问"
          typeAhead = ""
          cleanup()
          output.write("\n")
          return reject(new InputCancelled())
        }
        if (char === "\r" || char === "\n") {
          if (settled) return
          settled = true
          // ★ 换行**后面**那几个字符留给下一次读。见 typeAhead
          typeAhead = chars.slice(at + 1).join("")
          cleanup()
          output.write("\n")
          return resolve(buffer.trim())
        }
        if (char === BACKSPACE || char === BACKSPACE_ALT) {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1)
            output.write("\b \b")
          }
          continue
        }
        if (char < " ") continue
        buffer += char
        output.write(char)
      }
    }

    try {
      input.setRawMode?.(true)
    } catch {
      settled = true
      return reject(new Error("cannot read from this terminal"))
    }
    input.resume()
    input.on("data", onData)
    // 上一问没用完的那几个字符先喂进来。放在挂监听**之后**,让它走的是和
    // 真正的输入完全同一条路 —— 回显、退格、换行判断一处都不会不一样
    if (typeAhead.length > 0) {
      const carried = typeAhead
      typeAhead = ""
      onData(carried)
    }
  })
}
