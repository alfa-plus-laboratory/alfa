/**
 * Results must survive an operator interrupt, independently of the deliberate child-only
 * interrupt used by recovery evaluations. Atomic replacement keeps readers from seeing
 * half a JSON document; stopping never starts a replacement child or a recovery attempt.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export function saveAtomic(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n")
  renameSync(temporary, path)
}

export function createRunLifecycle(onStop: () => void) {
  let stopped: "SIGINT" | "SIGTERM" | null = null
  let child: ReturnType<typeof Bun.spawn> | undefined
  let escalation: ReturnType<typeof setTimeout> | undefined
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    if (stopped) return
    stopped = signal
    if (child) {
      const active = child
      active.kill(signal)
      escalation = setTimeout(() => active.kill("SIGKILL"), 1_000)
    }
    onStop()
  }
  const sigint = () => stop("SIGINT"), sigterm = () => stop("SIGTERM")
  process.on("SIGINT", sigint); process.on("SIGTERM", sigterm)
  return {
    get stopped() { return stopped },
    async run(cmd: string[], cwd: string, env = process.env, interruptMs?: number) {
      if (stopped) throw new Error("Evaluation stopped; no further child may start")
      const active = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" })
      child = active
      const out = new Response(active.stdout).text(), err = new Response(active.stderr).text()
      const timeout = setTimeout(() => active.kill("SIGKILL"), 10 * 60_000)
      // This timer belongs to the recovery experiment, not the operator stop state.
      const interrupt = interruptMs ? setTimeout(() => active.kill("SIGINT"), interruptMs) : undefined
      try { return { exit: await active.exited, stdout: await out, stderr: await err } }
      finally {
        clearTimeout(timeout); if (interrupt) clearTimeout(interrupt)
        if (escalation) clearTimeout(escalation)
        child = undefined
      }
    },
    dispose() {
      process.off("SIGINT", sigint); process.off("SIGTERM", sigterm)
      if (escalation) clearTimeout(escalation)
    },
  }
}
