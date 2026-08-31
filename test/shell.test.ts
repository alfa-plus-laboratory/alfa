/**
 * 命令跑在哪个 shell 里。
 *
 * 这里守的是 Windows 那条路 —— 而这台开发机不是 Windows,所以平台、文件系统、
 * PATH 全部注入。**这不是"聊胜于无的模拟"**:被守住的那几条恰恰是没有真机也
 * 会错的判断(选谁、不选谁、包成什么 argv),而它们正是上一次整个 bash 工具在
 * Windows 上失灵的原因。
 */
import { describe, expect, test } from "bun:test"
import { resolveShell } from "../src/env/shell.ts"

/** 一台干净的 Windows:装了 Git,PATH 上还有 WSL 的 bash.exe */
const WINDOWS_ENV = {
  ProgramFiles: "C:\\Program Files",
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  ComSpec: "C:\\Windows\\System32\\cmd.exe",
} as NodeJS.ProcessEnv

const win = (options: {
  env?: NodeJS.ProcessEnv
  files?: string[]
  path?: Record<string, string>
}) =>
  resolveShell({
    platform: "win32",
    env: options.env ?? WINDOWS_ENV,
    exists: (p) => (options.files ?? []).includes(p),
    which: (name) => options.path?.[name],
  })

describe("POSIX", () => {
  test("$SHELL 说了算", () => {
    const shell = resolveShell({ platform: "linux", env: { SHELL: "/bin/zsh" } })
    expect(shell.file).toBe("/bin/zsh")
    expect(shell.label).toBe("zsh")
    expect(shell.posix).toBe(true)
    // 独立进程组是 POSIX 上杀干净进程树的唯一办法(见 tool/bash/kill.ts)
    expect(shell.detached).toBe(true)
  })

  test("没有 $SHELL 就 /bin/bash", () => {
    expect(resolveShell({ platform: "linux", env: {} }).file).toBe("/bin/bash")
  })

  test("命令包成 -c 一段", () => {
    expect(resolveShell({ platform: "linux", env: {} }).argsFor("ls -la | wc -l")).toEqual(["-c", "ls -la | wc -l"])
  })
})

describe("Windows", () => {
  test("★ 优先 Git for Windows 的 bash —— 拆句器和规则表都建立在 POSIX 语法上", () => {
    const shell = win({
      files: ["C:\\Program Files\\Git\\bin\\bash.exe"],
      path: { pwsh: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
    })
    expect(shell.file).toBe("C:\\Program Files\\Git\\bin\\bash.exe")
    expect(shell.posix).toBe(true)
    // ★ Windows 上 detached 的含义是"自己开一个控制台窗口",一律关掉
    expect(shell.detached).toBe(false)
  })

  test("用户级安装的 Git 也认", () => {
    const shell = win({ files: ["C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe"] })
    expect(shell.posix).toBe(true)
    expect(shell.label).toBe("bash")
  })

  test("★ PATH 上的 System32\\bash.exe 是 WSL 启动器,不能要", () => {
    // 要了的话命令会跑进另一个文件系统命名空间,C:\repo 在那边根本不存在
    const shell = win({
      path: { bash: "C:\\Windows\\System32\\bash.exe", powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" },
    })
    expect(shell.label).toBe("powershell")
    expect(shell.posix).toBe(false)
  })

  test("PATH 上别处的 bash(scoop / msys2)照收", () => {
    const shell = win({ path: { bash: "C:\\msys64\\usr\\bin\\bash.exe" } })
    expect(shell.file).toBe("C:\\msys64\\usr\\bin\\bash.exe")
    expect(shell.posix).toBe(true)
  })

  test("没有任何 POSIX shell 时退化:pwsh → powershell → cmd", () => {
    expect(win({ path: { pwsh: "pwsh.exe", powershell: "powershell.exe", cmd: "cmd.exe" } }).label).toBe("pwsh")
    expect(win({ path: { powershell: "powershell.exe", cmd: "cmd.exe" } }).label).toBe("powershell")
    expect(win({ path: { cmd: "cmd.exe" } }).label).toBe("cmd")
  })

  test("连 which 都问不到时落到 ComSpec —— 总得有个能跑的", () => {
    expect(win({}).file).toBe("C:\\Windows\\System32\\cmd.exe")
  })

  test("$ALFA_SHELL 压过一切 —— 装在猜不到的地方不该等于用不了", () => {
    const shell = win({
      env: { ...WINDOWS_ENV, ALFA_SHELL: "D:\\portable\\git\\bin\\bash.exe" },
      files: ["C:\\Program Files\\Git\\bin\\bash.exe"],
    })
    expect(shell.file).toBe("D:\\portable\\git\\bin\\bash.exe")
    expect(shell.posix).toBe(true)
  })

  test("★ 各自包成自己认的 argv —— 包错的话第一条命令就报语法错", () => {
    const bash = win({ files: ["C:\\Program Files\\Git\\bin\\bash.exe"] })
    expect(bash.argsFor("git status")).toEqual(["-c", "git status"])

    const ps = win({ path: { powershell: "powershell.exe" } })
    // -NoProfile:用户 profile 打印的横幅会混进命令输出;-NonInteractive:没有 TTY
    expect(ps.argsFor("git status")).toEqual(["-NoProfile", "-NonInteractive", "-Command", "git status"])

    const cmd = win({ path: { cmd: "cmd.exe" } })
    expect(cmd.argsFor("git status")).toEqual(["/d", "/s", "/c", "git status"])
  })
})
