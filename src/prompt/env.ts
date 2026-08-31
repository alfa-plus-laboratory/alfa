/**
 * 环境块 —— 告诉模型「你现在站在哪」。
 *
 * 只放七件事:工作目录、是不是 git 仓库、平台、日期、shell、自己的版本号、跑的是哪个模型。
 * 克制是有原因的:
 *   - 目录树 / git status 这类会变的东西放进 system,等于每轮都在动 prompt
 *     前缀,cache 直接归零。分支和工作区状态另有去处 —— 挂在一场会话第一句话
 *     上的一份快照(见 prompt/git.ts),历史只增不改,前缀不受影响。
 *   - 「今天是几号」是唯一一个我们主动接受的失效源:模型不知道日期会去猜,
 *     猜出来的年份能让它写出过时的 API 用法。代价是**每天午夜 cache 失效一次**,
 *     换来的是它不会以为现在是训练截止那年。这笔交易划算,但要知道自己在付什么。
 *   - 模型名这一行是**白拿的**:缓存本来就按模型分开存,换模型的那一次无论
 *     写不写它都必然全 miss。而它能省掉的是模型对自己的猜测 —— 一个以为自己
 *     是两年前那一版的模型,会主动绕开它其实有的能力。
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { resolveShell } from "../env/shell.ts"
import { VERSION } from "../update/release.ts"

export interface EnvInput {
  cwd: string
  /** 工作区根(通常是 git 根) */
  root: string
  /** 注入用,测试里固定住 */
  now?: Date
  platform?: string
  shell?: string
  /** `provider/model`,就是 `-m` 那个串。拿不到就不写这一行 */
  model?: string
  /** 注入用,测试里固定住。默认是这个二进制自己的版本 */
  version?: string
}

export function environmentBlock(input: EnvInput): string {
  const now = input.now ?? new Date()
  const lines = [
    "Here is useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${input.cwd}`,
    `  Is directory a git repo: ${isGitRepo(input.root) ? "yes" : "no"}`,
    `  Platform: ${input.platform ?? process.platform}`,
    `  Today's date: ${formatDate(now)}`,
    `  Default shell: ${input.shell ?? defaultShell()}`,
    /**
     * ★ 自己的版本号。
     *
     * 不写的话模型只能猜自己是哪一版 —— 而用户在会话里问「你这个版本有没有
     * XX」「怎么升级」是常事,它猜出来的答案听起来一样自信。写进来还有一个
     * 附带好处:用户贴出来的一段对话自带版本,不用再回头问一遍。
     *
     * 它一个版本只变一次,对 prompt 缓存几乎没有影响(换二进制那次本来就全 miss)
     */
    `  alfa version: ${input.version ?? VERSION}`,
    "</env>",
  ]
  // 模型名排在最后、在 </env> 之前 —— 上面几行讲的是环境,这一行讲的是它自己
  if (input.model) lines.splice(lines.length - 1, 0, `  Model: ${input.model}`)
  if (input.root !== input.cwd) {
    lines.splice(3, 0, `  Workspace root: ${input.root}`)
  }
  return lines.join("\n")
}

/** .git 可能是目录(普通仓库)也可能是文件(worktree / submodule),两种都算。 */
function isGitRepo(root: string): boolean {
  return existsSync(join(root, ".git"))
}

/** YYYY-MM-DD,本地时区。用 ISO 的 UTC 会让时区靠东的用户在半夜看到"昨天"。 */
function formatDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * ★ 问的是**真正会被用来跑命令的那个** shell(见 env/shell.ts),不是 $SHELL。
 *
 * 两者在 Windows 上完全不是一回事:那边没有 $SHELL,这一行原来一律写 "unknown",
 * 而模型看到 unknown 会默认自己在 POSIX 下,接着写一串 `| head -20`。它现在会
 * 老实写着 bash / powershell / cmd —— 环境块的意义就是让它别去猜。
 */
function defaultShell(): string {
  return resolveShell().label
}
