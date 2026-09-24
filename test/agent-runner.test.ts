/**
 * Runner / Ctrl-C.
 *
 * This group **really spawns `sleep 60`**, no mocking. If any link in the interruption
 * chain breaks, unit tests can be all green while reality is littered with orphan
 * processes — the only way to prove it right is to count processes.
 *
 * Acceptance criteria (from the plan):
 *   1. A single Ctrl-C returns the prompt to the user within 200ms
 *   2. pgrep sees no orphans
 *   3. The next input carries on normally
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CANCEL_TIMEOUT_MS, Runner, SessionBusyError } from "../src/agent/runner.ts"
import { Loop } from "../src/agent/loop.ts"
import { Emitter, type UIEvent } from "../src/agent/events.ts"
import { Store } from "../src/session/store.ts"
import { newSessionID } from "../src/session/id.ts"
import { createToolContext } from "../src/tool/context.ts"
import { BashTool } from "../src/tool/bash.ts"
import type { LLMEvent, LLMRequest, ModelInfo } from "../src/llm/types.ts"
import type { ToolPart } from "../src/session/schema.ts"

const INFO: ModelInfo = {
  ref: { providerID: "p", modelID: "m" },
  limit: { context: 200_000, output: 32_000 },
  supportsThinking: false,
  promptTemplate: "default",
  cacheInInput: false,
}
const MODEL = { providerID: "p", modelID: "m" }
const TOKENS = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "apc-runner-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * A unique sleep duration per test case.
 *
 * ⚠ Don't count the total with `pgrep -xc sleep`. The machine already has other
 *   people's sleeps (a resident `sleep infinity` in a container, a `sleep 5` in a CI
 *   script), and using the total as a baseline is randomly flaky — my first version did
 *   exactly that, and then I spent ten minutes chasing an orphan that didn't exist.
 *   With a unique duration, `pgrep -fx` only counts the ones we started ourselves.
 */
let markSeq = 0
function uniqueSleep(): { seconds: string; count: () => Promise<number>; reap: () => void } {
  const seconds = `6${markSeq++}.${(Date.now() % 997).toString().padStart(3, "0")}`
  const pattern = `sleep ${seconds}`
  return {
    seconds,
    async count() {
      const proc = Bun.spawn(["pgrep", "-fx", pattern], { stdout: "pipe", stderr: "ignore" })
      const text = await new Response(proc.stdout).text()
      await proc.exited
      return text.trim() ? text.trim().split(/\s+/).length : 0
    },
    reap() {
      Bun.spawnSync(["pkill", "-f", pattern])
    },
  }
}

/** Poll until the condition holds, instead of guessing the timing with a fixed sleep. */
async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await Bun.sleep(20)
  }
  return false
}

function build(makeEvents: (request: LLMRequest) => AsyncIterable<LLMEvent>) {
  const store = new Store(":memory:")
  const sessionID = newSessionID()
  store.createSession(sessionID, dir)
  const emitter = new Emitter<UIEvent>()

  const loop = new Loop({
    store,
    emitter,
    tools: () => [BashTool],
    system: () => ["SYS"],
    makeToolContext: (call) =>
      createToolContext(
        {
          cwd: dir,
          root: dir,
          sessionID,
          ask: async () => {}, // always allow in tests; permissions have their own tests
          onProgress: () => {},
          onMetadata: () => {},
        },
        call,
      ),
    stream: (request) => ({ info: INFO, events: makeEvents(request) }),
  })

  return { store, sessionID, emitter, runner: new Runner(loop) }
}

/** A fake stream that runs one command through the real bash tool. */
function bashStream(command: string) {
  return (request: LLMRequest): AsyncIterable<LLMEvent> =>
    (async function* () {
      yield { type: "step-start" } as LLMEvent
      yield { type: "tool-call", callID: "c1", tool: "bash", input: { command } } as LLMEvent
      const ctx = request.makeToolContext({ callID: "c1", abortSignal: request.abortSignal })
      try {
        const result = await BashTool.execute({ command }, ctx)
        yield { type: "tool-result", callID: "c1", tool: "bash", output: result.output } as LLMEvent
      } catch (error) {
        yield {
          type: "tool-error",
          callID: "c1",
          tool: "bash",
          error: error instanceof Error ? error.message : String(error),
        } as LLMEvent
      }
      yield { type: "step-finish", finishReason: "tool-calls", tokens: TOKENS } as LLMEvent
    })()
}

// ─────────────────────────────────────────────── Lifecycle

describe("Runner lifecycle", () => {
  test("one session never runs two turns at once", async () => {
    const h = build(() =>
      (async function* () {
        await Bun.sleep(50)
        yield { type: "step-finish", finishReason: "stop", tokens: TOKENS } as LLMEvent
      })(),
    )
    const run = h.runner.start({ sessionID: h.sessionID, model: MODEL, text: "a" })
    expect(h.runner.isBusy(h.sessionID)).toBe(true)
    expect(() => h.runner.start({ sessionID: h.sessionID, model: MODEL, text: "b" })).toThrow(SessionBusyError)
    await run.promise
    expect(h.runner.isBusy(h.sessionID)).toBe(false)
  })

  test("a finished turn is removed from active", async () => {
    const h = build(() =>
      (async function* () {
        yield { type: "step-finish", finishReason: "stop", tokens: TOKENS } as LLMEvent
      })(),
    )
    await h.runner.start({ sessionID: h.sessionID, model: MODEL, text: "a" }).promise
    expect(h.runner.isBusy()).toBe(false)
    expect(h.runner.get(h.sessionID)).toBeUndefined()
  })

  test("a throwing Loop is still cleaned up, leaving no busy state", async () => {
    const h = build(() => {
      throw new Error("stream construction blew up")
    })
    const run = h.runner.start({ sessionID: h.sessionID, model: MODEL, text: "a" })
    await run.promise
    expect(h.runner.isBusy(h.sessionID)).toBe(false)
  })

  test("cancel returns idle when nothing is running", async () => {
    const h = build(() => (async function* () {})())
    expect(await h.runner.cancel(h.sessionID)).toBe("idle")
  })
})

// ─────────────────────────────────────────────── ★ Real interruption

describe("★ real Ctrl-C", () => {
  test("① returns within 200ms ② no orphans ③ tool part is finalized", async () => {
    const mark = uniqueSleep()
    const h = build(bashStream(`sleep ${mark.seconds}`))
    try {
      const run = h.runner.start({ sessionID: h.sessionID, model: MODEL, text: "wait" })

      // Wait until the process is really up, otherwise we'd be testing the much easier
      // "aborted before it even spawned" case
      expect(await until(async () => (await mark.count()) === 1)).toBe(true)

      const started = Date.now()
      const outcome = await h.runner.cancel(h.sessionID)
      const elapsed = Date.now() - started

      // ① The prompt must come back within 200ms
      expect(elapsed).toBeLessThanOrEqual(CANCEL_TIMEOUT_MS + 60)
      expect(outcome === "settled" || outcome === "timeout").toBe(true)

      // ② The process group must already be empty when drain returns — no "it'll be fine
      // if you wait a bit longer"
      await h.runner.drain()
      expect(await mark.count()).toBe(0)

      // ③ The tool part in history must not be left at running/pending, otherwise every
      // later turn gets a 400
      await run.promise.catch(() => undefined)
      const tool = h.store
        .listAll(h.sessionID)
        .flatMap((m) => m.parts)
        .find((p) => p.type === "tool") as ToolPart | undefined
      expect(tool).toBeDefined()
      expect(["completed", "error"]).toContain(tool!.state.status)
    } finally {
      mark.reap()
    }
  }, 20_000)

  test("after an interrupt, the next input runs normally", async () => {
    const mark = uniqueSleep()
    const h = build(bashStream(`sleep ${mark.seconds}`))
    try {
      h.runner.start({ sessionID: h.sessionID, model: MODEL, text: "wait" })
      await until(async () => (await mark.count()) === 1)
      await h.runner.cancel(h.sessionID)
      await h.runner.drain()

      // Swap in a stream that doesn't hang, and carry on with the same session
      const h2 = build(() =>
        (async function* () {
          yield { type: "text-delta", id: "t", text: "back to work" } as LLMEvent
          yield { type: "step-finish", finishReason: "stop", tokens: TOKENS } as LLMEvent
        })(),
      )
      const result = await h2.runner.start({ sessionID: h2.sessionID, model: MODEL, text: "again" }).promise
      expect(result.steps).toBe(1)
      expect(result.interrupted).toBe(false)
    } finally {
      mark.reap()
    }
  }, 20_000)

  test("grandchildren started in the background are killed too", async () => {
    const mark = uniqueSleep()
    // The shell starts two in the background and waits itself — killing only the direct
    // child would leave these two alive
    const h = build(bashStream(`sleep ${mark.seconds} & sleep ${mark.seconds} & wait`))
    try {
      h.runner.start({ sessionID: h.sessionID, model: MODEL, text: "spawn" })
      expect(await until(async () => (await mark.count()) === 2)).toBe(true)

      await h.runner.cancel(h.sessionID)
      await h.runner.drain()
      expect(await mark.count()).toBe(0)
    } finally {
      mark.reap()
    }
  }, 20_000)

  test("★ a grandchild that ignores SIGTERM and detaches from stdio — must escalate to SIGKILL", async () => {
    const mark = uniqueSleep()
    // The outer shell doesn't trap, so it dies on SIGTERM at once → 'close' fires at once.
    // The grandchild traps TERM (SIG_IGN is inherited across exec, so sleep is immune
    // too) and holds no pipe. The old implementation returned here in 2ms and declared
    // success, leaving behind a sleep that runs forever.
    const escape = `bash -c 'trap "" TERM; exec sleep ${mark.seconds}' >/dev/null 2>&1 </dev/null & wait`
    const h = build(bashStream(escape))
    try {
      h.runner.start({ sessionID: h.sessionID, model: MODEL, text: "escape" })
      expect(await until(async () => (await mark.count()) === 1)).toBe(true)

      await h.runner.cancel(h.sessionID)
      await h.runner.drain()
      expect(await mark.count()).toBe(0)
    } finally {
      mark.reap()
    }
  }, 20_000)

  test("cancelAll clears every session", async () => {
    const mark = uniqueSleep()
    const a = build(bashStream(`sleep ${mark.seconds}`))
    const b = build(bashStream(`sleep ${mark.seconds}`))
    try {
      a.runner.start({ sessionID: a.sessionID, model: MODEL, text: "x" })
      b.runner.start({ sessionID: b.sessionID, model: MODEL, text: "y" })
      expect(await until(async () => (await mark.count()) === 2)).toBe(true)

      await Promise.all([a.runner.cancelAll(), b.runner.cancelAll()])
      await Promise.all([a.runner.drain(), b.runner.drain()])
      expect(await mark.count()).toBe(0)
      expect(a.runner.isBusy()).toBe(false)
      expect(b.runner.isBusy()).toBe(false)
    } finally {
      mark.reap()
    }
  }, 20_000)
})

// ─────────────────────────────────────────────── drain

describe("drain", () => {
  test("waits for a finishing turn to end", async () => {
    let finished = false
    const h = build(() =>
      (async function* () {
        await Bun.sleep(80)
        finished = true
        yield { type: "step-finish", finishReason: "stop", tokens: TOKENS } as LLMEvent
      })(),
    )
    h.runner.start({ sessionID: h.sessionID, model: MODEL, text: "x" })
    await h.runner.drain()
    expect(finished).toBe(true)
  })

  test("a stuck turn never hangs drain forever", async () => {
    const h = build(() =>
      (async function* () {
        await new Promise(() => {}) // never resolves
        yield { type: "step-finish", finishReason: "stop", tokens: TOKENS } as LLMEvent
      })(),
    )
    h.runner.start({ sessionID: h.sessionID, model: MODEL, text: "x" })
    const started = Date.now()
    await h.runner.drain(300)
    expect(h.runner.hasPending()).toBe(true)
    expect(Date.now() - started).toBeLessThan(1_500)
  })
})
