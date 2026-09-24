/**
 * SSH regressions use a process fixture and never connect to the user's machines; a
 * rejected approval must land before the child process starts.
 */
import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SshHostAccess } from "../src/security/ssh-access.ts"
import { runSsh, sshArgs, inspectSshConfig } from "../src/security/ssh.ts"
import { runtimeSnapshot } from "../src/security/runtime.ts"
import { AccessManager } from "../src/security/access.ts"
import { buildSystem } from "../src/prompt/system.ts"
import { EnvironmentTool } from "../src/tool/environment.ts"
import { createToolContext } from "../src/tool/context.ts"
import { scan } from "../src/tool/bash/scan.ts"

test("descriptor redirects aren't background jobs; a real background & is still detected", () => {
  for (const command of ["ssh pc1 2>&1", "cat <&0", "echo ok &>out", "echo ok &>>out"]) {
    expect(scan(command).reasons.some(r => r.includes("background"))).toBe(false)
    expect(scan(command).forceAsk).toBe(true)
  }
  expect(scan("ssh pc1 2>&1 &").reasons.some(r => r.includes("background"))).toBe(true)
})
test("SSH arguments bypass the local shell and can't inject options", () => {
  for (const host of ["-F", "user@pc1", "pc1;touch x", "pc1\nfoo"]) expect(() => sshArgs({ host, action: "inspect" })).toThrow()
  expect(() => sshArgs({ host: "pc1", action: "run" })).toThrow()
  const args = sshArgs({ host: "pc1", action: "run", command: "printf '%s' 'a; b'" })
  expect(args.slice(-3)).toEqual(["-T", "pc1", "printf '%s' 'a; b'"])
  expect(args).toContain("StrictHostKeyChecking=yes")
  expect(args).toContain("ForwardAgent=no")
})
test("an unexpanded SSH alias isn't reported as success, and config inspection never claims a connection", () => {
  expect(inspectSshConfig("hostname pc1\nproxycommand secret\n", "pc1")).toContain("Hostname is unchanged")
  const result = inspectSshConfig("hostname 192.168.1.52\nproxyjump imini\nproxycommand secret\n", "pc1")
  expect(result).toContain("proxyjump imini")
  expect(result).toContain("No SSH connection")
  expect(result).not.toContain("secret")
})
test("a rejected SSH call starts no process; each call is approved separately and failure evidence is kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alfa-ssh-test-"))
  const executable = join(dir, "fake-ssh"), marker = join(dir, "started")
  writeFileSync(executable, '#!/bin/sh\nprintf started > "' + marker + '"\nprintf "Permission denied (publickey).\\n" >&2\nexit 255\n', { mode: 0o700 })
  let approvals = 0
  const base = { cwd: dir, signal: new AbortController().signal, executable, onProgress() {} }
  try {
    await expect(runSsh({ host: "pc1", action: "run", command: "true" }, { ...base, prompt: async () => "reject" })).rejects.toThrow("No SSH process")
    expect(existsSync(marker)).toBe(false)
    for (let i = 0; i < 2; i++) {
      const result = await runSsh({ host: "pc1", action: "run", command: "true" }, { ...base, prompt: async request => {
        approvals++
        expect(request.forbidAlways).toBe(true)
        expect(request.alwaysPatterns).toEqual([])
        expect(request.metadata?.command).toContain("true")
        return "once"
      } })
      expect(result.metadata.exit).toBe(255)
      expect(result.output).toContain("Permission denied (publickey)")
      expect(result.output).toContain("do not infer")
    }
    expect(approvals).toBe(2)
    const access = new SshHostAccess()
    await runSsh({ host: "pc1", action: "run", command: "true" }, { ...base, access, auto: () => true, prompt: async () => { throw new Error("auto must not prompt for SSH authorization") } })
    expect(access.list()).toEqual([])
    let sessionPrompts = 0
    for (let i = 0; i < 2; i++) await runSsh({ host: "pc1", action: "run", command: "true" }, { ...base, access, prompt: async () => { sessionPrompts++; return "session" } })
    expect(sessionPrompts).toBe(1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test("the runtime snapshot updates on grant revocation; the temp dir is read-write but symlinks can't escape", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alfa-runtime-test-"))
  const root = join(dir, "repo"), other = join(dir, "other")
  mkdirSync(root); mkdirSync(other)
  const access = new AccessManager(root, async () => "reject")
  try {
    const initial = runtimeSnapshot(access, "auto")
    expect(initial.permissionMode).toBe("auto")
    expect(initial.controls.join(" ")).toContain("/settings → OS sandbox (experimental)")
    access.sandboxEnabled = false
    expect(runtimeSnapshot(access, "auto").shellExecution).toBe("host")
    expect(runtimeSnapshot(access, "auto").sandbox).toBe("off")
    access.sandboxEnabled = true
    const before = buildSystem({ cwd: root, root, template: "default", instructions: [], runtime: initial })
    access.add(other, "read")
    const after = buildSystem({ cwd: root, root, template: "default", instructions: [], runtime: runtimeSnapshot(access, "default") })
    expect(before.parts[0]).toBe(after.parts[0])
    expect(before.parts[1]).not.toBe(after.parts[1])
    const ctx = createToolContext({ cwd: root, root, sessionID: "runtime-test", runtime: () => runtimeSnapshot(access, "default"), ask: async () => {}, onProgress() {}, onMetadata() {} }, { messageID: "m", callID: "c", abortSignal: new AbortController().signal })
    expect(JSON.parse((await EnvironmentTool.execute({}, ctx)).output).grants).toHaveLength(1)
    expect(runtimeSnapshot(access, "default").grants).toHaveLength(1)
    access.revoke(other)
    expect(runtimeSnapshot(access, "default").grants).toHaveLength(0)
    const log = join(initial.temporaryDirectory, "ssh.log")
    writeFileSync(log, "diagnostic")
    expect(await access.authorize(log, root, "read")).toBe(log)
    expect(await access.authorize(log, root, "write")).toBe(log)
    symlinkSync(other, join(initial.temporaryDirectory, "escape"))
    await expect(access.authorize(join(initial.temporaryDirectory, "escape", "file"), root, "write")).rejects.toThrow()
  } finally { access.dispose(); rmSync(dir, { recursive: true, force: true }) }
})

test("cancelling while awaiting approval starts no SSH, and a run timeout reports a clear reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alfa-ssh-cancel-")), executable = join(dir, "ssh"), marker = join(dir, "started")
  writeFileSync(executable, '#!/bin/sh\nprintf started > "' + marker + '"\nexec sleep 30\n', { mode: 0o700 })
  const controller = new AbortController()
  const base = { cwd: dir, executable, onProgress() {} }
  try {
    await expect(runSsh({ host: "pc1", action: "inspect" }, { ...base, signal: controller.signal, prompt: async () => { controller.abort(); return "once" } })).rejects.toThrow("cancelled")
    expect(existsSync(marker)).toBe(false)
    const result = await runSsh({ host: "pc1", action: "run", command: "true", timeout: 100 }, { ...base, signal: new AbortController().signal, prompt: async () => "once" })
    expect(result.metadata.exit).toBeNull()
    expect(result.metadata.outcome).toBe("timeout")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test.skipIf(!existsSync("/usr/bin/ssh"))("system OpenSSH keeps alias and jump-host resolution without connecting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alfa-ssh-config-"))
  const config = join(dir, "config"), executable = join(dir, "ssh-fixture")
  writeFileSync(config, "Host pc1\n HostName 192.0.2.52\n User fixture\n ProxyJump imini\nHost imini\n HostName 192.0.2.53\n")
  writeFileSync(executable, '#!/bin/sh\nexec /usr/bin/ssh -F "' + config + '" "$@"\n', { mode: 0o700 })
  try {
    const result = await runSsh({ host: "pc1", action: "inspect" }, { cwd: dir, executable, signal: new AbortController().signal, prompt: async () => "once", onProgress() {} })
    expect(result.metadata.exit).toBe(0)
    expect(result.output).toContain("hostname 192.0.2.52")
    expect(result.output).toContain("proxyjump imini")
    expect(result.output).toContain("No SSH connection")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
