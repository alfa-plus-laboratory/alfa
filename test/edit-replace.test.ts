import { describe, expect, test } from "bun:test"
import {
  ERR_DISPROPORTIONATE,
  ERR_EMPTY_OLD,
  ERR_IDENTICAL,
  ERR_MULTIPLE,
  ERR_NOT_FOUND,
  isDisproportionateMatch,
  replace,
} from "../src/tool/edit/replace.ts"
import {
  bomJoin,
  bomSplit,
  convertToLineEnding,
  decodeWithBom,
  decodeWithBomStrict,
  detectLineEnding,
  normalizeLineEndings,
} from "../src/tool/edit/line-ending.ts"

describe("preconditions", () => {
  test("the identical check comes before the empty check", () => {
    // when both hold, it must report identical — with the order reversed the model gets a
    // misleading hint
    expect(() => replace("x", "", "")).toThrow(ERR_IDENTICAL)
  })

  test("empty oldString reports empty", () => {
    expect(() => replace("x", "", "y")).toThrow(ERR_EMPTY_OLD)
  })

  // ⚠ This guards against **an empty candidate produced by the cascade itself**, not an
  //    empty argument from the user — the test above already covers the latter.
  //    When LineTrimmedReplacer trims "\t" and compares line by line, a blank line's
  //    "".trim() equals it, so every blank line "matches" and the candidate handed over
  //    is "". And "".indexOf is always 0, and replaceAll("", x) inserts a copy of x
  //    between every two characters.
  //    What it once did for real: the whole file got scattered, with "Replacements: 18"
  //    reported back.
  test("★ whitespace oldString + replaceAll must report not found, never scatter the file", () => {
    const file = "line one\n\nline two\n"
    expect(() => replace(file, "\t", "  ", true)).toThrow(ERR_NOT_FOUND)
    expect(() => replace(file, " ", "  ", true)).not.toThrow() // real spaces: still replaces
  })

  test("★ when the file really has tabs, replacement works as usual", () => {
    const file = "\tindented\n"
    expect(replace(file, "\t", "  ", true).content).toBe("  indented\n")
  })
})

describe("level 1 SimpleReplacer", () => {
  test("exact unique match", () => {
    const r = replace("const a = 1\nconst b = 2\n", "const a = 1", "const a = 42")
    expect(r.content).toBe("const a = 42\nconst b = 2\n")
    expect(r.replacerIndex).toBe(0)
    expect(r.replacements).toBe(1)
  })

  test("exact but not unique → multiple (not not found)", () => {
    expect(() => replace("dup\ndup\n", "dup", "x")).toThrow(ERR_MULTIPLE)
  })

  test("replaceAll skips the uniqueness check", () => {
    const r = replace("dup\ndup\n", "dup", "x", true)
    expect(r.content).toBe("x\nx\n")
    expect(r.replacements).toBe(2)
  })

  test("no match at all → not found", () => {
    expect(() => replace("abc", "zzz", "y")).toThrow(ERR_NOT_FOUND)
  })
})

describe("level 2 LineTrimmedReplacer", () => {
  test("matches a multi-line block whose indentation differs, replacing the original text", () => {
    const content = "function f() {\n    const a = 1\n    return a\n}\n"
    // the model gave 2-space indentation, the file has 4 spaces — no verbatim match
    const find = "  const a = 1\n  return a"
    const r = replace(content, find, "    return 1")
    expect(r.content).toBe("function f() {\n    return 1\n}\n")
    expect(r.replacerIndex).toBe(1)
  })

  test("single line: when an exact match exists level 1 wins first, original whitespace kept", () => {
    // this deliberately checks the short-circuit order — "hello" exists verbatim, so
    // level 2 never gets a turn
    const content = "a\n  hello   \nb\n"
    const r = replace(content, "hello", "world")
    expect(r.content).toBe("a\n  world   \nb\n")
    expect(r.replacerIndex).toBe(0)
  })

  test("notFound is sticky: located but never unique → multiple", () => {
    // verbatim "  x" exists in two places → level 1 already lands on multiple, not on
    // not found
    const content = "  x  \n  x  \n"
    expect(() => replace(content, "x", "y")).toThrow(ERR_MULTIPLE)
  })

  test("sticky across levels: no hit at level 1, multiple hits at a later level → multiple, not not found", () => {
    // find has leading and trailing spaces and doesn't exist verbatim in the original
    // (which is tab-indented); after trimming both lines match → notFound is set to false
    // → it must end up reporting multiple
    const content = "\tfoo()\n\tfoo()\n"
    expect(() => replace(content, "  foo()  ", "bar()")).toThrow(ERR_MULTIPLE)
  })
})

describe("level 3 BlockAnchorReplacer", () => {
  test("first and last lines as anchors match even when the middle lines were rewritten from memory", () => {
    const content = ["function calc(a, b) {", "  const sum = a + b", "  return sum", "}", ""].join("\n")
    // the model wrote the middle two lines differently, but the first/last anchors match
    // and so does the line count
    const find = ["function calc(a, b) {", "  const total = a + b", "  return total", "}"].join("\n")
    const r = replace(content, find, "function calc(a, b) {\n  return a + b\n}")
    expect(r.content).toBe("function calc(a, b) {\n  return a + b\n}\n")
    expect(r.replacerIndex).toBe(2)
  })

  test("fewer than 3 lines never reach this level", () => {
    expect(() => replace("aaa\nbbb\n", "aaa\nzzz\n", "q")).toThrow(ERR_NOT_FOUND)
  })
})

describe("level 4 WhitespaceNormalizedReplacer", () => {
  test("still matches when in-line whitespace was normalized", () => {
    const content = "call(  a,   b )\nother()\n"
    // the model squeezed out the extra spaces within the line — none of the first three
    // levels match
    const r = replace(content, "call( a, b )", "call(a, b)")
    expect(r.content).toBe("call(a, b)\nother()\n")
    expect(r.replacerIndex).toBe(3)
  })
})

describe("level 5 TrimmedBoundaryReplacer", () => {
  test("multi-line find with blank lines on both ends — the blind spot level 4 can't reach", () => {
    // level 4 also folds \n into spaces, so a multi-line find normalized to one line
    // matches no window; only level 5, which keeps the internal line structure, can hit
    const content = "foo\nbar\n"
    const r = replace(content, "\n\nfoo\nbar\n\n", "baz")
    expect(r.content).toBe("baz\n")
    expect(r.replacerIndex).toBe(4)
  })
})

describe("isDisproportionateMatch guards against accidental deletion", () => {
  test("line-count blowup is caught", () => {
    expect(isDisproportionateMatch("a\nb\nc\nd\ne\nf", "a\nb")).toBe(true)
  })

  test("a single-line oldString skips the character-count criterion", () => {
    expect(isDisproportionateMatch("x".repeat(5000), "y")).toBe(false)
  })

  test("multi-line character-count blowup is caught", () => {
    const old = "aa\nbb"
    const search = "aa\n" + "z".repeat(2000)
    expect(isDisproportionateMatch(search, old)).toBe(true)
  })

  test("with a big chunk between first and last anchors, BlockAnchor's maxLineDelta blocks it first", () => {
    // This guards the outcome "never silently delete dozens of lines", not that some
    // particular function gets called. With the current cascade the block happens during
    // candidate collection (line count differs by > 25%) and never even reaches
    // isDisproportionateMatch — so this asserts not found, not disproportionate.
    // If a looser level like ContextAware is added later, this should switch to
    // asserting ERR_DISPROPORTIONATE.
    const body = Array.from({ length: 40 }, (_, i) => `  line${i}`).join("\n")
    const content = `{\n${body}\n}\n`
    const find = "{\n  lineA\n}"
    expect(() => replace(content, find, "{}")).toThrow(ERR_NOT_FOUND)
    expect(ERR_DISPROPORTIONATE).toContain("Refusing replacement")
  })
})

describe("line endings and BOM", () => {
  test("detects the file-level line ending", () => {
    expect(detectLineEnding("a\r\nb\n")).toBe("\r\n")
    expect(detectLineEnding("a\nb\n")).toBe("\n")
  })

  test("a CRLF file is still pure CRLF after replacement", () => {
    const original = "const a = 1\r\nconst b = 2\r\n"
    const ending = detectLineEnding(original)
    const lf = normalizeLineEndings(original)
    const replaced = replace(lf, "const a = 1", "const a = 42").content
    const out = convertToLineEnding(replaced, ending)
    expect(out).toBe("const a = 42\r\nconst b = 2\r\n")
    expect(out.includes("\n\r")).toBe(false)
    expect(out.split("\r\n").length - 1).toBe(2)
  })

  test("BOM survives a round trip", () => {
    const withBom = "﻿hello"
    const split = bomSplit(withBom)
    expect(split.bom).toBe("﻿")
    expect(split.text).toBe("hello")
    expect(bomJoin(split.text, split.bom)).toBe(withBom)
  })

  test("bomJoin doesn't add the BOM twice", () => {
    expect(bomJoin("﻿x", "﻿")).toBe("﻿x")
  })

  // ⚠ This guards the fact that "edit writes the whole file back". Lenient decoding turns
  //    invalid bytes into U+FFFD, and on write-back those original bytes are gone for
  //    good — and the line destroyed is usually one edit never touched, while the
  //    approval diff is computed from the decoded text, so it's invisible on the
  //    approval screen.
  test("★ non-UTF-8 file: strict decoding must refuse, never silently turn into U+FFFD", () => {
    // "// caf<0xe9>\nconst a = 1\n" — Latin-1 é
    const latin1 = new Uint8Array([
      0x2f, 0x2f, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a,
      0x63, 0x6f, 0x6e, 0x73, 0x74, 0x20, 0x61, 0x20, 0x3d, 0x20, 0x31, 0x0a,
    ])
    expect(() => decodeWithBomStrict(latin1, "legacy.ts")).toThrow(/not valid UTF-8/)
    // the lenient one stays lenient — write only uses it for the diff preview and never
    // writes back what it couldn't read
    expect(decodeWithBom(latin1).text).toContain("\uFFFD")
  })

  test("strict decoding leaves normal files alone and still recognizes the BOM", () => {
    const utf8 = new TextEncoder().encode("// café\nconst a = 1\n")
    expect(decodeWithBomStrict(utf8, "x.ts").text).toBe("// café\nconst a = 1\n")
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("hello")])
    expect(decodeWithBomStrict(withBom, "x.ts")).toEqual({ bom: "\uFEFF", text: "hello" })
  })
})
