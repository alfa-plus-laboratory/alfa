/**
 * Subagents.
 *
 * A fake stream feeds fixed events (same approach as agent-loop.test.ts), and what's
 * tested is **the background layer**: returns right after starting, the cursor only gives
 * what's new, the report is the last message, it can be stopped, names don't collide
 * with processes, and those sessions stay out of the "resume" list.
 *
 * The real loop behavior is covered by agent-loop.test.ts and isn't wired up again here
 * — doing so would only blur the cause of a failure.
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { SubagentJobs, MAX_AGENT_JOBS } from "../src/agent/subagent.ts"
import { MAX_ALIVE_JOBS, MAX_FLOW_ALIVE_JOBS } from "../src/agent/flow.ts"
import { MAX_STEPS } from "../src/prompt/max-steps.ts"
import { Store } from "../src/session/store.ts"
import { newSessionID } from "../src/session/id.ts"
import { __resetNamesForTest, reserveName } from "../src/tool/background.ts"
import type { LLMEvent, LLMRequest, ModelInfo } from "../src/llm/types.ts"
import type { ToolContext } from "../src/tool/types.ts"
import { JobTool } from "../src/tool/job.ts"
import { TaskTool } from "../src/tool/task.ts"

const INFO: ModelInfo = {
  ref: { providerID: "p", modelID: "m" },
  limit: { context: 200_000, output: 32_000 },
  supportsThinking: false,
  promptTemplate: "default",
  cacheInInput: false,
}

const tokens = (input: number, output = 0) => ({
  input,
  output,
  reasoning: 0,
  cache: { read: 0, write: 0 },
})

const say = (text: string): LLMEvent[] => [
  { type: "step-start" },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", text },
  { type: "text-end", id: "t" },
  { type: "step-finish", finishReason: "stop", tokens: tokens(100, 10) },
]

const readThenSay = (text: string): LLMEvent[][] => [
  [
    { type: "step-start" },
    { type: "tool-call", callID: "c1", tool: "read", input: { filePath: "src/auth/token.ts" } },
    { type: "tool-result", callID: "c1", tool: "read", output: "…" },
    { type: "step-finish", finishReason: "tool-calls", tokens: tokens(100, 10) },
  ],
  say(text),
]

interface HarnessOptions {
  /** Events per turn. Past the end, the last one is reused */
  script?: LLMEvent[][]
  /** Keeps the stream hanging forever (tests "still running" and kill) */
  hang?: boolean
  /** Emit the scripted progress first, then wait for cancellation. */
  hangAfterScript?: boolean
  /**
   * Holds the stream at the start until the test itself calls release().
   *
   * hang is "can't stop"; this is "goes when I say so" — only with it can timings like
   * "another downstream agent was dispatched while it was still running" be tested, and
   * that's the one place orchestration can go wrong.
   */
  hold?: boolean
  /** The agentflow window. false = off (the default) */
  flow?: number | false
}

function harness(options: HarnessOptions = {}) {
  __resetNamesForTest()
  let letGo = () => {}
  const held = new Promise<void>((resolve) => {
    letGo = resolve
  })
  const store = new Store(":memory:")
  const parent = newSessionID()
  store.createSession(parent, "/repo")
  /** Which session is current. Mutable — `/clear` swaps it out while things are running */
  const session = { id: parent }
  const events: Array<{ kind: string; id: string; exit?: number | null; steps?: number; feeds?: string[] }> = []
  const requests: LLMRequest[] = []
  const refreshes = { panel: 0 }

  const agents = new SubagentJobs({
    store,
    model: () => ({ providerID: "p", modelID: "m" }),
    info: () => INFO,
    tools: () => [],
    system: () => ["TEMPLATE", "SUBAGENT"],
    directory: "/repo",
    session: () => session.id,
    makeToolContext: (job, call): ToolContext => ({
      cwd: "/repo",
      root: "/repo",
      sessionID: job.sessionID,
      messageID: call.messageID,
      callID: call.callID,
      abortSignal: call.abortSignal,
      ask: async () => {},
      onProgress: () => {},
      metadata: () => {},
    }),
    onChange: () => refreshes.panel++,
    flow: () => options.flow ?? false,
    observer: (event) =>
      events.push({
        kind: event.kind,
        id: event.job.id,
        ...(event.job.exit !== undefined ? { exit: event.job.exit } : {}),
        ...(event.job.steps !== undefined ? { steps: event.job.steps } : {}),
        ...(event.job.feeds !== undefined ? { feeds: event.job.feeds } : {}),
      }),
    stream(request) {
      requests.push(request)
      const script = options.script ?? [say("done")]
      const entry = script[Math.min(requests.length - 1, script.length - 1)]!
      return {
        info: INFO,
        events: (async function* () {
          if (options.hang) {
            // hang until the caller aborts. After abort the generator is dropped and Loop
            // takes the interrupt path
            await new Promise<void>((resolve) => {
              if (request.abortSignal?.aborted) return resolve()
              request.abortSignal?.addEventListener("abort", () => resolve(), { once: true })
            })
            throw Object.assign(new Error("aborted"), { name: "AbortError" })
          }
          if (options.hold) await held
          for (const event of entry) yield event
          if (options.hangAfterScript) {
            await new Promise<void>(resolve => {
              if (request.abortSignal.aborted) return resolve()
              request.abortSignal.addEventListener("abort", () => resolve(), { once: true })
            })
            throw Object.assign(new Error("aborted"), { name: "AbortError" })
          }
        })(),
      }
    },
  })

  return { store, parent, session, agents, events, requests, refreshes, release: () => letGo() }
}

/**
 * Which session that subagent was opened in.
 *
 * JobSnapshot **deliberately has no** sessionID (neither the model nor the UI needs it),
 * so this asks the DB directly: child sessions are the ones with a parent_id (see
 * agent/subagent.ts).
 */
function sessionOf(h: { store: Store }, _id: string): string {
  const db = (h.store as unknown as { db: { query(sql: string): { all(): unknown[] } } }).db
  const rows = db.query(`SELECT id FROM session WHERE parent_id IS NOT NULL`).all() as Array<{ id: string }>
  return rows[0]?.id ?? ""
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * Waits until this job is no longer running (or times out), plus one tick: a job that
 * ends inside its settle window announces its exit a tick late (see settle in
 * agent/subagent.ts)
 */
async function settled(agents: SubagentJobs, id: string, ms = 2_000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // ★ the check is exited, not "not running" — a queued one isn't running either, and
    // it hasn't even started its work
    if (agents.list().find((job) => job.id === id)?.status === "exited") return void (await tick())
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// ─────────────────────────────────────────────── waking up a finished one

describe("waking up a finished one", () => {
  test("★ continues the original session — it still holds everything it read last round", async () => {
    const h = harness({ script: [say("第一份报告"), say("第二份报告")] })
    const job = await h.agents.start({ name: "scout", prompt: "先看一遍" })
    await settled(h.agents, job.id)
    const first = h.store.listAll(sessionOf(h, job.id)).length

    const again = await h.agents.resume(job.id, "再看一下测试那边")
    expect(again.id).toBe(job.id)
    await settled(h.agents, job.id)

    // same session: the previous round's messages are still there, the new one follows
    const history = h.store.listAll(sessionOf(h, job.id))
    expect(history.length).toBeGreaterThan(first)
    expect(JSON.stringify(history)).toContain("先看一遍")
    expect(JSON.stringify(history)).toContain("再看一下测试那边")
    // still **one** agent in total, not two
    expect(h.agents.list()).toHaveLength(1)
  })

  test("★ the new report can be handed over again — the earlier one being claimed doesn't mark this one claimed", async () => {
    const h = harness({ script: [say("第一份"), say("第二份")] })
    const job = await h.agents.start({ name: "scout", prompt: "看" })
    await settled(h.agents, job.id)
    expect(h.agents.claimReport(job.id)).toContain("第一份")
    // once handed over, it can't be claimed again
    expect(h.agents.claimReport(job.id)).toBeUndefined()

    await h.agents.resume(job.id, "再看")
    await settled(h.agents, job.id)
    expect(h.agents.claimReport(job.id)).toContain("第二份")
  })

  test("★ a running agent can't be woken — its answer will come back on its own", async () => {
    const h = harness({ hang: true })
    const job = await h.agents.start({ name: "slow", prompt: "等" })
    await expect(h.agents.resume(job.id, "再来一句")).rejects.toThrow(/still working/)
    await h.agents.killAll()
  })

  test("an unknown name is reported as such", async () => {
    const h = harness()
    await expect(h.agents.resume("nobody", "喂")).rejects.toThrow(/No subagent named/)
  })

  test("an empty brief is rejected — waking an agent and saying nothing leaves it guessing", async () => {
    const h = harness()
    const job = await h.agents.start({ name: "scout", prompt: "看" })
    await settled(h.agents, job.id)
    await expect(h.agents.resume(job.id, "   ")).rejects.toThrow(/prompt is required/)
  })

  test("steps and cost accumulate, the clock restarts — the bill asks 'what did this agent cost in total'", async () => {
    const h = harness({ script: [readThenSay("一")[0]!, readThenSay("一")[1]!, say("二")] })
    const job = await h.agents.start({ name: "scout", prompt: "看" })
    await settled(h.agents, job.id)
    const before = h.agents.list()[0]!
    await h.agents.resume(job.id, "再看")
    await settled(h.agents, job.id)
    const after = h.agents.list()[0]!
    expect(after.steps!).toBeGreaterThan(before.steps!)
    expect(after.tokensIn!).toBeGreaterThan(before.tokensIn!)
    expect(after.startedAt).toBeGreaterThanOrEqual(before.startedAt)
    expect(after.status).toBe("exited")
  })

  test("★ after /clear, the previous conversation's agents can't be woken — they don't belong to this one", async () => {
    const h = harness({ script: [say("一"), say("二")] })
    const job = await h.agents.start({ name: "scout", prompt: "看" })
    await settled(h.agents, job.id)

    h.session.id = "另一场"
    await expect(h.agents.resume(job.id, "再看")).rejects.toThrow(/No subagent named/)
    // ownership wasn't rewritten: back in the original session, it still belongs there
    expect(h.agents.parentOf(job.id)).toBe(h.parent)
    h.session.id = h.parent
    await h.agents.resume(job.id, "再看")
    await settled(h.agents, job.id)
  })

  test("waking also leaves a trace — the panel and receipts show it is active again", async () => {
    const h = harness({ script: [say("一"), say("二")] })
    const job = await h.agents.start({ name: "scout", prompt: "看" })
    await settled(h.agents, job.id)
    h.events.length = 0
    await h.agents.resume(job.id, "再看一遍那个文件")
    await settled(h.agents, job.id)
    expect(h.events.map((event) => event.kind)).toEqual(["exited"])
    // the panel line switches to this round's work — the name answers "what is this", this
    // line answers "what is it doing now"
    expect(h.agents.list()[0]!.command).toBe("再看一遍那个文件")
  })
})

// ─────────────────────────────────────────────── ownership

describe("suspend keeps it, kill removes it", () => {
  test("★ a suspended one keeps its memory and can be woken", async () => {
    const h = harness({ hang: true })
    const job = await h.agents.start({ name: "slow", prompt: "等" })
    const result = await h.agents.suspend(job.id)
    expect(result.job.status).toBe("exited")
    expect(h.agents.list()).toHaveLength(1)
    await h.agents.resume(job.id, "再说一句")
    await h.agents.killAll()
  })

  test("★ kill removes a running one for good: not listed, not wakeable", async () => {
    const h = harness({ hang: true })
    const job = await h.agents.start({ name: "slow", prompt: "等" })
    const result = await h.agents.kill(job.id)
    expect(result.removed).toBe(true)
    expect(h.agents.list()).toEqual([])
    await expect(h.agents.resume(job.id, "再看")).rejects.toThrow(/No subagent named/)
  })

  test("kill on a suspended one removes it too — that is the call for 'not needed any more'", async () => {
    const h = harness()
    const job = await h.agents.start({ name: "scout", prompt: "看" })
    await settled(h.agents, job.id)
    expect((await h.agents.kill(job.id)).removed).toBe(true)
    expect(h.agents.list()).toEqual([])
  })
})

describe("follows the session that dispatched it", () => {
  test("★ a new conversation can't see the previous one's agents — the fresh agent never dispatched them", async () => {
    const h = harness()
    const job = await h.agents.start({ name: "scout", prompt: "看" })
    await settled(h.agents, job.id)
    expect(h.agents.list()).toHaveLength(1)

    h.session.id = "另一场"
    expect(h.agents.list()).toEqual([])
    expect(h.agents.has(job.id)).toBe(false)
    // read, stop, and claiming the report all treat it as nonexistent — saying "hands off"
    // only sends the model looking for a way around
    await expect(h.agents.read(job.id, 0)).rejects.toThrow(/No subagent named/)
    await expect(h.agents.kill(job.id)).rejects.toThrow(/No subagent named/)
    await expect(h.agents.suspend(job.id)).rejects.toThrow(/No subagent named/)
    expect(h.agents.report(job.id)).toBeUndefined()
    expect(h.agents.claimReport(job.id)).toBeUndefined()
  })

  test("★ back in the original conversation, they return — ownership is stored on the job, the current session is looked up live", async () => {
    const h = harness()
    const job = await h.agents.start({ name: "scout", prompt: "看" })
    await settled(h.agents, job.id)
    h.session.id = "另一场"
    expect(h.agents.list()).toEqual([])
    h.session.id = h.parent
    expect(h.agents.list().map((each) => each.id)).toEqual([job.id])
    expect(h.agents.claimReport(job.id)).toBeDefined()
  })
})

// ─────────────────────────────────────────────── starting

describe("dispatching one", () => {
  test("named by **role**; the panel line shows the brief's first sentence", async () => {
    const h = harness()
    const job = await h.agents.start({
      name: "audit agent",
      prompt: "Check how auth works.\nStart from src/auth/.",
    })
    expect(job.id).toBe("audit-agent")
    expect(job.kind).toBe("agent")
    // the name answers "what is this", this line answers "what is it doing this time"
    expect(job.command).toBe("Check how auth works.")
    expect(h.agents.list().map((each) => each.id)).toEqual(["audit-agent"])
  })

  test("★ names keep Chinese — stripping non-ASCII would turn every Chinese name into job / job-2", async () => {
    const h = harness()
    const first = await h.agents.start({ name: "调查agent", prompt: "看看磁盘" })
    const second = await h.agents.start({ name: "调查agent", prompt: "再看看内存" })
    expect(first.id).toBe("调查agent")
    expect(second.id).toBe("调查agent-2")
  })

  test("long names are cut by **display width** — CJK characters take two columns, so cutting by character count overflows the column", async () => {
    const h = harness()
    const job = await h.agents.start({ name: "调查电脑存储空间的那个非常长的名字", prompt: "go" })
    expect(job.id).toBe("调查电脑存储空间")
  })

  test("★ names share one registry with background processes — on a collision, job output would be a coin toss", async () => {
    const h = harness()
    reserveName("audit-agent") // pretend a process with the same name is already running
    const job = await h.agents.start({ name: "audit agent", prompt: "check it" })
    expect(job.id).toBe("audit-agent-2")
  })

  test("workers receive their reserved identity after collisions and keep it on resume", async () => {
    const h = harness()
    try {
      reserveName("demo")
      const first = await h.agents.start({ name: "demo", prompt: "Report your own name." })
      await settled(h.agents, first.id)
      const second = await h.agents.start({ name: "demo", prompt: "Report your own name." })
      await settled(h.agents, second.id)
      await h.agents.resume(first.id, "Report your own name again.")
      await settled(h.agents, first.id)
      expect(first.id).toBe("demo-2")
      expect(second.id).toBe("demo-3")
      for (const [index, id] of [first.id, second.id, first.id].entries()) {
        const request = h.requests[index]!
        expect(request.system).toEqual(["TEMPLATE", "SUBAGENT"])
        expect(JSON.stringify(request.messages)).toContain(JSON.stringify(`Your assigned job ID is "${id}"`).slice(1, -1))
      }
    } finally {
      await h.agents.killAll()
      h.store.close()
    }
  })

  test("twenty dispatched tasks obey the six-worker window and drain the queue", async () => {
    const h = harness({ hold: true, flow: 6 })
    try {
      await Promise.all(Array.from({ length: 20 }, (_, n) =>
        h.agents.start({ name: `demo-${n + 1}`, prompt: "Report your own name." })))
      expect(h.agents.list().filter(job => job.status === "running")).toHaveLength(6)
      expect(h.agents.list().filter(job => job.status === "queued")).toHaveLength(14)
      expect(h.requests).toHaveLength(6)
      h.release()
      for (const job of h.agents.list()) await settled(h.agents, job.id)
      expect(h.requests).toHaveLength(20)
      expect(h.agents.list().every(job => job.status === "exited")).toBe(true)
    } finally {
      h.release()
      await h.agents.killAll()
      h.store.close()
    }
  })

  test("the task goes out as the first user message, not spliced into system", async () => {
    const h = harness()
    await h.agents.start({ name: "count files", prompt: "count the ts files under src" })
    expect(h.requests[0]!.system).toEqual(["TEMPLATE", "SUBAGENT"])
    const first = JSON.stringify(h.requests[0]!.messages)
    expect(first).toContain("count the ts files under src")
  })

  test("★ its session stays out of the resume list — the user wants to resume their own", async () => {
    const h = harness()
    // the parent session must have a message before it shows up in the list (empty shells
    // don't count), so that "who's missing" is visible
    h.store.upsertMessage({ id: "msg_parent", sessionID: h.parent, role: "user", timeCreated: Date.now() })
    await h.agents.start({ name: "scout", prompt: "look around" })
    await settled(h.agents, "scout")
    // the subagent's session does have messages (it wrote both the task and the answer
    // into it), so the only reason it's missing from this list is the parent_id filter
    const sessions = h.store.listSessions({ directory: "/repo" })
    expect(sessions.map((session) => session.id)).toEqual([h.parent])
  })

  test("only a few run at once; the excess is **queued**, not an error", async () => {
    const h = harness({ hang: true })
    for (let n = 0; n < MAX_AGENT_JOBS; n++) {
      await h.agents.start({ name: `job ${n}`, prompt: "wait" })
    }
    const extra = await h.agents.start({ name: "one more", prompt: "wait" })
    expect(extra.status).toBe("queued")
    // the window is hard: the fifth hasn't sent a single request yet
    expect(h.agents.list().filter((job) => job.status === "running")).toHaveLength(MAX_AGENT_JOBS)
    expect(h.requests).toHaveLength(MAX_AGENT_JOBS)
    await h.agents.killAll()
  })

  test("the queue has a limit too — only a full total errors, and it says how to make room", async () => {
    const h = harness({ hang: true })
    for (let n = 0; n < MAX_ALIVE_JOBS; n++) {
      await h.agents.start({ name: `job ${n}`, prompt: "wait" })
    }
    await expect(h.agents.start({ name: "one more", prompt: "wait" })).rejects.toThrow(
      /Too many subagents already queued or running/,
    )
    await h.agents.killAll()
  })

  test("★ in flow mode the total is **far larger** than the window — capping at twenty-odd would tell it not to split work finely", async () => {
    const h = harness({ hang: true, flow: 6 })
    // line up forty at once: six start, thirty-four queue. That's exactly the scale this
    // mode exists for ("check each of forty files"), while with it off the ninth should
    // already blow up
    for (let n = 0; n < 40; n++) {
      await h.agents.start({ name: `job ${n}`, prompt: "wait" })
    }
    expect(h.agents.list().filter((job) => job.status === "running")).toHaveLength(6)
    expect(h.agents.list().filter((job) => job.status === "queued")).toHaveLength(34)
    expect(MAX_FLOW_ALIVE_JOBS).toBeGreaterThanOrEqual(100)
    await h.agents.killAll()
  })

  test("★ when a slot frees up, the queued one starts by itself — nobody needs to nudge it", async () => {
    const h = harness({ hang: true })
    for (let n = 0; n < MAX_AGENT_JOBS; n++) {
      await h.agents.start({ name: `job ${n}`, prompt: "wait" })
    }
    await h.agents.start({ name: "last", prompt: "wait" })
    expect(h.requests).toHaveLength(MAX_AGENT_JOBS)

    await h.agents.suspend("job-0")
    expect(h.agents.list().find((job) => job.id === "last")?.status).toBe("running")
    expect(h.requests).toHaveLength(MAX_AGENT_JOBS + 1)
    await h.agents.killAll()
  })

  test("an empty brief is rejected — the subagent can't see the main conversation, so an empty brief means guessing", async () => {
    const h = harness()
    await expect(h.agents.start({ name: "x", prompt: "   " })).rejects.toThrow(/prompt is required/)
  })
})

// ─────────────────────────────────────────────── orchestration

describe("pipelines (after)", () => {
  test("★ takes no step until the awaited one finishes, then starts **with its report**", async () => {
    const h = harness({ script: [say("scout 的结论")], hold: true })
    await h.agents.start({ name: "scout", prompt: "去查" })
    const next = await h.agents.start({ name: "verify", prompt: "核对上面那份", after: ["scout"] })
    expect(next.status).toBe("queued")
    expect(next.after).toEqual(["scout"])
    // scout is still held at the starting line, so verify must not have sent a single
    // request
    expect(h.requests).toHaveLength(1)

    h.release()
    await settled(h.agents, "verify")
    // the second request is verify's. Its first user message must **carry** what scout
    // said — otherwise this edge is just a queue order with no handoff at all
    const brief = JSON.stringify(h.requests[1]?.messages ?? [])
    expect(brief).toContain("scout 的结论")
    expect(brief).toContain("核对上面那份")
  })

  test("once a dependency finishes, its report is **not sent to the main conversation** — it already went downstream", async () => {
    // hold: scout has to see the downstream agent register **before it finishes**. In
    // real runs it takes minutes, while here it's done in one turn — without holding it,
    // this would be testing a different timing
    const h = harness({ script: [say("给下家的东西")], hold: true })
    await h.agents.start({ name: "scout", prompt: "去查" })
    await h.agents.start({ name: "verify", prompt: "核对", after: ["scout"] })
    h.release()
    await settled(h.agents, "scout")
    // feeds is non-empty, so the cli side doesn't deliver it (see deliverReport in main.ts)
    const scout = h.events.find((event) => event.kind === "exited" && event.id === "scout")
    expect(scout?.feeds).toEqual(["verify"])
    // while the last one (nobody waiting on it) still gets reported up
    await settled(h.agents, "verify")
    expect(h.events.find((event) => event.kind === "exited" && event.id === "verify")?.feeds).toBeUndefined()
  })

  test("an unknown name errors at once instead of counting as satisfied", async () => {
    const h = harness()
    await expect(h.agents.start({ name: "verify", prompt: "核对", after: ["nobody"] })).rejects.toThrow(
      /No subagent named "nobody"/,
    )
    // ★ the name shouldn't get burned either: the next verify is still verify, not verify-2
    const job = await h.agents.start({ name: "verify", prompt: "核对" })
    expect(job.id).toBe("verify")
  })

  test("stopping upstream cancels everything waiting on it, and names what was cancelled", async () => {
    const h = harness({ hang: true })
    await h.agents.start({ name: "scout", prompt: "去查" })
    await h.agents.start({ name: "verify", prompt: "核对", after: ["scout"] })
    await h.agents.start({ name: "write", prompt: "写出来", after: ["verify"] })

    const result = await h.agents.suspend("scout")
    // the whole chain can't reach the end, so the whole chain is wound down — and it's
    // **said out loud**
    expect(result.output).toContain("also cancelled")
    expect(result.output).toContain("verify")
    expect(result.output).toContain("write")
    expect(h.agents.list().every((job) => job.status === "exited")).toBe(true)
  })

  test("a failed upstream still releases downstream — its 'why it failed' helps the next one", async () => {
    // first request (scout) errors out; the second (verify) answers normally
    const h = harness({
      script: [[{ type: "step-start" }, { type: "error", error: new Error("我没找到那个文件") }], say("核对完了")],
    })
    await h.agents.start({ name: "scout", prompt: "去查" })
    await h.agents.start({ name: "verify", prompt: "核对", after: ["scout"] })
    await settled(h.agents, "verify")
    expect(h.agents.list().find((job) => job.id === "scout")?.exit).toBe(1)
    expect(h.requests).toHaveLength(2)
    // the failure and its reason both reach verify's brief
    const brief = JSON.stringify(h.requests[1]!.messages)
    expect(brief).toContain("THIS ONE FAILED")
    expect(brief).toContain("我没找到那个文件")
  })
})

// ─────────────────────────────────────────────── reading

describe("reading what it said", () => {
  test("★ the final message is the deliverable and enters the buffer verbatim", async () => {
    const h = harness({ script: readThenSay("Handled in src/auth/token.ts:88.") })
    const job = await h.agents.start({ name: "find handler", prompt: "where is it" })
    await settled(h.agents, job.id)
    const result = await h.agents.read(job.id, 0)
    expect(result.output).toContain("Handled in src/auth/token.ts:88.")
    expect(result.job.status).toBe("exited")
    expect(result.job.exit).toBe(0)
  })

  test("the work shows one line per tool call, and its interim talk stays out", async () => {
    const h = harness({ script: readThenSay("done") })
    const job = await h.agents.start({ name: "find handler", prompt: "where is it" })
    await settled(h.agents, job.id)
    const result = await h.agents.read(job.id, 0)
    expect(result.output).toContain("read src/auth/token.ts")
  })

  test("step.finish refreshes the panel", async () => {
    const h = harness({ script: [say("done")] })
    const job = await h.agents.start({ name: "scout", prompt: "look" })
    await settled(h.agents, job.id)
    expect(h.refreshes.panel).toBeGreaterThan(0)
  })

  test("★ the cursor only yields what's new: a second read doesn't repeat the same text", async () => {
    const h = harness({ script: readThenSay("the answer") })
    const job = await h.agents.start({ name: "find handler", prompt: "where is it" })
    await settled(h.agents, job.id)
    const first = await h.agents.read(job.id, 0)
    expect(first.output.length).toBeGreaterThan(0)
    const second = await h.agents.read(job.id, 0)
    expect(second.output).toBe("")
  })

  test("user inspection does not consume output the model has not read", async () => {
    const h = harness({ script: readThenSay("the answer") })
    const job = await h.agents.start({ name: "find handler", prompt: "where is it" })
    await settled(h.agents, job.id)

    const shown = await h.agents.read(job.id, 0, "user")
    expect(shown.output).toContain("the answer")
    const model = await h.agents.read(job.id, 0)
    expect(model.output).toContain("the answer")
  })

  test("wait times out when nothing arrives, and says it's still running", async () => {
    const h = harness({ hang: true })
    const job = await h.agents.start({ name: "slow one", prompt: "wait" })
    const result = await h.agents.read(job.id, 50)
    expect(result.timedOut).toBe(true)
    expect(result.job.status).toBe("running")
    await h.agents.killAll()
  })

  test("an unknown name gets an actionable message, not an empty result", async () => {
    const h = harness()
    await expect(h.agents.read("nope", 0)).rejects.toThrow(/No subagent named/)
  })
})

// ─────────────────────────────────────────────── stopping

describe("stopping", () => {
  test("after kill the status is exited and marked stopped — not the same as finishing on its own", async () => {
    const h = harness({ hang: true })
    const job = await h.agents.start({ name: "slow one", prompt: "wait" })
    const result = await h.agents.suspend(job.id)
    expect(result.job.status).toBe("exited")
    expect(result.job.signal).toBe("stopped")
  })

  test("killAll reports how many it stopped — the message on exit must be true", async () => {
    const h = harness({ hang: true })
    await h.agents.start({ name: "one", prompt: "wait" })
    await h.agents.start({ name: "two", prompt: "wait" })
    expect(await h.agents.killAll()).toBe(2)
    expect(h.agents.list().every((job) => job.status === "exited")).toBe(true)
  })
})

// ─────────────────────────────────────────────── leaving a trace

describe("start and finish both leave a trace", () => {
  test("the exit event carries the exit code and step count", async () => {
    const h = harness({ script: readThenSay("done") })
    const job = await h.agents.start({ name: "scout", prompt: "look" })
    await settled(h.agents, job.id)
    const exited = h.events.find((event) => event.kind === "exited")
    expect(exited?.exit).toBe(0)
    expect(exited?.steps).toBe(2)
  })

  test("★ 'started' is reported only once it really runs — one that dies on the spot is reported as exited", async () => {
    const h = harness({ hang: true })
    await h.agents.start({ name: "scout", prompt: "look" })
    expect(h.events.map((event) => event.kind)).toEqual(["started"])
    await h.agents.killAll()

    // errors within the settle window (bad credentials, mistyped model): no "started"
    // first, or the model reads it as dispatched and goes off to do other things
    const dead = harness({ script: [[{ type: "step-start" }, { type: "error", error: new Error("401 bad key") }]] })
    await dead.agents.start({ name: "scout", prompt: "look" })
    await tick()
    expect(dead.events.map((event) => event.kind)).toEqual(["exited"])
  })
})

// ─────────────────────────────────────────────── the job tool: one entry for both kinds

describe("job tool manages both processes and subagents", () => {
  const context = (agents: SubagentJobs): ToolContext => ({
    cwd: "/repo",
    root: "/repo",
    sessionID: "s",
    messageID: "m",
    callID: "c",
    abortSignal: new AbortController().signal,
    ask: async () => {},
    onProgress: () => {},
    metadata: () => {},
    agents,
  })

  test("★ a finished one is listed to the model as suspended, with how to wake it — 'finished' read as 'used up'", async () => {
    const h = harness()
    const job = await h.agents.start({ name: "scout", prompt: "看" })
    await settled(h.agents, job.id)
    const result = await JobTool.execute({ action: "list" }, context(h.agents))
    expect(result.output).toContain("scout  suspended after")
    expect(result.output).toContain(`task resume:"${job.id}"`)
  })

  test("★ job suspend keeps a subagent; job kill removes it; killing a suspended one isn't a no-op 'Stopped'", async () => {
    const h = harness({ hang: true })
    const job = await h.agents.start({ name: "slow", prompt: "等" })
    const suspended = await JobTool.execute({ action: "suspend", id: job.id }, context(h.agents))
    expect(suspended.output).toContain(`Suspended ${job.id}`)
    const again = await JobTool.execute({ action: "suspend", id: job.id }, context(h.agents))
    expect(again.output).toContain("already stopped")
    const killed = await JobTool.execute({ action: "kill", id: job.id }, context(h.agents))
    expect(killed.output).toContain("removed for good")
    expect((await JobTool.execute({ action: "list" }, context(h.agents))).output).not.toContain(job.id)
  })

  test("list shows both kinds together and marks which are subagents", async () => {
    const h = harness({ hang: true })
    await h.agents.start({ name: "audit agent", prompt: "Look at the auth flow" })
    const result = await JobTool.execute({ action: "list" }, context(h.agents))
    expect(result.output).toContain("audit-agent")
    expect(result.output).toContain("subagent: Look at the auth flow")
    expect(result.title).toBe("1 running")
    await h.agents.killAll()
  })

  test("★ the kind is recognized from the name; the model needn't say", async () => {
    const h = harness({ script: readThenSay("the answer") })
    const job = await h.agents.start({ name: "scout", prompt: "look" })
    await settled(h.agents, job.id)
    const result = await JobTool.execute({ action: "output", id: job.id }, context(h.agents))
    expect(result.output).toContain("the answer")
  })

  test("★ wait never applies to a subagent — for those two minutes the main agent is frozen while the user wants to talk", async () => {
    const h = harness({ hang: true })
    const job = await h.agents.start({ name: "scout", prompt: "look" })
    const started = Date.now()
    const result = await JobTool.execute(
      { action: "output", id: job.id, wait: 5 },
      context(h.agents),
    )
    // if it really waited, this would take at least five seconds
    expect(Date.now() - started).toBeLessThan(1_000)
    // and it must be told the wait didn't happen — otherwise it thinks it waited, and so
    // waits again
    expect(result.output).toContain("wait does not apply to a subagent")
    expect(result.output).toMatch(/delivered to you/i)
    await h.agents.killAll()
  })

  test("wait still works for processes — 'start a server, wait for listening' needs it", async () => {
    const h = harness()
    const started = Date.now()
    // there's no such process, so it just throws; this only asserts it wasn't caught up
    // in the change above
    await expect(
      JobTool.execute({ action: "output", id: "dev", wait: 1 }, context(h.agents)),
    ).rejects.toThrow(/No background job named/)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("a name nobody knows gets an actionable message", async () => {
    const h = harness()
    await expect(JobTool.execute({ action: "output", id: "ghost" }, context(h.agents))).rejects.toThrow(
      /No background job named/,
    )
  })

  test("in a host without subagents, job still handles only processes", async () => {
    const result = await JobTool.execute(
      { action: "list" },
      {
        cwd: "/repo",
        root: "/repo",
        sessionID: "s",
        messageID: "m",
        callID: "c",
        abortSignal: new AbortController().signal,
        ask: async () => {},
        onProgress: () => {},
        metadata: () => {},
      },
    )
    expect(result.output).toContain("Nothing running")
  })
})

// ─────────────────────────────────────────────── the task tool: dispatch and return

describe("task tool", () => {
  /**
   * ★ A subagent **does** have the skill tool and the same catalog (subagentTools only
   *   removes task / ask), but it doesn't have the conversation that made that skill
   *   relevant, and a narrow brief happens to kill the thought "I should look something
   *   up first" — lookup is driven by perceived uncertainty. So naming the skill can only
   *   be done by whoever dispatches the work, and this sentence is the only place that
   *   says so.
   */
  test("the description tells the dispatcher to name the skill in the brief", () => {
    expect(TaskTool.description).toContain("name it in the brief")
    // naming it is enough: the subagent can open it itself; pasting the body into the
    // brief pays for it twice
    expect(TaskTool.description).toContain("do not paste its text")
  })

  /**
   * ★ Since the chaining and resume sections of the description moved into
   *   `alfa-subagents`, **this pointer is its only entry point**. The catalog line can
   *   only say what it covers, not "you're about to send out a team, read this first" —
   *   and this is exactly the sentence most likely to be deleted as filler in the next
   *   trim. The symptom of deleting it isn't an error; it's the model making up the
   *   semantics of after on its own.
   */
  test("the description points to alfa-subagents before sending out a team", () => {
    expect(TaskTool.description).toContain("alfa-subagents")
  })

  const context = (agents: SubagentJobs, over: Partial<ToolContext> = {}): ToolContext => ({
    cwd: "/repo",
    root: "/repo",
    sessionID: "s",
    messageID: "m",
    callID: "c",
    abortSignal: new AbortController().signal,
    ask: async () => {},
    onProgress: () => {},
    metadata: () => {},
    agents,
    ...over,
  })

  test("★ returns right after dispatch and says the result will be delivered — otherwise the model polls or redoes the work", async () => {
    const h = harness({ hang: true })
    const result = await TaskTool.execute(
      { name: "audit auth", prompt: "look at it" },
      context(h.agents),
    )
    expect(result.output).toContain("is working on")
    expect(result.output).toMatch(/delivered to you/i)
    expect(result.output).toMatch(/do not poll/i)
    expect(result.metadata["started"]).toBe(true)
    await h.agents.killAll()
  })

  test("★ one that answers within the first few hundred ms hands over its answer at once — not reported as a failure", async () => {
    const h = harness({ script: [say("42 files")] })
    const result = await TaskTool.execute({ name: "count agent", prompt: "count them" }, context(h.agents))
    expect(result.metadata["answered"]).toBe(true)
    expect(result.output).toContain("42 files")
    // and this report **has already been claimed**: the push at the end won't deliver it
    // again
    expect(h.agents.claimReport("count-agent")).toBeUndefined()
  })

  test("one that **fails** in those few hundred ms is reported as failed, with what it said", async () => {
    const h = harness({ script: [[{ type: "error", error: new Error("no credentials") }]] })
    const result = await TaskTool.execute({ name: "broken one", prompt: "go" }, context(h.agents))
    expect(result.metadata["started"]).toBe(false)
    expect(result.output).toContain("stopped without doing the work")
  })

  test("★ resume reuses the same agent, so the brief needn't repeat the background", async () => {
    const h = harness({ script: [say("第一份"), say("第二份")] })
    await TaskTool.execute({ name: "scout", prompt: "先看一遍" }, context(h.agents))
    await settled(h.agents, "scout")
    const result = await TaskTool.execute({ resume: "scout", prompt: "再看一下测试那边" }, context(h.agents))
    expect(result.metadata["job"]).toBe("scout")
    expect(result.metadata["resumed"]).toBe(true)
    expect(h.agents.list()).toHaveLength(1)
    await settled(h.agents, "scout")
  })

  test("★ after builds a pipeline and says up front what it's waiting for", async () => {
    const h = harness({ hang: true })
    await TaskTool.execute({ name: "scout", prompt: "去查" }, context(h.agents))
    const result = await TaskTool.execute(
      { name: "verify", after: ["scout"], prompt: "核对" },
      context(h.agents),
    )
    expect(result.metadata["queued"]).toBe(true)
    expect(result.output).toContain("waiting for scout")
    // ★ This sentence must be there: without it, the model sees the job sitting still and
    //   goes `job output` fishing on a job that hasn't done anything yet, or just does the
    //   work over again itself
    expect(result.output).toMatch(/starts on its own/i)
    await h.agents.killAll()
  })

  test("after can't be combined with resume — the only way this graph could form a cycle", async () => {
    const h = harness({ script: [say("一"), say("二")] })
    await TaskTool.execute({ name: "scout", prompt: "去查" }, context(h.agents))
    await settled(h.agents, "scout")
    await expect(
      TaskTool.execute({ resume: "scout", after: ["scout"], prompt: "再看看" }, context(h.agents)),
    ).rejects.toThrow(/"after" only works when starting a new subagent/)
  })

  test("name together with resume likely means the model is unsure which it wants; report it so it picks", async () => {
    const h = harness()
    await expect(
      TaskTool.execute({ name: "scout", resume: "scout", prompt: "go" }, context(h.agents)),
    ).rejects.toThrow(/either "name".*or "resume"/)
  })

  test("neither is rejected too — no way to know which to start", async () => {
    const h = harness()
    await expect(TaskTool.execute({ prompt: "go" }, context(h.agents))).rejects.toThrow(/name is required/)
  })

  test("a host that can't start subagents says so, so the model does the work itself", async () => {
    await expect(
      TaskTool.execute(
        { name: "x", prompt: "y" },
        {
          cwd: "/repo",
          root: "/repo",
          sessionID: "s",
          messageID: "m",
          callID: "c",
          abortSignal: new AbortController().signal,
          ask: async () => {},
          onProgress: () => {},
          metadata: () => {},
        },
      ),
    ).rejects.toThrow(/not available/)
  })
})

// ─────────────────────────────────────────────── a new session stops them

describe("switching to a new conversation", () => {
  test("★ abort stops everything running at once and reports how many — /clear relies on it", async () => {
    const h = harness({ hang: true })
    await h.agents.start({ name: "one", prompt: "wait" })
    await h.agents.start({ name: "two", prompt: "wait" })
    expect(h.agents.abort()).toBe(2)
    await settled(h.agents, "one")
    await settled(h.agents, "two")
    expect(h.agents.list().every((job) => job.status === "exited")).toBe(true)
    // ones already stopped aren't counted again
    expect(h.agents.abort()).toBe(0)
  })
})

// ─────────────────────────────────────────────── the ones the audit caught

describe("★ fixes from the audit", () => {
  test("a report is handed over once: whoever claims it first owns it, the other path gets undefined", async () => {
    const h = harness({ script: [say("the answer")] })
    const job = await h.agents.start({ name: "scout agent", prompt: "look" })
    await settled(h.agents, job.id)
    expect(h.agents.claimReport(job.id)).toContain("the answer")
    expect(h.agents.claimReport(job.id)).toBeUndefined()
    // report() only takes a look; it doesn't claim the slot
    expect(h.agents.report(job.id)).toContain("the answer")
  })

  test("★ remembers **which session** dispatched it — after /clear its findings have nowhere to go", async () => {
    const h = harness({ script: [say("done")] })
    const job = await h.agents.start({ name: "scout agent", prompt: "look" })
    expect(h.agents.parentOf(job.id)).toBe(h.parent)
  })

  test("a report that hit the step limit is flagged, or a half-done investigation passes as a conclusion", async () => {
    // calling a tool every turn = never wrapping up, until the last step (tools off)
    // forces the wrap-up paragraph
    const readTurn = (callID: string): LLMEvent[] => [
      { type: "step-start" },
      { type: "tool-call", callID, tool: "read", input: { filePath: "a.ts" } },
      { type: "tool-result", callID, tool: "read", output: "…" },
      { type: "step-finish", finishReason: "tool-calls", tokens: tokens(10, 1) },
    ]
    const h = harness({
      script: [...Array.from({ length: MAX_STEPS - 1 }, (_, i) => readTurn(`c${i}`)), say("what I have so far")],
    })
    const job = await h.agents.start({ name: "endless agent", prompt: "go" })
    await settled(h.agents, job.id, 20_000)
    expect(h.requests).toHaveLength(MAX_STEPS)
    const report = h.agents.report(job.id) ?? ""
    expect(report).toContain("what I have so far")
    expect(report).toContain("ran out of steps")
  })

  test("a report that finished normally carries no step-limit flag", async () => {
    const h = harness({ script: readThenSay("what I found") })
    const job = await h.agents.start({ name: "scout agent", prompt: "go" })
    await settled(h.agents, job.id)
    expect(h.agents.report(job.id)).toContain("what I found")
    expect(h.agents.report(job.id)).not.toContain("ran out of steps")
  })

  test("spend follows the provider's accounting, not a sum computed locally", async () => {
    const h = harness({ script: [say("ok")] })
    const job = await h.agents.start({ name: "count agent", prompt: "go" })
    await settled(h.agents, job.id)
    const snapshot = h.agents.list().find((each) => each.id === job.id)!
    // INFO.cacheInInput is false → input + cache; cache is 0 here, so it's just input
    expect(snapshot.tokensIn).toBe(100)
    expect(snapshot.tokensOut).toBe(10)
  })
})


test("subagent trace keeps actual parent identity and gets a new run identity on resume", async () => {
  const h = harness({ script: [say("Done")] })
  try {
    const job = await h.agents.start({ name: "trace-worker", prompt: "Inspect files" })
    await settled(h.agents, job.id)
    const first = h.requests[0]!.execution!
    expect(first.requestKind).toBe("subagent")
    expect(first.sessionId).toBe(sessionOf(h, job.id))
    expect(first.agentInstanceId).toBe(first.sessionId)
    expect(first.parentAgentInstanceId).toBe(h.agents.parentOf(job.id))
    expect(first.depth).toBe(1)
    await h.agents.resume(job.id, "Check again")
    await settled(h.agents, job.id)
    expect(h.requests[1]!.execution!.runId).not.toBe(first.runId)
    expect(h.requests[1]!.execution!.agentInstanceId).toBe(first.agentInstanceId)
  } finally { await h.agents.killAll(); h.store.close() }
})


for (const commentary of [true, false]) test(`resuming then interrupting ${commentary ? "commentary" : "partial final text"} cannot report the previous dispatch's answer`, async () => {
  const options: HarnessOptions = { script: [say("Previous dispatch succeeded")] }
  const h = harness(options)
  try {
    const job = await h.agents.start({ name: "interrupted-resume", prompt: "First dispatch" })
    await settled(h.agents, job.id)
    options.script = [[
      { type: "text-start", id: "progress", ...(commentary ? { responses: { phase: "commentary" as const } } : {}) },
      { type: "text-delta", id: "progress", text: "Inspecting the new request" },
      { type: "text-end", id: "progress", ...(commentary ? { responses: { phase: "commentary" as const } } : {}) },
    ]]
    options.hangAfterScript = true
    await h.agents.resume(job.id, "Second dispatch")
    await h.agents.suspend(job.id)
    await settled(h.agents, job.id)
    const report = h.agents.claimReport(job.id)
    expect(report).not.toContain("Previous dispatch succeeded")
    if (commentary) expect(report).toBe("(stopped before a final answer)")
    else {
      expect(report).toContain("Inspecting the new request")
      expect(report).toContain("Stopped before finishing")
    }
  } finally { await h.agents.killAll(); h.store.close() }
})
