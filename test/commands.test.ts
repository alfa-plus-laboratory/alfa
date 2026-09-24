/**
 * Slash command completion.
 *
 * The most important group is "when it should **not** pop up". A completion box that
 * pops up and blocks the view while you're typing a path is far more annoying than no
 * completion at all, and it grabs tab / up / down along the way.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { apply, BARE_LABEL, commands, complete, lookup, setModelChoices } from "../src/cli/commands.ts"

const values = (text: string, cursor = text.length): string[] =>
  complete(text, cursor)?.items.map((item) => item.value) ?? []

describe("command table", () => {
  test("every command has a leading slash and a one-line hint", () => {
    for (const command of commands()) {
      expect(command.name.startsWith("/")).toBe(true)
      expect(command.hint.length).toBeGreaterThan(0)
    }
  })

  test("aliases resolve but are not listed as candidates", () => {
    expect(lookup("/quit")?.name).toBe("/exit")
    expect(values("/")).not.toContain("/quit")
    expect(lookup("/models")?.name).toBe("/model")
    expect(values("/")).not.toContain("/models")
  })
})

describe("completing command names", () => {
  test("a lone slash lists every command", () => {
    expect(values("/")).toEqual([
      "/access",
      "/agents",
      "/detail",
      "/jobs",
      "/ssh",
      "/permission",
      "/view",
      "/language",
      "/think",
      "/effort",
      "/agentflow",
      "/model",
      "/setting",
      "/resume",
      "/cache-hit",
      "/debugger",
      "/context",
      "/compact",
      "/check",
      "/init",
      "/mcp",
      "/trust",
      "/skills",
      "/upgrade",
      "/history-clean",
      "/reset",
      "/help",
      "/clear",
      "/exit",
    ])
  })

  test("a prefix narrows the list", () => {
    expect(values("/pe")).toEqual(["/permission"])
    // ★ Before the rename it was called /clean-history, so `/cl` would pop up both
    //   "delete most of a year's history" and "start a new conversation" — side by side,
    //   with consequences an order of magnitude apart
    expect(values("/cl")).toEqual(["/clear"])
    expect(values("/c")).toEqual(["/cache-hit", "/context", "/compact", "/check", "/clear"])
    expect(values("/h")).toEqual(["/history-clean", "/help"])
  })

  test("/content is an alias of /context: it resolves but is not listed", () => {
    expect(lookup("/content")?.name).toBe("/context")
    expect(values("/co")).not.toContain("/content")
  })

  test("matching is case-insensitive", () => {
    expect(values("/PE")).toEqual(["/permission"])
  })

  test("★ a fully typed command with no arguments closes the box — leaving it open only blocks the view", () => {
    expect(complete("/clear", 6)).toBeUndefined()
  })

  test("★ a fully typed command that takes arguments goes on to suggest them", () => {
    expect(values("/permission")).toEqual(["/permission"])
    // The first one is "add nothing" (empty value), see the group below
    expect(values("/permission ")).toEqual(["", "confirm", "default", "auto", "forget"])
  })

  test("★ /upgrade lists only force — check is accepted but not listed, since it equals no argument", () => {
    expect(values("/upgrade ")).toEqual(["", "force"])
    // Listing a candidate identical to no argument only makes the reader stop and wonder
    // how they differ
    expect(values("/upgrade c")).toEqual([])
  })

  test("★ 'add nothing' is the first candidate — otherwise the most common usage can't be picked", () => {
    const found = complete("/upgrade ", 9)!
    const first = found.items[0]!
    expect(first.value).toBe("")
    expect(first.label).toBe(BARE_LABEL)
    expect(first.hint.length).toBeGreaterThan(0)
    // ★ This candidate relies on an existing rule, not a special-case branch: the span in
    //   the input box (from..to) is empty, and the highlighted item's value is empty too —
    //   so completion judges it "already fully typed" and lets enter through to submit.
    //   See the `exact` check in onKey, cli/shell.ts
    expect("/upgrade ".slice(found.from, found.to)).toBe(first.value)
  })

  test("the bare candidate disappears once something is typed — the user wants a specific argument then", () => {
    expect(values("/upgrade f")).toEqual(["force"])
    expect(values("/permission au")).toEqual(["auto"])
  })

  test("★ the bare candidate is offered only at the first level — `/language interface` alone is not a complete command", () => {
    expect(values("/language ")).toEqual(["", "interface", "reply"])
    expect(values("/language interface ")).toEqual(["auto", "en", "zh", "ja"])
  })

  test("a command without argument candidates still shows nothing — e.g. /reset", () => {
    expect(complete("/reset ", 7)).toBeUndefined()
  })

  test("picking the bare candidate leaves the input box unchanged", () => {
    const found = complete("/upgrade ", 9)!
    expect(apply("/upgrade ", found, found.items[0]!)).toBe("/upgrade ")
  })

  test("no match, no popup", () => {
    expect(complete("/zzz", 4)).toBeUndefined()
  })
})

describe("★ when it must not pop up", () => {
  test("an ordinary sentence not starting with a slash", () => {
    expect(complete("fix the /etc thing", 18)).toBeUndefined()
    expect(complete("", 0)).toBeUndefined()
  })

  test("★ no popup when the cursor isn't at the end — the completion would land where the user doesn't expect", () => {
    expect(complete("/help", 2)).toBeUndefined()
  })

  test("★ a slash in multi-line input is not a command", () => {
    expect(complete("/help\nsecond line", 17)).toBeUndefined()
  })

  test("no popup once a second word follows the argument", () => {
    expect(complete("/permission auto x", 18)).toBeUndefined()
  })

  test("a command without arguments suggests none", () => {
    expect(complete("/help ", 6)).toBeUndefined()
  })

  test("no popup when the argument matches nothing", () => {
    expect(complete("/permission zz", 14)).toBeUndefined()
  })
})

describe("filling the input box", () => {
  test("a command name replaces the whole input", () => {
    const completion = complete("/pe", 3)!
    expect(apply("/pe", completion, completion.items[0]!)).toBe("/permission ")
  })

  test("★ a command that takes arguments gets a trailing space, saving a keystroke", () => {
    const completion = complete("/", 1)!
    const permission = completion.items.find((item) => item.value === "/permission")!
    const help = completion.items.find((item) => item.value === "/help")!
    expect(apply("/", completion, permission)).toBe("/permission ")
    expect(apply("/", completion, help)).toBe("/help")
  })

  test("an argument replaces only the argument span", () => {
    const completion = complete("/permission au", 14)!
    expect(apply("/permission au", completion, completion.items[0]!)).toBe("/permission auto")
  })
})

// ─────────────────────────────────────────────── /model

describe("★ /model candidates", () => {
  afterEach(() => setModelChoices([]))

  test("no args until candidates are loaded — an empty box reads as 'no models to pick', not 'none configured'", () => {
    expect(lookup("/model")?.args).toBeUndefined()
    // The command itself is still there, and free input always works. When it's fully
    // typed and has no arguments the box closes — that's an existing rule (see only in
    // complete), not a special case for this command
    expect(values("/mod")).toEqual(["/model"])
    expect(values("/model")).toEqual([])
  })

  test("loaded candidates are listed and narrowed by prefix", () => {
    setModelChoices(["anthropic/claude-opus-4-1", "minimax/MiniMax-M3"])
    expect(values("/model ")).toEqual(["", "anthropic/claude-opus-4-1", "minimax/MiniMax-M3"])
    expect(values("/model min")).toEqual(["minimax/MiniMax-M3"])
  })

  test("★ case-insensitive — model names aren't lowercase, so an exact comparison would match nothing", () => {
    setModelChoices(["minimax/MiniMax-M3"])
    expect(values("/model minimax/mini")).toEqual(["minimax/MiniMax-M3"])
  })

  test("the completion uses the model's original casing, not what the user typed", () => {
    setModelChoices(["minimax/MiniMax-M3"])
    const completion = complete("/model minimax/mini", 19)!
    expect(apply("/model minimax/mini", completion, completion.items[0]!)).toBe("/model minimax/MiniMax-M3")
  })
})
