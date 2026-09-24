/**
 * An arbitrary script stepping out of bounds must be stopped by the kernel; testing only
 * the command-string scan is not enough.
 */
import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { AccessManager } from "../src/security/access.ts"
import { sandboxShell, sandboxBackend, effectiveGrants, bwrapBlocked } from "../src/security/sandbox.ts"
import { resolveShell } from "../src/env/shell.ts"
test.skipIf(sandboxBackend() === "unavailable")("the kernel blocks a script going out of bounds; granted, access works; revoked, new processes are denied again", () => {
  const dir = mkdtempSync(join(tmpdir(), "alfa-sandbox-")), root = join(dir, "repo"), other = join(dir, "other")
  mkdirSync(root); mkdirSync(other)
  writeFileSync(join(other, "value"), "outside")
  const access = new AccessManager(root, async () => "reject")
  access.sandboxEnabled = true
  const execute = (command: string) => {
    const shell = sandboxShell(resolveShell(), access)
    return spawnSync(shell.file, shell.argsFor(command), { cwd: root, encoding: "utf8" })
  }
  try {
    expect(execute(`cat '${other}/value'`).status).not.toBe(0)
    access.add(other, "read")
    const read = execute(`cat '${other}/value'`)
    expect(read.stderr).toBe("")
    expect(read.stdout).toBe("outside")
    expect(execute(`echo changed > '${other}/value'`).status).not.toBe(0)
    access.add(other, "write")
    expect(execute(`echo changed > '${other}/value'`).status).toBe(0)
    expect(readFileSync(join(other, "value"), "utf8")).toBe("changed\n")
    access.revoke(other)
    expect(execute(`cat '${other}/value'`).status).not.toBe(0)
  } finally { access.dispose(); rmSync(dir, { recursive: true, force: true }) }
})

test("a repeated cwd must not downgrade write access; nested grants mount the parent first", () => {
  const grants = effectiveGrants([
    {path:"/tmp/example/child",mode:"write",directory:true,persistent:false},
    {path:"/tmp/example",mode:"read",directory:true,persistent:false},
    {path:"/tmp/example/child",mode:"read",directory:true,persistent:false},
  ])
  expect(grants.map(g => g.mode)).toEqual(["read","write"])
})

test.skipIf(sandboxBackend() === "unavailable")("exact-file shell grants exclude siblings and revoke writes while scratch remains usable", () => {
  const dir = mkdtempSync(join(tmpdir(), "alfa-sandbox-file-")), root = join(dir, "repo"), other = join(dir, "other")
  mkdirSync(root); mkdirSync(other)
  const value = join(other, "value"), sibling = join(other, "sibling"), secret = join(root, ".env")
  writeFileSync(value, "outside"); writeFileSync(sibling, "sibling"); writeFileSync(secret, "fixture-secret")
  const access = new AccessManager(root, async () => "reject")
  access.sandboxEnabled = true
  const execute = (command: string) => {
    const shell = sandboxShell(resolveShell(), access)
    return spawnSync(shell.file, shell.argsFor(command), { cwd: root, env: { ...process.env, ...shell.env }, encoding: "utf8" })
  }
  try {
    access.add(value, "write", false, false)
    expect(execute(`echo changed > '${value}'`).status).toBe(0)
    expect(readFileSync(value, "utf8")).toBe("changed\n")
    expect(execute(`cat '${sibling}'`).status).not.toBe(0)
    expect(execute(`cat '${secret}'`).stdout).not.toContain("fixture-secret")
    expect(execute('printf scratch > "$TMPDIR/result"').status).toBe(0)
    expect(readFileSync(join(access.scratch(), "result"), "utf8")).toBe("scratch")
    access.revoke(value)
    expect(execute(`echo revoked > '${value}'`).status).not.toBe(0)
    expect(readFileSync(value, "utf8")).toBe("changed\n")
    expect(execute('cat "$TMPDIR/result"').stdout).toBe("scratch")
  } finally { access.dispose(); rmSync(dir, { recursive: true, force: true }) }
})

test("explicitly disabled returns the host shell; re-enabling reapplies file isolation", () => {
  const dir = mkdtempSync(join(tmpdir(), "alfa-sandbox-mode-")), root = join(dir, "repo"), outside = join(dir, "outside")
  mkdirSync(root); writeFileSync(outside, "host-only")
  const access = new AccessManager(root, async () => "reject"), shell = resolveShell()
  access.sandboxEnabled = true
  try {
    access.sandboxEnabled = false
    const host = sandboxShell(shell, access)
    expect(host.file).toBe(shell.file)
    expect(spawnSync(host.file, host.argsFor(`cat '${outside}'`), { cwd: root, encoding: "utf8" }).stdout).toBe("host-only")
    access.sandboxEnabled = true
    if (sandboxBackend() === "unavailable") expect(() => sandboxShell(shell, access)).toThrow("unavailable")
    else {
      const isolated = sandboxShell(shell, access)
      expect(spawnSync(isolated.file, isolated.argsFor(`cat '${outside}'`), { cwd: root }).status).not.toBe(0)
    }
  } finally { access.dispose(); rmSync(dir, { recursive: true, force: true }) }
})


/**
 * ★ On Ubuntu 23.10+ bwrap is often installed but refused a user namespace. Checking only
 *   for the binary made the sandbox look on while every command failed, and made the
 *   kernel tests above "pass" because nothing could run at all. Runs only where that is
 *   the situation (CI's Ubuntu runner before it lifts the restriction).
 */
test.skipIf(!(process.platform === "linux" && Bun.which("bwrap") && bwrapBlocked()))("an installed but blocked bubblewrap is unavailable, and the error says why", () => {
  expect(sandboxBackend()).toBe("unavailable")
  const dir = mkdtempSync(join(tmpdir(), "alfa-sandbox-blocked-"))
  const access = new AccessManager(dir, async () => "reject")
  access.sandboxEnabled = true
  try {
    expect(() => sandboxShell(resolveShell(), access)).toThrow("cannot create a user namespace")
  } finally { access.dispose(); rmSync(dir, { recursive: true, force: true }) }
})

test("new access managers leave the experimental shell sandbox off until explicitly enabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "alfa-sandbox-default-"))
  const access = new AccessManager(dir, async () => "reject")
  try {
    expect(access.sandboxEnabled).toBe(false)
    expect(access.sandboxActive).toBe(false)
    const shell = resolveShell()
    expect(sandboxShell(shell, access).file).toBe(shell.file)
    access.sandboxEnabled = true
    expect(access.sandboxActive).toBe(true)
  } finally { access.dispose(); rmSync(dir, { recursive: true, force: true }) }
})
