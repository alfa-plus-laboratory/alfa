/**
 * The eval really invokes the alfa CLI, and results are judged by independent tests. With no
 * model a run is marked not-run; the oracle must never be passed off as a success rate.
 * --validate only checks the tasks and their acceptance tests; only --model runs (and pays
 * for) a model. Cost needs per-unit prices; without them it defaults to null.
 * Repeated runs use independent workspaces but cannot reset provider caches. Labels
 * describe the experiment, not an asserted warm/cold provider state.
 * Billable children reserve a missing-report slot before dispatch. Otherwise an operator
 * stop can save a plausible complete subtotal while the active call is still unaccounted.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { join, dirname, resolve } from "node:path"
import { tmpdir } from "node:os"
import { tasks } from "./tasks.ts"
import { aggregateReports, type Report, type Prices } from "./metrics.ts"
import { help, parseOptions } from "./options.ts"
import { createRunLifecycle, saveAtomic } from "./lifecycle.ts"
import { gradeRuntimeBatch, validateRuntimeScenarios, type RuntimeEvidence } from "./runtime.ts"
const cli = resolve(import.meta.dir, "../src/cli/main.ts")
const options = parseOptions(process.argv.slice(2))
if (options.help) { console.log(help); process.exit(0) }
const { validate, model } = options
const selectedTasks = options.task ? tasks.filter(task => task.id === options.task) : tasks
if (!selectedTasks.length) throw new Error(`Unknown coding task: ${options.task}; available: ${tasks.map(task => task.id).join(", ")}`)
const output = resolve(options.out)
const experiment = { taskSelection: options.task ?? null, taskSetHash: options.runtimeEvidence ? null : createHash("sha256").update(JSON.stringify(selectedTasks)).digest("hex"), repeat: options.repeat, comparison: options.compare, permissionOverride: options.permission ?? null, cacheCondition: options.cacheCondition, profileLabel: options.profile, cacheConditionSource: "operator-declared; no cache flush or provider warming is performed", profileNote: "Label only; does not change model settings or prompt." }
const permissionArgs = options.permission ? ["--permission", options.permission] : []
if (options.runtimeEvidence) {
  const evidence: unknown = JSON.parse(readFileSync(resolve(options.runtimeEvidence), "utf8"))
  if (!Array.isArray(evidence)) throw new Error("Runtime evidence must be an array")
  const batch = gradeRuntimeBatch(evidence as RuntimeEvidence[])
  if (options.compare) {
    const counts = new Map<string, number>()
    for (const result of batch.results) {
      const key = JSON.stringify([result.scenario, result.model])
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    if (!counts.size || [...counts.values()].some(n => n < 3)) throw new Error("Runtime comparison requires at least three captured attempts per scenario/model")
  }
  writeFileSync(output, JSON.stringify({ generatedAt: new Date().toISOString(), experiment, evidenceSource: resolve(options.runtimeEvidence), evidence, ...batch }, null, 2) + "\n")
  console.log(output); process.exit(0)
}
const prices: Prices | undefined = options.prices ? JSON.parse(readFileSync(resolve(options.prices), "utf8")) : undefined
const results: unknown[] = []
const allReports: (Report | null)[] = []
const expectedAttempts = options.repeat * selectedTasks.length
let activeAttempt: Record<string, unknown> | null = null
const save = () => saveAtomic(output, {
  generatedAt: new Date().toISOString(), experiment,
  status: lifecycle.stopped ? "stopped" : results.length === expectedAttempts ? "complete" : "running",
  incomplete: results.length !== expectedAttempts, stoppedBy: lifecycle.stopped,
  expectedAttempts, completedAttempts: results.length, activeAttempt,
  summary: validate ? null : aggregateReports(allReports, prices),
  runtimeValidation: validate ? validateRuntimeScenarios() : null, results,
})
const lifecycle = createRunLifecycle(() => {
  save()
  console.error(`Evaluation stopped (${lifecycle.stopped}); preserving ${results.length}/${expectedAttempts} completed attempts: ${output}`)
})
const run = lifecycle.run
save()
try {
attempts: for (let repetition = 1; repetition <= options.repeat; repetition++) for (const task of selectedTasks) {
  const cwd = mkdtempSync(join(tmpdir(), `alfa-eval-${task.id}-`))
  activeAttempt = { task: task.id, repetition, cwd, stage: "fixture-check" }
  save()
  console.error(`[${results.length + 1}/${expectedAttempts}] ${task.id} repetition ${repetition}: starting`)
  const put = (files: Record<string, string>) => { for (const [name, body] of Object.entries(files)) { mkdirSync(dirname(join(cwd, name)), { recursive: true }); writeFileSync(join(cwd, name), body) } }
  put(task.files)
  writeFileSync(join(cwd, "package.json"), '{"scripts":{"test":"bun test"}}')
  const acceptance = join(cwd, "acceptance.test.ts")
  writeFileSync(acceptance, task.acceptance)
  const before = await run([process.execPath, "test"], cwd)
  if (lifecycle.stopped) { activeAttempt.before = before; break attempts }
  if (before.exit === 0) throw new Error(`Broken fixture unexpectedly passes: ${task.id}`)
  // Agent never receives the hidden acceptance tests before its attempt.
  const { unlinkSync } = await import("node:fs"); unlinkSync(acceptance)
  const started = Date.now()
  let attempt: Awaited<ReturnType<typeof run>> | null = null, metrics: Report | null = null, recovery: Awaited<ReturnType<typeof run>> | null = null, recoveryMetrics: Report | null = null
  if (validate) put(task.oracle)
  else {
    const report = join(cwd, "metrics.json")
    const command = [process.execPath, cli, "-c", cwd, "-m", model!, ...permissionArgs, "--report", report, "-p", task.prompt]
    const interruptMs = options.interruptMs
    activeAttempt.stage = "model"
    const reportIndex = allReports.length
    allReports.push(null)
    save()
    attempt = await run(command, cwd, process.env, interruptMs)
    activeAttempt.attempt = attempt
    if (existsSync(report)) metrics = JSON.parse(readFileSync(report, "utf8"))
    allReports[reportIndex] = metrics
    activeAttempt.metrics = metrics
    if (lifecycle.stopped) break attempts
    if (interruptMs) {
      activeAttempt.stage = "recovery"
      const recoveryReportIndex = allReports.length
      allReports.push(null)
      save()
      recovery = await run([process.execPath, cli, "-c", cwd, "-m", model!, ...permissionArgs, "--continue", "--report", join(cwd, "resume-metrics.json"), "-p", "Continue the original task. Finish and run the tests."], cwd)
      activeAttempt.recovery = recovery
      const resumeReport = join(cwd, "resume-metrics.json")
      if (existsSync(resumeReport)) recoveryMetrics = JSON.parse(readFileSync(resumeReport, "utf8"))
      allReports[recoveryReportIndex] = recoveryMetrics
      activeAttempt.recoveryMetrics = recoveryMetrics
      if (lifecycle.stopped) break attempts
    }
  }
  writeFileSync(acceptance, task.acceptance)
  activeAttempt.stage = "acceptance-check"
  save()
  const checked = await run([process.execPath, "test"], cwd)
  if (lifecycle.stopped) { activeAttempt.tests = checked; break attempts }
  const reports = [metrics, ...(recovery ? [recoveryMetrics] : [])]
  const usage = validate ? null : aggregateReports(reports, prices)
  results.push({ task: task.id, repetition, mode: validate ? "fixture-validation-only" : "live-model", model: model ?? null, completed: validate ? null : checked.exit === 0, acceptancePassed: checked.exit === 0, elapsedMs: Date.now() - started, apiCostUSD: usage?.apiCostUSD ?? null, usage, pricingSource: options.prices ?? null, metrics, attempt, recovery, recoveryMetrics, cwd, tests: checked })
  activeAttempt = null
  save()
  console.error(`[${results.length}/${expectedAttempts}] ${task.id} repetition ${repetition}: acceptance ${checked.exit === 0 ? "passed" : "failed"}`)
}
} finally {
  save()
  lifecycle.dispose()
}
console.log(output)
if (lifecycle.stopped) process.exitCode = lifecycle.stopped === "SIGINT" ? 130 : 143
