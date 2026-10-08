/**
 * Compaction leaves a way back: an index of folded turns pinned to the summary, and the
 * recall tool that reads them back. What is guarded here is that the two always agree on
 * which turn a number means, and that nothing a turn did is lost on the way back.
 */
import { describe, expect, test } from "bun:test"
import { midTurnNote, withHistoryIndex } from "../src/agent/compact.ts"
import type { MessageWithParts, Part } from "../src/session/schema.ts"
import { renderTurn, searchTurns, splitTurns } from "../src/session/turns.ts"
import { RecallTool } from "../src/tool/recall.ts"
import type { ToolContext } from "../src/tool/types.ts"

let seq = 0
function message(role: "user" | "assistant", ...parts: Array<Partial<Part> & { type: Part["type"] }>): MessageWithParts {
  const id = `m${++seq}`
  const info: MessageWithParts["info"] = role === "user"
    ? { id, sessionID: "s", role, timeCreated: seq }
    : { id, sessionID: "s", role, parentID: "u", providerID: "p", modelID: "m", cost: 0, timeCreated: seq }
  return { info, parts: parts.map((part, i) => ({ id: `${id}-p${i}`, sessionID: "s", messageID: id, timeCreated: seq, ...part }) as Part) }
}
const said = (text: string) => message("user", { type: "text", text })
const note = (text: string) => message("user", { type: "text", text, synthetic: true })
const replied = (text: string) => message("assistant", { type: "text", text })
const ran = (tool: string, input: unknown, output: string) => message("assistant", {
  type: "tool", callID: `c${++seq}`, tool,
  state: { status: "completed", input, output, metadata: {}, time: { start: 1, end: 2 } },
})
const compacted = (text: string) => message("user", { type: "compact", text, folded: 3, tokensBefore: 100 })

function ctx(history?: MessageWithParts[]): ToolContext {
  return {
    cwd: "/tmp", root: "/tmp", sessionID: "s", messageID: "m", callID: "c", abortSignal: new AbortController().signal,
    ask: async () => {}, onProgress: () => {}, metadata: () => {},
    ...(history ? { history: () => history } : {}),
  } as ToolContext
}

describe("turns", () => {
  test("★ a turn starts where the user spoke; reminders and compaction points don't start or join one", () => {
    const history = [said("fix the build"), ran("bash", { command: "make" }, "error E42"), note("check failed"), replied("fixed"), compacted("SUMMARY"), said("now the docs")]
    const turns = splitTurns(history)
    expect(turns.map(turn => turn.number)).toEqual([1, 2])
    expect(turns[0]!.messages.length).toBe(4)
    expect(JSON.stringify(turns)).not.toContain("SUMMARY")
  })

  // An index written by the first compaction says "turn 2"; after a second compaction the
  // same number must still find the same turn
  test("★ numbers stay put however many compaction points land in between", () => {
    const before = splitTurns([said("one"), replied("a"), said("two"), replied("b")])
    const after = splitTurns([said("one"), replied("a"), compacted("S1"), said("two"), replied("b"), compacted("S2"), said("three")])
    const words = (turn: { messages: MessageWithParts[] }) => turn.messages.map(entry => entry.parts.map(part => part.type === "text" ? part.text : "").join())
    expect(words(after.find(turn => turn.number === 2)!)).toEqual(words(before[1]!))
  })

  test("a read-back keeps the tool call, its full result, and marks reminders as not the user's words", () => {
    const [turn] = splitTurns([said("fix"), ran("bash", { command: "make" }, "x".repeat(5_000) + " E42"), note("a check failed")])
    const text = renderTurn(turn!)
    expect(text).toContain("USER: fix")
    expect(text).toContain("E42")
    expect(text).toContain("NOTE (not the user's words): a check failed")
  })

  test("search needs every word, ignores case, newest first", () => {
    const turns = splitTurns([said("use pnpm"), replied("ok"), said("why did Build fail"), ran("bash", { command: "pnpm build" }, "Error: E42 build failed")])
    const hits = searchTurns(turns, "build e42")
    expect(hits.map(hit => [hit.turn, hit.where])).toEqual([[2, "tool bash"]])
    expect(searchTurns(turns, "pnpm").map(hit => hit.turn)).toEqual([2, 1])
  })
})

describe("the index pinned to a summary", () => {
  test("★ lists every folded turn with its number and what it changed; kept turns stay off it", () => {
    const history = [said("make the parser"), ran("edit", { filePath: "/r/src/parser.ts" }, "ok"), said("now tests"), replied("done")]
    const kept = new Set([history[2]!.info.id, history[3]!.info.id])
    const text = withHistoryIndex("SUMMARY", history, kept)
    expect(text.startsWith("SUMMARY\n")).toBe(true)
    expect(text).toContain("HISTORY INDEX")
    expect(text).toContain('turn 1 · ')
    expect(text).toContain('"make the parser"')
    expect(text).toContain("edited src/parser.ts")
    expect(text).not.toContain("turn 2")
  })

  test("nothing folded, no index", () => {
    const history = [said("a")]
    expect(withHistoryIndex("SUMMARY", history, new Set([history[0]!.info.id]))).toBe("SUMMARY")
  })
})

describe("recall", () => {
  const run = (args: Parameters<typeof RecallTool.execute>[0], history?: MessageWithParts[]) => RecallTool.execute(args, ctx(history))

  test("reads a turn back by its index number, paged with an offset that continues it", async () => {
    const logs = Array.from({ length: 5 }, (_, i) => ran("bash", { command: `cat log${i}` }, "y".repeat(8_000)))
    const history = [said("first"), said("second"), ...logs]
    const page = await run({ turn: 2 }, history)
    expect(page.output).toContain("USER: second")
    const next = /offset (\d+)/.exec(page.output)
    expect(next).not.toBeNull()
    const rest = await run({ turn: 2, offset: Number(next![1]) }, history)
    expect(rest.output).not.toContain("USER: second")
  })

  test("an unknown turn says which ones exist", async () => {
    await expect(run({ turn: 9 }, [said("a")])).rejects.toThrow("turns 1–1")
  })

  test("a query names the turn of each hit, and a miss says so plainly", async () => {
    const history = [said("deploy to staging"), ran("bash", { command: "deploy" }, "ERR_TIMEOUT at step 3")]
    expect((await run({ query: "err_timeout" }, history)).output).toContain("turn 1 · tool bash")
    expect((await run({ query: "nothing-like-this" }, history)).output).toContain("Nothing in this session")
  })

  test("without a store it says it can't, rather than reporting an empty history", async () => {
    expect((await run({})).output).toContain("not available")
  })
})

describe("compacting in the middle of a turn", () => {
  // ★ Without it the model wakes to a summary alone, reads it as a fresh session, and the
  //   turn the user left running ends in a recap
  test("★ the note says to carry on, and carries the user's request and the plan verbatim", () => {
    const text = midTurnNote([said("build the whole site"), replied("on it"), note("reminder")], ["[x] scaffold", "[>] pages"])
    expect(text).toContain("Carry on")
    expect(text).toContain("build the whole site")
    expect(text).not.toContain("reminder")
    expect(text).toContain("[>] pages")
  })
})
