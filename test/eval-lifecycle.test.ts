/**
 * Operator signals must preserve finished attempts and stop dispatch, while the recovery
 * timer must only interrupt its child. Fixtures exercise real local processes, never models.
 */
import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRunLifecycle, saveAtomic } from "../eval/lifecycle.ts"

test("atomic progress replaces complete JSON and creates the output directory", () => {
  const root = mkdtempSync(join(tmpdir(), "eval-progress-"))
  try {
    const path = join(root, "nested", "results.json")
    saveAtomic(path, { results: [1] }); saveAtomic(path, { results: [1, 2] })
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ results: [1, 2] })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("planned child interruption still permits a recovery child", async () => {
  const lifecycle = createRunLifecycle(() => { throw new Error("Unexpected operator stop") })
  try {
    const interrupted = await lifecycle.run([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd(), process.env, 100)
    expect(interrupted.exit).not.toBe(0)
    expect(lifecycle.stopped).toBeNull()
    const recovery = await lifecycle.run([process.execPath, "-e", "console.log('recovered')"], process.cwd())
    expect(recovery.stdout.trim()).toBe("recovered")
  } finally { lifecycle.dispose() }
})

for (const signal of ["SIGINT", "SIGTERM"] as const) test(`${signal} preserves completed progress and prevents dispatch after stopping the child`, async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-signal-"))
  const output = join(root, "progress.json")
  const fixture = join(root, "fixture.ts")
  writeFileSync(fixture, `
import { createRunLifecycle, saveAtomic } from ${JSON.stringify(resolve(import.meta.dir, "../eval/lifecycle.ts"))}
const output = ${JSON.stringify(output)}
const results = [{ task: "finished" }]
const save = () => saveAtomic(output, { results, status: life.stopped ? "stopped" : "running", incomplete: true, stoppedBy: life.stopped })
const life = createRunLifecycle(save)
save()
await life.run([process.execPath, "-e", "console.log('ready'); setInterval(() => {}, 1000)"], process.cwd())
let prevented = false
try { await life.run([process.execPath, "-e", "console.log('should not run')"], process.cwd()) } catch { prevented = true }
save(); life.dispose()
if (!prevented) process.exit(1)
`)
  const child = Bun.spawn([process.execPath, fixture], { stdout: "pipe", stderr: "pipe" })
  try {
    // Wait for an atomic progress document; the local child starts before signal delivery.
    for (let i = 0; i < 100; i++) {
      try { if (JSON.parse(readFileSync(output, "utf8")).status === "running") break } catch {}
      await Bun.sleep(10)
    }
    await Bun.sleep(100)
    child.kill(signal)
    expect(await child.exited).toBe(0)
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({ results: [{ task: "finished" }], status: "stopped", incomplete: true, stoppedBy: signal })
  } finally { child.kill(); rmSync(root, { recursive: true, force: true }) }
})

test("real eval runner saves attempts before finishing and retains them on operator interruption", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-run-progress-"))
  const output = join(root, "results.json")
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../eval/run.ts"), "--validate", "--repeat", "100", "--out", output], { stdout: "pipe", stderr: "pipe" })
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text()
  try {
    let first: { completedAttempts: number; status: string } | undefined
    for (let i = 0; i < 300; i++) {
      try {
        const current = JSON.parse(readFileSync(output, "utf8"))
        if (current.completedAttempts >= 1) { first = current; break }
      } catch {}
      await Bun.sleep(10)
    }
    expect(first?.status).toBe("running")
    child.kill("SIGINT")
    expect(await child.exited).toBe(130)
    const saved = JSON.parse(readFileSync(output, "utf8"))
    expect(saved.status).toBe("stopped")
    expect(saved.incomplete).toBe(true)
    expect(saved.summary).toBeNull()
    expect(saved.completedAttempts).toBeGreaterThanOrEqual(first!.completedAttempts)
    expect(saved.results.length).toBe(saved.completedAttempts)
    expect(saved.completedAttempts).toBeLessThan(saved.expectedAttempts)
    expect(await stderr).toContain("acceptance passed")
    expect(await stdout).toContain(output)
  } finally { child.kill(); rmSync(root, { recursive: true, force: true }) }
})

for (const stage of ["fixture-check", "model", "recovery", "acceptance-check"] as const) test(`real runner tracks billable report coverage when stopped during ${stage}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-missing-report-"))
  const output = join(root, "results.json"), runner = join(root, "run.ts"), stub = join(root, "stub.ts")
  const taskFile = join(root, "tasks.ts"), prices = join(root, "prices.json")
  const knownReport = { requests: [{ model: { providerID: "stub", modelID: "model" }, cacheInInput: true, tokens: { input: 100, output: 10, cache: { read: 0, write: 0 } } }], approvals: 0, interruptions: 0 }
  // Execute the real runner source, substituting only the external CLI and task fixture.
  // The stub never imports the alfa CLI or has any route to a provider.
  const original = readFileSync(resolve(import.meta.dir, "../eval/run.ts"), "utf8")
  const fixtureRunner = original
    .replace('const cli = resolve(import.meta.dir, "../src/cli/main.ts")', `const cli = ${JSON.stringify(stub)}`)
    .replace(/from "\.\/(.*?)"/g, (_match, name: string) => `from ${JSON.stringify(name === "tasks.ts" ? taskFile : resolve(import.meta.dir, "../eval", name))}`)
  writeFileSync(runner, fixtureRunner)
  const acceptance = stage === "fixture-check" ? 'await new Promise(() => {}); export {}' : 'import {existsSync} from "node:fs"; if (existsSync("completed")) await new Promise(() => {}); throw new Error("fixture not fixed");'
  writeFileSync(taskFile, `export const tasks = ${JSON.stringify([{ id: "stub-task", prompt: "fixture", files: {}, oracle: {}, acceptance }])}`)
  writeFileSync(prices, JSON.stringify({ "stub/model": { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }))
  writeFileSync(stub, `
import { writeFileSync } from "node:fs"
const args = process.argv.slice(2)
const stage = ${JSON.stringify(stage)}
if (stage === "model" || args.includes("--continue")) {
  await new Promise(() => {})
} else {
  if (stage === "recovery") writeFileSync(args[args.indexOf("--report") + 1]!, ${JSON.stringify(JSON.stringify(knownReport))})
  writeFileSync("completed", "done")
}
`)
  const child = Bun.spawn([process.execPath, runner, "--model", "stub/model", "--prices", prices, "--out", output, ...(stage === "recovery" ? ["--interrupt-ms", "10000"] : [])], { stdout: "pipe", stderr: "pipe" })
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text()
  let cwd: string | undefined
  try {
    let running: any
    for (let index = 0; index < 300; index++) {
      try {
        const saved = JSON.parse(readFileSync(output, "utf8"))
        if (saved.activeAttempt?.stage === stage) { running = saved; cwd = saved.activeAttempt.cwd; break }
      } catch {}
      await Bun.sleep(10)
    }
    expect(running?.status).toBe("running")
    expect(running.summary.missingReports).toBe(stage === "fixture-check" ? 0 : 1)
    if (stage === "fixture-check") {
      expect(running.summary.tokens.input).toBe(0)
      expect(running.summary.apiCostUSD).toBe(0)
    } else {
      expect(running.summary.tokens).toBeNull()
      expect(running.summary.apiCostUSD).toBeNull()
    }
    expect(running.summary.knownTokens.input).toBe(stage === "recovery" ? 100 : 0)
    child.kill("SIGINT")
    expect(await child.exited).toBe(130)
    const stopped = JSON.parse(readFileSync(output, "utf8"))
    expect(stopped.status).toBe("stopped")
    expect(stopped.activeAttempt.stage).toBe(stage)
    expect(stopped.summary.missingReports).toBe(stage === "fixture-check" ? 0 : 1)
    if (stage === "fixture-check") {
      expect(stopped.summary.tokens.input).toBe(0)
      expect(stopped.summary.apiCostUSD).toBe(0)
    } else {
      expect(stopped.summary.tokens).toBeNull()
      expect(stopped.summary.apiCostUSD).toBeNull()
    }
    expect(stopped.summary.knownTokens.input).toBe(stage === "recovery" ? 100 : 0)
    expect(stopped.results).toEqual([])
    await stdout; await stderr
  } finally {
    child.kill()
    await child.exited
    rmSync(root, { recursive: true, force: true })
    if (cwd) rmSync(cwd, { recursive: true, force: true })
  }
}, 10_000)
