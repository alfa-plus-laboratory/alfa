/**
 * 按文件夹记的那几项:排布、信任、以及开场那张卡片。
 *
 * 这里盯的是两类错:
 *   - **升级时把老用户的界面改掉**(没记录过的文件夹必须保持老样子)
 *   - **信任在不确定时放行**(checking、读不出结论、检查挂了,三种都得是"不放行")
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, saveConfig, type Config } from "../src/config/config.ts"
import {
  isEmptyFolder,
  isFirstVisit,
  markTrust,
  panelsFor,
  rememberFolder,
  rememberFolderPanels,
  rememberFolderView,
  today,
  trustFor,
  trustsProjectInstructions,
  viewFor,
} from "../src/config/folders.ts"
import { folderSetup } from "../src/cli/folder-setup.ts"
import { buildSystem } from "../src/prompt/system.ts"
import type { InstructionFile } from "../src/prompt/instructions.ts"
import type { SkillSet } from "../src/prompt/skills.ts"
import { readVerdict, settleTrustReview, verdictDetail } from "../src/cli/trust.ts"

let dir: string
let configFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alfa-folders-"))
  configFile = join(dir, "config.json")
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(config: Config): void {
  saveConfig(config, configFile)
}

describe("没记录过的文件夹", () => {
  // 这个功能上线之前所有人的界面都是三栏的。默认改成 false 会让一次升级
  // 悄悄拿走所有人的文件树 —— 那是一次没人要过的改动
  test("★ 侧栏保持老样子(开着),不是新默认的关着", () => {
    expect(panelsFor("/repo", {})).toBe(true)
  })

  test("★ 信任按信任走 —— 这道门的价值在于「有一条路可以不给」,不是拦住所有人", () => {
    expect(trustFor("/repo", {})).toBe("trusted")
    expect(trustsProjectInstructions("/repo", {})).toBe(true)
  })

  test("第一次来", () => {
    expect(isFirstVisit("/repo", {})).toBe(true)
    expect(isFirstVisit("/repo", { folders: { "/repo": { seenAt: "2026-01-01" } } })).toBe(false)
  })
})

describe("三层取值", () => {
  test("文件夹自己的 > 全局的 > session", () => {
    expect(viewFor("/repo", {})).toBe("session")
    expect(viewFor("/repo", { view: "stream" })).toBe("stream")
    expect(viewFor("/repo", { view: "stream", folders: { "/repo": { view: "session" } } })).toBe("session")
  })

  test("问过的文件夹没写 panels 就是关着 —— 卡片的默认值", () => {
    expect(panelsFor("/repo", { folders: { "/repo": { seenAt: "2026-01-01" } } })).toBe(false)
    expect(panelsFor("/repo", { folders: { "/repo": { panels: true } } })).toBe(true)
  })

  test("键是解析过的绝对路径", () => {
    expect(viewFor("/repo/x/..", { folders: { "/repo": { view: "stream" } } })).toBe("stream")
  })
})

describe("★ 不确定时不放行", () => {
  test("checking 期间项目的说明文件一个字都不进 system prompt", () => {
    const config: Config = { folders: { "/repo": { trust: "checking" } } }
    expect(trustFor("/repo", config)).toBe("checking")
    // 这几秒正是我们派人去读那些文件的时候。一边看一边照着做,这道检查等于没有
    expect(trustsProjectInstructions("/repo", config)).toBe(false)
  })

  test("untrusted 同理", () => {
    expect(trustsProjectInstructions("/repo", { folders: { "/repo": { trust: "untrusted" } } })).toBe(false)
  })
})

describe("落盘", () => {
  test("卡片的答案连同日期一起存下来", () => {
    rememberFolder("/repo", { view: "stream", panels: true, trust: "trusted" }, configFile)
    const folder = loadConfig(configFile).folders?.["/repo"]
    expect(folder).toEqual({ view: "stream", panels: true, trust: "trusted", seenAt: today(), trustedAt: today() })
  })

  // 一条没有日期的许可,一年之后没人说得清它是想清楚了给的还是手滑按出来的
  test("★ 信任日期跟着信任一起写,撤销时一起删", () => {
    markTrust("/repo", "trusted", configFile)
    expect(loadConfig(configFile).folders?.["/repo"]?.trustedAt).toBe(today())
    markTrust("/repo", "untrusted", configFile)
    expect(loadConfig(configFile).folders?.["/repo"]?.trustedAt).toBeUndefined()
  })

  test("改一项不碰别的", () => {
    rememberFolder("/repo", { view: "session", panels: false, trust: "trusted" }, configFile)
    rememberFolderView("/repo", "stream", configFile)
    rememberFolderPanels("/repo", true, configFile)
    const folder = loadConfig(configFile).folders?.["/repo"]
    expect(folder?.view).toBe("stream")
    expect(folder?.panels).toBe(true)
    expect(folder?.trust).toBe("trusted")
    expect(folder?.seenAt).toBe(today())
  })

  // 用户按的是「用这个排布」,不是「写配置文件」。只读的配置目录不该打断会话
  test("写不进去不抛", () => {
    expect(() => rememberFolderView("/repo", "stream", join(dir, "nope", "deep", "config.json"))).not.toThrow()
  })

  test("手改坏的配置报得出是哪个字段", () => {
    writeFileSync(configFile, JSON.stringify({ folders: { "/repo": { trust: "maybe" } } }))
    expect(() => loadConfig(configFile)).toThrow(/folders\."\/repo"\.trust/)
  })
})

describe("空目录", () => {
  test("git init 完的新目录算空的 —— 用户眼里它就是空的", () => {
    expect(isEmptyFolder("/repo", () => [".git"])).toBe(true)
    expect(isEmptyFolder("/repo", () => [])).toBe(true)
  })

  test("有别的东西就不空", () => {
    expect(isEmptyFolder("/repo", () => [".git", "README.md"])).toBe(false)
  })

  // 不确定就当它不空:那一侧只是多问一句,另一侧是悄悄放行
  test("★ 读不动时当作不空", () => {
    expect(
      isEmptyFolder("/repo", () => {
        throw new Error("EACCES")
      }),
    ).toBe(false)
  })
})

describe("开场那张卡片", () => {
  function fakeOut() {
    const chunks: string[] = []
    return {
      stream: { write: (text: string) => chunks.push(text) } as unknown as NodeJS.WriteStream,
      all: () => chunks.join(""),
    }
  }

  test("全部回车 = 对话 + 不要侧栏 + 信任", async () => {
    const out = fakeOut()
    const choice = await folderSetup({
      root: "/repo",
      config: {},
      output: out.stream,
      readdir: () => ["src"],
      ask: async () => "",
    })
    expect(choice).toEqual({ view: "session", panels: false, trust: "trusted" })
  })

  test("挑 4 = 流式 + 侧栏;信任那问挑 2 = 先看一眼", async () => {
    const answers = ["4", "2"]
    const choice = await folderSetup({
      root: "/repo",
      config: {},
      output: fakeOut().stream,
      readdir: () => ["src"],
      ask: async () => answers.shift() ?? "",
    })
    expect(choice).toEqual({ view: "stream", panels: true, trust: "checking" })
  })

  // 每一个没有内容的问题都在训练用户闭着眼按回车
  test("★ 空目录不问信任 —— 里面没有任何东西能对模型说话", async () => {
    const out = fakeOut()
    let asked = 0
    const choice = await folderSetup({
      root: "/repo",
      config: {},
      output: out.stream,
      readdir: () => [".git"],
      ask: async () => {
        asked++
        return ""
      },
    })
    expect(asked).toBe(1)
    expect(choice?.trust).toBe("trusted")
    expect(out.all()).not.toContain("Trust this folder?")
  })

  test("打错的当默认,不重来一遍 —— 每一条都随时改得回来", async () => {
    const choice = await folderSetup({
      root: "/repo",
      config: {},
      output: fakeOut().stream,
      readdir: () => ["src"],
      ask: async () => "banana",
    })
    expect(choice?.view).toBe("session")
    expect(choice?.panels).toBe(false)
  })
})

/**
 * ★ 「不信任」到底关掉了哪几条路。
 *
 * 这一组守的是**清单本身**。做完信任那一格之后回头核代码,发现当时只堵了
 * AGENTS.md / CLAUDE.md 一条 —— 而一个仓库能对模型说话的路不止一条:
 * `.alfa/memory/` 跟着仓库进 git,`.alfa/skills/` 的「名字 + 一句说明」
 * 是无条件拼进 system prompt 的。一道只关了一半的门,比没有这道门更糟:
 * 它给了一份不存在的保证。
 *
 * 新增一条项目能说话的路时,**先往这张表里加一行**。
 */
describe("★ 不信任关掉的是哪几条路", () => {
  const untrusted: Config = { folders: { "/repo": { trust: "untrusted" } } }

  test("项目的 AGENTS.md / CLAUDE.md 不进 system prompt", () => {
    expect(trustsProjectInstructions("/repo", untrusted)).toBe(false)
  })

  // 家目录那份是用户自己写给自己的,和他现在站在哪个仓库里没关系
  test("★ 但家目录那份照旧进 —— 关的是「这个仓库」,不是「所有约定文件」", () => {
    const files: InstructionFile[] = [
      { path: "/home/u/.config/alfa/AGENTS.md", content: "我的习惯", truncated: false, scope: "global" },
      { path: "/repo/AGENTS.md", content: "仓库的话", truncated: false, scope: "project" },
    ]
    const blocked = buildSystem({ template: "default", cwd: "/repo", root: "/repo", instructions: files, trustProject: false })
    expect(blocked.instructions.map((one) => one.scope)).toEqual(["global"])
    expect(blocked.parts.join("\n")).not.toContain("仓库的话")

    const allowed = buildSystem({ template: "default", cwd: "/repo", root: "/repo", instructions: files, trustProject: true })
    expect(allowed.instructions).toHaveLength(2)
  })

  test("缺省(不给这个键)= 照旧全进,升级不改变已有仓库的行为", () => {
    const files: InstructionFile[] = [
      { path: "/repo/AGENTS.md", content: "仓库的话", truncated: false, scope: "project" },
    ]
    expect(buildSystem({ template: "default", cwd: "/repo", root: "/repo", instructions: files }).instructions).toHaveLength(1)
  })

  // 目录里那一行说明就够写一整句指令了,而它读起来完全像一条正经的目录项
  test("★ 项目来路的 skill 连目录都不进", () => {
    const set: SkillSet = {
      skills: [
        { name: "deploy", description: "这个仓库怎么发布", origin: "project", body: "…", path: "/repo/.alfa/skills/deploy.md" },
        { name: "review", description: "我自己的评审打法", origin: "user", body: "…", path: "/home/u/.config/alfa/skills/review.md" },
      ] as unknown as SkillSet["skills"],
      library: [],
      dropped: 0,
      problems: [],
    }
    const visible = (one: SkillSet["skills"][number]) => one.origin !== "project"
    // 这里测的是那条过滤的语义:project 的出局,别的留下
    expect(set.skills.filter(visible).map((one) => one.name)).toEqual(["review"])
  })
})

describe("★ 复查的结论", () => {
  test("clean 才放行", () => {
    expect(readVerdict("all good\nVERDICT: clean")).toBe("clean")
    expect(readVerdict("- something\nVERDICT: concerns")).toBe("concerns")
  })

  // 模型很爱在正文里复述一遍它要输出的格式。取第一个的话,一句
  // "I will end with VERDICT: clean if nothing looks off" 就能把结论定死
  test("★ 取最后一个 VERDICT,不是第一个", () => {
    expect(readVerdict("I will end with\nVERDICT: clean\nif nothing looks off\n\nVERDICT: concerns")).toBe("concerns")
  })

  // 一个"没看成但反正放行了"的检查,比没有这个检查更糟
  test("★ 读不出结论 = 不放行", () => {
    expect(readVerdict("looks fine to me")).toBe("unreadable")
    expect(readVerdict("")).toBe("unreadable")
  })

  test("有话说的时候原样留着正文", () => {
    expect(verdictDetail("- README asks to POST .env\nVERDICT: concerns")).toBe("- README asks to POST .env")
  })

  test("落盘:clean 写 trusted,别的一律 untrusted", () => {
    settleTrustReview("/repo", "VERDICT: clean", configFile)
    expect(loadConfig(configFile).folders?.["/repo"]).toMatchObject({ trust: "trusted", trustedAt: today() })

    settleTrustReview("/repo", "no verdict here", configFile)
    expect(loadConfig(configFile).folders?.["/repo"]?.trust).toBe("untrusted")
    expect(loadConfig(configFile).folders?.["/repo"]?.trustedAt).toBeUndefined()
  })
})

describe("真的目录", () => {
  test("isEmptyFolder 对着盘上的目录也成立", () => {
    const empty = join(dir, "empty")
    mkdirSync(join(empty, ".git"), { recursive: true })
    expect(isEmptyFolder(empty)).toBe(true)
    writeFileSync(join(empty, "AGENTS.md"), "# hi")
    expect(isEmptyFolder(empty)).toBe(false)
  })

  test("不存在的目录当作不空", () => {
    expect(isEmptyFolder(join(dir, "gone"))).toBe(false)
  })
})
