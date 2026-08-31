/**
 * 「以后不再问」的落盘。
 *
 * 这一份的每条断言背后都是一次真实的失败方式:在 A 仓库批的规则在 B 仓库
 * 生效、坏掉的 json 让程序起不来、手改文件造出一条全放开。
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { forgetApprovals, loadApprovals, rememberApprovals, toRuleset } from "../src/permission/approvals.ts"
import { PermissionGate } from "../src/permission/gate.ts"
import type { Ruleset } from "../src/permission/rules.ts"
import type { AskDecision } from "../src/tool/types.ts"

function scratch(): string {
  return join(mkdtempSync(join(tmpdir(), "apc-approvals-")), "approvals.json")
}

describe("落盘", () => {
  test("存进去再读出来", () => {
    const path = scratch()
    rememberApprovals("/repo/a", [{ permission: "bash", pattern: "npm run *", action: "allow" }], path)
    const back = loadApprovals("/repo/a", path)
    expect(back.map((one) => one.pattern)).toEqual(["npm run *"])
    expect(back[0]!.permission).toBe("bash")
  })

  test("★ 按工作区分开 —— 在 A 批的不许在 B 生效", () => {
    // 规则里的路径是相对工作区的:两个仓库各有一个 src/,混在一起就是
    // 在 B 仓库放行了一个用户从没看过的目录
    const path = scratch()
    rememberApprovals("/repo/a", [{ permission: "edit", pattern: "src/*", action: "allow" }], path)
    expect(loadApprovals("/repo/b", path)).toEqual([])
    expect(loadApprovals("/repo/a", path)).toHaveLength(1)
  })

  test("同一条存两次不会重复", () => {
    const path = scratch()
    const rule: Ruleset = [{ permission: "bash", pattern: "npm test *", action: "allow" }]
    rememberApprovals("/repo", rule, path)
    rememberApprovals("/repo", rule, path)
    expect(loadApprovals("/repo", path)).toHaveLength(1)
  })

  test("只存 allow —— deny 进不来", () => {
    const path = scratch()
    rememberApprovals("/repo", [{ permission: "bash", pattern: "rm *", action: "deny" }], path)
    expect(loadApprovals("/repo", path)).toEqual([])
  })

  test("★ 手改出来的 permission:* 一律丢掉", () => {
    // 这一条会把**将来新加的每一个工具**都放行,包括用户从没见过的那些
    const path = scratch()
    writeFileSync(
      path,
      JSON.stringify({ version: 1, workspaces: { "/repo": [{ permission: "*", pattern: "*", time: 1 }] } }),
    )
    expect(loadApprovals("/repo", path)).toEqual([])
  })

  test("文件坏了当没有,不抛", () => {
    const path = scratch()
    writeFileSync(path, "{ not json")
    expect(loadApprovals("/repo", path)).toEqual([])
  })

  test("文件不存在也不抛", () => {
    expect(loadApprovals("/repo", join(tmpdir(), "apc-does-not-exist", "approvals.json"))).toEqual([])
  })

  test("forget 只清这一个工作区", () => {
    const path = scratch()
    rememberApprovals("/repo/a", [{ permission: "bash", pattern: "a *", action: "allow" }], path)
    rememberApprovals("/repo/b", [{ permission: "bash", pattern: "b *", action: "allow" }], path)
    expect(forgetApprovals("/repo/a", path)).toBe(1)
    expect(loadApprovals("/repo/a", path)).toEqual([])
    expect(loadApprovals("/repo/b", path)).toHaveLength(1)
  })

  test("toRuleset 补上的 action 只可能是 allow", () => {
    const rules = toRuleset([{ permission: "bash", pattern: "ls *", time: 0 }])
    expect(rules).toEqual([{ permission: "bash", pattern: "ls *", action: "allow" }])
  })
})

describe("门卫这一头", () => {
  /** 记下门卫问了几次、要求存了什么 */
  function makeGate(answer: AskDecision) {
    let asked = 0
    const saved: Ruleset = []
    const gate = new PermissionGate(
      async () => {
        asked += 1
        return answer
      },
      { remember: (rules) => saved.push(...rules) },
    )
    return { gate, saved, asks: () => asked }
  }

  test("★ 选 always 才落盘,选 once 不落", async () => {
    const once = makeGate("once")
    await once.gate.ask({ permission: "bash", patterns: ["npm run deploy"] })
    expect(once.saved).toEqual([])

    const always = makeGate("always")
    await always.gate.ask({ permission: "bash", patterns: ["npm run deploy"] })
    // 存的是**归约过**的规则,不是这一条命令原文 —— 见 narrowAlways
    expect(always.saved).toEqual([{ permission: "bash", pattern: "npm run deploy *", action: "allow" }])
  })

  test("forbidAlways 时一个字都不存", async () => {
    const gate = makeGate("always")
    await gate.gate.ask({ permission: "bash", patterns: ["echo $(cat x)"], forbidAlways: true })
    expect(gate.saved).toEqual([])
  })

  test("★ 装回来之后就不再问了 —— 这就是「记住」的全部意义", async () => {
    const first = makeGate("always")
    await first.gate.ask({ permission: "bash", patterns: ["npm run deploy"] })

    // 新开一个门卫(= 重启一次),把存下来的装回去
    const next = makeGate("reject")
    next.gate.restoreApproved(toRuleset(first.saved.map((r) => ({ ...r, time: 0 }))))
    await next.gate.ask({ permission: "bash", patterns: ["npm run deploy --force"] })
    expect(next.asks()).toBe(0)
  })

  test("restoreApproved 拒收 deny —— 存档改不了门卫的结论", () => {
    const gate = new PermissionGate(async () => "reject")
    gate.restoreApproved([{ permission: "bash", pattern: "ls *", action: "deny" }])
    expect(gate.listApproved()).toEqual([])
  })

  test("★ 记住的规则压不过硬名单", async () => {
    const gate = makeGate("always")
    gate.gate.restoreApproved([{ permission: "bash", pattern: "*", action: "allow" }])
    // 硬名单在 ask() 的第一步就短路了,根本走不到规则叠加
    await expect(gate.gate.ask({ permission: "bash", patterns: ["mkfs.ext4 /dev/sda"] })).rejects.toThrow(
      /hard safety rule/,
    )
  })

  test("forgetApproved 返回清掉了几条", () => {
    const gate = new PermissionGate(async () => "reject")
    gate.restoreApproved([
      { permission: "bash", pattern: "a *", action: "allow" },
      { permission: "bash", pattern: "b *", action: "allow" },
    ])
    expect(gate.forgetApproved()).toBe(2)
    expect(gate.listApproved()).toEqual([])
  })
})
