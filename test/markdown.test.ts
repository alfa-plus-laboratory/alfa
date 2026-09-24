/**
 * Markdown rendering.
 *
 * Assertions are always made **after stripping colors**, unless the test is about color
 * itself — otherwise one palette change means rewriting half the file, and the palette is
 * the thing most likely to get tweaked.
 *
 * The two groups that matter most:
 *   - "Things that must not be taken as formatting". snake_case, 2 * 3, the minus signs
 *     in a diff — a false match is far worse than not rendering at all, because the user
 *     will think the content itself changed.
 *   - "Split anywhere, same result". Text arrives one token at a time; a split landing
 *     in the middle of ` ** `, of a fence, or of a table is routine.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { MarkdownStream, renderInline, renderLine } from "../src/cli/markdown.ts"
import { colorEnabled, setColorEnabled, theme } from "../src/cli/theme.ts"
import { displayWidth, stripAnsi } from "../src/cli/width.ts"

// The test process isn't a TTY, so color is off by default. It's forced on here so the
// palette can be asserted — but that's a global switch and must be restored afterward,
// or test files will affect each other depending on execution order
const wasEnabled = colorEnabled()
beforeAll(() => setColorEnabled(true))
afterAll(() => setColorEnabled(wasEnabled))

const plain = (text: string): string => stripAnsi(text)
const inline = (text: string): string => plain(renderInline(text))
const line = (text: string): string => plain(renderLine(text))

/** Feeds everything at once and takes all finalized lines (colors stripped). */
const render = (source: string): string[] => {
  const md = new MarkdownStream()
  md.push(source)
  return [...md.drain(), ...md.end()].map(plain)
}

/** Feeds it in size-sized slices, simulating streaming. */
const stream = (source: string, size: number): string[] => {
  const md = new MarkdownStream()
  const out: string[] = []
  for (let i = 0; i < source.length; i += size) {
    md.push(source.slice(i, i + size))
    out.push(...md.drain())
  }
  out.push(...md.end())
  return out.map(plain)
}

describe("inline: emphasis", () => {
  test("bold / italic / strikethrough: the markers themselves disappear", () => {
    expect(inline("a **b** c")).toBe("a b c")
    expect(inline("a *b* c")).toBe("a b c")
    expect(inline("a ~~b~~ c")).toBe("a b c")
    expect(inline("a __b__ c")).toBe("a b c")
  })

  test("bold is actually rendered bold", () => {
    expect(renderInline("**b**")).toContain("\u001b[1m")
    expect(renderInline("*b*")).toContain("\u001b[3m")
  })

  test("nesting", () => {
    expect(inline("***both***")).toBe("both")
    expect(inline("**a *b* c**")).toBe("a b c")
  })

  test("★ snake_case is not italic — code is full of underscores", () => {
    expect(inline("snake_case_name")).toBe("snake_case_name")
    expect(inline("__dunder__")).toBe("dunder") // word-edge double underscores still count
    expect(inline("a_b_c d")).toBe("a_b_c d")
  })

  test("★ multiplication signs are not italic", () => {
    expect(inline("2 * 3 * 4")).toBe("2 * 3 * 4")
    expect(inline("a * b")).toBe("a * b")
  })

  test("unclosed markers stay as is and don't swallow what follows", () => {
    expect(inline("**未闭合的粗体")).toBe("**未闭合的粗体")
    expect(inline("看这个 *")).toBe("看这个 *")
  })

  test("backslash escapes", () => {
    expect(inline("\\*不是斜体\\*")).toBe("*不是斜体*")
    expect(inline("\\`不是代码\\`")).toBe("`不是代码`")
  })
})

describe("inline: code", () => {
  test("backticks disappear, content stays verbatim", () => {
    expect(inline("用 `foo(1, 2)` 调用")).toBe("用 foo(1, 2) 调用")
  })

  test("★ asterisks and underscores in code are literal", () => {
    expect(inline("`a * b` 和 `x_y_z`")).toBe("a * b 和 x_y_z")
    expect(inline("`**not bold**`")).toBe("**not bold**")
  })

  test("double backticks can wrap a single backtick", () => {
    expect(inline("`` ` ``")).toBe("`")
  })

  test("is colored", () => {
    expect(renderInline("`x`")).toBe(theme.code("x"))
    expect(renderInline("`x`")).toContain("\u001b[")
  })
})

describe("inline: links", () => {
  test("shows the title then the URL — terminal links aren't clickable, so the URL must be visible", () => {
    expect(inline("见 [文档](https://example.com)")).toBe("见 文档 (https://example.com)")
  })

  test("a title identical to the URL isn't shown twice", () => {
    expect(inline("[https://a.io](https://a.io)")).toBe("https://a.io")
  })

  test("bare and angle-bracket links", () => {
    expect(inline("去 https://a.io/x 看看")).toBe("去 https://a.io/x 看看")
    expect(renderInline("https://a.io")).toContain("\u001b[4m")
    expect(inline("<https://a.io>")).toBe("https://a.io")
  })

  test("images omit the URL — a terminal can't show them, and a long URL only takes up space", () => {
    expect(inline("![猫](https://a.io/cat.png)")).toBe("[image 猫]")
  })

  test("brackets that aren't links stay as is", () => {
    expect(inline("数组 [0] 和 [1]")).toBe("数组 [0] 和 [1]")
  })
})

describe("block: headings", () => {
  test("hash marks disappear", () => {
    expect(line("# 标题")).toBe("标题")
    expect(line("### 三级")).toBe("三级")
    expect(line("## 尾随井号 ##")).toBe("尾随井号")
  })

  test("★ a heading gets one blank line before it, never two", () => {
    expect(render("正文\n# 标题\n")).toEqual(["正文", "", "标题"])
    expect(render("正文\n\n# 标题\n")).toEqual(["正文", "", "标题"])
    expect(render("# 标题\n")).toEqual(["标题"])
  })

  test("a hash without a following space is not a heading", () => {
    expect(line("#hashtag")).toBe("#hashtag")
  })
})

describe("block: lists", () => {
  test("markers become bullets, different per nesting level", () => {
    expect(render("- a\n  - b\n    - c\n")).toEqual(["• a", "  ◦ b", "    ▪ c"])
  })

  test("ordered lists keep their numbers", () => {
    expect(render("1. a\n2. b\n")).toEqual(["1. a", "2. b"])
  })

  test("task lists", () => {
    expect(render("- [ ] 没做\n- [x] 做完\n")).toEqual(["☐ 没做", "☑ 做完"])
  })

  test("★ a paragraph starting with **bold** is not a list", () => {
    expect(line("**bold** text")).toBe("bold text")
  })

  test("inline formatting works inside list items", () => {
    expect(line("- 用 `x` 和 **y**")).toBe("• 用 x 和 y")
  })
})

describe("block: quotes / rules", () => {
  test("quotes become bars, one per nesting level", () => {
    expect(line("> 一层")).toBe("│ 一层")
    expect(line(">> 两层")).toBe("│ │ 两层")
  })

  test("horizontal rules", () => {
    expect(line("---")).toBe("─".repeat(24))
    expect(line("***")).toBe("─".repeat(24))
  })

  test("★ rules are checked before lists, or a spaced rule like - - - would be taken as a list item", () => {
    expect(line("- - -")).not.toContain("•")
    expect(line("- - -")).toBe("─".repeat(24))
    expect(line("* * *")).toBe("─".repeat(24))
  })
})

describe("block: code fences", () => {
  test("the language becomes a label, code lines get a left gutter", () => {
    expect(render("```py\nx = 1\n```\n")).toEqual(["  py", "  │ x = 1"])
  })

  test("★ markdown inside a fence is literal", () => {
    expect(render("```\n**not bold** and `not code`\n```\n")).toEqual(["  │ **not bold** and `not code`"])
  })

  test("★ blank lines inside a fence are kept — code relies on them for structure", () => {
    expect(render("```\na\n\nb\n```\n")).toEqual(["  │ a", "  │ ", "  │ b"])
  })

  test("tilde fences, and one fence kind can't close the other", () => {
    expect(render("~~~\na\n```\nb\n~~~\n")).toEqual(["  │ a", "  │ ```", "  │ b"])
  })

  test("relative indentation is kept, the opening fence's indentation is stripped", () => {
    expect(render("  ```\n  def f():\n      pass\n  ```\n")).toEqual(["  │ def f():", "  │     pass"])
  })

  test("★ an unclosed fence is still flushed at the end, its content not swallowed", () => {
    expect(render("```\nhalf")).toEqual(["  │ half"])
  })
})

describe("block: tables", () => {
  const TABLE = "| a | bbbb |\n|---|---|\n| 1 | 2 |\n"

  test("columns are aligned", () => {
    const rows = render(TABLE)
    expect(rows).toEqual(["  a │ bbbb", "  ──┼─────", "  1 │ 2"])
  })

  test("★ CJK characters count as two columns, or the whole table goes crooked", () => {
    const rows = render("| k | v |\n|---|---|\n| 中文 | x |\n| ab | y |\n")
    // "中文" is 4 columns, "ab" is 2 — after padding, the bars of both rows must land in
    // the same column
    const bars = rows.slice(2).map((row) => displayWidth(row.slice(0, row.indexOf("│"))))
    expect(bars[0]).toBe(bars[1])
    // and confirm the column width really counts as 4 columns, not 2 characters: left
    // margin 2 + column width 4 + separator space 1
    expect(bars[0]).toBe(7)
  })

  test("alignment markers: right-align pushes content to the right", () => {
    const rows = render("| num |\n|----:|\n| 1 |\n")
    expect(rows[2]).toBe("    1")
  })

  test("★ without a separator as the second row it's not a table, and the content shows normally", () => {
    expect(render("| 这句话里有竖线 |\n后面一句\n")).toEqual(["| 这句话里有竖线 |", "后面一句"])
  })

  test("★ a line not starting with a bar is not a table — so a sentence containing one isn't held back", () => {
    expect(render("a | b\n")).toEqual(["a | b"])
  })

  test("a table still open at the end is laid out and flushed", () => {
    const md = new MarkdownStream()
    md.push("| a |\n|---|\n| 1 |\n")
    expect(md.drain()).toEqual([]) // still held back, waiting for the next line
    expect(md.end().map(plain)).toEqual(["  a", "  ─", "  1"])
  })

  test("inline formatting works inside cells", () => {
    expect(render("| x |\n|---|\n| `c` |\n").map(plain)[2]).toBe("  c")
  })
})

describe("★ streaming: any split point gives the same result", () => {
  const SOURCE = [
    "# 标题",
    "",
    "一段 **粗体** 和 `代码`。",
    "",
    "- 列表 *斜体*",
    "- 第二条",
    "",
    "```ts",
    "const x = 1",
    "```",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "结尾",
  ].join("\n")

  const once = render(SOURCE)

  for (const size of [1, 2, 3, 5, 7, 13, 64]) {
    test(`${size} characters per chunk`, () => {
      expect(stream(SOURCE, size)).toEqual(once)
    })
  }

  test("a last line without a newline is still flushed", () => {
    expect(render("没有换行结尾")).toEqual(["没有换行结尾"])
  })
})

describe("★ preview: the not-yet-finalized part", () => {
  test("a partial line renders as a partial line; already closed formatting applies immediately", () => {
    const md = new MarkdownStream()
    md.push("这是 **粗")
    expect(plain(md.preview())).toBe("这是 **粗") // not closed yet, markers shown as is
    md.push("体** 了")
    expect(plain(md.preview())).toBe("这是 粗体 了")
    expect(md.preview()).toContain("\u001b[1m")
  })

  test("a completed line moves from preview to finalized", () => {
    const md = new MarkdownStream()
    md.push("- 一条")
    expect(md.drain()).toEqual([])
    expect(plain(md.preview())).toBe("• 一条")
    md.push("\n")
    expect(md.drain().map(plain)).toEqual(["• 一条"])
    expect(md.preview()).toBe("")
  })

  test("★ while a table is buffering, preview shows the raw text — otherwise it looks stuck", () => {
    const md = new MarkdownStream()
    md.push("| a | b |\n|---|---|\n| 1 |")
    expect(md.drain()).toEqual([])
    expect(plain(md.preview()).split("\n")).toEqual(["| a | b |", "|---|---|", "| 1 |"])
  })

  test("a partial line inside a fence has the left gutter", () => {
    const md = new MarkdownStream()
    md.push("```\nconst x")
    expect(plain(md.preview())).toBe("  │ const x")
  })

  test("idle is true only when nothing at all is pending", () => {
    const md = new MarkdownStream()
    expect(md.idle).toBe(true)
    md.push("a")
    expect(md.idle).toBe(false)
    md.end()
    expect(md.idle).toBe(true)
  })

  test("state resets after end, so the next segment doesn't inherit the previous fence", () => {
    const md = new MarkdownStream()
    md.push("```\ncode")
    md.end()
    md.push("普通一行\n")
    expect(md.drain().map(plain)).toEqual(["普通一行"])
  })
})

describe("misc", () => {
  test("consecutive blank lines collapse into one", () => {
    expect(render("a\n\n\n\nb\n")).toEqual(["a", "", "b"])
  })

  test("the \\r of \\r\\n is dropped — left in, it pulls the cursor back at line end", () => {
    expect(render("a\r\nb\r\n")).toEqual(["a", "b"])
  })

  test("empty input produces nothing", () => {
    expect(render("")).toEqual([])
  })
})
