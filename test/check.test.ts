/**
 * 收口前的自动检查。
 *
 * 两组:认出来(detectChecker / worthChecking)和跑起来(runCheck)。前一组是
 * 纯函数,后一组真的起进程 —— 用 `sh -c` 造出退出码、输出、找不到命令、超时
 * 四种收场,因为**这四种在界面上的处理完全不同**,而把它们混成一个 boolean
 * 正是"检查器坏了却显示代码有问题"的来源。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkReminder, detectChecker, runCheck, worthChecking, type Checker } from "../src/agent/check.ts"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "apc-check-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const touch = (...parts: string[]) => {
  const path = join(root, ...parts)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, "")
  return path
}

describe("认出这个项目该跑什么", () => {
  test("tsconfig + 本地 tsc → tsc --noEmit", () => {
    touch("tsconfig.json")
    touch("node_modules", ".bin", "tsc")
    const checker = detectChecker(root)
    expect(checker?.id).toBe("tsc")
    expect(checker?.command).toContain("--noEmit")
    expect(checker?.extensions).toContain(".ts")
  })

  test("★ 有 tsconfig 但本地没装 tsc —— 什么都不跑,绝不去网上现拉一个", () => {
    touch("tsconfig.json")
    expect(detectChecker(root)).toBeUndefined()
  })

  test("Cargo.toml → cargo check;go.mod → go build", () => {
    touch("Cargo.toml")
    expect(detectChecker(root)?.id).toBe("cargo")
    rmSync(join(root, "Cargo.toml"))
    touch("go.mod")
    expect(detectChecker(root)?.id).toBe("go")
  })

  test("★ 非 POSIX shell 下要的是 tsc.cmd —— PowerShell 跑不了那个没扩展名的 sh 脚本", () => {
    touch("tsconfig.json")
    touch("node_modules", ".bin", "tsc")
    // 只有 sh 脚本、没有 .cmd:那台机器上这个检查跑不起来,就该当作没有 ——
    // 每轮一行"检查失败"比没有检查更糟
    expect(detectChecker(root, undefined, { posix: false })).toBeUndefined()

    touch("node_modules", ".bin", "tsc.cmd")
    expect(detectChecker(root, undefined, { posix: false })?.command).toBe("node_modules\\.bin\\tsc.cmd --noEmit")
    expect(detectChecker(root, undefined, { posix: true })?.command).toBe("node_modules/.bin/tsc --noEmit")
  })

  test("什么都没有就是没有 —— 这个功能安静地不存在", () => {
    expect(detectChecker(root)).toBeUndefined()
  })

  test("配置里写了命令就用它,写了 false 就整个关掉", () => {
    touch("tsconfig.json")
    touch("node_modules", ".bin", "tsc")
    expect(detectChecker(root, "bun run typecheck")?.command).toBe("bun run typecheck")
    // 自定义命令不知道自己管哪些后缀,所以动了什么都跑
    expect(detectChecker(root, "bun run typecheck")?.extensions).toEqual([])
    expect(detectChecker(root, false)).toBeUndefined()
  })
})

describe("值不值得跑", () => {
  const tsc: Checker = { id: "tsc", command: "tsc --noEmit", extensions: [".ts", ".tsx"] }

  test("只改了 README 不跑 —— 那几秒是用户在等", () => {
    expect(worthChecking(tsc, ["/repo/README.md"])).toBe(false)
  })
  test("动了一个 .ts 就跑", () => {
    expect(worthChecking(tsc, ["/repo/README.md", "/repo/src/a.ts"])).toBe(true)
  })
  test("什么都没改不跑", () => {
    expect(worthChecking(tsc, [])).toBe(false)
  })
  test("自定义命令:动了任何文件都跑", () => {
    expect(worthChecking({ id: "check", command: "x", extensions: [] }, ["/repo/README.md"])).toBe(true)
  })
})

describe("跑起来", () => {
  const checker = (command: string): Checker => ({ id: "test", command, extensions: [] })

  test("退出码 0 = 干净", async () => {
    const outcome = await runCheck(checker("true"), { root })
    expect(outcome.status).toBe("ok")
    expect(outcome.output).toBe("")
  })

  test("非 0 = 有问题,输出原样带回来(stderr 也算)", async () => {
    const outcome = await runCheck(checker("echo 'a.ts(1,1): error TS1005' >&2; exit 2"), { root })
    expect(outcome.status).toBe("problems")
    expect(outcome.code).toBe(2)
    expect(outcome.output).toContain("error TS1005")
  })

  test("★ 找不到命令 = 检查器没装,不是代码有问题", async () => {
    const outcome = await runCheck(checker("definitely-not-a-real-command-xyz"), { root })
    expect(outcome.status).toBe("unavailable")
    expect(outcome.reason).toContain("not found")
  })

  test("超时也算没跑成 —— 一个卡住的检查器不该被当成编译不过", async () => {
    const outcome = await runCheck(checker("sleep 5"), { root, timeoutMs: 150 })
    expect(outcome.status).toBe("unavailable")
    expect(outcome.reason).toBe("timeout")
  })

  test("已经中断了就别起进程", async () => {
    const controller = new AbortController()
    controller.abort()
    const outcome = await runCheck(checker("true"), { root, signal: controller.signal })
    expect(outcome.status).toBe("unavailable")
    expect(outcome.reason).toBe("interrupted")
  })

  test("跑到一半被中断", async () => {
    const controller = new AbortController()
    const running = runCheck(checker("sleep 5"), { root, signal: controller.signal })
    controller.abort()
    expect((await running).status).toBe("unavailable")
  })

  test("★ 留头不留尾 —— 编译器的第一条错误常常是根因", async () => {
    const outcome = await runCheck(checker("seq 1 500; exit 1"), { root })
    expect(outcome.output.startsWith("1\n2\n3")).toBe(true)
    expect(outcome.output).toContain("more lines")
    expect(outcome.output.split("\n").length).toBeLessThan(60)
  })

  test("在工作区根下跑,不是在进程的 cwd 下", async () => {
    const outcome = await runCheck(checker("test \"$(pwd)\" = \"$(cd . && pwd)\" && ls tsconfig.json"), { root })
    // tsconfig 不存在 → 非 0。真正要证的是它确实在 root 里找
    expect(outcome.status).toBe("problems")
    touch("tsconfig.json")
    expect((await runCheck(checker("ls tsconfig.json"), { root })).status).toBe("ok")
  })
})

describe("塞回给模型的那段话", () => {
  const tsc: Checker = { id: "tsc", command: "tsc --noEmit", extensions: [".ts"] }

  test("带上命令和原文", () => {
    const text = checkReminder(tsc, "a.ts(1,1): error TS1005")
    expect(text).toContain("tsc --noEmit")
    expect(text).toContain("error TS1005")
  })

  test("★ 三句都在:不是用户说的、先判断是不是你弄的、修不了要说出来", () => {
    const text = checkReminder(tsc, "boom")
    expect(text).toContain("not by the user")
    expect(text).toContain("Pre-existing")
    expect(text).toContain("Never silently work around")
  })
})
