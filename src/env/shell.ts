/**
 * 命令跑在哪个 shell 里。
 *
 * ── 为什么这件事值一个模块 ──
 * 原来是 bash 工具里的一行 `process.env.SHELL || "/bin/bash"`。那一行在 Windows 上
 * 两头都落空:没有 $SHELL,也没有 /bin/bash —— spawn 直接 ENOENT,而 bash 工具把
 * spawn 失败**当成进程退出**处理(错误本该由 stderr 带出来,可这时候连进程都没
 * 起来,stderr 是空的)。用户看到的现象是:模型说它几乎所有命令都用不了,每一条
 * 都返回 "(no output)"。一行找不到的路径,表现出来是整个工具坏掉。
 *
 * ── Windows 上优先找真的 bash,而不是直接上 PowerShell ──
 * 这个程序里有三样东西建立在 POSIX shell 语法上:拆句(tool/bash/scan.ts)、
 * 权限规则表(permission/rules.ts)、还有 bash 工具描述里教模型写的那些管道。
 * 换成 PowerShell,这三样同时失准 —— 而 Git for Windows 几乎装在每一台写代码的
 * Windows 机器上,它自带的 bash 让上面三样原样成立。所以顺序是:
 *
 *   $ALFA_SHELL → Git for Windows 的 bash → PATH 上的 bash → pwsh → powershell → cmd
 *
 * ★ PATH 上的 bash 要**排除 System32\bash.exe**:那是 WSL 的启动器,它把命令送进
 *   另一个文件系统命名空间 —— `C:\repo` 在那边根本不存在,而报错会是一句
 *   "no such file or directory",没有任何线索指向"你其实进了 WSL"。
 *
 * ── 落到 PowerShell / cmd 时,调用方要知道 ──
 * 所以 posix 这个标志是给外面用的:拆句和规则表不再可信,那时候每条命令都要问
 * (见 tool/bash.ts),模型也要被告知别再写 `| head -20`(见工具描述)。
 */
import { existsSync } from "node:fs"
import { readEnv } from "./vars.ts"

export interface Shell {
  /** 可执行文件路径,直接交给 spawn */
  file: string
  /** 把一条命令包成 argv */
  argsFor(command: string): string[]
  /**
   * 它认的是不是 POSIX 语法。
   *
   * false 的后果不只是"语法不一样":我们的拆句器会把一条 PowerShell 命令按
   * POSIX 规则拆错,于是授权授的是**另一条命令**。所以这个标志一路传到门卫。
   */
  posix: boolean
  /** 给人和模型看的名字:bash / powershell / cmd */
  label: string
  /**
   * 能不能起在独立进程组里。
   *
   * POSIX 上必须开(见 tool/bash/kill.ts:杀不干净进程树的唯一办法是负 pid)。
   * Windows 上必须关 —— 那边 detached 的含义是"给它自己开一个控制台窗口",
   * 每跑一条命令闪一个黑框。进程树那边用 taskkill /T 收拾。
   */
  detached: boolean
}

export interface ResolveOptions {
  platform?: string
  env?: NodeJS.ProcessEnv
  /** 注入用。默认查文件系统 */
  exists?: (path: string) => boolean
  /** 注入用。默认查 PATH */
  which?: (name: string) => string | undefined
}

let cached: Shell | undefined

/**
 * 这台机器上用哪个 shell。**结果缓存**:一次会话里问很多遍(每条命令一遍),
 * 而答案在进程活着期间不会变,没必要每次都去敲文件系统。
 *
 * 传了 options 就不走缓存 —— 那是测试在问"如果这台机器长成那样呢"。
 */
export function resolveShell(options: ResolveOptions = {}): Shell {
  const fresh = Object.keys(options).length > 0
  if (!fresh && cached) return cached

  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? defaultExists
  const which = options.which ?? defaultWhich

  const resolved = platform === "win32" ? windowsShell(env, exists, which) : posixShell(env["SHELL"] || "/bin/bash")
  if (!fresh) cached = resolved
  return resolved
}

/** 给测试用:把缓存清掉 */
export function resetShellCache(): void {
  cached = undefined
}

function posixShell(file: string): Shell {
  return {
    file,
    argsFor: (command) => ["-c", command],
    posix: true,
    label: baseName(file),
    detached: true,
  }
}

function windowsShell(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  which: (name: string) => string | undefined,
): Shell {
  // 用户自己指的最优先。他可能装在一个我们猜不到的地方(scoop、便携版、
  // 公司镜像),而"猜不到"不该等于"用不了"
  const explicit = readEnv("SHELL", env)
  if (explicit) return classify(explicit, false)

  // Git for Windows。装 git 就有,路径是固定的几个
  const programFiles = [env["ProgramFiles"], env["ProgramW6432"], env["ProgramFiles(x86)"], "C:\\Program Files"]
  const candidates: string[] = []
  for (const root of programFiles) {
    if (root) candidates.push(winPath(root, "Git", "bin", "bash.exe"))
  }
  // 用户级安装(不需要管理员权限的那种,现在是 Git 安装器的默认选项之一)
  if (env["LOCALAPPDATA"]) candidates.push(winPath(env["LOCALAPPDATA"], "Programs", "Git", "bin", "bash.exe"))
  for (const candidate of candidates) {
    if (exists(candidate)) return classify(candidate, false)
  }

  // PATH 上的 bash —— 但不要 WSL 那个(见文件头)
  const onPath = which("bash")
  if (onPath && !isWSLLauncher(onPath)) return classify(onPath, false)

  // 退化档。到这儿说明这台机器上没有 POSIX shell,拆句和规则表都不再可信
  for (const name of ["pwsh", "powershell", "cmd"]) {
    const found = which(name)
    if (found) return classify(found, false)
  }
  // which 全都问不到(PATH 坏了?)。cmd 的位置由 ComSpec 给,它是 Windows 上
  // 唯一一个可以硬写死的路径
  return classify(env["ComSpec"] || "C:\\Windows\\System32\\cmd.exe", false)
}

/**
 * 拼一条 Windows 路径。
 *
 * 不用 node:path 的 join:它按**当前**平台拼分隔符,而这段代码永远在描述
 * Windows 上的路径 —— 在 Linux 上跑测试时它会拼出 `C:\Program Files/Git/bin`,
 * 一个既不像 Windows 也不像 POSIX 的东西。
 */
function winPath(root: string, ...parts: string[]): string {
  return [root.replace(/[\\/]+$/, ""), ...parts].join("\\")
}

/**
 * 取文件名。**两种分隔符都认** —— 不用 node:path 的 basename 是因为它按**当前**
 * 平台判:在 Linux 上跑测试时,`C:\...\powershell.exe` 整条会被当成一个文件名。
 * 而这个模块的全部意义就是回答"另一个平台上会怎样"。
 */
function baseName(file: string): string {
  const parts = file.split(/[\\/]/)
  return parts[parts.length - 1] ?? file
}

/** `C:\Windows\System32\bash.exe` 是 WSL 的启动器,不是一个能操作本机文件的 shell */
function isWSLLauncher(path: string): boolean {
  return /[\\/]windows[\\/](system32|sysnative)[\\/]bash(\.exe)?$/i.test(path)
}

/**
 * 按文件名认它是哪一种 shell。
 *
 * 认不出来一律当 POSIX:走到这儿的只可能是用户自己用 $ALFA_SHELL 指的那个,
 * 而会去设这个变量的人指的基本都是某个 sh 家族的东西。猜错的代价是他自己看得见
 * (第一条命令就报语法错),而猜成 PowerShell 会让每条命令都白白多问一次。
 */
function classify(file: string, detached: boolean): Shell {
  const name = baseName(file).toLowerCase().replace(/\.exe$/, "")
  if (name === "powershell" || name === "pwsh") {
    return {
      file,
      // -NoProfile:用户的 profile 会打印横幅、改编码、设别名 —— 那些东西混进
      // 命令输出里,模型读到的就不是命令本身的输出了。
      // -NonInteractive:没有 TTY,任何一句确认提示都会挂到超时
      argsFor: (command) => ["-NoProfile", "-NonInteractive", "-Command", command],
      posix: false,
      label: name,
      detached,
    }
  }
  if (name === "cmd") {
    return {
      // /d 跳过 AutoRun 注册表项(同 -NoProfile 的理由),/s /c 让整条命令原样交过去
      argsFor: (command) => ["/d", "/s", "/c", command],
      file,
      posix: false,
      label: "cmd",
      detached,
    }
  }
  return { file, argsFor: (command) => ["-c", command], posix: true, label: name, detached }
}

/** 同步:一场会话只问一次,做成异步只会给 bash 工具的第一次调用多一层 await */
function defaultExists(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

function defaultWhich(name: string): string | undefined {
  return Bun.which(name) ?? undefined
}
