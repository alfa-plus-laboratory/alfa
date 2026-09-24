/**
 * Which shell a command runs in.
 *
 * What's guarded here is the Windows path — and this dev machine isn't Windows, so the
 * platform, the filesystem and PATH are all injected. **This is not "a mock that's better
 * than nothing"**: the checks guarded here are exactly the decisions that go wrong even
 * without a real machine (which one to pick, which one not to, what argv to wrap it in),
 * and they are exactly why the whole bash tool broke on Windows last time.
 */
import { describe, expect, test } from "bun:test"
import { resolveShell } from "../src/env/shell.ts"

/**
 * A bare Windows box: only the env vars the resolver reads to guess install locations
 * (ProgramFiles, LOCALAPPDATA) and the last-resort cmd (ComSpec). No shell is installed
 * here — each test puts Git / WSL / PowerShell in place through `files` and `path`.
 */
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
  test("$SHELL decides", () => {
    const shell = resolveShell({ platform: "linux", env: { SHELL: "/bin/zsh" } })
    expect(shell.file).toBe("/bin/zsh")
    expect(shell.label).toBe("zsh")
    expect(shell.posix).toBe(true)
    // a separate process group is the only way to kill a process tree cleanly on POSIX
    // (see tool/bash/kill.ts)
    expect(shell.detached).toBe(true)
  })

  test("no $SHELL means /bin/bash", () => {
    expect(resolveShell({ platform: "linux", env: {} }).file).toBe("/bin/bash")
  })

  test("the command is wrapped as a single -c argument", () => {
    expect(resolveShell({ platform: "linux", env: {} }).argsFor("ls -la | wc -l")).toEqual(["-c", "ls -la | wc -l"])
  })
})

describe("Windows", () => {
  test("★ prefers Git for Windows bash — the splitter and rule table are built on POSIX syntax", () => {
    const shell = win({
      files: ["C:\\Program Files\\Git\\bin\\bash.exe"],
      path: { pwsh: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
    })
    expect(shell.file).toBe("C:\\Program Files\\Git\\bin\\bash.exe")
    expect(shell.posix).toBe(true)
    // ★ on Windows, detached means "open a console window of its own"; always off
    expect(shell.detached).toBe(false)
  })

  test("a per-user Git install is found too", () => {
    const shell = win({ files: ["C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe"] })
    expect(shell.posix).toBe(true)
    expect(shell.label).toBe("bash")
  })

  test("★ System32\\bash.exe on PATH is the WSL launcher and is refused", () => {
    // take it and commands run in another filesystem namespace, where C:\repo doesn't
    // even exist
    const shell = win({
      path: { bash: "C:\\Windows\\System32\\bash.exe", powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" },
    })
    expect(shell.label).toBe("powershell")
    expect(shell.posix).toBe(false)
  })

  test("a bash elsewhere on PATH (scoop / msys2) is accepted", () => {
    const shell = win({ path: { bash: "C:\\msys64\\usr\\bin\\bash.exe" } })
    expect(shell.file).toBe("C:\\msys64\\usr\\bin\\bash.exe")
    expect(shell.posix).toBe(true)
  })

  test("with no POSIX shell, falls back: pwsh → powershell → cmd", () => {
    expect(win({ path: { pwsh: "pwsh.exe", powershell: "powershell.exe", cmd: "cmd.exe" } }).label).toBe("pwsh")
    expect(win({ path: { powershell: "powershell.exe", cmd: "cmd.exe" } }).label).toBe("powershell")
    expect(win({ path: { cmd: "cmd.exe" } }).label).toBe("cmd")
  })

  test("when even which finds nothing, falls back to ComSpec — something has to run", () => {
    expect(win({}).file).toBe("C:\\Windows\\System32\\cmd.exe")
  })

  test("$ALFA_SHELL overrides everything — installing somewhere unguessable shouldn't mean unusable", () => {
    const shell = win({
      env: { ...WINDOWS_ENV, ALFA_SHELL: "D:\\portable\\git\\bin\\bash.exe" },
      files: ["C:\\Program Files\\Git\\bin\\bash.exe"],
    })
    expect(shell.file).toBe("D:\\portable\\git\\bin\\bash.exe")
    expect(shell.posix).toBe(true)
  })

  test("★ each shell gets the argv it understands — wrap it wrong and the first command is a syntax error", () => {
    const bash = win({ files: ["C:\\Program Files\\Git\\bin\\bash.exe"] })
    expect(bash.argsFor("git status")).toEqual(["-c", "git status"])

    const ps = win({ path: { powershell: "powershell.exe" } })
    // -NoProfile: a banner printed by the user's profile would mix into command output;
    // -NonInteractive: there is no TTY
    expect(ps.argsFor("git status")).toEqual(["-NoProfile", "-NonInteractive", "-Command", "git status"])

    const cmd = win({ path: { cmd: "cmd.exe" } })
    expect(cmd.argsFor("git status")).toEqual(["/d", "/s", "/c", "git status"])
  })
})
