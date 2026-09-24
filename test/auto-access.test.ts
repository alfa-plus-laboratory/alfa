/** Verifies auto mode's permissions using only temp files, a synthetic environment and
 *  HTTP stubs; never runs a dangerous command or reads real credentials. */
import { test, expect, spyOn } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AccessManager } from "../src/security/access.ts"
import { canonicalPath } from "../src/fs/guard.ts"
import { dataDir } from "../src/util/xdg.ts"
import { sandboxStatus } from "../src/security/sandbox.ts"
import { buildChildEnv } from "../src/env/whitelist.ts"
import { runtimeSnapshot } from "../src/security/runtime.ts"
import { fetchUrl } from "../src/tool/web/fetch.ts"

/**
 * ★ Guards the Claude Code alignment of auto: the saved sandbox stays in
 *   force, and leaving the workspace to read is asked about once instead of being silent.
 */
test("auto keeps the saved sandbox, asks before the first outside read, and creates no path grants", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "alfa-auto-access-"))), root = join(dir, "repo"), keyDir = join(dir, ".ssh")
  mkdirSync(root); mkdirSync(keyDir)
  const fixture = join(keyDir, "id_ed25519"), other = join(dir, "notes.txt")
  writeFileSync(fixture, "synthetic-fixture-only")
  writeFileSync(other, "synthetic")
  let auto = false, answer: "reject" | "session" | "always" = "reject", asked = 0, remembered = false
  const access = new AccessManager(root, async () => { asked++; return answer }, undefined, () => auto, { allowed: () => remembered, remember: () => { remembered = true } })
  access.sandboxEnabled = true
  try {
    await expect(access.authorize(fixture, root, "read")).rejects.toThrow()
    auto = true
    expect(sandboxStatus(access)).not.toBe("off")
    expect(runtimeSnapshot(access, "auto").unrestricted).toBe(true)
    // alfa's own overflow logs, which bash tells the model to read, don't count as leaving
    const overflow = join(dataDir(), "tool-output", "tool_fixture.log")
    expect(await access.authorize(overflow, root, "read")).toBe(canonicalPath(overflow))
    expect(asked).toBe(1)
    // First outside read asks; a rejection refuses it and the next one asks again
    await expect(access.authorize(fixture, root, "read")).rejects.toThrow("declined")
    expect(asked).toBe(2)
    answer = "session"
    expect(await access.authorize(fixture, root, "read")).toBe(fixture)
    expect(await access.authorize(other, root, "read")).toBe(other)
    expect(asked).toBe(3)
    expect(remembered).toBe(false)
    // Writes outside aren't asked here: the classifier gates them at the tool level
    expect(await access.authorize(join(dir, "new"), root, "write")).toBe(join(dir, "new"))
    // Reads inside the workspace never ask
    expect(await access.authorize(join(root, "a.ts"), root, "read")).toBe(join(root, "a.ts"))
    expect(asked).toBe(3)
    expect(access.list()).toEqual([])
    // Leaving auto: the outside-read allowance doesn't carry into default's path prompts
    auto = false
    answer = "reject"
    expect(sandboxStatus(access)).not.toBe("off")
    await expect(access.authorize(fixture, root, "read")).rejects.toThrow()
    const signal = AbortSignal.abort()
    auto = true
    await expect(access.authorize(fixture, root, "read", signal)).rejects.toThrow("Cancelled")
  } finally { access.dispose(); rmSync(dir, { recursive: true, force: true }) }
})

test("\"always\" on the first outside read is remembered for later sessions", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "alfa-auto-outside-"))), root = join(dir, "repo")
  mkdirSync(root)
  writeFileSync(join(dir, "a.txt"), "x")
  let remembered = false, asked = 0
  const outside = { allowed: () => remembered, remember: () => { remembered = true } }
  const first = new AccessManager(root, async () => { asked++; return "always" }, undefined, () => true, outside)
  const second = new AccessManager(root, async () => { asked++; return "reject" }, undefined, () => true, outside)
  try {
    await first.authorize(join(dir, "a.txt"), root, "read")
    expect(remembered).toBe(true)
    expect(await second.authorize(join(dir, "a.txt"), root, "read")).toBe(join(dir, "a.txt"))
    expect(asked).toBe(1)
  } finally { first.dispose(); second.dispose(); rmSync(dir, { recursive: true, force: true }) }
})
test("auto child processes inherit the full environment; default rules mode still filters", () => {
  const source = { PATH: "/usr/bin", SYNTHETIC_TOKEN: "fixture-only", SSH_AUTH_SOCK: "/synthetic/agent", EMPTY: undefined }
  expect(buildChildEnv(source, "darwin", true).env).toEqual({ PATH: "/usr/bin", SYNTHETIC_TOKEN: "fixture-only", SSH_AUTH_SOCK: "/synthetic/agent" })
  expect(buildChildEnv(source, "darwin").env.SYNTHETIC_TOKEN).toBeUndefined()
})
test("auto passes the network-range check, default rules still refuse; no real metadata endpoint is hit", async () => {
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response("fixture", { headers: { "content-type": "text/plain" } }), { preconnect: fetch.preconnect }))
  const target = { url: new URL("http://127.0.0.1/fixture"), reach: "blocked" as const, addresses: [] }
  try {
    await expect(fetchUrl({ target, signal: new AbortController().signal })).rejects.toThrow("Refused")
    expect(mock).not.toHaveBeenCalled()
    expect((await fetchUrl({ target, signal: new AbortController().signal, unrestricted: true })).body).toBe("fixture")
    expect(mock).toHaveBeenCalledTimes(1)
  } finally { mock.mockRestore() }
})
