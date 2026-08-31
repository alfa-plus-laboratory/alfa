/**
 * `alfa uninstall`。
 *
 * 这里只测**算出要删什么**和**删**这两段纯逻辑,不起进程 —— 命令行那层的渲染
 * 归 cli 测试。真正端到端(二进制自己删掉自己)在沙箱里手验过,做不成自动测试:
 * 它需要一个真的编译产物,而那是 96MB。
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  findProjectDirsCommand,
  performUninstall,
  runningFromSource,
  uninstallScope,
} from "../src/cli/uninstall.ts"

let dir: string
let previous: { config?: string; data?: string }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alfa-uninstall-"))
  previous = { config: process.env["XDG_CONFIG_HOME"], data: process.env["XDG_DATA_HOME"] }
  process.env["XDG_CONFIG_HOME"] = join(dir, "cfg")
  process.env["XDG_DATA_HOME"] = join(dir, "data")
})

afterEach(() => {
  if (previous.config === undefined) delete process.env["XDG_CONFIG_HOME"]
  else process.env["XDG_CONFIG_HOME"] = previous.config
  if (previous.data === undefined) delete process.env["XDG_DATA_HOME"]
  else process.env["XDG_DATA_HOME"] = previous.data
  rmSync(dir, { recursive: true, force: true })
})

function seed(): { config: string; data: string; project: string; binary: string } {
  const config = join(dir, "cfg", "alfa")
  const data = join(dir, "data", "alfa")
  const project = join(dir, "proj", ".alfa")
  const binary = join(dir, "bin", "alfa")
  for (const path of [config, data, project, join(dir, "bin")]) mkdirSync(path, { recursive: true })
  writeFileSync(join(config, "config.json"), "{}")
  writeFileSync(join(data, "auth.json"), '{"anthropic":{"key":"sk-not-real"}}')
  writeFileSync(join(project, "note.md"), "note")
  writeFileSync(binary, "#!/bin/sh\n")
  return { config, data, project, binary }
}

describe("跑源码时的守卫", () => {
  // `bun run bin/alfa` 的 execPath 是 bun 自己。照着删就是把用户的 bun 删了,
  // 而这个错误无法挽回 —— 和 upgrade.ts 那条守卫同一个理由
  test("★ execPath 是 bun 时,二进制绝不进删除清单", () => {
    seed()
    expect(runningFromSource("/usr/local/bin/bun")).toBe(true)
    expect(runningFromSource("/c/Program Files/bun.exe")).toBe(true)
    const scope = uninstallScope(join(dir, "proj"), "/usr/local/bin/bun")
    expect(scope.targets.some((one) => one.path.includes("bun"))).toBe(false)
    expect(scope.binaryDir).toBeUndefined()
  })

  test("装好的二进制不会被误判成源码", () => {
    expect(runningFromSource("/home/u/.local/bin/alfa")).toBe(false)
    // 名字里**包含** bun 但不是 bun 的,别误伤
    expect(runningFromSource("/home/u/bunny/alfa")).toBe(false)
  })
})

describe("算出要删什么", () => {
  test("配置、数据、项目便条、二进制都在,而且凭据要被标出来", () => {
    const { config, data, project, binary } = seed()
    const scope = uninstallScope(join(dir, "proj"), binary)
    const paths = scope.targets.map((one) => one.path)
    expect(paths).toContain(config)
    expect(paths).toContain(data)
    expect(paths).toContain(project)
    expect(paths).toContain(binary)
    expect(scope.targets.find((one) => one.path === data)?.hasCredentials).toBe(true)
  })

  // 二进制丢了还能再装,auth.json 丢了不能 —— 所以人扫这张表时先看见的该是后者
  test("二进制排在最后,「你的东西」排在前面", () => {
    const { binary } = seed()
    const scope = uninstallScope(join(dir, "proj"), binary)
    expect(scope.targets.at(-1)?.path).toBe(binary)
  })

  test("execPath 指向一个不存在的文件时不硬塞进清单", () => {
    seed()
    const scope = uninstallScope(join(dir, "proj"), join(dir, "bin", "gone"))
    expect(scope.targets.some((one) => one.path.endsWith("gone"))).toBe(false)
  })

  test("什么都没有的机器上,清单是空的", () => {
    const scope = uninstallScope(join(dir, "proj"), join(dir, "bin", "gone"))
    expect(scope.targets).toHaveLength(0)
  })
})

describe("真删", () => {
  test("列出来的都删掉了", () => {
    const { config, data, project, binary } = seed()
    const scope = uninstallScope(join(dir, "proj"), binary)
    const result = performUninstall(scope.targets, binary)
    expect(result.failed).toHaveLength(0)
    for (const path of [config, data, project, binary]) expect(existsSync(path)).toBe(false)
  })

  // ⚠ 守的是顺序:二进制那一步在 Windows 上注定失败(文件被自己锁着),要走挪开
  //    那条路。顺序反过来的话,一次 Windows 卸载会卡在那儿,而配置和凭据一个都没删
  test("★ 单个失败不中断,其余照删", () => {
    const { config, data } = seed()
    const targets = [
      { path: join(dir, "nope", "missing-parent", "x"), what: "x", bytes: 0 },
      { path: config, what: "config", bytes: 0 },
      { path: data, what: "data", bytes: 0 },
    ]
    const result = performUninstall(targets, "/nonexistent/alfa")
    expect(existsSync(config)).toBe(false)
    expect(existsSync(data)).toBe(false)
    // rmSync 的 force 让「本来就不存在」不算失败 —— 那是对的,目标状态达到了
    expect(result.removed).toContain(config)
  })
})

describe("散在各仓库里的 .alfa/", () => {
  // 一个会遍历你整个 home 删东西的卸载器正是不该存在的那种东西。
  // 我们只把命令交出去,不替他扫 —— 见 cli/uninstall.ts 头注释第 1 条
  test("给的是一条命令,而且认得出平台", () => {
    expect(findProjectDirsCommand("/home/u", "linux")).toContain("find /home/u")
    expect(findProjectDirsCommand("/home/u", "linux")).toContain(".alfa")
    expect(findProjectDirsCommand("/home/u", "linux")).toContain("node_modules")
    expect(findProjectDirsCommand("C:\\Users\\u", "win32")).toContain("Get-ChildItem")
  })
})
