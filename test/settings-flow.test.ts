/**
 * Neither opening settings nor backing out of them may perform an action; current values
 * come from the host, and actions must be persisted through the existing commands.
 */
import { test, expect } from "bun:test"
import { settings, type SettingsHost, type SettingsState } from "../src/cli/settings.ts"
import { InputCancelled } from "../src/cli/secret-input.ts"

const state = (): SettingsState => ({ sandbox: true, limit: { context: 128000, output: 8192 }, model: "local/test", classifier: undefined, permission: "default", trust: "trusted", interface: "zh", reply: "auto", check: true, thinking: false, agentflow: 4, autoCompact: true, theme: "terminal", toolOutput: "compact", animation: "on", reasoning: "preview" })
function host(commands: string[], current = state()): SettingsHost {
  return { setLimit(limit) { current.limit = limit }, state: () => current, models: () => [current.model], command: async text => { commands.push(text); if (text === "/think on") current.thinking = true }, reload() {}, switch() { return undefined }, setClassifier(spec) { current.classifier = spec; return undefined }, appearance() {}, access: { list: () => [], add() {}, async revoke() {} } }
}

test("opening or cancelling settings triggers no check, compaction or toggle change", async () => {
  const commands: string[] = []
  await settings({ ask: async () => { throw new Error("must not ask for a typed command") }, say() {}, choose: async (_title, items) => {
    expect(items.find(item => item.value === "model")?.current).toBe("local/test")
    expect(items.find(item => item.value === "interface")?.current).toBe("zh")
    throw new InputCancelled()
  } }, host(commands))
  expect(commands).toEqual([])
})

test("cancelling a submenu returns to settings, and after a change the state is re-read and settings stay usable", async () => {
  const commands: string[] = [], choices = ["check", "cancel", "thinking", "on", "check", "run", "autoCompact", "off", "back"]
  const current = state()
  await settings({ ask: async () => { throw new Error("must not ask for a typed command") }, say() {}, choose: async (_title, items) => {
    const choice = choices.shift()
    if (!choice) throw new Error("settings did not exit")
    if (choice === "cancel") throw new InputCancelled()
    if (current.thinking && items.some(item => item.value === "thinking")) expect(items.find(item => item.value === "thinking")?.current).not.toBe("Off")
    return choice
  } }, host(commands, current))
  expect(commands).toEqual(["/think on", "/check", "/compact auto off"])
})

test("model selection offers the existing candidates, never asks to retype the model name", async () => {
  const commands: string[] = [], h = host(commands)
  let switched = ""
  h.switch = spec => { switched = spec; return undefined }
  await settings({ ask: async () => { throw new Error("must not ask for a typed model name") }, say() {}, choose: async (_title, items) => { expect(items.some(item => item.value === "local/test")).toBe(true); return "local/test" } }, h, "model")
  expect(switched).toBe("local/test")
})

test("changing only the context window keeps the output limit and shows the new value at once", async () => {
  const current = state(), h = host([], current), choices = ["limits", "back"], answers = ["256000", ""]
  await settings({ ask: async () => answers.shift()!, say() {}, choose: async (_title, items) => {
    if (choices.length === 1) expect(items.find(i => i.value === "limits")?.current).toBe("256000 / 8192")
    return choices.shift()!
  } }, h)
  expect(current.limit).toEqual({ context: 256000, output: 8192 })
})
test("invalid window values and a mid-way cancel save nothing, the sandbox menu uses its own command", async () => {
  for (const answer of ["-1", "1.5", "NaN", "100"]) {
    const current = state(), choices = ["limits", "sandbox", "off", "back"], commands: string[] = []
    let ask = 0
    await settings({ ask: async () => ask++ === 0 ? answer : "", say() {}, choose: async () => choices.shift()! }, host(commands, current))
    expect(current.limit).toEqual({ context: 128000, output: 8192 })
    expect(commands).toEqual(["/sandbox off"])
  }
  const current = state(), choices = ["limits", "back"]
  let asked = false
  await settings({ ask: async () => { if (asked) throw new InputCancelled(); asked = true; return "256000" }, say() {}, choose: async () => choices.shift()! }, host([], current))
  expect(current.limit.context).toBe(128000)
})

test("★ the concurrency menu offers only values /agentflow accepts", async () => {
  const commands: string[] = []
  let offered: string[] = []
  let calls = 0
  await settings({ ask: async () => { throw new Error("must not ask") }, say() {}, choose: async (_title, items) => {
    calls++
    if (calls === 1) return "agentflow"
    if (calls === 2) { offered = items.map(item => item.value).filter(value => /^\d+$/.test(value)); return "back" }
    throw new InputCancelled()
  } }, host(commands))
  expect(offered.length).toBeGreaterThan(0)
  for (const value of offered) expect(Number(value)).toBeGreaterThanOrEqual(2)
  expect(commands).toEqual([])
})

// Showing "off" right after the user chose "on" is what once made the switch look broken.
// The sandbox now applies in auto too, so auto must not mark it as not in force
test("in auto the sandbox entry and submenu show the saved setting as it is", async () => {
  const current = { ...state(), permission: "auto", sandbox: true }, choices = ["sandbox", "back", "back"]
  const seen: Array<string | undefined> = []
  await settings({ ask: async () => "", say() {}, choose: async (_title, items, initial) => {
    const entry = items.find(item => item.value === "sandbox")
    if (entry) {
      expect(entry.label).toMatch(/experimental|功能不完整|実験的/)
      expect(entry.description).toMatch(/Off by default|默认关闭|既定はオフ/)
    }
    if (entry) seen.push(String(entry.current))
    else seen.push(initial)
    return choices.shift()!
  } }, host([], current))
  expect(seen[0]).not.toMatch(/auto/)
  expect(seen[0]).not.toMatch(/^(Off|关闭|オフ)/)
  expect(seen[1]).toBe("on")
})
