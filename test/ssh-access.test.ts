/**
 * Guards the boundaries and concurrent timing of per-host session grants: one grant must
 * never widen, and a stale prompt must never bring back a revoked grant.
 */
import { test, expect } from "bun:test"
import { SshHostAccess } from "../src/security/ssh-access.ts"
import type { PromptRequest } from "../src/permission/gate.ts"
const request = (host = "pc1", signal?: AbortSignal): PromptRequest => ({ permission: "ssh.host", patterns: [host], alwaysPatterns: [], forbidAlways: true, allowSession: true, signal })

test("session grants are reused per host; new hosts and new sessions still need approval", async () => {
  const access = new SshHostAccess()
  let calls = 0
  const prompt = async () => { calls++; return "session" as const }
  await access.authorize(request(), prompt)
  await access.authorize(request(), prompt)
  expect(calls).toBe(1)
  await access.authorize(request("pc2"), prompt)
  expect(calls).toBe(2)
  expect(access.list()).toEqual(["pc1", "pc2"])
  access.revoke("pc1")
  await access.authorize(request(), prompt)
  expect(calls).toBe(3)
  access.revoke()
  expect(access.list()).toEqual([])
  await access.authorize(request(), prompt)
  expect(calls).toBe(4)
  expect(new SshHostAccess().list()).toEqual([])
})
test("concurrent waiters re-check after the first session approval, prompting only once", async () => {
  const access = new SshHostAccess()
  let calls = 0
  const answers = await Promise.all(Array.from({ length: 5 }, () => access.authorize(request(), async () => { calls++; await Bun.sleep(5); return "session" })))
  expect(calls).toBe(1)
  expect(answers).toEqual(["session", "once", "once", "once", "once"])
})
test("once, reject and an invalid persistent grant never create a session grant", async () => {
  const access = new SshHostAccess()
  for (const decision of ["once", "reject", "always"] as const) {
    await access.authorize(request(), async () => decision)
    expect(access.list()).toEqual([])
  }
  let calls = 0
  await Promise.all([1, 2].map(() => access.authorize(request(), async () => { calls++; return "once" })))
  expect(calls).toBe(2)
})
test("a revoke or cancel while waiting is not undone by a late session approval", async () => {
  for (const cancel of [false, true]) {
    const access = new SshHostAccess(), controller = new AbortController()
    let finish!: () => void
    const wait = new Promise<void>(resolve => { finish = resolve })
    const pending = access.authorize(request("pc1", controller.signal), async () => { await wait; return "session" })
    const queued = access.authorize(request("pc1", controller.signal), async () => "session")
    await Bun.sleep(1)
    if (cancel) controller.abort(); else access.revoke()
    finish()
    expect(await pending).toBe("reject")
    expect(await queued).toBe("reject")
    expect(access.list()).toEqual([])
  }
})

test("auto runs directly without leaving a grant; switching back to default asks again", async () => {
  const access = new SshHostAccess()
  let auto = true, calls = 0
  const prompt = async () => { calls++; return "reject" as const }
  expect(await access.authorize(request(), prompt, () => auto)).toBe("once")
  expect(calls).toBe(0)
  expect(access.list()).toEqual([])
  auto = false
  expect(await access.authorize(request(), prompt, () => auto)).toBe("reject")
  expect(calls).toBe(1)
})
