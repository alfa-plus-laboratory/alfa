/**
 * Permission modes and their interaction with the configurable rules.
 *
 * In auto, an injected classifier decides whether to ask; these tests only call the
 * permission decision and never execute a dangerous command. default/confirm keep the
 * deny rules, auto writes no grants, and the original rules must come back after
 * switching back.
 *
 * Permission modes accept only their current names; the project is unreleased, so no
 * command aliases are kept.
 */
import { describe, expect, test } from "bun:test"
import { PermissionGate } from "../src/permission/gate.ts"
import { isPermissionMode, MODES, nextMode, normalizeMode } from "../src/permission/mode.ts"
import { fromConfig } from "../src/permission/rules.ts"
import { PermissionDeniedError } from "../src/tool/types.ts"

// ───────────────────────────────────────────── the modes themselves

describe("Modes", () => {
  test("strictest to loosest, cycling back to the start", () => {
    expect(MODES).toEqual(["confirm", "default", "auto"])
    expect(nextMode("confirm")).toBe("default")
    expect(nextMode("default")).toBe("auto")
    expect(nextMode("auto")).toBe("confirm")
  })

  test("recognizes exact mode names", () => {
    expect(isPermissionMode("auto")).toBe(true)
    expect(isPermissionMode("AUTO")).toBe(false)
    expect(isPermissionMode("yolo")).toBe(false)
  })

  test("★ only current names are accepted; no command compatibility kept for trust", () => {
    expect(normalizeMode(" auto ")).toBe("auto")
    expect(isPermissionMode("trust")).toBe(false)
    expect(MODES).not.toContain("trust")
    expect(normalizeMode("trust")).toBeUndefined()
    expect(normalizeMode("yolo")).toBeUndefined()
  })

  test("a bare gate defaults to default — full permissions must be wired up explicitly by the host", () => {
    expect(new PermissionGate(async () => "reject").permissionMode).toBe("default")
  })
})

// ───────────────────────────────────────────── confirm

describe("confirm mode", () => {
  test("★ asks even when the rules say allow", async () => {
    let asked = 0
    const gate = new PermissionGate(async () => {
      asked++
      return "once"
    })
    gate.setMode("confirm")
    await gate.ask({ permission: "read", patterns: ["src/a.ts"] })
    expect(asked).toBe(1)
  })

  test("★ the ask tool isn't confirmed first — approving it was asking whether it may ask", async () => {
    let asked = 0
    const gate = new PermissionGate(async () => {
      asked++
      return "once"
    })
    gate.setMode("confirm")
    await gate.ask({ permission: "ask", patterns: ["*"] })
    expect(asked).toBe(0)
    // Only the blanket pull skips it: a rule the user wrote for it still holds
    gate.setUserRules(fromConfig({ ask: "ask" }))
    await gate.ask({ permission: "ask", patterns: ["*"] })
    expect(asked).toBe(1)
    gate.setUserRules(fromConfig({ ask: "deny" }))
    await expect(gate.ask({ permission: "ask", patterns: ["*"] })).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  test("★ but what's blocked stays blocked: deny still throws outright, no 'just ask and it passes'", async () => {
    const gate = new PermissionGate(async () => "once")
    gate.setUserRules(fromConfig({ external_directory: "deny" }))
    gate.setMode("confirm")
    await expect(gate.ask({ permission: "external_directory", patterns: ["/etc/passwd"] })).rejects.toBeInstanceOf(
      PermissionDeniedError,
    )
  })
})

// ───────────────────────────────────────────── auto

describe("auto mode lets the classifier allow", () => {
  test("★ what the rule table would ask about is allowed directly", async () => {
    let asked = 0
    const gate = new PermissionGate(async () => {
      asked++
      return "reject"
    }, { auto: async () => ({ allow: true }) })
    gate.setMode("auto")
    await gate.ask({ permission: "bash", patterns: ["docker run ubuntu"] })
    expect(asked).toBe(0)
  })

  // A deny the user wrote used to be void in auto, the mode where nobody is watching
  test("a deny rule holds in auto as in default, even when the classifier would allow", async () => {
    const gate = new PermissionGate(async () => "once", { auto: async () => ({ allow: true }) })
    gate.setUserRules(fromConfig({ external_directory: "deny" }))
    for (const mode of ["auto", "default"] as const) {
      gate.setMode(mode)
      expect(gate.disabled("external_directory")).toBe(true)
      await expect(gate.ask({ permission: "external_directory", patterns: ["/etc"] })).rejects.toBeInstanceOf(PermissionDeniedError)
    }
  })

  test("a classifier allow writes no always — after switching back to default everything is as before", async () => {
    let asked = 0
    const gate = new PermissionGate(async () => {
      asked++
      return "reject"
    }, { auto: async () => ({ allow: true }) })
    gate.setMode("auto")
    await gate.ask({ permission: "bash", patterns: ["docker run ubuntu"] })
    gate.setMode("default")
    await gate.ask({ permission: "bash", patterns: ["docker run ubuntu"] }).catch(() => {})
    expect(asked).toBe(1)
  })
})
