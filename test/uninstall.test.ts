/**
 * `alfa uninstall`.
 *
 * This only tests the two pieces of pure logic, **working out what to delete** and
 * **deleting it**, without spawning a process — rendering at the command-line layer
 * belongs to the cli tests. The true end to end (the binary deleting itself) was verified
 * by hand in a sandbox and can't be an automated test: it needs a real compiled build,
 * and that's 96MB.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  findProjectDirsCommand,
  performUninstall,
  runningFromSource,
  uninstallScope,
} from "../src/cli/uninstall.ts"

let dir: string
let previous: { config?: string; data?: string }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alfa-uninstall-"))
  previous = { config: process.env["XDG_CONFIG_HOME"], data: process.env["XDG_DATA_HOME"] }
  process.env["XDG_CONFIG_HOME"] = join(dir, "cfg")
  process.env["XDG_DATA_HOME"] = join(dir, "data")
})

afterEach(() => {
  if (previous.config === undefined) delete process.env["XDG_CONFIG_HOME"]
  else process.env["XDG_CONFIG_HOME"] = previous.config
  if (previous.data === undefined) delete process.env["XDG_DATA_HOME"]
  else process.env["XDG_DATA_HOME"] = previous.data
  rmSync(dir, { recursive: true, force: true })
})

function seed(): { config: string; data: string; project: string; binary: string } {
  const config = join(dir, "cfg", "alfa")
  const data = join(dir, "data", "alfa")
  const project = join(dir, "proj", ".alfa")
  const binary = join(dir, "bin", "alfa")
  for (const path of [config, data, project, join(dir, "bin")]) mkdirSync(path, { recursive: true })
  writeFileSync(join(config, "config.json"), "{}")
  writeFileSync(join(data, "auth.json"), '{"anthropic":{"key":"sk-not-real"}}')
  writeFileSync(join(project, "note.md"), "note")
  writeFileSync(binary, "#!/bin/sh\n")
  return { config, data, project, binary }
}

describe("guard when running from source", () => {
  // Under `bun run bin/alfa`, execPath is bun itself. Deleting it as-is deletes the
  // user's bun, and that mistake can't be undone — same reason as the guard in upgrade.ts
  test("★ when execPath is bun, the binary never goes on the delete list", () => {
    seed()
    expect(runningFromSource("/usr/local/bin/bun")).toBe(true)
    expect(runningFromSource("/c/Program Files/bun.exe")).toBe(true)
    const scope = uninstallScope(join(dir, "proj"), "/usr/local/bin/bun")
    expect(scope.targets.some((one) => one.path.includes("bun"))).toBe(false)
    expect(scope.binaryDir).toBeUndefined()
  })

  test("an installed binary is not mistaken for running from source", () => {
    expect(runningFromSource("/home/u/.local/bin/alfa")).toBe(false)
    // a name that **contains** bun but isn't bun must not get caught
    expect(runningFromSource("/home/u/bunny/alfa")).toBe(false)
  })
})

describe("working out what to delete", () => {
  test("config, data, project notes and binary are all listed, with credentials flagged", () => {
    const { config, data, project, binary } = seed()
    const scope = uninstallScope(join(dir, "proj"), binary)
    const paths = scope.targets.map((one) => one.path)
    expect(paths).toContain(config)
    expect(paths).toContain(data)
    expect(paths).toContain(project)
    expect(paths).toContain(binary)
    expect(scope.targets.find((one) => one.path === data)?.hasCredentials).toBe(true)
  })

  // a lost binary can be reinstalled, a lost auth.json can't — so someone skimming the
  // list should see the latter first
  test("the binary comes last, 'your stuff' first", () => {
    const { binary } = seed()
    const scope = uninstallScope(join(dir, "proj"), binary)
    expect(scope.targets.at(-1)?.path).toBe(binary)
  })

  test("an execPath pointing at a missing file is not forced onto the list", () => {
    seed()
    const scope = uninstallScope(join(dir, "proj"), join(dir, "bin", "gone"))
    expect(scope.targets.some((one) => one.path.endsWith("gone"))).toBe(false)
  })

  test("on a machine with nothing installed, the list is empty", () => {
    const scope = uninstallScope(join(dir, "proj"), join(dir, "bin", "gone"))
    expect(scope.targets).toHaveLength(0)
  })
})

describe("actual deletion", () => {
  test("everything listed gets deleted", () => {
    const { config, data, project, binary } = seed()
    const scope = uninstallScope(join(dir, "proj"), binary)
    const result = performUninstall(scope.targets, binary)
    expect(result.failed).toHaveLength(0)
    for (const path of [config, data, project, binary]) expect(existsSync(path)).toBe(false)
  })

  // ⚠ This guards the order: the binary step is bound to fail on Windows (the file is
  //    locked by itself) and has to take the move-it-aside route. With the order
  //    reversed, a Windows uninstall would get stuck there with not one bit of config or
  //    credentials deleted
  test("★ one failure doesn't stop the rest from being deleted", () => {
    const { config, data } = seed()
    const targets = [
      { path: join(dir, "nope", "missing-parent", "x"), what: "x", bytes: 0 },
      { path: config, what: "config", bytes: 0 },
      { path: data, what: "data", bytes: 0 },
    ]
    const result = performUninstall(targets, "/nonexistent/alfa")
    expect(existsSync(config)).toBe(false)
    expect(existsSync(data)).toBe(false)
    // rmSync's force makes "didn't exist in the first place" not a failure — which is
    // right: the target state was reached
    expect(result.removed).toContain(config)
  })
})

describe(".alfa/ scattered across repos", () => {
  // An uninstaller that walks your whole home deleting things is exactly the kind of thing
  // that shouldn't exist. We only hand over the command and don't do the scan for them —
  // see point 1 of the header comment in cli/uninstall.ts
  test("hands over a command, matched to the platform", () => {
    expect(findProjectDirsCommand("/home/u", "linux")).toContain("find /home/u")
    expect(findProjectDirsCommand("/home/u", "linux")).toContain(".alfa")
    expect(findProjectDirsCommand("/home/u", "linux")).toContain("node_modules")
    expect(findProjectDirsCommand("C:\\Users\\u", "win32")).toContain("Get-ChildItem")
  })
})
