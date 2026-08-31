/**
 * `alfa uninstall` —— 把这台机器上属于 alfa 的东西删干净,**包括二进制自己**。
 *
 * ── 和 `/reset` 的分工 ──
 * `/reset` 是「再走一遍第一次」:删配置和数据,程序留着。这条是「我不用了」:
 * 同样那些东西,外加装在 PATH 上的那个文件。之前没有它的后果是,用户清完数据
 * 之后还得自己去翻二进制装在哪 —— 而 `~/.local/bin` 那个路径只写在安装脚本里。
 *
 * ── ★ 为什么只做终端子命令,不做 `/uninstall` ──
 * 不是"从会话里删自己不体面",是有具体的失败:
 *
 * 1. reset.ts 的文件头记着,删除必须发生在 `store.close()` 之后 —— SQLite 关库
 *    时会做 WAL checkpoint,库文件被删了它照写不误,于是刚删掉的 sessions.db
 *    又躺回原地。会话内部这个顺序本来就微妙。
 * 2. 再叠一层「顺便把正在跑的这个程序删掉」,进程就进入了一个对着不存在的自己
 *    继续操作的状态 —— 而它还握着已解析的模型、打开的库、装好的注册表。
 *
 * 所以入口只有一个,而且是在会话之外。
 *
 * ── 两段式,和 /reset 同一条规矩 ──
 * `alfa uninstall` 只**列出**要删什么;`alfa uninstall confirm` 才动手。
 * 不是 y/N:这件事不可撤销,而列表是唯一能让人在按下去之前发现「等等,那里面
 * 还有我不想丢的东西」的机会。
 *
 * ── 刻意不做的三件事 ──
 * 1. **不扫描家目录**找散落的 `.alfa/`。一个会遍历你整个 home 删东西的卸载器,
 *    正是不该存在的那种东西。打印一条 find 命令,由人自己看 —— 和 xdg.ts 那条
 *    「要搬的人自己 mv 一下,那是一条看得见的命令」是同一条立场。
 * 2. **不碰 PATH**。安装脚本从来没往 rc 文件里写过东西(install.sh 只是打印一行
 *    让用户自己加),而 `~/.local/bin` 里多半还装着别人的工具。
 * 3. **Windows 上不 spawn 一个游离进程去删自己**。删不掉正在运行的 exe 是真的,
 *    但「后台留一个进程等着删文件」这个形状,是安全评审第一个会圈出来的东西。
 *    挪成 `.uninstalled`(不用 `.old` —— 那是 upgrade 的名字,而它靠"下次启动"清理,
 *    卸载没有下次启动),然后把剩下那一条命令打印给用户。
 */
import { existsSync, renameSync, rmSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { ALFA_DIR } from "../prompt/init.ts"
import { resetScope, type ResetTarget } from "./reset.ts"

export interface UninstallScope {
  targets: ResetTarget[]
  /** 装着二进制的那个目录,给「PATH 里那一行可以撤了」那句话用 */
  binaryDir?: string
}

/** 跑源码时 `process.execPath` 是 bun 自己 —— 照着删就是删掉用户的 bun */
export function runningFromSource(execPath: string = process.execPath): boolean {
  return /(^|[/\\])bun(\.exe)?$/.test(execPath)
}

/**
 * 算出要删什么。**只看,不动**。
 *
 * 二进制排在最后:上面两条是「你的东西」(配置、凭据、会话),它是「这个程序」。
 * 人扫这张表时最该先看见的是前者 —— 二进制丢了还能再装,auth.json 丢了不能。
 */
export function uninstallScope(root: string, execPath: string = process.execPath): UninstallScope {
  const scope = resetScope(root)
  const targets = [...scope.global, ...scope.project]

  if (runningFromSource(execPath)) return { targets }
  if (!existsSync(execPath)) return { targets }

  targets.push({
    path: execPath,
    what: "the alfa binary itself",
    bytes: sizeOfFile(execPath),
  })
  return { targets, binaryDir: dirname(execPath) }
}

export interface UninstallResult {
  removed: string[]
  failed: Array<{ path: string; why: string }>
  /**
   * Windows 上删不掉、只能挪开的那个。有值时必须把它打印出来 ——
   * 一个「装完还剩一步」的卸载器,不说那一步就等于没卸干净
   */
  parked?: string
}

/**
 * 真删。
 *
 * 单个失败不中断:删了一半就退出的话,用户处在一个比开始时更糟的状态,而且
 * 不知道糟在哪。哪个没删掉照实报出来,他自己 rm 一下就是了。
 *
 * ★ 二进制放在最后删。前面那些是普通目录,删起来不会出意外;而删自己这一步在
 *   Windows 上注定失败(文件被自己的进程锁着),要走挪开那条路。顺序反过来的话,
 *   一次 Windows 上的卸载会在挪文件那儿卡住,而配置和凭据**一个都没删掉**。
 */
export function performUninstall(targets: ResetTarget[], execPath: string = process.execPath): UninstallResult {
  const removed: string[] = []
  const failed: Array<{ path: string; why: string }> = []
  let parked: string | undefined

  const isSelf = (path: string): boolean => path === execPath
  const ordered = [...targets.filter((one) => !isSelf(one.path)), ...targets.filter((one) => isSelf(one.path))]

  for (const target of ordered) {
    try {
      rmSync(target.path, { recursive: true, force: true })
      removed.push(target.path)
    } catch (error) {
      // POSIX 上删一个正在跑的二进制是**合法的**(进程握的是 inode,不是路径),
      // 所以走到这条 catch 基本只有 Windows。挪开是那边唯一能做的事
      if (isSelf(target.path)) {
        const moved = `${target.path}.uninstalled`
        try {
          rmSync(moved, { force: true })
          renameSync(target.path, moved)
          parked = moved
          continue
        } catch {
          // 挪也挪不动,那就照实说
        }
      }
      failed.push({ path: target.path, why: (error as Error).message })
    }
  }

  return { removed, failed, ...(parked ? { parked } : {}) }
}

/** 找散落在各个仓库里的 `.alfa/` 的那条命令。我们不去跑它,只把它交给用户 */
export function findProjectDirsCommand(home: string, platform: string = process.platform): string {
  if (platform === "win32") {
    return `Get-ChildItem -Path '${home}' -Recurse -Directory -Filter '${ALFA_DIR}' -ErrorAction SilentlyContinue`
  }
  return `find ${home} -type d -name '${ALFA_DIR}' -not -path '*/node_modules/*' 2>/dev/null`
}

/** 单个文件的大小。算不动的当 0 —— 这个数只用来给人一个量级 */
function sizeOfFile(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
