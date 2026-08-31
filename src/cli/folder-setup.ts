/**
 * 第一次在一个文件夹里跑 alfa 时问的那两句。
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
 * ── ★ 两句,不是四句 ──
 * 「中间栏画什么」和「侧栏开不开」是同一个问题的两半:用户心里想的是"这个
 * 仓库我要什么样的界面",不是两个独立开关。拆成两问的代价是每进一个新仓库
 * 多按一次回车,而多按的那一次会让这张卡片从"帮我配一下"变成"又来了"。
 *
 * ── 空目录不问信任 ──
 * 里面一个文件都没有的地方,没有任何东西能对模型说话。为一个空目录问一句
 * "要信任它吗",问的是一个没有内容的问题 —— 而每一个没有内容的问题都在
 * 训练用户闭着眼按回车。
 *
 * ── 为什么在进全屏之前问 ──
 * 答案决定的正是全屏界面长什么样。进去之后再问就得先画一遍旧样子、再当着
 * 用户的面重排一次。而且这里能直接用 readLine —— 那条路要求 keyboard 还
 * 没接管 stdin(见 cli/main.ts 里调用它的位置)。
 */
import { type Config, type ViewMode } from "../config/config.ts"
import { isEmptyFolder, type FolderChoice } from "../config/folders.ts"
import { homePath } from "../fs/workspace.ts"
import { t } from "../i18n/index.ts"
import { InputCancelled, readLine } from "./secret-input.ts"
import { theme } from "./theme.ts"

/** 四种排布。顺序就是列出来的顺序,第一条是默认 */
const LAYOUTS: Array<{ key: string; view: ViewMode; panels: boolean }> = [
  { key: "1", view: "session", panels: false },
  { key: "2", view: "session", panels: true },
  { key: "3", view: "stream", panels: false },
  { key: "4", view: "stream", panels: true },
]

export interface FolderSetupDeps {
  root: string
  config: Config
  output?: NodeJS.WriteStream
  /** 注入用。测试里给一个假的目录列表 */
  readdir?: (dir: string) => string[]
  /** 注入用。测试里按顺序喂答案 */
  ask?: (prompt: string) => Promise<string>
}

/**
 * 问一次。
 *
 * 返回 undefined = 用户按了 Ctrl-C。**那种情况什么都不存** —— 下次进来再问一遍。
 * 存一份"他没回答的答案"下来,等于用一次逃跑替他做了决定。
 */
export async function folderSetup(deps: FolderSetupDeps): Promise<FolderChoice | undefined> {
  const out = deps.output ?? process.stdout
  const ask = deps.ask ?? ((prompt: string) => readLine(prompt))

  out.write("\n" + theme.bold(`  ${t.folderSetupTitle(homePath(deps.root))}`) + "\n")
  out.write(theme.dim(`  ${t.folderSetupWhere}`) + "\n\n")

  try {
    out.write(theme.bold(`  ${t.folderSetupLayout}`) + "\n")
    for (const [index, option] of LAYOUTS.entries()) {
      const label = t.folderSetupLayoutOptions[index]!
      out.write(
        theme.bold(`    ${option.key}  `) +
          label.name.padEnd(28) +
          theme.dim(label.hint) +
          (index === 0 ? theme.dim(`  (${t.folderSetupDefault})`) : "") +
          "\n",
      )
    }
    const picked = (await ask(theme.bold(`  ${t.folderSetupChoose}`) + theme.dim(" [1]: "))).trim()
    // 打错的当默认。这张卡片不该有"你选错了,再来一次" —— 每一条都随时改得回来
    const layout = LAYOUTS.find((one) => one.key === picked) ?? LAYOUTS[0]!

    const trust = await askTrust(deps, out, ask)
    if (trust === undefined) return undefined

    out.write(theme.dim(`\n  ${t.folderSetupSaved}`) + "\n\n")
    return { view: layout.view, panels: layout.panels, trust }
  } catch (error) {
    if (error instanceof InputCancelled) return undefined
    throw error
  }
}

/**
 * 信任那一问。
 *
 * 空目录直接给 trusted 且**一个字都不写** —— 见文件头。
 */
async function askTrust(
  deps: FolderSetupDeps,
  out: NodeJS.WriteStream,
  ask: (prompt: string) => Promise<string>,
): Promise<FolderChoice["trust"] | undefined> {
  if (isEmptyFolder(deps.root, deps.readdir)) return "trusted"

  out.write("\n" + theme.bold(`  ${t.folderSetupTrust}`) + "\n")
  for (const line of t.folderSetupTrustWhy) out.write(theme.dim(`  ${line}`) + "\n")
  out.write(
    theme.bold("    1  ") +
      t.folderSetupTrustYes.padEnd(28) +
      theme.dim(`(${t.folderSetupDefault})`) +
      "\n" +
      theme.bold("    2  ") +
      t.folderSetupTrustCheck.padEnd(28) +
      theme.dim(t.folderSetupTrustCheckHint) +
      "\n",
  )
  const answer = (await ask(theme.bold(`  ${t.folderSetupChoose}`) + theme.dim(" [1]: "))).trim()
  return answer === "2" ? "checking" : "trusted"
}
