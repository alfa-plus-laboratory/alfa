/**
 * The repo snapshot.
 *
 * The collection half runs real git — stub it out and this file only tests "my way of
 * gluing strings together hasn't changed", while every place this code can really go
 * wrong is on git's side: HEAD not existing yet in an empty repo, what the branch name is
 * when detached, how many spaces are in porcelain's first column.
 *
 * ★ The last group watches that **it must not appear in the system prompt**. Putting it
 *   there raises no error and fails no typecheck; it just makes every commit blow away
 *   the cache for the whole prefix — and the only thing standing between that and
 *   cache_creation quietly doubling on the bill is this test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectGitSnapshot, gitContextBlock, renderGitSnapshot } from "../src/prompt/git.ts"
import { buildSystem } from "../src/prompt/system.ts"

let dir: string

/**
 * Runs real git. The test repo has to bring its own identity, or commit fails on machines
 * with no user.email configured
 */
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
  test("not a repo: no block at all — a 'no git' line would cost every session tokens to say nothing", () => {
    expect(collectGitSnapshot(dir)).toBeUndefined()
    expect(gitContextBlock(dir)).toBeUndefined()
  })

  test("branch, changes, recent commits", () => {
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

  test("★ the first line's leading space must not be trimmed — ' M' is unstaged, 'M ' is staged, trimming flips them", () => {
    init()
    commit("first")
    writeFileSync(join(dir, "staged.txt"), "a")
    writeFileSync(join(dir, "dirty.txt"), "b")
    git("add", "staged.txt", "dirty.txt")
    git("commit", "--quiet", "-m", "two files")
    writeFileSync(join(dir, "staged.txt"), "changed")
    writeFileSync(join(dir, "dirty.txt"), "changed")
    git("add", "staged.txt")

    // the order is up to git; both lines must be there, each with its two-column status
    // code kept as is
    const status = collectGitSnapshot(dir)!.status
    expect(status).toContain("M  staged.txt")
    expect(status).toContain(" M dirty.txt")
  })

  test("★ a fresh repo with no commits is still described — exactly when the state most needs explaining", () => {
    init()
    const snapshot = collectGitSnapshot(dir)!
    // rev-parse --abbrev-ref HEAD errors out right here, so collection goes through
    // symbolic-ref
    expect(snapshot.head).toBe("main")
    expect(snapshot.detached).toBe(false)
    expect(snapshot.commits).toEqual([])
  })

  test("detached HEAD reports the short sha, not a fake branch name", () => {
    init()
    commit("first")
    const sha = git("rev-parse", "--short", "HEAD")
    git("checkout", "--quiet", "--detach", "HEAD")

    const snapshot = collectGitSnapshot(dir)!
    expect(snapshot.detached).toBe(true)
    expect(snapshot.head).toBe(sha)
    expect(renderGitSnapshot(snapshot)).toContain(`(detached HEAD at ${sha})`)
  })

  test("no inferable main branch means no such line — guessing one would get PRs opened against the wrong branch", () => {
    init()
    commit("first")
    git("branch", "--move", "trunk") // no origin/HEAD, and no main / master either
    expect(collectGitSnapshot(dir)!.mainBranch).toBeUndefined()
    expect(gitContextBlock(dir)).not.toContain("Main branch:")
  })

  test("with origin/HEAD present, the remote's answer wins", () => {
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

  test("★ the first sentence says it's a snapshot, and to run git yourself for accurate state", () => {
    const text = renderGitSnapshot(base)
    expect(text).toContain("snapshot")
    expect(text).toContain("never refreshed")
    expect(text).toMatch(/Run git yourself/)
  })

  test("a clean working tree says clean", () => {
    expect(renderGitSnapshot(base)).toContain("Working tree clean")
  })

  test("★ the cut count must be stated — seeing 20 changes when there are 300 invites 'just commit it all'", () => {
    const text = renderGitSnapshot({ ...base, status: [" M a.ts", " M b.ts"], statusTotal: 42 })
    expect(text).toContain("Uncommitted changes (42):")
    expect(text).toContain("[... 40 more files not listed]")
  })

  test("nothing cut, no filler line", () => {
    const text = renderGitSnapshot({ ...base, status: [" M a.ts"], statusTotal: 1 })
    expect(text).not.toContain("not listed")
  })
})

describe("★ it stays out of the system prompt", () => {
  test("no branch and no status in system — when either changes, the whole prefix cache is gone", () => {
    init()
    commit("first")
    writeFileSync(join(dir, "a.txt"), "hi")

    const parts = buildSystem({ template: "anthropic", cwd: dir, root: dir }).parts
    const system = parts.join("\n")
    expect(system).not.toContain("<git-status>")
    expect(system).not.toContain("Current branch")
    expect(system).not.toContain("a.txt")
    // only the one static fact stays — it follows the directory, not the changes
    expect(system).toContain("Is directory a git repo: yes")
  })

  test("the model name in system comes free: the cache is already stored per model", () => {
    const { parts } = buildSystem({ template: "anthropic", cwd: dir, root: dir, model: "anthropic/claude-opus-4-1" })
    expect(parts.join("\n")).toContain("Model: anthropic/claude-opus-4-1")
  })

  test("no model given, no such line", () => {
    expect(buildSystem({ template: "anthropic", cwd: dir, root: dir }).parts.join("\n")).not.toContain("Model:")
  })
})
