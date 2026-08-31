/**
 * Markdown 渲染。
 *
 * 断言一律在**剥掉颜色之后**做,除非这条测的就是颜色本身 —— 否则改一次配色
 * 就要重写半个文件,而配色是最可能被调的东西。
 *
 * 最要紧的两组:
 *   - 「不该被当成格式的东西」。snake_case、2 * 3、diff 里的减号 —— 误判比
 *     不渲染难受得多,因为用户会以为内容本身变了。
 *   - 「切在任意位置都得出同一个结果」。文本是一个 token 一个 token 来的,
 *     切点落在 ` ** ` 中间、围栏中间、表格中间都是常事。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { MarkdownStream, renderInline, renderLine } from "../src/cli/markdown.ts"
import { colorEnabled, setColorEnabled } from "../src/cli/theme.ts"
import { displayWidth, stripAnsi } from "../src/cli/width.ts"

// 测试进程不是 TTY,颜色默认是关的。这里强行打开才能断言配色 —— 但那是个
// 全局开关,跑完必须还回去,否则测试文件之间会按执行顺序互相影响
const wasEnabled = colorEnabled()
beforeAll(() => setColorEnabled(true))
afterAll(() => setColorEnabled(wasEnabled))

const plain = (text: string): string => stripAnsi(text)
const inline = (text: string): string => plain(renderInline(text))
const line = (text: string): string => plain(renderLine(text))

/** 一次性喂完,取所有定稿行(已剥色)。 */
const render = (source: string): string[] => {
  const md = new MarkdownStream()
  md.push(source)
  return [...md.drain(), ...md.end()].map(plain)
}

/** 按 size 一片一片喂,模拟流式。 */
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

describe("行内:强调", () => {
  test("粗体 / 斜体 / 删除线,标记本身要消失", () => {
    expect(inline("a **b** c")).toBe("a b c")
    expect(inline("a *b* c")).toBe("a b c")
    expect(inline("a ~~b~~ c")).toBe("a b c")
    expect(inline("a __b__ c")).toBe("a b c")
  })

  test("粗体真的加了粗", () => {
    expect(renderInline("**b**")).toContain("\u001b[1m")
    expect(renderInline("*b*")).toContain("\u001b[3m")
  })

  test("嵌套", () => {
    expect(inline("***both***")).toBe("both")
    expect(inline("**a *b* c**")).toBe("a b c")
  })

  test("★ snake_case 不是斜体 —— 代码里到处都是下划线", () => {
    expect(inline("snake_case_name")).toBe("snake_case_name")
    expect(inline("__dunder__")).toBe("dunder") // 词首词尾的双下划线仍然算
    expect(inline("a_b_c d")).toBe("a_b_c d")
  })

  test("★ 乘号不是斜体", () => {
    expect(inline("2 * 3 * 4")).toBe("2 * 3 * 4")
    expect(inline("a * b")).toBe("a * b")
  })

  test("没有闭合的标记原样留着,不吞后面的内容", () => {
    expect(inline("**未闭合的粗体")).toBe("**未闭合的粗体")
    expect(inline("看这个 *")).toBe("看这个 *")
  })

  test("反斜杠转义", () => {
    expect(inline("\\*不是斜体\\*")).toBe("*不是斜体*")
    expect(inline("\\`不是代码\\`")).toBe("`不是代码`")
  })
})

describe("行内:代码", () => {
  test("反引号消失,内容原样", () => {
    expect(inline("用 `foo(1, 2)` 调用")).toBe("用 foo(1, 2) 调用")
  })

  test("★ 代码里的星号和下划线是字面量", () => {
    expect(inline("`a * b` 和 `x_y_z`")).toBe("a * b 和 x_y_z")
    expect(inline("`**not bold**`")).toBe("**not bold**")
  })

  test("双反引号能包住单反引号", () => {
    expect(inline("`` ` ``")).toBe("`")
  })

  test("上色了", () => {
    expect(renderInline("`x`")).toContain("\u001b[33m")
  })
})

describe("行内:链接", () => {
  test("显示标题,地址跟在后面 —— 终端里点不动,地址必须看得见", () => {
    expect(inline("见 [文档](https://example.com)")).toBe("见 文档 (https://example.com)")
  })

  test("标题和地址相同就不说两遍", () => {
    expect(inline("[https://a.io](https://a.io)")).toBe("https://a.io")
  })

  test("裸链接和尖括号链接", () => {
    expect(inline("去 https://a.io/x 看看")).toBe("去 https://a.io/x 看看")
    expect(renderInline("https://a.io")).toContain("\u001b[4m")
    expect(inline("<https://a.io>")).toBe("https://a.io")
  })

  test("图片不显示地址 —— 终端里放不出来,一长串 URL 纯占地方", () => {
    expect(inline("![猫](https://a.io/cat.png)")).toBe("[image 猫]")
  })

  test("不是链接的方括号原样留着", () => {
    expect(inline("数组 [0] 和 [1]")).toBe("数组 [0] 和 [1]")
  })
})

describe("块:标题", () => {
  test("井号消失", () => {
    expect(line("# 标题")).toBe("标题")
    expect(line("### 三级")).toBe("三级")
    expect(line("## 尾随井号 ##")).toBe("尾随井号")
  })

  test("★ 标题前自动空一行,但不空两行", () => {
    expect(render("正文\n# 标题\n")).toEqual(["正文", "", "标题"])
    expect(render("正文\n\n# 标题\n")).toEqual(["正文", "", "标题"])
    expect(render("# 标题\n")).toEqual(["标题"])
  })

  test("没有空格的井号不是标题", () => {
    expect(line("#hashtag")).toBe("#hashtag")
  })
})

describe("块:列表", () => {
  test("符号换成圆点,层级不同符号不同", () => {
    expect(render("- a\n  - b\n    - c\n")).toEqual(["• a", "  ◦ b", "    ▪ c"])
  })

  test("有序列表保留序号", () => {
    expect(render("1. a\n2. b\n")).toEqual(["1. a", "2. b"])
  })

  test("任务列表", () => {
    expect(render("- [ ] 没做\n- [x] 做完\n")).toEqual(["☐ 没做", "☑ 做完"])
  })

  test("★ **粗体** 开头的段落不是列表", () => {
    expect(line("**bold** text")).toBe("bold text")
  })

  test("列表项里的行内格式照常", () => {
    expect(line("- 用 `x` 和 **y**")).toBe("• 用 x 和 y")
  })
})

describe("块:引用 / 分隔线", () => {
  test("引用换成竖线,嵌套按层数", () => {
    expect(line("> 一层")).toBe("│ 一层")
    expect(line(">> 两层")).toBe("│ │ 两层")
  })

  test("分隔线", () => {
    expect(line("---")).toBe("─".repeat(24))
    expect(line("***")).toBe("─".repeat(24))
  })

  test("★ 分隔线要排在列表前面判断,不然 --- 会被当成列表项", () => {
    expect(line("- - -")).not.toContain("•")
  })
})

describe("块:代码围栏", () => {
  test("语言当标签,代码行加左槽", () => {
    expect(render("```py\nx = 1\n```\n")).toEqual(["  py", "  │ x = 1"])
  })

  test("★ 围栏里的 markdown 是字面量", () => {
    expect(render("```\n**not bold** and `not code`\n```\n")).toEqual(["  │ **not bold** and `not code`"])
  })

  test("★ 围栏里的空行要留着 —— 代码的分段全靠它", () => {
    expect(render("```\na\n\nb\n```\n")).toEqual(["  │ a", "  │ ", "  │ b"])
  })

  test("波浪号围栏,以及不同种类的围栏关不掉对方", () => {
    expect(render("~~~\na\n```\nb\n~~~\n")).toEqual(["  │ a", "  │ ```", "  │ b"])
  })

  test("相对缩进留着,开围栏那层缩进剥掉", () => {
    expect(render("  ```\n  def f():\n      pass\n  ```\n")).toEqual(["  │ def f():", "  │     pass"])
  })

  test("★ 没关的围栏在收尾时照样吐出来,不能把内容吞掉", () => {
    expect(render("```\nhalf")).toEqual(["  │ half"])
  })
})

describe("块:表格", () => {
  const TABLE = "| a | bbbb |\n|---|---|\n| 1 | 2 |\n"

  test("列对齐了", () => {
    const rows = render(TABLE)
    expect(rows).toEqual(["  a │ bbbb", "  ──┼─────", "  1 │ 2"])
  })

  test("★ 中日韩字符按两列算,不然整张表歪掉", () => {
    const rows = render("| k | v |\n|---|---|\n| 中文 | x |\n| ab | y |\n")
    // "中文" 4 列、"ab" 2 列 —— 补空格之后两行的竖线要落在同一列
    const bars = rows.slice(2).map((row) => displayWidth(row.slice(0, row.indexOf("│"))))
    expect(bars[0]).toBe(bars[1])
    // 顺带确认列宽真按 4 列算,而不是按 2 个字符:左边距 2 + 列宽 4 + 分隔空格 1
    expect(bars[0]).toBe(7)
  })

  test("对齐记号:右对齐把内容推到右边", () => {
    const rows = render("| num |\n|----:|\n| 1 |\n")
    expect(rows[2]).toBe("    1")
  })

  test("★ 第二行不是分隔行就不是表格,内容照常显示", () => {
    expect(render("| 这句话里有竖线 |\n后面一句\n")).toEqual(["| 这句话里有竖线 |", "后面一句"])
  })

  test("★ 不以竖线开头的行不算表格 —— 免得一句带竖线的话被攒住不显示", () => {
    expect(render("a | b\n")).toEqual(["a | b"])
  })

  test("表格没结束就收尾,也要排版吐出来", () => {
    const md = new MarkdownStream()
    md.push("| a |\n|---|\n| 1 |\n")
    expect(md.drain()).toEqual([]) // 还攒着,等下一行
    expect(md.end().map(plain)).toEqual(["  a", "  ─", "  1"])
  })

  test("单元格里的行内格式照常", () => {
    expect(render("| x |\n|---|\n| `c` |\n").map(plain)[2]).toBe("  c")
  })
})

describe("★ 流式:切在哪儿都得出同一个结果", () => {
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
    test(`每片 ${size} 个字符`, () => {
      expect(stream(SOURCE, size)).toEqual(once)
    })
  }

  test("最后一行没有换行也要吐出来", () => {
    expect(render("没有换行结尾")).toEqual(["没有换行结尾"])
  })
})

describe("★ 预览:没定稿的那部分", () => {
  test("半行就按半行渲染,已经闭合的格式立刻生效", () => {
    const md = new MarkdownStream()
    md.push("这是 **粗")
    expect(plain(md.preview())).toBe("这是 **粗") // 还没闭合,标记原样
    md.push("体** 了")
    expect(plain(md.preview())).toBe("这是 粗体 了")
    expect(md.preview()).toContain("\u001b[1m")
  })

  test("整行凑齐之后从预览挪进定稿", () => {
    const md = new MarkdownStream()
    md.push("- 一条")
    expect(md.drain()).toEqual([])
    expect(plain(md.preview())).toBe("• 一条")
    md.push("\n")
    expect(md.drain().map(plain)).toEqual(["• 一条"])
    expect(md.preview()).toBe("")
  })

  test("★ 攒表格的时候预览要显示原文 —— 不然用户以为卡住了", () => {
    const md = new MarkdownStream()
    md.push("| a | b |\n|---|---|\n| 1 |")
    expect(md.drain()).toEqual([])
    expect(plain(md.preview()).split("\n")).toEqual(["| a | b |", "|---|---|", "| 1 |"])
  })

  test("围栏里的半行带左槽", () => {
    const md = new MarkdownStream()
    md.push("```\nconst x")
    expect(plain(md.preview())).toBe("  │ const x")
  })

  test("idle 只在手上真的什么都没有时为真", () => {
    const md = new MarkdownStream()
    expect(md.idle).toBe(true)
    md.push("a")
    expect(md.idle).toBe(false)
    md.end()
    expect(md.idle).toBe(true)
  })

  test("end 之后状态复位,下一段不会继承上一段的围栏", () => {
    const md = new MarkdownStream()
    md.push("```\ncode")
    md.end()
    md.push("普通一行\n")
    expect(md.drain().map(plain)).toEqual(["普通一行"])
  })
})

describe("杂项", () => {
  test("连着的空行压成一条", () => {
    expect(render("a\n\n\n\nb\n")).toEqual(["a", "", "b"])
  })

  test("\\r\\n 的 \\r 要去掉 —— 留着会在行尾把光标拉回去", () => {
    expect(render("a\r\nb\r\n")).toEqual(["a", "b"])
  })

  test("空输入什么都不产生", () => {
    expect(render("")).toEqual([])
  })
})
