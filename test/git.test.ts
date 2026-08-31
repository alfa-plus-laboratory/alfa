/**
 * 仓库快照。
 *
 * 采集这一半跑的是真的 git —— 桩掉的话,这个文件测的就只是"我拼字符串的手法
 * 没变",而这段代码真正会出问题的地方全在 git 那边:空仓库里 HEAD 还不存在、
 * detached 时分支名是什么、porcelain 的第一列有几个空格。
 *
 * ★ 最后一组盯的是**它不能出现在 system prompt 里**。写进去不会报错、不会
 *   typecheck 失败,只会让每一次 commit 把整段前缀的缓存打掉 —— 和账单里
 *   cache_creation 悄悄翻倍之间,隔着的只有这条测试。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectGitSnapshot, gitContextBlock, renderGitSnapshot } from "../src/prompt/git.ts"
import { buildSystem } from "../src/prompt/system.ts"

let dir: string

/** 真跑 git。测试仓库要自带身份,否则没配 user.email 的机器上 commit 会失败 */
const git = (...args: string[]) => {
  const proc = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  if (!proc.success) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
  return proc.stdout.toString().trim()
}

const init = () => {
  git("init", "--quiet", "--initial-branch=main")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "Test")
  git("config", "commit.gpgsign", "false")
}

const commit = (message: string) => git("commit", "--quiet", "--allow-empty", "-m", message)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "apc-git-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("collectGitSnapshot", () => {
  test("不是仓库就整块不挂 —— 一段写着「no git」的文字每一场都在花钱讲一件不存在的事", () => {
    expect(collectGitSnapshot(dir)).toBeUndefined()
    expect(gitContextBlock(dir)).toBeUndefined()
  })

  test("分支、改动、最近的提交", () => {
    init()
    commit("first")
    commit("second")
    writeFileSync(join(dir, "a.txt"), "hi")

    const snapshot = collectGitSnapshot(dir)!
    expect(snapshot.head).toBe("main")
    expect(snapshot.detached).toBe(false)
    expect(snapshot.mainBranch).toBe("main")
    expect(snapshot.status).toEqual(["?? a.txt"])
    expect(snapshot.statusTotal).toBe(1)
    expect(snapshot.commits.map((line) => line.split(" ").slice(1).join(" "))).toEqual(["second", "first"])
  })

  test("★ 第一行的前导空格不能被削掉 —— \" M\" 是没暂存,\"M \" 是暂存了,削一下就全反了", () => {
    init()
    commit("first")
    writeFileSync(join(dir, "staged.txt"), "a")
    writeFileSync(join(dir, "dirty.txt"), "b")
    git("add", "staged.txt", "dirty.txt")
    git("commit", "--quiet", "-m", "two files")
    writeFileSync(join(dir, "staged.txt"), "changed")
    writeFileSync(join(dir, "dirty.txt"), "changed")
    git("add", "staged.txt")

    // 排序由 git 定,两行都要在,而且各自的两列状态码要原样保留
    const status = collectGitSnapshot(dir)!.status
    expect(status).toContain("M  staged.txt")
    expect(status).toContain(" M dirty.txt")
  })

  test("★ 一次提交都没有的新仓库也要说得出话 —— 那正是最需要有人交代现状的时刻", () => {
    init()
    const snapshot = collectGitSnapshot(dir)!
    // rev-parse --abbrev-ref HEAD 在这里会直接报错,所以采集走的是 symbolic-ref
    expect(snapshot.head).toBe("main")
    expect(snapshot.detached).toBe(false)
    expect(snapshot.commits).toEqual([])
  })

  test("detached HEAD 报短 sha,不报一个假的分支名", () => {
    init()
    commit("first")
    const sha = git("rev-parse", "--short", "HEAD")
    git("checkout", "--quiet", "--detach", "HEAD")

    const snapshot = collectGitSnapshot(dir)!
    expect(snapshot.detached).toBe(true)
    expect(snapshot.head).toBe(sha)
    expect(renderGitSnapshot(snapshot)).toContain(`(detached HEAD at ${sha})`)
  })

  test("推不出主分支就不写这一行 —— 猜一个出来会让它把 PR 开到错地方", () => {
    init()
    commit("first")
    git("branch", "--move", "trunk") // 既没有 origin/HEAD,也没有 main / master
    expect(collectGitSnapshot(dir)!.mainBranch).toBeUndefined()
    expect(gitContextBlock(dir)).not.toContain("Main branch:")
  })

  test("有 origin/HEAD 时以远端说的为准", () => {
    init()
    commit("first")
    git("branch", "--move", "trunk")
    git("remote", "add", "origin", "https://example.invalid/repo.git")
    git("update-ref", "refs/remotes/origin/trunk", "HEAD")
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
    expect(collectGitSnapshot(dir)!.mainBranch).toBe("trunk")
  })
})

describe("renderGitSnapshot", () => {
  const base = { head: "main", detached: false, status: [], statusTotal: 0, commits: [] }

  test("★ 头一句必须说清这是快照,而且要准的自己去跑 git", () => {
    const text = renderGitSnapshot(base)
    expect(text).toContain("snapshot")
    expect(text).toContain("never refreshed")
    expect(text).toMatch(/Run git yourself/)
  })

  test("干净的工作区说干净", () => {
    expect(renderGitSnapshot(base)).toContain("Working tree clean")
  })

  test("★ 截掉的条数必须说出来 —— 看着只有 20 个改动、实际 300 个,会让它「一起提交了吧」", () => {
    const text = renderGitSnapshot({ ...base, status: [" M a.ts", " M b.ts"], statusTotal: 42 })
    expect(text).toContain("Uncommitted changes (42):")
    expect(text).toContain("[... 40 more files not listed]")
  })

  test("一条也没截就不写那行废话", () => {
    const text = renderGitSnapshot({ ...base, status: [" M a.ts"], statusTotal: 1 })
    expect(text).not.toContain("not listed")
  })
})

describe("★ 它不进 system prompt", () => {
  test("system 里没有分支、没有 status —— 那两样一变,整段前缀的缓存就没了", () => {
    init()
    commit("first")
    writeFileSync(join(dir, "a.txt"), "hi")

    const parts = buildSystem({ template: "anthropic", cwd: dir, root: dir }).parts
    const system = parts.join("\n")
    expect(system).not.toContain("<git-status>")
    expect(system).not.toContain("Current branch")
    expect(system).not.toContain("a.txt")
    // 只留那一句静态的判断 —— 它跟着目录走,不跟着改动走
    expect(system).toContain("Is directory a git repo: yes")
  })

  test("模型名进 system 是白拿的:缓存本来就按模型分开存", () => {
    const { parts } = buildSystem({ template: "anthropic", cwd: dir, root: dir, model: "anthropic/claude-opus-4-1" })
    expect(parts.join("\n")).toContain("Model: anthropic/claude-opus-4-1")
  })

  test("没给模型就不写这一行", () => {
    expect(buildSystem({ template: "anthropic", cwd: dir, root: dir }).parts.join("\n")).not.toContain("Model:")
  })
})
