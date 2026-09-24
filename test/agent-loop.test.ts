/**
 * The main loop.
 *
 * A fake stream function feeds fixed event sequences — what's tested is **control
 * flow**: when to send another turn, when to stop, how hitting the cap wraps up. The
 * real SDK's behavior is already covered by the retry/prompt end-to-end test groups;
 * wiring it in again here would only blur the cause of a failure.
 */
import { describe, expect, test } from "bun:test"
import { Loop, isSettled } from "../src/agent/loop.ts"
import { Emitter, type UIEvent } from "../src/agent/events.ts"
import { Store } from "../src/session/store.ts"
import { newMessageID, newPartID, newSessionID } from "../src/session/id.ts"
import { MAX_STEPS, MAX_STEPS_PROMPT } from "../src/prompt/max-steps.ts"
import { findUnpairedToolCalls, toLLMMessages } from "../src/agent/to-model-messages.ts"
import { ContextOverflowError, type LLMEvent, type LLMRequest, type ModelInfo } from "../src/llm/types.ts"

const INFO: ModelInfo = {
  ref: { providerID: "p", modelID: "m" },
  limit: { context: 200_000, output: 32_000 },
  supportsThinking: false,
  promptTemplate: "default",
  cacheInInput: false,
}

const MODEL = { providerID: "p", modelID: "m" }

function tokens(input: number, output = 0) {
  return { input, output, reasoning: 0, cache: { read: 0, write: 0 } }
}

/**
 * Each turn returns the event sequence script[i]; past the end, the last one is reused.
 *
 * A script entry may be a function that gets this turn's request — to simulate "the
 * tool reported metadata" (edit's filePath goes this way), makeToolContext has to come
 * first, just like the real flow.
 */
function harness(
  script: Array<LLMEvent[] | ((request: LLMRequest) => LLMEvent[])>,
  options: {
    verify?: (input: { touched: string[]; abortSignal: AbortSignal }) => Promise<string | undefined>
    memory?: () => { text: string; notes: number } | undefined
    gitContext?: () => string | undefined
  } = {},
) {
  const store = new Store(":memory:")
  const sessionID = newSessionID()
  store.createSession(sessionID, "/tmp")
  const emitter = new Emitter<UIEvent>()
  const seen: UIEvent[] = []
  emitter.on((e) => seen.push(e))

  const requests: LLMRequest[] = []
  const loop = new Loop({
    store,
    emitter,
    tools: () => [],
    system: () => ["TEMPLATE", "ENV"],
    // Tools aren't executed here, but the ctx itself must be obtainable — metadata is
    // reported through it
    makeToolContext: () => ({
      cwd: "/tmp",
      root: "/tmp",
      sessionID,
      messageID: "m",
      callID: "c",
      abortSignal: new AbortController().signal,
      ask: async () => {},
      onProgress: () => {},
      metadata: () => {},
    }),
    ...(options.verify ? { verify: options.verify } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.gitContext ? { gitContext: options.gitContext } : {}),
    stream(request) {
      requests.push(request)
      const entry = script[Math.min(requests.length - 1, script.length - 1)]!
      return {
        info: INFO,
        // ★ Script entries are evaluated **inside the generator**, not in stream(). Loop
        //   only builds the Processor after it has the handle, and ctx.metadata has to go
        //   through the Processor to land in a part — calling makeToolContext already in
        //   stream() would quietly drop the metadata
        events: (async function* () {
          for (const event of typeof entry === "function" ? entry(request) : entry) yield event
        })(),
      }
    },
  })

  return { store, sessionID, emitter, seen, requests, loop }
}

const say = (text: string, finishReason = "stop"): LLMEvent[] => [
  { type: "step-start" },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", text },
  { type: "text-end", id: "t" },
  { type: "step-finish", finishReason, tokens: tokens(100, 10) },
]

const callTool = (callID: string, finishReason: string): LLMEvent[] => [
  { type: "step-start" },
  { type: "tool-call", callID, tool: "bash", input: { command: "ls" } },
  { type: "tool-result", callID, tool: "bash", output: "a\nb" },
  { type: "step-finish", finishReason, tokens: tokens(100, 10) },
]

// ─────────────────────────────────────────────── Basics

describe("Loop", () => {
  test("commentary-only responses continue to a final answer even when finishReason is stop", async () => {
    const phased = (text: string, phase: "commentary" | "final_answer"): LLMEvent[] => say(text).map(event =>
      event.type === "text-end" ? { ...event, responses: { phase } } : event)
    const h = harness([phased("Checking the implementation.", "commentary"), phased("Fixed and tested.", "final_answer")])
    try {
      const result = await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "fix it", abortSignal: new AbortController().signal })
      expect(result.steps).toBe(2)
      expect(isSettled(h.store.listAll(h.sessionID))).toBe(true)
      expect(h.requests[1]!.messages.some(message => message.role === "assistant" && message.content.some(part => part.type === "text" && part.responses?.phase === "commentary"))).toBe(true)
    } finally { h.store.close() }
  })

  test("a phase-null answer retains legacy completion behavior", async () => {
    const h = harness([say("legacy").map(event => event.type === "text-end" ? { ...event, responses: { phase: null } } : event)])
    try {
      const result = await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal })
      expect(result.steps).toBe(1)
    } finally { h.store.close() }
  })

  test("commentary does not silently restart a failed request", async () => {
    const h = harness([[...say("Checking.").map(event => event.type === "text-end" ? { ...event, responses: { phase: "commentary" as const } } : event), { type: "error", error: new Error("fixture failure") }]])
    try {
      const result = await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal })
      expect(result.steps).toBe(1)
      expect(result.error?.message).toBe("fixture failure")
      expect(isSettled(h.store.listAll(h.sessionID))).toBe(true)
    } finally { h.store.close() }
  })

  test("a plain text answer stops after one turn", async () => {
    const h = harness([say("hello")])
    const result = await h.loop.run({
      sessionID: h.sessionID,
      model: MODEL,
      text: "hi",
      abortSignal: new AbortController().signal,
    })
    expect(result.steps).toBe(1)
    expect(h.requests).toHaveLength(1)
    expect(result.interrupted).toBe(false)
    expect(result.error).toBeUndefined()
  })

  test("the user message is stored first and appears in the first request", async () => {
    const h = harness([say("ok")])
    await h.loop.run({
      sessionID: h.sessionID,
      model: MODEL,
      text: "do the thing",
      abortSignal: new AbortController().signal,
    })
    const first = h.requests[0]!
    expect(first.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "do the thing" }] })
    expect(first.system).toEqual(["TEMPLATE", "ENV"])
  })

  test("★ finishReason says stop but a tool ran — must still send another turn", async () => {
    // Compatible endpoints like MiniMax really do report this; trusting finishReason means
    // "runs the tool, then says nothing"
    const h = harness([callTool("c1", "stop"), say("here is the result")])
    const result = await h.loop.run({
      sessionID: h.sessionID,
      model: MODEL,
      text: "ls",
      abortSignal: new AbortController().signal,
    })
    expect(result.steps).toBe(2)
    // The second turn's history must carry the tool result
    const second = h.requests[1]!
    const toolMessage = second.messages.find((m) => m.role === "tool")
    expect(toolMessage?.role === "tool" && toolMessage.content[0]!.output).toBe("a\nb")
  })

  test("finishReason=tool-calls also sends another turn", async () => {
    const h = harness([callTool("c1", "tool-calls"), say("done")])
    const result = await h.loop.run({
      sessionID: h.sessionID,
      model: MODEL,
      text: "ls",
      abortSignal: new AbortController().signal,
    })
    expect(result.steps).toBe(2)
  })

  test("runs several consecutive tool-call turns", async () => {
    const h = harness([
      callTool("c1", "tool-calls"),
      callTool("c2", "tool-calls"),
      callTool("c3", "tool-calls"),
      say("finally"),
    ])
    const result = await h.loop.run({
      sessionID: h.sessionID,
      model: MODEL,
      text: "go",
      abortSignal: new AbortController().signal,
    })
    expect(result.steps).toBe(4)
  })

  test("billed usage accumulates across turns", async () => {
    const h = harness([callTool("c1", "tool-calls"), say("done")])
    const result = await h.loop.run({
      sessionID: h.sessionID,
      model: MODEL,
      text: "go",
      abortSignal: new AbortController().signal,
    })
    expect(result.billedTokens.input).toBe(200)
    expect(result.billedTokens.output).toBe(20)
  })
})

// ─────────────────────────────────────────────── Interruption

describe("Interruption", () => {
  test("★ stops when only an interrupted tool part remains, instead of spinning", async () => {
    const h = harness([say("should never be called")])

    // Hand-build a history that "was cut off by Ctrl-C last time"
    const userID = newMessageID()
    h.store.upsertMessage({ id: userID, sessionID: h.sessionID, role: "user", timeCreated: 1 })
    h.store.upsertPart({
      id: newPartID(), sessionID: h.sessionID, messageID: userID, timeCreated: 1,
      type: "text", text: "run something long",
    })
    const assistantID = newMessageID()
    h.store.upsertMessage({
      id: assistantID, sessionID: h.sessionID, role: "assistant", parentID: userID,
      providerID: "p", modelID: "m", cost: 0, timeCreated: 2, timeCompleted: 3, finish: "interrupted",
    })
    h.store.upsertPart({
      id: newPartID(), sessionID: h.sessionID, messageID: assistantID, timeCreated: 2,
      type: "tool", callID: "c1", tool: "bash",
      state: {
        status: "error", input: { command: "sleep 60" },
        error: "Tool execution was interrupted by the user before it completed.",
        metadata: { interrupted: true }, time: { start: 2, end: 3 },
      },
    })

    // No text = "continue from last time"
    const result = await h.loop.run({
      sessionID: h.sessionID,
      model: MODEL,
      abortSignal: new AbortController().signal,
    })
    expect(result.steps).toBe(0)
    expect(h.requests).toHaveLength(0)
  })

  test("contrast: a completed tool part does trigger a follow-up turn", async () => {
    const h = harness([say("continuing")])
    const userID = newMessageID()
    h.store.upsertMessage({ id: userID, sessionID: h.sessionID, role: "user", timeCreated: 1 })
    h.store.upsertPart({
      id: newPartID(), sessionID: h.sessionID, messageID: userID, timeCreated: 1, type: "text", text: "x",
    })
    const assistantID = newMessageID()
    h.store.upsertMessage({
      id: assistantID, sessionID: h.sessionID, role: "assistant", parentID: userID,
      providerID: "p", modelID: "m", cost: 0, timeCreated: 2, timeCompleted: 3, finish: "tool-calls",
    })
    h.store.upsertPart({
      id: newPartID(), sessionID: h.sessionID, messageID: assistantID, timeCreated: 2,
      type: "tool", callID: "c1", tool: "bash",
      state: { status: "completed", input: {}, output: "out", metadata: {}, time: { start: 2, end: 3 } },
    })

    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, abortSignal: new AbortController().signal,
    })
    expect(result.steps).toBe(1)
  })

  test("aborted before starting: sends no request at all", async () => {
    const h = harness([say("nope")])
    const controller = new AbortController()
    controller.abort()
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: controller.signal,
    })
    expect(result.steps).toBe(0)
    expect(result.interrupted).toBe(true)
    expect(h.requests).toHaveLength(0)
  })

  test("abort mid-stream: marked interrupted, no further turn", async () => {
    const controller = new AbortController()
    const h = harness([
      () => {
        controller.abort()
        const error = new Error("aborted")
        error.name = "AbortError"
        throw error
      },
    ])
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: controller.signal,
    })
    expect(result.interrupted).toBe(true)
    expect(result.error).toBeUndefined()
    expect(h.requests).toHaveLength(1)
  })

  // ★ This guards **the kind of interruption that actually happens in production**, which
  //   is not the same thing as the AbortError-throwing one above.
  //
  //   The AI SDK **doesn't throw** on abort: it pushes a {type:"abort"} and closes the
  //   stream normally, and normalize in llm/stream.ts explicitly ignores abort. So the
  //   loop's catch block (which has a whole set of interruption handling) is never
  //   reached in production — the generator ends normally, outcome.error is undefined,
  //   and for a while this was wrapped up as "done".
  //
  //   And "done" writes, for unfinished tools, "the tool was NOT run and nothing changed.
  //   Call it again" — yet killGroup really did kill the command; it **did run**. The
  //   model would then redo a write/edit that had already landed on disk.
  test("★ SDK-style interruption (stream closes cleanly, no throw): the tool is recorded as 'interrupted', not 'never ran'", async () => {
    const controller = new AbortController()
    const h = harness([
      () => {
        // The real shape: arguments received, the tool starts running, then the user
        // presses ctrl-c. The stream ends cleanly, not a single exception thrown
        controller.abort()
        return [
          { type: "step-start" },
          { type: "tool-call", callID: "c1", tool: "bash", input: { command: "npm run build" } },
        ] as LLMEvent[]
      },
    ])
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "build it", abortSignal: controller.signal,
    })

    expect(result.interrupted).toBe(true)

    const messages = h.store.listAll(h.sessionID)
    const assistant = messages.find(
      (m): m is typeof m & { info: { role: "assistant"; id: string; finish?: string } } =>
        m.info.role === "assistant",
    )!
    expect(assistant.info.finish).toBe("interrupted")

    const tool = h.store.listParts(assistant.info.id).find((part) => part.type === "tool")!
    const state = tool.state as { status: string; error?: string; metadata?: { interrupted?: boolean } }
    expect(state.metadata?.interrupted).toBe(true)
    // ⚠ These two assert the **exact wording**, guarding against that error message ever
    //    reverting: "it wasn't run, call it again" is the worst possible thing to say
    //    about a command that already ran
    expect(state.error).toContain("interrupted")
    expect(state.error).not.toContain("was NOT run")
  })

  test("tool interrupted midway — history keeps no tool_use without a result", async () => {
    const controller = new AbortController()
    const h = harness([
      () =>
        // Only a tool-call, no tool-result, then the stream **throws** on the interruption
        // — the other shape next to the clean close above
        (function* () {
          yield { type: "step-start" } as LLMEvent
          yield { type: "tool-call", callID: "c1", tool: "bash", input: { command: "sleep 60" } } as LLMEvent
          controller.abort()
          throw new DOMException("The operation was aborted.", "AbortError")
        })() as unknown as LLMEvent[],
    ])
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "go", abortSignal: controller.signal })
    // Even if this turn didn't complete, the loop must not keep going forever on this
    // tool part
    expect(h.requests.length).toBeLessThanOrEqual(1)
    // ★ The next request built from this history must pair the call with a result — one
    //   orphan tool_use and every later turn 400s (see to-model-messages.ts)
    const next = toLLMMessages(h.store.listAll(h.sessionID))
    expect(next.some((m) => m.role === "assistant" && m.content.some((c) => c.type === "tool-call"))).toBe(true)
    expect(findUnpairedToolCalls(next)).toEqual([])
  })
})

// ─────────────────────────────────────────────── Step limit

describe("Step limit", () => {
  test("★ the turn that hits the cap injects MAX_STEPS_PROMPT and disables tools, with no turn after it", async () => {
    // Always calls a tool — without a cap this is an infinite loop
    const h = harness([() => callTool(`c${Math.floor(Math.random() * 1e9)}`, "tool-calls")])
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "loop forever", abortSignal: new AbortController().signal,
    })

    expect(result.steps).toBe(MAX_STEPS)
    expect(h.requests).toHaveLength(MAX_STEPS)
    expect(result.hitStepLimit).toBe(true)

    const last = h.requests[MAX_STEPS - 1]!
    expect(last.system).toContain(MAX_STEPS_PROMPT)
    expect(last.activeTools).toEqual([])

    // None of the earlier turns should carry this
    const earlier = h.requests[MAX_STEPS - 2]!
    expect(earlier.system).not.toContain(MAX_STEPS_PROMPT)
    expect(earlier.activeTools).toBeUndefined()
  })

  test("a normal finish doesn't count as hitting the cap", async () => {
    const h = harness([say("done")])
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal,
    })
    expect(result.hitStepLimit).toBe(false)
  })
})

// ─────────────────────────────────────────────── Errors

describe("Errors", () => {
  test("an error event in the stream ends after one turn, no retry", async () => {
    const h = harness([
      [{ type: "step-start" }, { type: "error", error: new Error("provider exploded") }],
      say("never"),
    ])
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal,
    })
    expect(h.requests).toHaveLength(1)
    expect(result.error?.message).toBe("provider exploded")
  })

  test("a thrown error also stops after one turn", async () => {
    const h = harness([
      () => {
        throw new Error("connection reset")
      },
      say("never"),
    ])
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal,
    })
    expect(h.requests).toHaveLength(1)
    expect(result.error?.message).toBe("connection reset")
    expect(h.seen.some((e) => e.type === "error")).toBe(true)
  })

  test("context overflow gives actionable advice, not the raw error", async () => {
    const h = harness([
      () => {
        throw new ContextOverflowError("prompt is too long: 250000 > 200000")
      },
    ])
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal,
    })
    expect(result.error).toBeInstanceOf(ContextOverflowError)
    // On hitting the ceiling it offers **the two paths you can take right now**, not "try
    // another model" — compaction already exists
    expect(result.error?.message).toContain("/compact")
  })

  test("a failure to open the stream still closes out the assistant shell — left unfinished, the next run spins on it", async () => {
    const h = harness([
      () => {
        throw new Error("no credentials")
      },
    ])
    await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal,
    })
    const history = h.store.listAll(h.sessionID)
    const assistant = history.find((m) => m.info.role === "assistant")
    expect(assistant?.info.role === "assistant" && assistant.info.finish).toBe("error")
    expect(assistant?.info.role === "assistant" && assistant.info.timeCompleted).toBeGreaterThan(0)
  })

  test("an empty session (no user message) returns immediately", async () => {
    const h = harness([say("nope")])
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, abortSignal: new AbortController().signal,
    })
    expect(result.steps).toBe(0)
    expect(h.requests).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────── Rereading history every turn

describe("Rereading history every turn", () => {
  test("parts stored in the previous turn appear in the next turn's request", async () => {
    const h = harness([callTool("c1", "tool-calls"), say("done")])
    await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "go", abortSignal: new AbortController().signal,
    })
    const second = h.requests[1]!
    // user → assistant(tool-call) → tool(result)
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"])
  })

  test("external storage changes between turns take effect on the very next turn", async () => {
    const h = harness([callTool("c1", "tool-calls"), say("done")])
    let injected = false
    h.emitter.on((event) => {
      if (event.type !== "message.end" || injected) return
      injected = true
      // Simulate compaction / external injection: force in a user message
      const id = newMessageID()
      h.store.upsertMessage({ id, sessionID: h.sessionID, role: "user", timeCreated: Date.now() })
      h.store.upsertPart({
        id: newPartID(), sessionID: h.sessionID, messageID: id, timeCreated: Date.now(),
        type: "text", text: "INJECTED MID-LOOP",
      })
    })

    await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "go", abortSignal: new AbortController().signal,
    })
    const second = h.requests[1]!
    const texts = second.messages
      .filter((m) => m.role === "user")
      .flatMap((m) => (m.role === "user" ? m.content : []))
      .map((c) => (c.type === "text" ? c.text : ""))
    expect(texts).toContain("INJECTED MID-LOOP")
  })
})

// ─────────────────────────────────────────────── Verification before wrapping up

/** One edit: like the real flow, ctx reports filePath first, then the tool-result comes out */
const editFile = (callID: string, filePath: string) => (request: LLMRequest): LLMEvent[] => {
  request.makeToolContext({ callID, abortSignal: new AbortController().signal }).metadata({ filePath })
  return [
    { type: "step-start" },
    { type: "tool-call", callID, tool: "edit", input: { filePath } },
    { type: "tool-result", callID, tool: "edit", output: "Edit applied successfully." },
    { type: "step-finish", finishReason: "tool-calls", tokens: tokens(100, 10) },
  ]
}

const userTexts = (request: LLMRequest): string[] =>
  request.messages
    .filter((m) => m.role === "user")
    .flatMap((m) => (m.role === "user" ? m.content : []))
    .map((c) => (c.type === "text" ? c.text : ""))

describe("Verification before wrapping up", () => {
  test("★ after editing files it verifies before wrapping up, and keeps working if problems are found", async () => {
    const touchedSeen: string[][] = []
    const h = harness([editFile("c1", "/repo/src/a.ts"), say("改好了"), say("这回真好了")], {
      verify: async ({ touched }) => {
        touchedSeen.push(touched)
        return touchedSeen.length === 1 ? "CHECK FAILED: a.ts(1,1)" : undefined
      },
    })

    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "改一下", abortSignal: new AbortController().signal,
    })

    // After it says "改好了" (all fixed) it doesn't stop, but runs another turn
    expect(result.steps).toBe(3)
    expect(touchedSeen[0]).toEqual(["/repo/src/a.ts"])
    // The verification message went into the next turn's request as a user message
    expect(userTexts(h.requests[2]!)).toContain("CHECK FAILED: a.ts(1,1)")
  })

  test("★ the injected message is synthetic — the UI must not treat it as something the user said", async () => {
    const h = harness([editFile("c1", "/repo/a.ts"), say("done"), say("done")], {
      verify: async () => (nth++ === 0 ? "PROBLEMS" : undefined),
    })
    let nth = 0
    await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "改一下", abortSignal: new AbortController().signal,
    })

    const users = h.store.listAll(h.sessionID).filter((m) => m.info.role === "user")
    expect(users.length).toBe(2)
    const injected = users[1]!.parts[0]!
    expect(injected.type === "text" && injected.synthetic).toBe(true)
    // What the user actually said doesn't carry this flag
    const original = users[0]!.parts[0]!
    expect(original.type === "text" && original.synthetic).toBeUndefined()
  })

  test("no verification when no file was touched — pure Q&A shouldn't pay those seconds", async () => {
    let called = 0
    const h = harness([say("是的")], {
      verify: async () => {
        called++
        return undefined
      },
    })
    await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "在吗", abortSignal: new AbortController().signal,
    })
    expect(called).toBe(0)
  })

  test("★ still wraps up if it never gets fixed — at the cap it lets the answer through instead of looping all night", async () => {
    let called = 0
    const h = harness([editFile("c1", "/repo/a.ts"), say("我修好了")], {
      verify: async () => {
        called++
        return "STILL BROKEN"
      },
    })
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "改", abortSignal: new AbortController().signal,
    })
    expect(called).toBe(2)
    expect(result.steps).toBeLessThan(MAX_STEPS)
  })

  test("a crash in the verifier itself doesn't fail the turn — it's a bonus", async () => {
    const h = harness([editFile("c1", "/repo/a.ts"), say("好了")], {
      verify: async () => {
        throw new Error("checker exploded")
      },
    })
    const result = await h.loop.run({
      sessionID: h.sessionID, model: MODEL, text: "改", abortSignal: new AbortController().signal,
    })
    expect(result.error).toBeUndefined()
    expect(result.interrupted).toBe(false)
  })

  test("no verification after an interrupt — esc means stop, not wait for a compile", async () => {
    const controller = new AbortController()
    let called = 0
    const h = harness([
      (request: LLMRequest) => {
        const events = editFile("c1", "/repo/a.ts")(request)
        controller.abort()
        return events
      },
      say("好了"),
    ], {
      verify: async () => {
        called++
        return "PROBLEMS"
      },
    })
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "改", abortSignal: controller.signal })
    expect(called).toBe(0)
  })
})

// ─────────────────────────────────────────────── Project memory

describe("★ project memory is attached to the first message", () => {
  const memory = () => ({ text: "<project-memory>MEMO-MARKER</project-memory>", notes: 1 })

  test("a new session's first message carries it, in the same user message", async () => {
    const h = harness([say("ok")], { memory })
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal })

    const history = h.store.listAll(h.sessionID)
    const first = history[0]!
    expect(first.info.role).toBe("user")
    // Same message: two user messages in a row get merged by some providers and rejected
    // by others
    expect(first.parts.map((p) => p.type)).toEqual(["memory", "text"])
    expect(h.requests[0]!.messages[0]!.content).toEqual([
      { type: "text", text: "<project-memory>MEMO-MARKER</project-memory>" },
      { type: "text", text: "hi" },
    ])
  })

  test("★ attached only once — not on the second message, or the same notes appear twice in one context", async () => {
    const h = harness([say("one"), say("two")], { memory })
    const signal = new AbortController().signal
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "first", abortSignal: signal })
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "second", abortSignal: signal })

    const memoryParts = h.store
      .listAll(h.sessionID)
      .flatMap((entry) => entry.parts)
      .filter((part) => part.type === "memory")
    expect(memoryParts).toHaveLength(1)
  })

  test("not attached to the synthetic pre-wrap-up reminder — that isn't the start of a conversation", async () => {
    let asked = false
    const h = harness([say("done"), say("fixed")], {
      memory,
      verify: async () => {
        if (asked) return undefined
        asked = true
        return "tsc failed"
      },
    })
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "go", abortSignal: new AbortController().signal })
    const memoryParts = h.store
      .listAll(h.sessionID)
      .flatMap((entry) => entry.parts)
      .filter((part) => part.type === "memory")
    expect(memoryParts).toHaveLength(1)
  })

  test("with no notes nothing is attached, and no empty memory part is left", async () => {
    const h = harness([say("ok")], { memory: () => undefined })
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal })
    expect(h.store.listAll(h.sessionID)[0]!.parts.map((p) => p.type)).toEqual(["text"])
  })
})

// ─────────────────────────────────────────────── Repository snapshot

describe("★ repository snapshot is attached to the first message", () => {
  const gitContext = () => "<git-status>GIT-MARKER</git-status>"
  const memory = () => ({ text: "<project-memory>MEMO-MARKER</project-memory>", notes: 1 })

  test("order is repo state → project memory → user's words: facts first, then conventions, then the question", async () => {
    const h = harness([say("ok")], { gitContext, memory })
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal })

    expect(h.requests[0]!.messages[0]!.content).toEqual([
      { type: "text", text: "<git-status>GIT-MARKER</git-status>" },
      { type: "text", text: "<project-memory>MEMO-MARKER</project-memory>" },
      { type: "text", text: "hi" },
    ])
  })

  test("★ it is synthetic — the UI won't treat it as something the user said", async () => {
    const h = harness([say("ok")], { gitContext })
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal })
    const [snapshot, said] = h.store.listAll(h.sessionID)[0]!.parts
    expect(snapshot!.type === "text" && snapshot!.synthetic).toBe(true)
    expect(said!.type === "text" && said!.synthetic).toBeUndefined()
  })

  test("★ attached only once — not on the second message; by then it's stale, and the agent itself made it stale", async () => {
    const h = harness([say("one"), say("two")], { gitContext })
    const signal = new AbortController().signal
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "first", abortSignal: signal })
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "second", abortSignal: signal })

    const marked = h.store
      .listAll(h.sessionID)
      .flatMap((entry) => entry.parts)
      .filter((part) => part.type === "text" && part.text.includes("GIT-MARKER"))
    expect(marked).toHaveLength(1)
  })

  test("★ never changes once attached — history is append-only, so the prefix stays stable and caching works", async () => {
    let branch = "main"
    const h = harness([say("one"), say("two")], { gitContext: () => `<git-status>on ${branch}</git-status>` })
    const signal = new AbortController().signal
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "first", abortSignal: signal })
    branch = "feature" // it switched branches midway
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "second", abortSignal: signal })

    // In the second turn's request, the first user message must match the first turn's
    // word for word
    expect(h.requests.at(-1)!.messages[0]!.content).toEqual(h.requests[0]!.messages[0]!.content)
    expect(JSON.stringify(h.requests.at(-1)!.messages)).not.toContain("on feature")
  })

  test("outside a repo nothing is attached, and no empty part is left", async () => {
    const h = harness([say("ok")], { gitContext: () => undefined })
    await h.loop.run({ sessionID: h.sessionID, model: MODEL, text: "hi", abortSignal: new AbortController().signal })
    expect(h.store.listAll(h.sessionID)[0]!.parts.map((p) => p.type)).toEqual(["text"])
  })
})


test("execution run identity stays stable across loop rounds and changes for a new turn", async () => {
  const h = harness([callTool("trace-tool", "tool-calls"), say("Finished")])
  try {
    const input = { sessionID: h.sessionID, model: MODEL, text: "Work", abortSignal: new AbortController().signal }
    await h.loop.run(input)
    expect(h.requests.length).toBe(2)
    expect(h.requests[0]!.execution).toEqual(h.requests[1]!.execution)
    expect(h.requests[0]!.execution!.sessionId).toBe(h.sessionID)
    expect(h.requests[0]!.execution!.requestKind).toBe("main")
    await h.loop.run(input)
    expect(h.requests[2]!.execution!.runId).not.toBe(h.requests[0]!.execution!.runId)
  } finally { h.store.close() }
})
