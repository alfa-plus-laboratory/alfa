/**
 * Display width.
 *
 * Getting any of these wrong isn't "looks a bit off": it means the bottom live area's row
 * count is wrong → erasing backs up the wrong number of rows → the UI starts eating
 * upward into output already printed. Hence the very rigid assertions.
 *
 * ESC is built with String.fromCharCode(27); no raw control characters in the source
 * (raw ones are invisible in diff and grep — this repo got burned by that once).
 */
import { describe, expect, test } from "bun:test"
import {
  charWidth,
  displayWidth,
  elideLeft,
  padToWidth,
  splitAtWidth,
  stripAnsi,
  truncateToWidth,
  wrapToWidth,
} from "../src/cli/width.ts"

const ESC = String.fromCharCode(27)
const RED = `${ESC}[31m`
const RESET = `${ESC}[0m`

describe("charWidth", () => {
  test("ASCII is 1", () => {
    expect(charWidth("a")).toBe(1)
    expect(charWidth(" ")).toBe(1)
  })

  test("★ CJK is 2", () => {
    for (const char of ["中", "文", "日", "本", "한", "あ", "ア"]) {
      expect(charWidth(char)).toBe(2)
    }
  })

  test("full-width punctuation is 2, half-width is 1", () => {
    expect(charWidth("，")).toBe(2)
    expect(charWidth("。")).toBe(2)
    expect(charWidth(",")).toBe(1)
  })

  test("emoji is 2", () => {
    expect(charWidth("😀")).toBe(2)
    expect(charWidth("🚀")).toBe(2)
  })

  test("combining marks and zero-width characters are 0", () => {
    // these characters are invisible in an editor; writing them as code points makes it
    // clear what's being tested
    expect(charWidth(String.fromCharCode(0x0301))).toBe(0) // combining acute accent
    expect(charWidth(String.fromCharCode(0x200b))).toBe(0) // zero-width space
    expect(charWidth(String.fromCharCode(0x200d))).toBe(0) // ZWJ
    expect(charWidth(String.fromCharCode(0xfe0f))).toBe(0) // variation selector
  })

  test("control characters are 0", () => {
    expect(charWidth(String.fromCharCode(7))).toBe(0)
    expect(charWidth(ESC)).toBe(0)
  })

  test("arrows and box-drawing characters are 1 — the input box relies on them to align", () => {
    for (const char of ["›", "╭", "─", "╮", "│", "╰", "╯", "⠹"]) {
      expect(charWidth(char)).toBe(1)
    }
  })
})

describe("displayWidth", () => {
  test("★ escape sequences take no width", () => {
    expect(displayWidth(`${RED}abc${RESET}`)).toBe(3)
    expect(stripAnsi(`${RED}abc${RESET}`)).toBe("abc")
  })

  test("mixed CJK and Latin text", () => {
    expect(displayWidth("你好 world")).toBe(4 + 1 + 5)
  })

  test("a combining sequence counts as one", () => {
    expect(displayWidth("e" + String.fromCharCode(0x0301))).toBe(1)
  })

  test("★ ZWJ sequences err on the wide side — too narrow would overflow and wreck the UI", () => {
    // a terminal that joins them shows one 2-column glyph; one that doesn't shows three.
    // We count it as not joined.
    const zwj = String.fromCharCode(0x200d)
    expect(displayWidth(["\u{1F468}", "\u{1F469}", "\u{1F467}"].join(zwj))).toBe(6)
  })
})

describe("wrapToWidth", () => {
  test("wraps by display width, not character count", () => {
    expect(wrapToWidth("中中中", 4)).toEqual(["中中", "中"])
  })

  test("★ double-width characters aren't split; one that doesn't fit moves whole to the next line", () => {
    // width 3 can't fit the second "中", so that row only uses 2 columns and the last
    // column stays empty — which is exactly what a terminal does in the same situation
    expect(wrapToWidth("中中", 3)).toEqual(["中", "中"])
  })

  test("explicit newlines still break", () => {
    expect(wrapToWidth("ab\ncd", 10)).toEqual(["ab", "cd"])
  })

  test("an exact fit doesn't wrap an extra line", () => {
    expect(wrapToWidth("abcd", 4)).toEqual(["abcd"])
  })

  test("★ color carries across wraps: reset at line end, replayed at the next line's start", () => {
    const lines = wrapToWidth(`${RED}abcd`, 2)
    expect(lines.length).toBe(2)
    expect(lines[0]).toBe(`${RED}ab${RESET}`)
    expect(lines[1]).toBe(`${RED}cd${RESET}`)
  })

  test("no color carry-over after a reset", () => {
    const lines = wrapToWidth(`${RED}ab${RESET}cd`, 2)
    expect(lines[1]).toBe("cd")
  })

  test("no line exceeds the width limit", () => {
    const text = "你好世界 hello 世界你好 abcdefghij"
    for (const line of wrapToWidth(text, 7)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(7)
    }
  })

  test("an invalid width returns the input as is, with no infinite loop", () => {
    expect(wrapToWidth("abc", 0)).toEqual(["abc"])
  })
})

describe("padToWidth / truncateToWidth", () => {
  test("★ padding goes by display width, not length", () => {
    expect(padToWidth("中", 4)).toBe("中  ")
    expect(displayWidth(padToWidth("中文", 10))).toBe(10)
  })

  test("already wide enough: unchanged", () => {
    expect(padToWidth("abcd", 2)).toBe("abcd")
  })

  test("truncation counts the ellipsis in the budget", () => {
    const out = truncateToWidth("abcdefgh", 5)
    expect(displayWidth(out)).toBe(5)
    expect(out.endsWith("…")).toBe(true)
  })

  test("★ truncating Chinese never cuts a character in half", () => {
    const out = truncateToWidth("中文中文中文", 5)
    expect(displayWidth(out)).toBeLessThanOrEqual(5)
    expect(out).toBe("中文…")
  })

  test("unchanged when it fits", () => {
    expect(truncateToWidth("abc", 10)).toBe("abc")
  })

  test("★ truncation preserves color — code lines overflowing the right pane are the norm", () => {
    const out = truncateToWidth("\u001b[31mabcdefgh\u001b[39m", 5)
    expect(out).toContain("\u001b[31m")
    expect(displayWidth(out)).toBe(5)
    expect(stripAnsi(out)).toBe("abcd…")
  })
})

describe("splitAtWidth", () => {
  test("splits by display column, not character index", () => {
    expect(splitAtWidth("abcdef", 3)).toEqual(["abc", "def"])
    expect(splitAtWidth("中文中文", 4)).toEqual(["中文", "中文"])
  })

  test("★ a split inside a double-width char gives the whole char to the tail; the head comes up a column short", () => {
    const [head, rest] = splitAtWidth("中文", 1)
    expect(head).toBe("")
    expect(rest).toBe("中文")
  })

  test("★ color is unbroken: the head is closed off and the tail re-emits the active SGR", () => {
    const [head, rest] = splitAtWidth("\u001b[31mabcdef\u001b[39m", 3)
    expect(head).toBe("\u001b[31mabc\u001b[0m")
    expect(rest).toBe("\u001b[31mdef\u001b[39m")
  })

  test("escape sequences take no columns and don't count toward the split point", () => {
    const [head] = splitAtWidth("\u001b[1m\u001b[31mab", 2)
    expect(displayWidth(head)).toBe(2)
  })

  test("edge cases", () => {
    expect(splitAtWidth("abc", 0)).toEqual(["", "abc"])
    expect(splitAtWidth("abc", 99)).toEqual(["abc", ""])
  })
})

describe("elideLeft", () => {
  test("unchanged when it fits", () => {
    expect(elideLeft("~/code/x", 20)).toBe("~/code/x")
  })

  test("★ drops the left side — a path's distinguishing part is at the end", () => {
    const out = elideLeft("~/code/alfa-labs/subtools/alfa-workspace", 26)
    expect(out).toBe("…/subtools/alfa-workspace")
    expect(displayWidth(out)).toBeLessThanOrEqual(26)
  })

  test("breaks at a /, leaving no half word", () => {
    expect(elideLeft("~/code/alfa-labs/subtools/alfa-workspace", 20)).toBe("…/alfa-workspace")
  })

  test("hard-cuts by character only when the last segment itself doesn't fit", () => {
    const out = elideLeft("~/code/alfa-workspace", 8)
    expect(out).toBe("…rkspace")
    expect(displayWidth(out)).toBe(8)
  })

  test("double-width characters aren't split, even at the cost of a column", () => {
    const out = elideLeft("/tmp/中文中文", 5)
    expect(displayWidth(out)).toBeLessThanOrEqual(5)
    expect(out.endsWith("中文")).toBe(true)
  })

  test("edge case: so narrow only the ellipsis remains", () => {
    expect(elideLeft("abcdef", 1)).toBe("…")
    expect(elideLeft("abcdef", 0)).toBe("")
  })
})
