/**
 * Live A2 evidence uses the real CLI and its persisted session, never an oracle answer.
 * --model and --permission are explicit so invoking the harness cannot silently choose
 * broader access. Inherit the caller's isolated config/data environment; do not copy
 * credentials into fixtures or results. Empty workspaces keep project content out.
 * Each finished attempt is saved atomically, and a sidecar records in-flight work so
 * interruption does not erase earlier evidence. Existing output is never overwritten.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { Store } from "../src/session/store.ts"
import { redact } from "../src/util/redact.ts"
import { parseOptions } from "./options.ts"
import { aggregateReports, type Report } from "./metrics.ts"
import { captureRuntime, captureConvention } from "./capture.ts"
import { runtimeScenarios } from "./runtime.ts"

const args = process.argv.slice(2)
if (args.includes("--help")) {
  console.log("bun eval/runtime-run.ts --model provider/model --permission default|confirm|auto --repeat 3 --out /absolute/evidence.json\nRuns all seven runtime scenarios at least three times through the real CLI; consumes API credits.\nUse isolated XDG_CONFIG_HOME/XDG_DATA_HOME. --permission is mandatory; approvals in default/confirm cannot be answered in -p mode.\nEvidence JSON is compatible with eval/run.ts --runtime-evidence. The .run.json sidecar records usage, progress and failures. Existing output is never overwritten.")
  process.exit(0)
}
const allowed = new Set(["--model", "--permission", "--repeat", "--out"])
for (let i = 0; i < args.length; i += 2) if (!allowed.has(args[i]!)) throw new Error(`Unsupported runtime runner option: ${args[i]}`)
const options = parseOptions([...args, ...(!args.includes("--repeat") ? ["--repeat", "3"] : [])])
if (!options.model || !options.permission || options.repeat < 3) throw new Error("Runtime runs require --model, explicit --permission and --repeat >= 3")
const output = resolve(args.includes("--out") ? options.out : "eval/runtime-evidence.json")
const sidecar = `${output}.run.json`
if (existsSync(output) || existsSync(sidecar)) throw new Error(`Output already exists; choose a new --out to preserve captured evidence: ${output}`)
mkdirSync(dirname(output), { recursive: true })
const root = mkdtempSync(join(tmpdir(), "alfa-runtime-eval-"))
const evidence: ReturnType<typeof captureRuntime>[] = []
type Attempt = { scenario: string; repetition: number; cwd: string; report: string; state: "running" | "finished"; exit?: number; elapsedMs?: number; sessionID?: string; stdout?: string; stderr?: string; outputTruncated?: boolean; captureError?: string; usage?: ReturnType<typeof aggregateReports> }
const attempts: Attempt[] = []
const reports: (Report | null)[] = []
let stopped = false, current: ReturnType<typeof Bun.spawn> | undefined
const interrupt = () => { stopped = true; current?.kill("SIGINT") }
process.on("SIGINT", interrupt)
process.on("SIGTERM", interrupt)
const save = (path: string, value: unknown) => {
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  renameSync(temporary, path)
}
const persist = () => {
  save(output, evidence)
  save(sidecar, { mode: "live-runtime-capture", model: options.model, permission: options.permission, repeat: options.repeat, expectedAttempts: runtimeScenarios.length * options.repeat, updatedAt: new Date().toISOString(), stopped, captureConvention, evidence: output, attempts, usage: reports.length ? aggregateReports(reports) : null, reviewNote: "No human factual review has been invented. Captured environment outputs are observations for later review." })
}
persist()
try {
  outer: for (const scenario of runtimeScenarios) for (let repetition = 1; repetition <= options.repeat; repetition++) {
    if (stopped) break outer
    const folder = join(root, `${scenario.id}-${repetition}`), cwd = join(folder, "workspace")
    mkdirSync(cwd, { recursive: true })
    const report = join(folder, "report.json")
    const attempt: Attempt = { scenario: scenario.id, repetition, cwd, report, state: "running" }
    attempts.push(attempt); persist()
    const started = Date.now()
    let metrics: (Report & { sessionID?: string }) | null = null
    try {
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli/main.ts"), "-c", cwd, "-m", options.model, "--permission", options.permission, "--no-color", "--report", report, "-p", scenario.prompt], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      current = child
      const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text()
      const timeout = setTimeout(() => child.kill("SIGINT"), 10 * 60_000)
      const hardTimeout = setTimeout(() => child.kill("SIGKILL"), 10 * 60_000 + 5000)
      try {
        attempt.exit = await child.exited
        const out = await stdout, err = await stderr
        attempt.stdout = redact(out).slice(-8000); attempt.stderr = redact(err).slice(-8000)
        attempt.outputTruncated = out.length > 8000 || err.length > 8000
      } finally { clearTimeout(timeout); clearTimeout(hardTimeout); current = undefined }
      if (!existsSync(report)) throw new Error("CLI produced no invocation report; session evidence is unavailable")
      metrics = JSON.parse(readFileSync(report, "utf8"))
      if (!metrics?.sessionID) throw new Error("Invocation report has no sessionID")
      attempt.sessionID = metrics.sessionID
      const store = new Store()
      try {
        const history = store.listAll(metrics.sessionID)
        if (!history.length) throw new Error("Reported session has no stored messages")
        evidence.push(captureRuntime(history, { scenario: scenario.id, model: options.model, repetition }))
      } finally { store.close() }
    } catch (error) {
      attempt.captureError = redact(error instanceof Error ? error.message : String(error))
      evidence.push({ scenario: scenario.id, model: options.model, repetition, events: [], environmentObservations: [], captureConvention })
    } finally {
      attempt.state = "finished"; attempt.elapsedMs = Date.now() - started
      reports.push(metrics); attempt.usage = aggregateReports([metrics]); persist()
      console.log(`${scenario.id} ${repetition}/${options.repeat}: exit=${attempt.exit ?? "unknown"}${attempt.captureError ? " capture unavailable" : " captured"}`)
    }
  }
} finally {
  process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); persist()
}
console.log(output)
if (stopped) process.exitCode = 130
else if (attempts.some(attempt => attempt.captureError || attempt.exit !== 0)) process.exitCode = 1
