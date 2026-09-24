/**
 * Syntax highlighting.
 *
 * The first test matters more than all the color assertions combined: **with colors
 * stripped, the output must equal the original text character for character**. If
 * highlighting swallows or adds a single character, the right pane's truncation, the chat
 * area's wrapping and the compositor's diffing all go out of alignment — and that kind of
 * misalignment looks like something is wrong with the file itself, so people suspect the
 * code first. That's why this one runs over the whole repo's source.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Highlighter, languageFor } from "../src/cli/highlight.ts"
import { colorEnabled, setColorEnabled } from "../src/cli/theme.ts"
import { displayWidth, stripAnsi } from "../src/cli/width.ts"
import { afterAll, beforeAll } from "bun:test"

const wasEnabled = colorEnabled()
beforeAll(() => setColorEnabled(true))
afterAll(() => setColorEnabled(wasEnabled))

const paint = (code: string, hint: string): string[] => {
  const rows = code.split("\n")
  const language = languageFor(hint)
  if (!language) return rows
  const highlighter = new Highlighter(language)
  return rows.map(row => highlighter.line(row))
}
const plain = (code: string, hint: string): string[] => paint(code, hint).map(stripAnsi)

/**
 * Which color a fragment was painted (judged by SGR code, so the assertions don't
 * hard-code the whole line)
 */
const KEYWORD = "\u001b[35m"
const TYPE = "\u001b[34m"
const STRING = "\u001b[32m"
const NUMBER = "\u001b[33m"
const COMMENT = "\u001b[2m"
const CALL = "\u001b[36m"

const painted = (line: string, hint: string, sgr: string, fragment: string): boolean =>
  paint(line, hint)[0]!.includes(sgr + fragment)

// ───────────────────────────────────────────── invariant

describe("★ stripped of color = original text", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, out)
      else if (entry.name.endsWith(".ts")) out.push(path)
    }
    return out
  }

  test("holds across all of src/", () => {
    // relative paths drift with cwd; the test has to locate the repo itself
    const files = walk(fileURLToPath(new URL("../src", import.meta.url)))
    expect(files.length).toBeGreaterThan(20)
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      const rows = text.split("\n")
      const out = paint(text, file)
      expect(out.length).toBe(rows.length)
      for (let i = 0; i < rows.length; i++) {
        if (stripAnsi(out[i]!) !== rows[i]) throw new Error(`${file}:${i + 1} content was altered`)
      }
    }
  })

  const SAMPLES: Array<[string, string]> = [
    ["a.py", 'def f(x: int = 0) -> str:\n    """doc\n    still doc"""\n    return f"{x}"  # tail'],
    ["a.go", 'func main() {\n\ts := `raw\nmulti`\n\tfmt.Println(s)\n}'],
    ["a.sh", 'set -e\nFOO="${BAR:-x}"\necho "$FOO" # hi'],
    ["a.json", '{ "a": [1, 2.5, true, null], "b": "c" }'],
    ["a.sql", "SELECT * FROM t WHERE x = 'y' -- note"],
    ["a.rs", 'fn main() { let s: &str = "hi\\""; }'],
    ["a.css", "/* c */\n.a { color: #fff; width: 10px; }"],
    ["a.html", '<!-- c -->\n<div class="x">text</div>'],
    ["a.yaml", "key: value  # note\nlist:\n  - 1\n  - 'two'"],
    ["a.ts", "const x = `a${b}c` // 中文注释 emoji 😀"],
  ]

  for (const [name, code] of SAMPLES) {
    test(`language sample: ${name}`, () => {
      expect(plain(code, name).join("\n")).toBe(code)
    })
  }

  test("★ display width doesn't change by a single cell (CJK, emoji)", () => {
    const line = 'const 名字 = "中文字符串 😀" // 注释'
    const out = paint(line, "a.ts")[0]!
    expect(displayWidth(out)).toBe(displayWidth(line))
  })

  test("an unterminated string / comment swallows nothing", () => {
    expect(plain('const s = "unterminated', "a.ts")).toEqual(['const s = "unterminated'])
    expect(plain("/* never closed", "a.ts")).toEqual(["/* never closed"])
  })
})

// ───────────────────────────────────────────── detecting the language

describe("language detection", () => {
  test("by file extension", () => {
    expect(languageFor("src/cli/main.ts")?.id).toBe("ts")
    expect(languageFor("/abs/path/thing.py")?.id).toBe("py")
    expect(languageFor("a.tsx")?.id).toBe("ts")
    expect(languageFor("a.yml")?.id).toBe("yaml")
  })

  test("by fence tag, case-insensitive and with aliases", () => {
    expect(languageFor("python")?.id).toBe("py")
    expect(languageFor("TypeScript")?.id).toBe("ts")
    expect(languageFor("Bash")?.id).toBe("sh")
  })

  test("a fence tag followed by arguments still matches", () => {
    expect(languageFor("python title=x")?.id).toBe("py")
  })

  test("★ unrecognized means no color — guessing the wrong language is worse than none", () => {
    expect(languageFor("brainfuck")).toBeUndefined()
    expect(languageFor("")).toBeUndefined()
    expect(languageFor("a.unknownext")).toBeUndefined()
    expect(plain("这不是代码 ** ##", "a.unknownext")).toEqual(["这不是代码 ** ##"])
    expect(paint("const x = 1", "a.unknownext")[0]).toBe("const x = 1")
  })

  test("common files without an extension", () => {
    expect(languageFor("Dockerfile")?.id).toBe("sh")
    expect(languageFor(".bashrc")?.id).toBe("sh")
  })
})

// ───────────────────────────────────────────── lexing

describe("comments", () => {
  test("a line comment runs to end of line, and keywords inside aren't colored", () => {
    const out = paint("// const if return", "a.ts")[0]!
    expect(out).toContain(COMMENT)
    expect(out).not.toContain(KEYWORD)
  })

  test("★ block comments span lines — state carries to the next line", () => {
    const out = paint("/* a\nconst b\n*/ const c", "a.ts")
    expect(out[1]).toContain(COMMENT)
    expect(out[1]).not.toContain(KEYWORD)
    // after the close on the third line, it's code again
    expect(out[2]).toContain(KEYWORD + "const")
  })

  test("// inside a string is not a comment", () => {
    const out = paint('const u = "http://x" // real', "a.ts")[0]!
    expect(out).toContain(STRING + '"http://x"')
  })

  test("SQL -- is a comment", () => {
    expect(painted("SELECT 1 -- note", "a.sql", COMMENT, "-- note")).toBe(true)
  })
})

describe("strings", () => {
  test("all three quote kinds", () => {
    expect(painted('a = "x"', "a.ts", STRING, '"x"')).toBe(true)
    expect(painted("a = 'x'", "a.ts", STRING, "'x'")).toBe(true)
    expect(painted("a = `x`", "a.ts", STRING, "`x`")).toBe(true)
  })

  test("★ escapes are counted in pairs: a quote after\\\\ really closes the string", () => {
    const out = paint('const a = "x\\\\"; const b = 1', "a.ts")[0]!
    // get the closing quote wrong and `const b` is taken as part of the string, so the
    // keyword disappears
    expect(out).toContain(KEYWORD + "const")
    expect(out.split(KEYWORD + "const").length - 1).toBe(2)
  })

  test("★ python triple quotes span lines", () => {
    const out = paint('x = """a\nb\n"""\ny = 1', "a.py")
    expect(out[1]).toContain(STRING)
    expect(out[3]).toContain(NUMBER + "1")
  })

  test("★ go backtick raw strings span lines", () => {
    const out = paint("s := `a\nb`\nn := 1", "a.go")
    expect(out[1]).toContain(STRING)
    expect(out[2]).toContain(NUMBER + "1")
  })

  test("★ triple quotes are tried before single quotes, or they never match", () => {
    // matched as "" + "a...", this line's closing detection would be completely off
    expect(plain('"""a"""', "a.py")).toEqual(['"""a"""'])
    expect(painted('"""a"""', "a.py", STRING, '"""a"""')).toBe(true)
  })
})

describe("numbers / identifiers", () => {
  test("hex, decimals, exponents", () => {
    expect(painted("a = 0xFF", "a.ts", NUMBER, "0xFF")).toBe(true)
    expect(painted("a = 3.14", "a.ts", NUMBER, "3.14")).toBe(true)
    expect(painted("a = 1e-9", "a.ts", NUMBER, "1e-9")).toBe(true)
  })

  test("★ digits inside an identifier are not a number literal", () => {
    const out = paint("const utf8 = base64", "a.ts")[0]!
    expect(out).not.toContain(NUMBER)
  })

  test("keywords / types / literals / function calls each get their own color", () => {
    expect(painted("return x", "a.ts", KEYWORD, "return")).toBe(true)
    expect(painted("let a: string", "a.ts", TYPE, "string")).toBe(true)
    expect(painted("a = true", "a.ts", NUMBER, "true")).toBe(true) // literal colored as number
    expect(painted("doThing(1)", "a.ts", CALL, "doThing")).toBe(true)
  })

  test("a function name counts only when immediately followed by a parenthesis", () => {
    expect(paint("doThing", "a.ts")[0]).toBe("doThing")
  })
})

describe("per-language quirks", () => {
  test("SQL keywords are case-insensitive", () => {
    expect(painted("select 1", "a.sql", KEYWORD, "select")).toBe(true)
    expect(painted("SELECT 1", "a.sql", KEYWORD, "SELECT")).toBe(true)
  })

  test("★ JSON keys and values are told apart — otherwise the whole config is one green blob", () => {
    const out = paint('{"k": "v"}', "a.json")[0]!
    expect(out).toContain(TYPE + '"k"')
    expect(out).toContain(STRING + '"v"')
  })

  test("shell variables", () => {
    expect(painted("echo $HOME", "a.sh", TYPE, "$HOME")).toBe(true)
    expect(painted("echo ${X:-y}", "a.sh", TYPE, "${X:-y}")).toBe(true)
  })

  test("HTML tags", () => {
    expect(painted("<div>", "a.html", KEYWORD, "<div")).toBe(true)
  })

  test("decorators / preprocessor directives", () => {
    expect(painted("@decorator", "a.py", COMMENT, "@decorator")).toBe(true)
    expect(painted("#include <stdio.h>", "a.c", COMMENT, "#include")).toBe(true)
  })
})

// ───────────────────────────────────────────── streaming

describe("★ line-by-line feeding + peek", () => {
  test("peek doesn't advance state — the partial line is redrawn every frame", () => {
    const h = new Highlighter(languageFor("ts"))
    h.line("const a = 1")
    // an unclosed block comment: peeking ten times must not leave the state stuck in the
    // comment
    for (let i = 0; i < 10; i++) expect(h.peek("/* half")).toContain(COMMENT)
    expect(h.line("const b = 2")).toContain(KEYWORD + "const")
  })

  test("line advances state", () => {
    const h = new Highlighter(languageFor("ts"))
    h.line("/* open")
    const next = h.line("const b = 2")
    expect(next).toContain(COMMENT)
    expect(next).not.toContain(KEYWORD)
  })

  test("an unrecognized language is a passthrough", () => {
    const h = new Highlighter(undefined)
    expect(h.active).toBe(false)
    expect(h.line("const x = 1")).toBe("const x = 1")
  })
})
