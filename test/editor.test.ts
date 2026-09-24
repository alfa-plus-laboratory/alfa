/**
 * The line editor and the input box.
 *
 * Two kinds of assertions deserve a word of their own:
 *   - **Chinese**. Deleting a "中" must back up one character, not one byte, and the
 *     cursor column must count it as 2. This is this project's everyday input, not an
 *     edge case.
 *   - **Every row of the box must be exactly width columns**. One column short and the
 *     right border goes crooked; one column over and the terminal wraps, and the live
 *     area's row count is wrong — that's where the whole UI starts to rot.
 */
import { describe, expect, test } from "bun:test"
import { Editor, cursorPosition, layoutRows, renderBox, wordLeft, wordRight } from "../src/cli/editor.ts"
import type { Key } from "../src/cli/keys.ts"
import { displayWidth } from "../src/cli/width.ts"

const key = (name: string, mods: Partial<Key> = {}): Key => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
  ...mods,
})

/** Types a string in, one character at a time. */
function type(editor: Editor, text: string, width?: number): void {
  for (const char of text) editor.handle(key(char), width)
}

const plainStyle = {
  border: (t: string) => t,
  marker: (t: string) => t,
  placeholder: (t: string) => t,
}

describe("insert and delete", () => {
  test("typing inserts text", () => {
    const editor = new Editor()
    type(editor, "hello")
    expect(editor.text).toBe("hello")
    expect(editor.cursor).toBe(5)
  })

  test("★ Chinese deletes one character at a time, not one byte", () => {
    const editor = new Editor()
    type(editor, "你好世界")
    editor.handle(key("backspace"))
    expect(editor.text).toBe("你好世")
    expect(editor.cursor).toBe(3)
  })

  test("★ an emoji is deleted whole, leaving no half surrogate", () => {
    const editor = new Editor()
    type(editor, "ok")
    editor.handle(key("😀"))
    expect(editor.text).toBe("ok😀")
    editor.handle(key("backspace"))
    expect(editor.text).toBe("ok")
  })

  test("inserts at a mid-line cursor", () => {
    const editor = new Editor()
    type(editor, "helo")
    editor.handle(key("left"))
    editor.handle(key("l"))
    expect(editor.text).toBe("hello")
  })

  test("backspace on empty input is harmless", () => {
    const editor = new Editor()
    editor.handle(key("backspace"))
    expect(editor.text).toBe("")
    expect(editor.cursor).toBe(0)
  })

  test("delete removes to the right", () => {
    const editor = new Editor()
    type(editor, "abc")
    editor.handle(key("home"))
    editor.handle(key("delete"))
    expect(editor.text).toBe("bc")
  })
})

describe("movement and whole-line editing", () => {
  test("Ctrl-A / Ctrl-E jump to line start / end", () => {
    const editor = new Editor()
    type(editor, "hello")
    editor.handle(key("a", { ctrl: true }))
    expect(editor.cursor).toBe(0)
    editor.handle(key("e", { ctrl: true }))
    expect(editor.cursor).toBe(5)
  })

  test("Ctrl-U deletes to line start, Ctrl-K to line end", () => {
    const editor = new Editor()
    type(editor, "hello world")
    editor.handle(key("left"))
    editor.handle(key("left"))
    editor.handle(key("k", { ctrl: true }))
    expect(editor.text).toBe("hello wor")
    editor.handle(key("u", { ctrl: true }))
    expect(editor.text).toBe("")
  })

  test("Ctrl-W deletes one word", () => {
    const editor = new Editor()
    type(editor, "fix the failing test")
    editor.handle(key("w", { ctrl: true }))
    expect(editor.text).toBe("fix the failing ")
  })

  test("word boundaries: Chinese counts as word characters", () => {
    expect(wordLeft("hello world", 11)).toBe(6)
    expect(wordRight("hello world", 0)).toBe(5)
    expect(wordLeft("修改 render.ts", 3)).toBe(0)
  })
})

describe("submit and newline", () => {
  test("Enter submits and clears", () => {
    const editor = new Editor()
    type(editor, "run the tests")
    expect(editor.handle(key("enter"))).toEqual({ type: "submit", text: "run the tests" })
    expect(editor.text).toBe("")
  })

  test("★ all-whitespace input isn't submitted, just cleared", () => {
    const editor = new Editor()
    type(editor, "   ")
    expect(editor.handle(key("enter"))).toBeUndefined()
    expect(editor.text).toBe("")
  })

  test("★ Ctrl-J inserts a newline, doesn't submit", () => {
    const editor = new Editor()
    type(editor, "line1")
    expect(editor.handle(key("j", { ctrl: true }))).toBeUndefined()
    type(editor, "line2")
    expect(editor.text).toBe("line1\nline2")
  })

  test("Alt-Enter also inserts a newline", () => {
    const editor = new Editor()
    type(editor, "a")
    editor.handle(key("enter", { meta: true }))
    expect(editor.text).toBe("a\n")
  })

  test("trailing backslash = line continuation, like the shell", () => {
    const editor = new Editor()
    type(editor, "first \\")
    expect(editor.handle(key("enter"))).toBeUndefined()
    expect(editor.text).toBe("first \n")
  })

  test("multi-line content submits as a whole", () => {
    const editor = new Editor()
    type(editor, "a")
    editor.handle(key("j", { ctrl: true }))
    type(editor, "b")
    expect(editor.handle(key("enter"))).toEqual({ type: "submit", text: "a\nb" })
  })
})

describe("★ interrupt semantics", () => {
  test("Ctrl-C reports whether there is text and leaves handling to the caller", () => {
    const editor = new Editor()
    expect(editor.handle(key("c", { ctrl: true }))).toEqual({ type: "interrupt", hasText: false })
    type(editor, "half a sentence")
    expect(editor.handle(key("c", { ctrl: true }))).toEqual({ type: "interrupt", hasText: true })
    // the editor doesn't clear itself — while running, Ctrl-C should interrupt, not eat
    // the draft
    expect(editor.text).toBe("half a sentence")
  })

  test("Esc works the same way", () => {
    const editor = new Editor()
    type(editor, "x")
    expect(editor.handle(key("escape"))).toEqual({ type: "escape", hasText: true })
  })

  test("Ctrl-D is eof on empty input, delete-right otherwise", () => {
    const editor = new Editor()
    expect(editor.handle(key("d", { ctrl: true }))).toEqual({ type: "eof" })
    type(editor, "ab")
    editor.handle(key("home"))
    expect(editor.handle(key("d", { ctrl: true }))).toBeUndefined()
    expect(editor.text).toBe("b")
  })
})

describe("paste", () => {
  test("★ arrives as one block; newlines don't submit", () => {
    const editor = new Editor()
    expect(editor.handle({ ...key("paste"), text: "line1\nline2\nline3" })).toBeUndefined()
    expect(editor.text).toBe("line1\nline2\nline3")
  })

  test("CRLF is normalized — a leftover \\r would throw the cursor off", () => {
    const editor = new Editor()
    editor.handle({ ...key("paste"), text: "a\r\nb\rc" })
    expect(editor.text).toBe("a\nb\nc")
  })

  test("tabs expand to spaces", () => {
    const editor = new Editor()
    editor.handle({ ...key("paste"), text: "a\tb" })
    expect(editor.text).toBe("a  b")
  })
})

describe("history", () => {
  test("↑ recalls the previous entry, ↓ comes back to the draft", () => {
    const editor = new Editor(["first", "second"])
    type(editor, "draft")
    editor.handle(key("up"))
    expect(editor.text).toBe("second")
    editor.handle(key("up"))
    expect(editor.text).toBe("first")
    editor.handle(key("down"))
    expect(editor.text).toBe("second")
    editor.handle(key("down"))
    expect(editor.text).toBe("draft")
  })

  test("stops at the oldest entry", () => {
    const editor = new Editor(["only"])
    editor.handle(key("up"))
    editor.handle(key("up"))
    expect(editor.text).toBe("only")
  })

  test("a submitted line can be recalled with ↑ next time", () => {
    const editor = new Editor()
    type(editor, "hello")
    editor.handle(key("enter"))
    editor.handle(key("up"))
    expect(editor.text).toBe("hello")
  })

  test("submitting the same line repeatedly records it once", () => {
    const editor = new Editor()
    for (let i = 0; i < 3; i++) {
      type(editor, "same")
      editor.handle(key("enter"))
    }
    editor.handle(key("up"))
    expect(editor.text).toBe("same")
    editor.handle(key("up"))
    expect(editor.text).toBe("same") // there is only one entry
  })

  test("★ in multi-line content ↑ moves between lines first, paging history only at the top", () => {
    const editor = new Editor(["old"])
    type(editor, "a")
    editor.handle(key("j", { ctrl: true }))
    type(editor, "b")
    editor.handle(key("up"))
    expect(editor.text).toBe("a\nb") // still in the box, didn't page into history
    editor.handle(key("up"))
    expect(editor.text).toBe("old")
  })

  test("★ in wrapped long text ↑ moves by screen row instead of jumping into history", () => {
    const editor = new Editor(["old"])
    const width = 10
    type(editor, "abcdefghijklmnopqrst", width) // 20 columns → wraps into two rows
    editor.handle(key("up"), width)
    expect(editor.text).toBe("abcdefghijklmnopqrst")
    expect(editor.cursor).toBe(10)
  })
})

describe("wrapping and cursor coordinates", () => {
  test("wraps by display width and records each row's start", () => {
    const rows = layoutRows("abcdef", 3)
    expect(rows.map((r) => r.text)).toEqual(["abc", "def"])
    expect(rows.map((r) => r.start)).toEqual([0, 3])
  })

  test("explicit newlines", () => {
    const rows = layoutRows("ab\ncd", 10)
    expect(rows.map((r) => r.start)).toEqual([0, 3])
  })

  test("★ Chinese column = character count × 2", () => {
    const rows = layoutRows("你好", 10)
    expect(cursorPosition(rows, 2)).toEqual({ row: 0, col: 4 })
  })

  test("a cursor at a wrap point lands at the start of the next row", () => {
    const rows = layoutRows("abcdef", 3)
    expect(cursorPosition(rows, 3)).toEqual({ row: 1, col: 0 })
  })

  test("a trailing newline leaves an empty row for the cursor", () => {
    const rows = layoutRows("a\n", 10)
    expect(rows.length).toBe(2)
    expect(cursorPosition(rows, 2)).toEqual({ row: 1, col: 0 })
  })
})

describe("single-column input", () => {
  test("Chinese/Japanese and multi-line text keep width and cursor, with no border drawn", () => {
    for (const width of [12, 24, 40, 80]) {
      const text = "你好日本語\n".repeat(20)
      const result = renderBox({ text, cursor: text.length, width, maxRows: 5, style: plainStyle })
      expect(result.lines.length).toBeLessThanOrEqual(5)
      expect(result.cursor.row).toBeLessThan(result.lines.length)
      for (const line of result.lines) {
        expect(displayWidth(line)).toBeLessThanOrEqual(width)
        expect(line).not.toContain("│")
      }
    }
  })
  test("empty input shows the placeholder, cursor right after the prompt", () => {
    const result = renderBox({ text: "", cursor: 0, width: 40, style: plainStyle, placeholder: "Ask anything" })
    expect(result.lines[0]).toContain("Ask anything")
    expect(result.cursor).toEqual({ row: 0, col: 2 })
  })

  test("★ with a risk marker wider than the usual prompt, continuation rows and cursor stay aligned", () => {
    const result = renderBox({
      text: "danger",
      cursor: 6,
      width: 12,
      marker: "❕ ",
      style: plainStyle,
    })
    expect(result.lines[0]).toBe("❕ danger")
    expect(result.cursor).toEqual({ row: 0, col: 9 })
    expect(displayWidth(result.lines[0]!)).toBeLessThanOrEqual(12)
  })
})
