/** Fixed titles must cost at most one attempt and remain attached to their original session. */
import { expect, test } from "bun:test"
import { createSessionTitler } from "../src/agent/session-title.ts"
import { Store } from "../src/session/store.ts"
import type { LLMRequest, LLMStreamFn } from "../src/llm/types.ts"
import { sessionLabel } from "../src/cli/sessions.ts"

const model = { providerID: "fixture", modelID: "fixture" }
function fixture(store: Store, events: LLMStreamFn, signal = new AbortController().signal) {
  return createSessionTitler({ store, stream: events, model: () => model, language: () => "en", signal })
}
const info = { ref: model, limit: { context: 10000, output: 1000 }, supportsThinking: false, promptTemplate: "default" as const, cacheInInput: true }

test("only the initial prompt is summarized and later turns and resumed sessions keep its title", async () => {
  const store = new Store(":memory:")
  store.createSession("original", "/repo")
  store.createSession("other", "/repo")
  const requests: LLMRequest[] = []
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const stream: LLMStreamFn = request => {
    requests.push(request)
    return { info, events: (async function* () {
      await pending
      yield { type: "text-delta" as const, id: "title", text: "Fix cache accounting" }
    })() }
  }
  try {
    const title = fixture(store, stream)
    const first = title("original", "Please fix cache accounting")
    await title("original", "Completely different later question")
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0]!.messages)).not.toContain("later question")
    expect(requests[0]!.execution?.requestKind).toBe("title")
    expect(requests[0]!.tools).toEqual([])
    release()
    await first
    expect(sessionLabel(store.getSession("original")!)).toBe("Fix cache accounting")
    expect(store.getSession("other")!.title).toBe("")
    await fixture(store, stream)("original", "Please fix cache accounting")
    expect(requests).toHaveLength(1)
  } finally { store.close() }
})

test("failed title calls keep the first-question fallback without retrying on resume", async () => {
  const store = new Store(":memory:")
  store.createSession("session", "/repo")
  let calls = 0
  const stream: LLMStreamFn = () => { calls++; throw new Error("offline") }
  try {
    await fixture(store, stream)("session", "Initial request")
    await fixture(store, stream)("session", "Later request")
    expect(calls).toBe(1)
    expect(store.getSession("session")!.title).toBe("Initial request")
  } finally { store.close() }
})

test("shutdown prevents late title completion from writing to a closed database", async () => {
  const store = new Store(":memory:")
  store.createSession("session", "/repo")
  const controller = new AbortController()
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const task = fixture(store, () => ({ info, events: (async function* () {
    await pending
    yield { type: "text-delta" as const, id: "title", text: "Late title" }
  })() }), controller.signal)("session", "Initial request")
  controller.abort()
  expect(store.getSession("session")!.title).toBe("Initial request")
  store.close()
  release()
  await task
})
