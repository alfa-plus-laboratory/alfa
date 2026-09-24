/**
 * Persisting "don't ask again" to disk.
 *
 * Behind every assertion in this file is a real way it failed: a rule approved in repo
 * A taking effect in repo B, a broken json keeping the program from starting, a
 * hand-edited file conjuring up an allow-everything rule.
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

describe("persisting to disk", () => {
  test("what is saved reads back", () => {
    const path = scratch()
    rememberApprovals("/repo/a", [{ permission: "bash", pattern: "npm run *", action: "allow" }], path)
    const back = loadApprovals("/repo/a", path)
    expect(back.map((one) => one.pattern)).toEqual(["npm run *"])
    expect(back[0]!.permission).toBe("bash")
  })

  test("★ scoped per workspace — approved in A never applies in B", () => {
    // Paths in rules are workspace-relative: both repos have a src/, and mixing them up
    // means allowing, in repo B, a directory the user has never looked at
    const path = scratch()
    rememberApprovals("/repo/a", [{ permission: "edit", pattern: "src/*", action: "allow" }], path)
    expect(loadApprovals("/repo/b", path)).toEqual([])
    expect(loadApprovals("/repo/a", path)).toHaveLength(1)
  })

  test("saving the same rule twice doesn't duplicate it", () => {
    const path = scratch()
    const rule: Ruleset = [{ permission: "bash", pattern: "npm test *", action: "allow" }]
    rememberApprovals("/repo", rule, path)
    rememberApprovals("/repo", rule, path)
    expect(loadApprovals("/repo", path)).toHaveLength(1)
  })

  test("only allow is stored — deny never gets in", () => {
    const path = scratch()
    rememberApprovals("/repo", [{ permission: "bash", pattern: "rm *", action: "deny" }], path)
    expect(loadApprovals("/repo", path)).toEqual([])
  })

  test("★ a hand-edited permission:* is always dropped", () => {
    // This would allow **every tool added in the future**, including ones the user has
    // never seen
    const path = scratch()
    writeFileSync(
      path,
      JSON.stringify({ version: 1, workspaces: { "/repo": [{ permission: "*", pattern: "*", time: 1 }] } }),
    )
    expect(loadApprovals("/repo", path)).toEqual([])
  })

  test("a corrupt file counts as empty, no throw", () => {
    const path = scratch()
    writeFileSync(path, "{ not json")
    expect(loadApprovals("/repo", path)).toEqual([])
  })

  test("a missing file doesn't throw either", () => {
    expect(loadApprovals("/repo", join(tmpdir(), "apc-does-not-exist", "approvals.json"))).toEqual([])
  })

  test("forget clears only this workspace", () => {
    const path = scratch()
    rememberApprovals("/repo/a", [{ permission: "bash", pattern: "a *", action: "allow" }], path)
    rememberApprovals("/repo/b", [{ permission: "bash", pattern: "b *", action: "allow" }], path)
    expect(forgetApprovals("/repo/a", path)).toBe(1)
    expect(loadApprovals("/repo/a", path)).toEqual([])
    expect(loadApprovals("/repo/b", path)).toHaveLength(1)
  })

  test("toRuleset only ever fills in allow as the action", () => {
    const rules = toRuleset([{ permission: "bash", pattern: "ls *", time: 0 }])
    expect(rules).toEqual([{ permission: "bash", pattern: "ls *", action: "allow" }])
  })
})

describe("the gate side", () => {
  /** Records how many times the gate asked and what it asked to save */
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

  test("★ only always is persisted, once is not", async () => {
    const once = makeGate("once")
    await once.gate.ask({ permission: "bash", patterns: ["npm run deploy"] })
    expect(once.saved).toEqual([])

    const always = makeGate("always")
    await always.gate.ask({ permission: "bash", patterns: ["npm run deploy"] })
    // What is saved is the **narrowed** rule, not this command verbatim — see narrowAlways
    expect(always.saved).toEqual([{ permission: "bash", pattern: "npm run deploy *", action: "allow" }])
  })

  test("forbidAlways saves nothing at all", async () => {
    const gate = makeGate("always")
    await gate.gate.ask({ permission: "bash", patterns: ["echo $(cat x)"], forbidAlways: true })
    expect(gate.saved).toEqual([])
  })

  test("★ once restored it stops asking — that's the whole point of 'remember'", async () => {
    const first = makeGate("always")
    await first.gate.ask({ permission: "bash", patterns: ["npm run deploy"] })

    // Open a new gate (= one restart) and load back what was saved
    const next = makeGate("reject")
    next.gate.restoreApproved(toRuleset(first.saved.map((r) => ({ ...r, time: 0 }))))
    await next.gate.ask({ permission: "bash", patterns: ["npm run deploy --force"] })
    expect(next.asks()).toBe(0)
  })

  test("restoreApproved rejects deny — saved data can't overturn the gate's verdict", () => {
    const gate = new PermissionGate(async () => "reject")
    gate.restoreApproved([{ permission: "bash", pattern: "ls *", action: "deny" }])
    expect(gate.listApproved()).toEqual([])
  })

  test("forgetApproved returns how many it cleared", () => {
    const gate = new PermissionGate(async () => "reject")
    gate.restoreApproved([
      { permission: "bash", pattern: "a *", action: "allow" },
      { permission: "bash", pattern: "b *", action: "allow" },
    ])
    expect(gate.forgetApproved()).toBe(2)
    expect(gate.listApproved()).toEqual([])
  })
})
