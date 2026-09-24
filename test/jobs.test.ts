/**
 * Background jobs.
 *
 * This group really spawns processes — because everything under test sits on the process
 * boundary: the cursor, the path where it dies on the spot, whether the kill is clean.
 * Test it with fakes and what passes is "my idea of what spawn does".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveShell } from "../src/env/shell.ts"
import { BashTool } from "../src/tool/bash.ts"
import { __resetForTest, kill, killAll, list, nameFor, ownedBy, read, setJobObserver, start, MAX_JOBS } from "../src/tool/bash/jobs.ts"
import { createToolContext } from "../src/tool/context.ts"
import { JobTool } from "../src/tool/job.ts"
import type { AgentJobs, JobSnapshot } from "../src/tool/background.ts"

let root: string
let counter = 0

const ctx = () =>
  createToolContext(
    {
      cwd: root,
      root,
      sessionID: "test",
      async ask() {},
      onProgress() {},
      onMetadata() {},
    },
    { messageID: "m", callID: `job${counter++}`, abortSignal: new AbortController().signal },
  )

const run = (command: string) => start({ command, workdir: root, shell: resolveShell({ platform: "linux", env: { SHELL: "/bin/sh" } }) })

/**
 * Waits until the check holds, or times out. Polling is steadier than sleeping for a
 * guessed number of seconds
 */
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("timed out waiting for a condition")
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "apc-jobs-"))
  __resetForTest()
})

afterEach(async () => {
  await killAll()
  __resetForTest()
  rmSync(root, { recursive: true, force: true })
})

describe("start", () => {
  test("a long-lived process returns at once instead of waiting", async () => {
    const started = Date.now()
    const result = await run("sleep 30")
    expect(result.kind).toBe("started")
    // it only waited out the few-hundred-ms observation window, not 30 seconds
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(list()[0]!.status).toBe("running")
  })

  test("★ one that dies on the spot is reported as failed, never as 'started'", async () => {
    // a command with one typo exits non-zero within tens of ms. Report it as "it's up" and
    // the model happily moves on, only to find five minutes later it never started
    const result = await run("definitely-not-a-real-command-xyz")
    expect(result.kind).toBe("exited")
    expect(result.job.exit).not.toBe(0)
    expect(result.output).toContain("not found")
  })

  test("one that exits instantly but succeeds is reported as finished too", async () => {
    const result = await run("echo hello")
    expect(result.kind).toBe("exited")
    expect(result.job.exit).toBe(0)
    expect(result.output).toContain("hello")
  })

  test("too many jobs are refused — a model starting jobs in a loop could bring the machine down", async () => {
    for (let i = 0; i < MAX_JOBS; i++) await run("sleep 30")
    expect(run("sleep 30")).rejects.toThrow(/Too many background jobs/)
  })
})

describe("read", () => {
  test("★ cursor: each read returns only what's new", async () => {
    // both lines come after the observation window (SETTLE_MS) — output inside the
    // window is taken by start() itself, which is deliberate (a mistyped command should
    // be known on the spot), but it would mask what's being tested here
    const started = await run("sleep 0.8; echo one; sleep 0.8; echo two; sleep 30")
    expect(started.kind).toBe("started")
    const job = started.job

    const first = await read(job.id, 3_000)
    expect(first.output).toContain("one")
    expect(first.output).not.toContain("two")

    // after the first read, reading again before anything new arrives is empty — no
    // repeats
    const empty = await read(job.id)
    expect(empty.output).toBe("")

    const second = await read(job.id, 3_000)
    expect(second.output).toContain("two")
    expect(second.output).not.toContain("one")
  })

  test("user inspection does not consume output the model has not read", async () => {
    const job = (await run("sleep 0.8; echo only-once; sleep 30")).job
    const shown = await read(job.id, 3_000, "user")
    expect(shown.output).toContain("only-once")

    const model = await read(job.id)
    expect(model.output).toContain("only-once")
  })

  test("wait: returns once there's output, no guessing how long to sleep", async () => {
    const job = (await run("sleep 1; echo listening on 3000; sleep 30")).job
    const started = Date.now()
    const result = await read(job.id, 5_000)
    expect(result.output).toContain("listening on 3000")
    expect(result.timedOut).toBe(false)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("wait also returns at its deadline and says it timed out", async () => {
    const job = (await run("sleep 30")).job
    const result = await read(job.id, 200)
    expect(result.timedOut).toBe(true)
    expect(result.job.status).toBe("running")
  })

  test("★ a process exiting during wait wakes it at once — no idling until the timeout", async () => {
    const job = (await run("sleep 0.3")).job
    const started = Date.now()
    const result = await read(job.id, 10_000)
    expect(result.job.status).toBe("exited")
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("the record survives exit — 'no such job' and 'it failed' are different answers", async () => {
    const started = await run("echo bye; exit 3")
    // what it said inside the observation window is taken by start() (the model already
    // saw it in bash's result)
    expect(started.output).toContain("bye")

    const result = await read(started.job.id)
    expect(result.job.status).toBe("exited")
    expect(result.job.exit).toBe(3)
    // what was already read isn't repeated, but the record remains — that's exactly the
    // difference between "it failed" and "no such job"
    expect(result.output).toBe("")
  })

  test("an unknown id gets a clear error", async () => {
    expect(read("nope")).rejects.toThrow(/No background job named/)
  })
})

describe("stop", () => {
  test("after kill the process is really gone", async () => {
    const job = (await run("sleep 30")).job
    await kill(job.id)
    expect(list()[0]!.status).toBe("exited")
  })

  test("★ killAll kills the whole process group — no grandchild survives", async () => {
    // the outer shell dies but the grandchild lives on — the escape route documented in
    // kill.ts
    const job = (await run("sh -c 'sleep 30' & wait")).job
    await until(() => list().length === 1)
    const killed = await killAll()
    expect(killed).toBe(1)
    await until(() => list()[0]!.status === "exited")
    expect(list()[0]!.id).toBe(job.id)
  })

  test("killing an already exited job is not an error", async () => {
    const job = (await run("echo done")).job
    await until(() => list()[0]!.status === "exited")
    const result = await kill(job.id)
    expect(result.job.status).toBe("exited")
  })

  test("★ a real stop carries no 'but' — it appears only when a clean stop isn't confirmed", async () => {
    const job = (await run("sleep 30")).job
    const result = await kill(job.id)
    expect(result.job.status).toBe("exited")
    expect(result.detail).toBeUndefined()
  })
})

// ─────────────────────────────────────────────── "stopped" has to be true

describe("★ job kill never reports a success that didn't happen", () => {
  /**
   * A job table that **can't be stopped**.
   *
   * What we hit in real runs was the Windows path (taskkill access denied, or only the
   * top of the tree killed), and on Linux there's nothing SIGKILL can't kill — so this
   * state is built from the injected side: AgentJobs is an injected interface anyway
   * (see tool/background.ts), and whatever it returns, the `job` tool has to report.
   */
  const stubborn = (over: Partial<JobSnapshot> = {}): AgentJobs => {
    const snapshot: JobSnapshot = {
      id: "dev",
      kind: "process",
      command: "npm run dev",
      workdir: "/repo",
      status: "running",
      startedAt: 1,
      pending: 0,
      ...over,
    }
    return {
      start: async () => snapshot,
      resume: async () => snapshot,
      list: () => [snapshot],
      has: (id) => id === snapshot.id,
      read: async () => ({ job: snapshot, output: "", timedOut: false }),
      suspend: async () => ({ job: snapshot, output: "", timedOut: false, detail: "taskkill exited with 1" }),
      kill: async () => ({ job: snapshot, output: "", timedOut: false, detail: "taskkill exited with 1", removed: snapshot.status === "exited" }),
      report: () => undefined,
      claimReport: () => undefined,
    }
  }

  const withAgents = (agents: AgentJobs) =>
    createToolContext(
      {
        cwd: root,
        root,
        sessionID: "test",
        agents,
        async ask() {},
        onProgress() {},
        onMetadata() {},
      },
      { messageID: "m", callID: `job${counter++}`, abortSignal: new AbortController().signal },
    )

  test("★ can't stop means saying so — an untrustworthy success message is far worse than a failure message", async () => {
    const result = await JobTool.execute({ action: "kill", id: "dev" }, withAgents(stubborn()))
    expect(result.output).toContain("Could NOT stop dev")
    expect(result.output).toContain("taskkill exited with 1")
    expect(result.output).toMatch(/still running/i)
    expect(result.metadata["killed"]).toBe(false)
    expect(result.title).toContain("still running")
  })

  test("★ record marked done but not killed cleanly: still says 'stopped', followed by the 'but'", async () => {
    const agents = stubborn({ status: "exited", exit: 0, endedAt: 2 })
    const result = await JobTool.execute({ action: "kill", id: "dev" }, withAgents(agents))
    expect(result.output).toContain("Stopped dev")
    expect(result.output).toContain("taskkill exited with 1")
    // and it has to say how to check for yourself next — whether the port is still taken
    // is the only thing you can check
    expect(result.output).toMatch(/port/i)
    expect(result.metadata["killed"]).toBe(true)
  })
})

describe("leaving a trace", () => {
  test("start and exit both notify the UI — an unseen background process is unseen automation", async () => {
    const seen: string[] = []
    setJobObserver((event) => seen.push(`${event.kind}:${event.job.id}`))

    const job = (await run("sleep 30")).job
    expect(seen).toContain(`started:${job.id}`)

    await kill(job.id)
    await until(() => seen.some((line) => line.startsWith("exited:")))
    expect(seen).toContain(`exited:${job.id}`)
  })

  test("one that dies on the spot reports only its exit, never 'started'", async () => {
    const seen: string[] = []
    setJobObserver((event) => seen.push(event.kind))
    await run("exit 1")
    expect(seen).not.toContain("started")
    expect(seen).toContain("exited")
  })
})

describe("bash background: true", () => {
  test("goes through the same approval path and returns a job id", async () => {
    const asked: string[] = []
    const tool = createToolContext(
      {
        cwd: root,
        root,
        sessionID: "test",
        async ask(input) {
          asked.push(...input.patterns)
        },
        onProgress() {},
        onMetadata() {},
      },
      { messageID: "m", callID: `bg${counter++}`, abortSignal: new AbortController().signal },
    )

    const result = await BashTool.execute({ command: "sleep 30", background: true }, tool)
    // ★ background is not a back door around the gatekeeper: the command was still
    // approved once
    expect(asked).toEqual(["sleep 30"])
    expect(result.output).toContain("Started background job")
    expect(result.metadata["alive"]).toBe(true)
    expect(list()).toHaveLength(1)
  })

  test("on the dies-on-the-spot path, bash reports failure too", async () => {
    const result = await BashTool.execute({ command: "exit 7", background: true }, ctx())
    expect(result.output).toContain("exited immediately")
    expect(result.metadata["alive"]).toBe(false)
    expect(result.metadata["exit"]).toBe(7)
  })

  test("without background it behaves as before: waits for it to finish", async () => {
    const result = await BashTool.execute({ command: "echo sync" }, ctx())
    expect(result.output).toContain("sync")
    expect(list()).toHaveLength(0)
  })
})

describe("★ a job name says what the job is", () => {
  const name = (command: string) => {
    __resetForTest()
    return nameFor(command)
  }

  test("what runs matters more than what runs it", () => {
    expect(name("npm run dev")).toBe("dev")
    expect(name("bun test --watch")).toBe("test")
    expect(name("cargo watch -x run")).toBe("watch")
    expect(name("go build ./...")).toBe("build")
    expect(name("pnpm run build:prod")).toBe("build-prod")
  })

  test("scripts drop their path and extension", () => {
    expect(name("./scripts/deploy.sh")).toBe("deploy")
    expect(name("python3 manage.py runserver")).toBe("manage")
  })

  test("a non-runner command is named after itself", () => {
    expect(name("sleep 30")).toBe("sleep")
    expect(name("tail -f /var/log/syslog")).toBe("tail")
  })

  test("leading env vars / sudo don't count", () => {
    expect(name("PORT=3000 npm run dev")).toBe("dev")
    expect(name("sudo systemctl restart nginx")).toBe("systemctl")
  })

  test("★ inline code after the runner falls back to the runner, never a name taken from a quote", () => {
    expect(name(`bun -e 'Bun.serve({port:3000})'`)).toBe("bun")
    expect(name(`sh -c "while true; do echo hi; done"`)).toBe("sh")
  })

  test("★ names are never reused — the model may still hold the previous one", () => {
    __resetForTest()
    expect(nameFor("npm run dev")).toBe("dev")
    expect(nameFor("npm run dev")).toBe("dev-2")
    expect(nameFor("npm run dev")).toBe("dev-3")
  })

  test("a really started job gets exactly this name", async () => {
    const result = await run("sleep 30")
    expect(result.job.id).toBe("sleep")
  })
})

describe("★ who started a job is recorded", () => {
  test("a subagent's process carries an owner — its start and exit don't belong in the user's conversation", async () => {
    const result = await start({
      command: "sleep 5",
      workdir: root,
      shell: resolveShell(),
      owner: "调查agent",
    })
    expect(result.job.owner).toBe("调查agent")
    // ones the main agent starts itself have none, and the UI still leaves a receipt
    const mine = await start({ command: "sleep 5", workdir: root, shell: resolveShell() })
    expect(mine.job.owner).toBeUndefined()
  })
})

describe("★ a subagent can't touch the main agent's processes", () => {
  test("list filters by owner: the main agent sees all, a subagent sees only its own", async () => {
    await start({ command: "sleep 5", workdir: root, shell: resolveShell() })
    await start({ command: "sleep 6", workdir: root, shell: resolveShell(), owner: "调查agent" })
    expect(list().length).toBe(2)
    expect(list("调查agent").map((job) => job.command)).toEqual(["sleep 6"])
  })

  test("★ jobs it didn't start don't exist for it — with one shared read cursor, a read would take another's output", async () => {
    const mine = await start({ command: "sleep 5", workdir: root, shell: resolveShell() })
    expect(ownedBy(mine.job.id, undefined)).toBe(true)
    expect(ownedBy(mine.job.id, "调查agent")).toBe(false)
  })

  test("killAll can reap only one subagent's jobs", async () => {
    await start({ command: "sleep 5", workdir: root, shell: resolveShell() })
    await start({ command: "sleep 6", workdir: root, shell: resolveShell(), owner: "调查agent" })
    expect(await killAll("调查agent")).toBe(1)
    expect(list().filter((job) => job.status === "running").length).toBe(1)
  })
})
