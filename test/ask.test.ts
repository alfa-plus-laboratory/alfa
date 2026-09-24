/**
 * "It asks you a question."
 *
 * The tool, its live card and its scrollback prompt are tested together so the four
 * answer forms stay aligned with what the user can actually enter.
 */
import { describe, expect, test } from "bun:test"
import { ask, AskCard, askInPlain } from "../src/cli/ask.ts"
import { setColorEnabled } from "../src/cli/theme.ts"
import { stripAnsi } from "../src/cli/width.ts"
import { AskTool } from "../src/tool/ask.ts"
import type { Key } from "../src/cli/keys.ts"
import type { Answer, Question, ToolContext } from "../src/tool/types.ts"
const key = (name: string, over: Partial<Key> = {}): Key => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
  ...over,
})

const question = (over: Partial<Question> = {}): Question => ({
  question: "Which database?",
  options: [{ label: "Postgres", description: "already in the stack" }, { label: "SQLite" }, { label: "MySQL" }],
  multiple: false,
  ...over,
})

describe("the ask tool", () => {
  const context = (over: Partial<ToolContext> = {}): ToolContext => ({
    cwd: "/tmp",
    root: "/tmp",
    sessionID: "s",
    messageID: "m",
    callID: "c",
    abortSignal: new AbortController().signal,
    ask: async () => {},
    onProgress: () => {},
    metadata: () => {},
    ...over,
  })

  const args = {
    questions: [{ question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] }],
  }

  test("★ with nobody to ask, replies at once with 'decide it yourself', not an error", async () => {
    const result = await AskTool.execute(args, context())
    expect(result.output).toContain("nobody to answer")
    expect(result.output).toContain("Decide it yourself")
    expect(result.metadata["unavailable"]).toBe(true)
  })

  test("fewer than two options is rejected — that is not a question", async () => {
    await expect(
      AskTool.execute({ questions: [{ question: "Which database?", options: [{ label: "Postgres" }] }] }, context()),
    ).rejects.toThrow(/fewer than 2 options/)
  })

  test("duplicate options are merged: two identical rows make the user doubt their eyes", async () => {
    let asked: Question | undefined
    await AskTool.execute(
      {
        questions: [
          {
            question: "Which database?",
            options: [{ label: "Postgres" }, { label: "postgres" }, { label: "SQLite" }],
          },
        ],
      },
      context({
        inquire: async (input) => {
          asked = input
          return { kind: "cancelled" }
        },
      }),
    )
    expect(asked?.options.map((option) => option.label)).toEqual(["Postgres", "SQLite"])
  })

  test("a pick returns the **option text** verbatim to the model, not an index", async () => {
    const patches: Record<string, unknown>[] = []
    const result = await AskTool.execute(
      args,
      context({
        inquire: async () => ({ kind: "picked", choices: ["SQLite"] }),
        metadata: (patch) => patches.push(patch),
      }),
    )
    expect(result.output).toContain("SQLite")
    // The line on the card reads metadata (see outcomeLine in cli/render.ts)
    expect(patches.some((patch) => patch["answer"] === "SQLite")).toBe(true)
  })

  test("★ a typed answer must be called a **new instruction** in the reply — otherwise the model treats it as a third option", async () => {
    const result = await AskTool.execute(
      args,
      context({ inquire: async () => ({ kind: "typed", text: "use redis" }) }),
    )
    expect(result.output).toContain("use redis")
    expect(result.output).toContain("instruction")
  })

  test("no answer means: don't ask again, pick one and carry on", async () => {
    const result = await AskTool.execute(
      args,
      context({ inquire: async () => ({ kind: "cancelled" }) }),
    )
    expect(result.output).toMatch(/do not ask it again/i)
    expect(result.metadata["answered"]).toBe(false)
  })

  test("a permission denial is thrown — 'never interrupt me' is a legitimate rule", async () => {
    await expect(
      AskTool.execute(
        args,
        context({
          ask: async () => {
            throw new Error("Permission denied")
          },
        }),
      ),
    ).rejects.toThrow(/Permission denied/)
  })
})

// ─────────────────────────────────────────────── The live card

describe("the live card", () => {
  setColorEnabled(false)
  const press = (card: AskCard, ...names: string[]): Answer | undefined => {
    let answer: Answer | undefined
    for (const name of names) answer = card.key(key(name))
    return answer
  }
  const shown = (card: AskCard, width = 60, height = 30) => card.render(width, height).lines.map(stripAnsi)

  test("★ ↓ then ⏎ picks what the cursor is on — ⏎ used to be able to mean only '1'", () => {
    const card = new AskCard(question())
    expect(press(card, "down", "enter")).toEqual({ kind: "picked", choices: ["SQLite"] })
  })

  test("the cursor wraps: ↑ from the first option lands on the type-your-own row", () => {
    const card = new AskCard(question())
    card.key(key("up"))
    expect(shown(card).some(line => line.startsWith("  ❯ 4."))).toBe(true)
  })

  test("a digit still picks in one key", () => {
    expect(new AskCard(question()).key(key("3"))).toEqual({ kind: "picked", choices: ["MySQL"] })
  })

  test("★ typing anything moves to the type-your-own row; ⏎ there sends it as typed, not as the option under the old cursor", () => {
    const card = new AskCard(question())
    expect(press(card, "r", "e", "d", "i", "s")).toBeUndefined()
    expect(card.key(key("enter"))).toEqual({ kind: "typed", text: "redis" })
  })

  test("an IME commit (CJK or a paste) starts an answer the same way", () => {
    const card = new AskCard(question())
    card.key(key("paste", { text: "用\nredis" }))
    expect(card.key(key("enter"))).toEqual({ kind: "typed", text: "用 redis" })
  })

  test("⏎ on an empty type-your-own row waits instead of dismissing — only esc dismisses", () => {
    const card = new AskCard(question())
    expect(press(card, "4", "enter")).toBeUndefined()
    expect(card.key(key("escape"))).toEqual({ kind: "cancelled" })
  })

  test("a space on a single-choice card neither picks nor starts typing — IMEs commit with it", () => {
    const card = new AskCard(question())
    expect(card.key(key(" "))).toBeUndefined()
    expect(card.key(key("enter"))).toEqual({ kind: "picked", choices: ["Postgres"] })
  })

  test("multiple choice ticks with ⏎ / space / digits and submits from the Done row", () => {
    const card = new AskCard(question({ multiple: true }))
    press(card, "enter", "down", "down", " ", "2", "2")
    expect(shown(card).filter(line => line.includes("[✓]"))).toHaveLength(2)
    // The digit left the cursor on option 2; below it: option 3, the type-your-own row, Done
    expect(press(card, "down", "down", "down", "enter")).toEqual({ kind: "picked", choices: ["Postgres", "MySQL"] })
  })

  test("Done with nothing ticked is a dismissal, the same as before", () => {
    const card = new AskCard(question({ multiple: true }))
    expect(press(card, "up", "enter")).toEqual({ kind: "cancelled" })
  })

  test("★ ← goes back only when there is a question to go back to — and says so only then", () => {
    const first = new AskCard(question({ position: { index: 1, total: 2 } }))
    expect(first.key(key("left"))).toBeUndefined()
    expect(shown(first).join("\n")).not.toContain("←")
    const second = new AskCard(question({ position: { index: 2, total: 2 } }))
    expect(shown(second).join("\n")).toContain("←")
    expect(second.key(key("left"))).toEqual({ kind: "back" })
  })

  test("← inside typed text edits the text instead of leaving the question", () => {
    const card = new AskCard(question({ position: { index: 2, total: 2 } }))
    press(card, "a", "b", "left", "x")
    expect(card.key(key("enter"))).toEqual({ kind: "typed", text: "axb" })
  })

  test("★ revisiting a question puts its answer back, and → keeps it", () => {
    const multi = new AskCard(question({ multiple: true, previous: { kind: "picked", choices: ["SQLite", "MySQL"] } }))
    expect(shown(multi).filter(line => line.includes("[✓]"))).toHaveLength(2)
    expect(multi.key(key("right"))).toEqual({ kind: "picked", choices: ["SQLite", "MySQL"] })

    const single = new AskCard(question({ previous: { kind: "picked", choices: ["MySQL"] } }))
    expect(single.key(key("enter"))).toEqual({ kind: "picked", choices: ["MySQL"] })

    const typed = new AskCard(question({ previous: { kind: "typed", text: "redis" } }))
    press(typed, "!")
    expect(typed.key(key("enter"))).toEqual({ kind: "typed", text: "redis!" })
  })

  test("the terminal cursor sits in the text being typed", () => {
    const card = new AskCard(question())
    press(card, "a", "b")
    const frame = card.render(60, 30)
    expect(stripAnsi(frame.lines[frame.cursor!.row]!)).toContain("4. ab")
    expect(frame.cursor!.col).toBe("  ❯ 4. ab".length)
  })

  test("★ on a short screen the keys stay and the window follows the cursor", () => {
    const many = question({ options: Array.from({ length: 6 }, (_, index) => ({ label: `option ${index + 1}`, description: "a line about it" })) })
    const card = new AskCard(many)
    press(card, "up", "up")
    const lines = card.render(60, 10).lines.map(stripAnsi)
    expect(lines).toHaveLength(10)
    expect(lines.at(-1)).toContain("esc")
    expect(lines.some(line => line.startsWith("  ❯ 6. option 6"))).toBe(true)
  })

  describe("in the live area", () => {
    function fakeKeyboard() {
      let handler: ((key: Key) => void) | undefined
      return {
        usable: true,
        attached: true,
        push(next: (key: Key) => void) {
          handler = next
          return () => { handler = undefined }
        },
        press: (name: string) => handler?.(key(name)),
        get held() { return handler !== undefined },
      }
    }
    function fakeRegion() {
      let frame: ((width: number, height: number) => { lines: string[] }) | undefined
      return {
        suspend() {}, resume() {}, refresh() {}, active: true,
        overlay(render: (width: number, height: number) => { lines: string[] }) {
          frame = render
          return () => { frame = undefined }
        },
        get frame() { return frame?.(60, 20).lines.map(stripAnsi) },
      }
    }

    test("★ the card takes the keyboard and the frame, and gives both back when answered", async () => {
      const keyboard = fakeKeyboard(), region = fakeRegion()
      const pending = ask(question(), { keyboard, region })
      await Promise.resolve()
      expect(region.frame?.join("\n")).toContain("? Which database?")
      keyboard.press("2")
      expect(await pending).toEqual({ kind: "picked", choices: ["SQLite"] })
      expect(region.frame).toBeUndefined()
      expect(keyboard.held).toBe(false)
    })

    test("an abort closes the card too — a turn interrupted mid-question must not leave it up", async () => {
      const keyboard = fakeKeyboard(), region = fakeRegion()
      const controller = new AbortController()
      const pending = ask(question(), { keyboard, region, signal: controller.signal })
      await Promise.resolve()
      controller.abort()
      expect(await pending).toEqual({ kind: "cancelled" })
      expect(region.frame).toBeUndefined()
      expect(keyboard.held).toBe(false)
    })

    test("with nobody at the keyboard no card opens at all", async () => {
      const region = fakeRegion()
      expect(await ask(question(), { region })).toEqual({ kind: "unavailable" })
      expect(region.frame).toBeUndefined()
    })
  })
})

// ─────────────────────────────────────────────── The --plain path

describe("the --plain path", () => {
  /** Fake keyboard: push takes the handler, and the test feeds keys into it itself */
  function fakeKeyboard() {
    let handler: ((key: Key) => void) | undefined
    return {
      usable: true,
      attached: true,
      push(next: (key: Key) => void) {
        handler = next
        return () => {
          handler = undefined
        }
      },
      press(name: string, over: Partial<Key> = {}) {
        handler?.(key(name, over))
      },
    }
  }

  function fakeOutput() {
    const chunks: string[] = []
    return {
      chunks,
      stream: { write: (text: string) => chunks.push(text) } as unknown as NodeJS.WriteStream,
    }
  }

  test("★ with nobody to ask, writes nothing — -p stdout is for other programs to consume", async () => {
    const out = fakeOutput()
    const answer = await askInPlain(question(), { output: out.stream })
    expect(answer).toEqual({ kind: "unavailable" })
    expect(out.chunks.join("")).toBe("")
  })

  test("writes the question and numbers, answered by number", async () => {
    const keyboard = fakeKeyboard()
    const out = fakeOutput()
    const pending = askInPlain(question(), { keyboard, output: out.stream })
    await Promise.resolve()
    expect(out.chunks.join("")).toContain("Which database?")
    keyboard.press("2")
    expect(await pending).toEqual({ kind: "picked", choices: ["SQLite"] })
  })

  test("multiple choice collects numbers and submits them on one enter", async () => {
    const keyboard = fakeKeyboard()
    const out = fakeOutput()
    const pending = askInPlain(question({ multiple: true }), { keyboard, output: out.stream })
    await Promise.resolve()
    keyboard.press("1")
    keyboard.press("3")
    keyboard.press("enter")
    expect(await pending).toEqual({ kind: "picked", choices: ["Postgres", "MySQL"] })
  })

  test("text typed after o comes back as typed", async () => {
    const keyboard = fakeKeyboard()
    const out = fakeOutput()
    const pending = askInPlain(question(), { keyboard, output: out.stream })
    await Promise.resolve()
    keyboard.press("o")
    for (const char of "redis") keyboard.press(char)
    keyboard.press("enter")
    expect(await pending).toEqual({ kind: "typed", text: "redis" })
  })

  test("an abort signal ends the prompt — otherwise the tool waits forever on an unattended terminal", async () => {
    const keyboard = fakeKeyboard()
    const out = fakeOutput()
    const controller = new AbortController()
    const pending = askInPlain(question(), { keyboard, output: out.stream, signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    expect(await pending).toEqual({ kind: "cancelled" })
  })
})

// ─────────────────────────────────────────────── Several questions at once

describe("several questions at once", () => {
  const context = (over: Partial<ToolContext> = {}): ToolContext => ({
    cwd: "/tmp",
    root: "/tmp",
    sessionID: "s",
    messageID: "m",
    callID: "c",
    abortSignal: new AbortController().signal,
    ask: async () => {},
    onProgress: () => {},
    metadata: () => {},
    ...over,
  })

  const three = {
    questions: [
      { question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
      { question: "Include migrations?", options: [{ label: "yes" }, { label: "no" }] },
      { question: "Which runtime?", options: [{ label: "bun" }, { label: "node" }] },
    ],
  }

  test("★ three questions are asked in one call — saving three rounds of resending the whole history", async () => {
    const seen: Question[] = []
    const result = await AskTool.execute(
      three,
      context({
        inquire: async (question) => {
          seen.push(question)
          return { kind: "picked", choices: [question.options[0]!.label] }
        },
      }),
    )
    expect(seen).toHaveLength(3)
    expect(result.output).toContain("1. Which database?")
    expect(result.output).toContain("3. Which runtime?")
    expect(result.output).toContain("Postgres")
    expect(result.metadata["questions"]).toBe(3)
  })

  test("the UI knows which question this is — otherwise the user thinks the model just thought of another", async () => {
    const seen: Question[] = []
    await AskTool.execute(
      three,
      context({
        inquire: async (question) => {
          seen.push(question)
          return { kind: "picked", choices: ["x"] }
        },
      }),
    )
    expect(seen.map((question) => question.position)).toEqual([
      { index: 1, total: 3 },
      { index: 2, total: 3 },
      { index: 3, total: 3 },
    ])
  })

  test("★ ← returns to the previous question with its earlier answer — checking that answer is why the user went back", async () => {
    const seen: Array<{ index: number; previous: Answer | undefined }> = []
    let step = 0
    const result = await AskTool.execute(
      three,
      context({
        inquire: async (question) => {
          seen.push({ index: question.position!.index, previous: question.previous })
          step++
          // Answer 1, answer 2, turn back on the third, change the second, then answer
          // straight through
          if (step === 3) return { kind: "back" }
          if (step === 4) return { kind: "picked", choices: ["no"] }
          return { kind: "picked", choices: [question.options[0]!.label] }
        },
      }),
    )
    expect(seen.map((each) => each.index)).toEqual([1, 2, 3, 2, 3])
    // Back on the second question, last time's choice comes back with it
    expect(seen[3]!.previous).toEqual({ kind: "picked", choices: ["yes"] })
    // The third is being answered for the first time, so no previous (last time it was
    // skipped by ←, not answered)
    expect(seen[4]!.previous).toBeUndefined()
    // The model sees the revised version; not one word about "going back a question"
    // enters its context
    expect(result.output).toContain("no")
    expect(result.output).not.toContain("back")
    expect(result.metadata["questions"]).toBe(3)
  })

  test("★ with nobody to ask, the remaining questions are not asked — each would get the same reply", async () => {
    let asked = 0
    const result = await AskTool.execute(
      three,
      context({
        inquire: async () => {
          asked++
          return { kind: "unavailable" }
        },
      }),
    )
    expect(asked).toBe(1)
    expect(result.metadata["unavailable"]).toBe(true)
    // The ones never asked must be reported, otherwise the model only knows the first
    // went unanswered
    expect(result.output).toContain("Include migrations?")
  })

  test("★ no more prompts after the user aborts the turn — that would be fighting someone who just hit Ctrl-C", async () => {
    const controller = new AbortController()
    let asked = 0
    const result = await AskTool.execute(
      three,
      context({
        abortSignal: controller.signal,
        inquire: async () => {
          asked++
          controller.abort()
          return { kind: "cancelled" }
        },
      }),
    )
    expect(asked).toBe(1)
    expect(result.metadata["questions"]).toBe(1)
  })

  test("with mixed answers, each says which kind it is", async () => {
    const answers: Answer[] = [
      { kind: "picked", choices: ["Postgres"] },
      { kind: "typed", text: "use redis" },
      { kind: "cancelled" },
    ]
    let at = 0
    const result = await AskTool.execute(three, context({ inquire: async () => answers[at++]! }))
    expect(result.output).toContain("Postgres")
    expect(result.output).toContain("in their own words) use redis")
    expect(result.output).toContain("dismissed without answering")
    expect(result.output).toMatch(/replaces the options/)
  })
})
