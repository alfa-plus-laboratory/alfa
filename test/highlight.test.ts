/**
 * 语法高亮。
 *
 * 头一条比所有配色断言加起来都重要:**剥掉颜色必须逐字等于原文**。
 * 高亮吞掉或者多吐一个字符,右栏的截断、对话区的折行、合成器的差分就全错位 ——
 * 而那种错位看起来像是文件本身有问题,人会先去怀疑代码。所以这条拿整个仓库
 * 的源码跑。
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Highlighter, highlightLines, languageFor } from "../src/cli/highlight.ts"
import { colorEnabled, setColorEnabled } from "../src/cli/theme.ts"
import { displayWidth, stripAnsi } from "../src/cli/width.ts"
import { afterAll, beforeAll } from "bun:test"

const wasEnabled = colorEnabled()
beforeAll(() => setColorEnabled(true))
afterAll(() => setColorEnabled(wasEnabled))

const paint = (code: string, hint: string): string[] => highlightLines(code, hint)
const plain = (code: string, hint: string): string[] => paint(code, hint).map(stripAnsi)

/** 某个片段被涂成了哪种颜色(用 SGR 码判定,免得把整行都写死在断言里) */
const KEYWORD = "\u001b[35m"
const TYPE = "\u001b[34m"
const STRING = "\u001b[32m"
const NUMBER = "\u001b[33m"
const COMMENT = "\u001b[2m"
const CALL = "\u001b[36m"

const painted = (line: string, hint: string, sgr: string, fragment: string): boolean =>
  paint(line, hint)[0]!.includes(sgr + fragment)

// ───────────────────────────────────────────── 不变量

describe("★ 剥掉颜色 = 原文", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, out)
      else if (entry.name.endsWith(".ts")) out.push(path)
    }
    return out
  }

  test("拿整个 src/ 跑一遍", () => {
    // 相对路径会跟着 cwd 漂,测试必须自己定位仓库
    const files = walk(fileURLToPath(new URL("../src", import.meta.url)))
    expect(files.length).toBeGreaterThan(20)
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      const rows = text.split("\n")
      const out = highlightLines(text, file)
      expect(out.length).toBe(rows.length)
      for (let i = 0; i < rows.length; i++) {
        if (stripAnsi(out[i]!) !== rows[i]) throw new Error(`${file}:${i + 1} 内容被改了`)
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
    test(`各语言样本:${name}`, () => {
      expect(plain(code, name).join("\n")).toBe(code)
    })
  }

  test("★ 显示宽度一个字都不能变(中日韩、emoji)", () => {
    const line = 'const 名字 = "中文字符串 😀" // 注释'
    const out = paint(line, "a.ts")[0]!
    expect(displayWidth(out)).toBe(displayWidth(line))
  })

  test("没有闭合的字符串 / 注释也不能吞内容", () => {
    expect(plain('const s = "unterminated', "a.ts")).toEqual(['const s = "unterminated'])
    expect(plain("/* never closed", "a.ts")).toEqual(["/* never closed"])
  })
})

// ───────────────────────────────────────────── 认语言

describe("认语言", () => {
  test("按扩展名", () => {
    expect(languageFor("src/cli/main.ts")?.id).toBe("ts")
    expect(languageFor("/abs/path/thing.py")?.id).toBe("py")
    expect(languageFor("a.tsx")?.id).toBe("ts")
    expect(languageFor("a.yml")?.id).toBe("yaml")
  })

  test("按围栏标签,大小写和别名都认", () => {
    expect(languageFor("python")?.id).toBe("py")
    expect(languageFor("TypeScript")?.id).toBe("ts")
    expect(languageFor("Bash")?.id).toBe("sh")
  })

  test("围栏标签后面带参数也认", () => {
    expect(languageFor("python title=x")?.id).toBe("py")
  })

  test("★ 认不出来就不上色 —— 猜错语言比没颜色更糟", () => {
    expect(languageFor("brainfuck")).toBeUndefined()
    expect(languageFor("")).toBeUndefined()
    expect(languageFor("a.unknownext")).toBeUndefined()
    expect(plain("这不是代码 ** ##", "a.unknownext")).toEqual(["这不是代码 ** ##"])
    expect(paint("const x = 1", "a.unknownext")[0]).toBe("const x = 1")
  })

  test("没有扩展名的常见文件", () => {
    expect(languageFor("Dockerfile")?.id).toBe("sh")
    expect(languageFor(".bashrc")?.id).toBe("sh")
  })
})

// ───────────────────────────────────────────── 词法

describe("注释", () => {
  test("行注释吃到行尾,里面的关键字不再上色", () => {
    const out = paint("// const if return", "a.ts")[0]!
    expect(out).toContain(COMMENT)
    expect(out).not.toContain(KEYWORD)
  })

  test("★ 块注释跨行 —— 状态要接到下一行", () => {
    const out = paint("/* a\nconst b\n*/ const c", "a.ts")
    expect(out[1]).toContain(COMMENT)
    expect(out[1]).not.toContain(KEYWORD)
    // 第三行收口之后又是代码了
    expect(out[2]).toContain(KEYWORD + "const")
  })

  test("字符串里的 // 不是注释", () => {
    const out = paint('const u = "http://x" // real', "a.ts")[0]!
    expect(out).toContain(STRING + '"http://x"')
  })

  test("SQL 的 -- 是注释", () => {
    expect(painted("SELECT 1 -- note", "a.sql", COMMENT, "-- note")).toBe(true)
  })
})

describe("字符串", () => {
  test("三种引号", () => {
    expect(painted('a = "x"', "a.ts", STRING, '"x"')).toBe(true)
    expect(painted("a = 'x'", "a.ts", STRING, "'x'")).toBe(true)
    expect(painted("a = `x`", "a.ts", STRING, "`x`")).toBe(true)
  })

  test("★ 转义要成对数:\\\\ 之后的引号是真收尾", () => {
    const out = paint('const a = "x\\\\"; const b = 1', "a.ts")[0]!
    // 收尾判错的话 `const b` 会被当成字符串的一部分,关键字就不见了
    expect(out).toContain(KEYWORD + "const")
    expect(out.split(KEYWORD + "const").length - 1).toBe(2)
  })

  test("★ python 三引号跨行", () => {
    const out = paint('x = """a\nb\n"""\ny = 1', "a.py")
    expect(out[1]).toContain(STRING)
    expect(out[3]).toContain(NUMBER + "1")
  })

  test("★ go 的反引号原始串跨行", () => {
    const out = paint("s := `a\nb`\nn := 1", "a.go")
    expect(out[1]).toContain(STRING)
    expect(out[2]).toContain(NUMBER + "1")
  })

  test("★ 三引号要排在单引号前面试,否则永远匹配不到", () => {
    // 匹配成 "" + "a..." 的话,这一行的收尾判定会完全错位
    expect(plain('"""a"""', "a.py")).toEqual(['"""a"""'])
    expect(painted('"""a"""', "a.py", STRING, '"""a"""')).toBe(true)
  })
})

describe("数字 / 标识符", () => {
  test("十六进制、小数、指数", () => {
    expect(painted("a = 0xFF", "a.ts", NUMBER, "0xFF")).toBe(true)
    expect(painted("a = 3.14", "a.ts", NUMBER, "3.14")).toBe(true)
    expect(painted("a = 1e-9", "a.ts", NUMBER, "1e-9")).toBe(true)
  })

  test("★ 标识符里的数字不是数字字面量", () => {
    const out = paint("const utf8 = base64", "a.ts")[0]!
    expect(out).not.toContain(NUMBER)
  })

  test("关键字 / 类型 / 字面量 / 函数调用各有各的颜色", () => {
    expect(painted("return x", "a.ts", KEYWORD, "return")).toBe(true)
    expect(painted("let a: string", "a.ts", TYPE, "string")).toBe(true)
    expect(painted("a = true", "a.ts", NUMBER, "true")).toBe(true) // literal 和 number 同色
    expect(painted("doThing(1)", "a.ts", CALL, "doThing")).toBe(true)
  })

  test("函数名只在后面紧跟括号时才算", () => {
    expect(paint("doThing", "a.ts")[0]).toBe("doThing")
  })
})

describe("各语言的小规矩", () => {
  test("SQL 关键字不分大小写", () => {
    expect(painted("select 1", "a.sql", KEYWORD, "select")).toBe(true)
    expect(painted("SELECT 1", "a.sql", KEYWORD, "SELECT")).toBe(true)
  })

  test("★ JSON 的键和值要分得开 —— 不然整份配置一片绿", () => {
    const out = paint('{"k": "v"}', "a.json")[0]!
    expect(out).toContain(TYPE + '"k"')
    expect(out).toContain(STRING + '"v"')
  })

  test("shell 的变量", () => {
    expect(painted("echo $HOME", "a.sh", TYPE, "$HOME")).toBe(true)
    expect(painted("echo ${X:-y}", "a.sh", TYPE, "${X:-y}")).toBe(true)
  })

  test("HTML 标签", () => {
    expect(painted("<div>", "a.html", KEYWORD, "<div")).toBe(true)
  })

  test("装饰器 / 预处理指令", () => {
    expect(painted("@decorator", "a.py", COMMENT, "@decorator")).toBe(true)
    expect(painted("#include <stdio.h>", "a.c", COMMENT, "#include")).toBe(true)
  })
})

// ───────────────────────────────────────────── 流式

describe("★ 逐行喂 + peek", () => {
  test("peek 不推进状态 —— 半行每帧都要重画一遍", () => {
    const h = new Highlighter(languageFor("ts"))
    h.line("const a = 1")
    // 一个没收口的块注释:peek 十次也不能让状态陷进注释里
    for (let i = 0; i < 10; i++) expect(h.peek("/* half")).toContain(COMMENT)
    expect(h.line("const b = 2")).toContain(KEYWORD + "const")
  })

  test("line 会推进状态", () => {
    const h = new Highlighter(languageFor("ts"))
    h.line("/* open")
    const next = h.line("const b = 2")
    expect(next).toContain(COMMENT)
    expect(next).not.toContain(KEYWORD)
  })

  test("认不出语言时是个直通管道", () => {
    const h = new Highlighter(undefined)
    expect(h.active).toBe(false)
    expect(h.line("const x = 1")).toBe("const x = 1")
  })
})
