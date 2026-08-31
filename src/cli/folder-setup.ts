/**
 * 第一次在一个文件夹里跑 alfa 时那张卡片的**驱动**。
 *
 * 卡片本身(问什么、怎么画、按键怎么走)在 tui/panes/setup.ts —— 那边是纯的。
 * 这里只干三件事:进全屏、把按键喂给它、把答案交回去。
 *
 * ── 为什么值得打断他一次 ──
 * 这两件事都属于「不问就只能替他猜,而猜错了他多半不知道能改」:
 *
 *   1. 屏幕怎么排。三栏很好用,但在一个只是 clone 下来看两眼的仓库里、或者
 *      在一块 80 列的屏幕上,文件树占掉的正是对话要用的地方。
 *   2. 这个文件夹能不能对模型说话。它的 AGENTS.md / CLAUDE.md 会进 system
 *      prompt,它的 `.alfa/mcp.json` 能指定要跑的进程 —— 而 clone 谁的仓库
 *      是一件太随手的事。
 *
 * ── ★ 位置变了:现在在 keyboard.open() **之后** ──
 * 上一版走 readLine,那条路要求 keyboard 还没接管 stdin,所以它必须排在前面。
 * 全屏卡片正好反过来 —— 它要的就是 raw 模式下的按键。合成器和主界面**共用
 * 同一个 Screen 实例**(由调用方创建后传进来):各自 new 一个的话,卡片退出
 * 时会离开备用屏、主界面再进一次,中间闪一下用户刚看完的横幅。
 *
 * ── 空目录不问信任 ──
 * 里面一个文件都没有的地方,没有任何东西能对模型说话。为一个空目录问一句
 * "要信任它吗",问的是一个没有内容的问题 —— 而每一个没有内容的问题都在
 * 训练用户闭着眼按回车。
 */
import type { Keyboard } from "./keyboard.ts"
import type { Screen } from "../tui/screen.ts"
import { type Config } from "../config/config.ts"
import { isEmptyFolder, type FolderChoice } from "../config/folders.ts"
import { homePath } from "../fs/workspace.ts"
import { SetupCard } from "../tui/panes/setup.ts"

export interface FolderSetupDeps {
  root: string
  config: Config
  screen: Screen
  keyboard: Keyboard
  /** 注入用。测试里给一个假的目录列表 */
  readdir?: (dir: string) => string[]
}

/**
 * 问一次。
 *
 * 返回 undefined = 用户按了 Ctrl-C。**那种情况什么都不存** —— 下次进来再问一遍。
 * 存一份"他没回答的答案"下来,等于用一次逃跑替他做了决定。
 */
export async function folderSetup(deps: FolderSetupDeps): Promise<FolderChoice | undefined> {
  const card = new SetupCard({
    where: homePath(deps.root),
    emptyFolder: isEmptyFolder(deps.root, deps.readdir),
  })
  const { screen, keyboard } = deps

  screen.enter()
  const paint = () => {
    screen.resize()
    screen.begin()
    screen.blit({ x: 0, y: 0, width: screen.width, height: screen.height }, card.render(screen.width, screen.height))
    screen.end()
  }
  paint()

  return await new Promise<FolderChoice | undefined>((resolve) => {
    let settled = false
    let release: (() => void) | undefined
    const finish = (choice: FolderChoice | undefined) => {
      if (settled) return
      settled = true
      release?.()
      resolve(choice)
    }
    release = keyboard.push((key) => {
      // 改大小也走这条路:全屏卡片上的预览小框宽度是算出来的,不重画就错位
      if (key.name === "mouse") return
      const action = card.key(key)
      if (action === "done") return finish(card.choice)
      if (action === "cancel") return finish(undefined)
      paint()
    })
  })
}
