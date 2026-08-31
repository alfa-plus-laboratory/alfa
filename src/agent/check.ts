/**
 * 改完之后,谁来告诉它编译过不过。
 *
 * ── 这件事为什么必须自动 ──
 * 模型改完一个文件,回头看只有它自己写下去的那份 diff。diff 长得对不对和
 * 编译过不过是两件事:少一个 import、把 `subclipped` 写成 `subclip`、改了签名
 * 忘了另外三个调用点 —— 这些在 diff 上全都很合理。它只有在**想起来**跑一次
 * 检查时才知道,而"想起来"不是一个能依赖的机制:它十次里有八次会想起来,
 * 剩下两次就是你收到一句"改好了"然后自己去发现红的。
 *
 * 所以这里把它变成不需要想起来的:一轮结束前、它准备开口说"好了"的那一刻,
 * 跑一次项目自己的检查,有问题就把问题原样塞回去让它接着修(见 agent/loop.ts
 * 的 verify)。
 *
 * ── 只跑装在项目里的那个二进制 ──
 * 检测到 tsconfig.json **并且** node_modules/.bin/tsc 确实存在才认。不 `npx`
 * 去网上现拉一个:那是在用户没点头的情况下下载并执行代码。检测不到就当没有
 * 这回事,整个功能安静地不存在 —— 一个会自作主张装东西的检查器比没有检查器
 * 危险得多。
 *
 * 即便如此,`node_modules/.bin/tsc` 在一个刚 clone 回来的仓库里仍然是别人写的
 * 东西。所以它**照旧过权限门卫**(和任何一条 bash 一样),第一次会问,可以
 * 「以后不再问」。见 cli/main.ts 里 verify 的实现。
 *
 * ── 留头不留尾 ──
 * 工具输出的通用规矩是留尾巴(结论在最后),编译器**反过来**:第一条错误
 * 常常是根因,后面几十条是它的余震。所以这里截头部。
 */
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { resolveShell } from "../env/shell.ts"
import { buildChildEnv } from "../env/whitelist.ts"

export interface Checker {
  /** 给界面看的短名:tsc / cargo / go / custom */
  id: string
  /** 完整命令行。过门卫时也是拿它当 pattern */
  command: string
  /**
   * 动过这些后缀才值得跑。空数组 = 动了任何文件都跑(用户自己配的命令)。
   *
   * 只改了 README 还跑一遍 tsc 是纯粹的浪费 —— 而浪费的是用户盯着屏幕等的
   * 那几秒,他会因此把整个功能关掉。
   */
  extensions: string[]
}

/** 出问题时保留几行 / 几字节。再多模型也读不完,只会把窗口撑爆 */
const MAX_LINES = 40
const MAX_BYTES = 6 * 1024
/** 检查跑多久算跑飞了。和 bash 工具的默认超时同一个量级 */
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * 这个项目该跑什么检查。
 *
 * 顺序即优先级,第一个命中就返回 —— 一个仓库里同时有 tsconfig.json 和 go.mod
 * 是可能的(前端 + 一个小工具),这时候跑哪个都不算错,但**每次跑同一个**
 * 比"看谁排前面"更重要:结论会变来变去的检查器没人信。
 */
/**
 * 本地 tsc 怎么写。
 *
 * npm 在 Windows 上装出来的是**三个**文件:`tsc`(sh 脚本)、`tsc.cmd`、`tsc.ps1`。
 * PowerShell 和 cmd 跑不了那个没有扩展名的 sh 脚本 —— 而检查每一轮都跑,一条
 * 跑不起来的检查会变成每轮一行红字。所以按 shell 挑:POSIX(含 Git bash)用
 * 原来那个,非 POSIX 用 .cmd。两个都没有就当这个项目没有本地 tsc。
 */
function localTsc(has: (...parts: string[]) => boolean, posix: boolean): string | undefined {
  if (posix) return has("node_modules", ".bin", "tsc") ? "node_modules/.bin/tsc" : undefined
  if (has("node_modules", ".bin", "tsc.cmd")) return "node_modules\\.bin\\tsc.cmd"
  return undefined
}

export function detectChecker(
  root: string,
  override?: string | false,
  /** 注入用:测试里问"如果这台机器上是 PowerShell 呢" */
  options: { posix?: boolean } = {},
): Checker | undefined {
  // 用户自己写的命令赢过一切,包括「关掉」
  if (override === false) return undefined
  if (typeof override === "string" && override.trim().length > 0) {
    return { id: "check", command: override.trim(), extensions: [] }
  }

  const has = (...parts: string[]) => existsSync(join(root, ...parts))

  // TypeScript:tsconfig 和本地 tsc 缺一不可,理由见文件头
  if (has("tsconfig.json")) {
    const tsc = localTsc(has, options.posix ?? resolveShell().posix)
    if (tsc) return { id: "tsc", command: `${tsc} --noEmit`, extensions: [".ts", ".tsx", ".mts", ".cts"] }
  }
  // cargo / go 在 Windows 上就叫 cargo.exe / go.exe,PATH 上找得到,命令原样成立
  if (has("Cargo.toml")) {
    return { id: "cargo", command: "cargo check --quiet --message-format short", extensions: [".rs"] }
  }
  if (has("go.mod")) {
    return { id: "go", command: "go build ./...", extensions: [".go"] }
  }
  return undefined
}

/** 这一批改动值不值得跑一次检查。 */
export function worthChecking(checker: Checker, touched: readonly string[]): boolean {
  if (touched.length === 0) return false
  if (checker.extensions.length === 0) return true
  return touched.some((path) => checker.extensions.some((ext) => path.endsWith(ext)))
}

export interface CheckOutcome {
  /**
   * ok        —— 干净
   * problems  —— 检查器说有问题(退出码非 0)
   * unavailable —— 没跑成:二进制不在、超时、被中断。**不是**代码有问题
   */
  status: "ok" | "problems" | "unavailable"
  /** 截好的输出。ok 时通常是空的 */
  output: string
  code?: number
  /** unavailable 的原因,给界面写一行 */
  reason?: string
}

export async function runCheck(
  checker: Checker,
  options: { root: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<CheckOutcome> {
  if (options.signal?.aborted) return { status: "unavailable", output: "", reason: "interrupted" }

  return new Promise<CheckOutcome>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      // 和 bash 工具同一个 shell(见 env/shell.ts)。原来这里写死 /bin/sh ——
      // Windows 上那个路径不存在,于是每一轮收口检查都报 "unavailable",而
      // 那句话看起来像"这个项目没有可用的检查",不像"我们找错了 shell"
      const shell = resolveShell()
      child = spawn(shell.file, shell.argsFor(checker.command), {
        cwd: options.root,
        // 和 bash 工具同一份白名单:*_TOKEN / *_SECRET 之类不往下传
        env: buildChildEnv().env,
        stdio: ["ignore", "pipe", "pipe"],
        // 独立进程组:超时/中断时整组杀干净,不留孤儿(和 bash 工具同一条规矩)
        detached: shell.detached,
        windowsHide: true,
      })
    } catch (error) {
      resolve({ status: "unavailable", output: "", reason: describe(error) })
      return
    }

    let raw = ""
    /** 收够了就不再往内存里堆 —— 一个刷屏的检查器不该把进程撑爆 */
    let full = false
    const collect = (chunk: Buffer | string) => {
      if (full) return
      raw += String(chunk)
      if (raw.length > MAX_BYTES * 8) full = true
    }
    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)

    let settled = false
    const finish = (outcome: CheckOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      resolve(outcome)
    }

    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
      } catch {
        // 已经没了
      }
    }

    const timer = setTimeout(() => {
      kill()
      finish({ status: "unavailable", output: "", reason: "timeout" })
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    const onAbort = () => {
      kill()
      finish({ status: "unavailable", output: "", reason: "interrupted" })
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })

    child.on("error", (error) => finish({ status: "unavailable", output: "", reason: describe(error) }))

    child.on("close", (code) => {
      // 127 = shell 说找不到这个命令。这不是"代码有问题",是"检查器没装"
      if (code === 127) {
        finish({ status: "unavailable", output: "", reason: `command not found: ${checker.command}` })
        return
      }
      finish(
        code === 0
          ? { status: "ok", output: "", code: 0 }
          : { status: "problems", output: clamp(raw), ...(code === null ? {} : { code }) },
      )
    })
  })
}

/**
 * 截头部。见文件头:编译器的第一条错误常常是根因。
 */
function clamp(raw: string): string {
  const text = raw.replace(/\r\n/g, "\n").trimEnd()
  const lines = text.split("\n")
  let kept = lines.length <= MAX_LINES ? lines : lines.slice(0, MAX_LINES)
  let out = kept.join("\n")
  if (Buffer.byteLength(out, "utf8") > MAX_BYTES) {
    while (kept.length > 1 && Buffer.byteLength(kept.join("\n"), "utf8") > MAX_BYTES) kept = kept.slice(0, -1)
    out = kept.join("\n")
  }
  const dropped = lines.length - kept.length
  return dropped > 0 ? `${out}\n... (${dropped} more lines)` : out
}

/**
 * 塞回给模型的那段话。
 *
 * ── 三句话缺一不可 ──
 * 1. 这是自动跑的,不是用户在说话 —— 不然它会回一句「好的,我这就按你说的改」,
 *    而用户根本没开口。
 * 2. 先判断是不是你改出来的 —— 一个本来就编译不过的仓库(这恰恰是很多人打开
 *    agent 的原因)会让它一头扎进去修一堆跟这次任务无关的东西。
 * 3. 修不了就说出来,别硬修 —— 沉默地绕过去比报错更糟。
 */
export function checkReminder(checker: Checker, output: string): string {
  return [
    "<system-reminder>",
    `An automatic check ran after your edits and reported problems. This was run by the harness, not by the user —`,
    `do not thank the user for it or treat it as a new request.`,
    "",
    `$ ${checker.command}`,
    output,
    "",
    "Before you answer: decide whether these problems come from the changes you just made.",
    "- Caused by your changes: fix them, then finish the task.",
    "- Pre-existing and unrelated: leave them alone and say so in one line, so the user knows the repo was",
    "  already in that state.",
    "Never silently work around a problem you cannot fix — say what it is and where.",
    "</system-reminder>",
  ].join("\n")
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
