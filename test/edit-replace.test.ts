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

describe("前置校验", () => {
  test("identical 检查必须早于 empty 检查", () => {
    // 两条都满足时,报的必须是 identical —— 顺序反了模型会收到误导性提示
    expect(() => replace("x", "", "")).toThrow(ERR_IDENTICAL)
  })

  test("空 oldString 报 empty", () => {
    expect(() => replace("x", "", "y")).toThrow(ERR_EMPTY_OLD)
  })

  // ⚠ 这条守的是**级联自己产出的空候选**,不是用户传空 —— 上面那条已经管了后者。
  //    LineTrimmedReplacer 拿 "\t" 逐行 trim 比对时,空行的 "".trim() 和它相等,
  //    于是每个空行都"匹配",交出来的候选是 ""。而 "".indexOf 恒为 0、
  //    replaceAll("", x) 会在每两个字符之间插一份 x。
  //    一度的真实表现:整个文件被打散,还回一句 "Replacements: 18"。
  test("★ 空白 oldString + replaceAll 必须报 not found,不许把文件打散", () => {
    const file = "line one\n\nline two\n"
    expect(() => replace(file, "\t", "  ", true)).toThrow(ERR_NOT_FOUND)
    expect(() => replace(file, " ", "  ", true)).not.toThrow() // 真有空格,照旧能替
  })

  test("★ 文件里真的有 tab 时,替换照常工作", () => {
    const file = "\tindented\n"
    expect(replace(file, "\t", "  ", true).content).toBe("  indented\n")
  })
})

describe("第 1 级 SimpleReplacer", () => {
  test("精确唯一匹配", () => {
    const r = replace("const a = 1\nconst b = 2\n", "const a = 1", "const a = 42")
    expect(r.content).toBe("const a = 42\nconst b = 2\n")
    expect(r.replacerIndex).toBe(0)
    expect(r.replacements).toBe(1)
  })

  test("精确但不唯一 → 落到 multiple(不是 not found)", () => {
    expect(() => replace("dup\ndup\n", "dup", "x")).toThrow(ERR_MULTIPLE)
  })

  test("replaceAll 跳过唯一性检查", () => {
    const r = replace("dup\ndup\n", "dup", "x", true)
    expect(r.content).toBe("x\nx\n")
    expect(r.replacements).toBe(2)
  })

  test("完全找不到 → not found", () => {
    expect(() => replace("abc", "zzz", "y")).toThrow(ERR_NOT_FOUND)
  })
})

describe("第 2 级 LineTrimmedReplacer", () => {
  test("多行块的缩进量对不上时命中,替换的是原文那段", () => {
    const content = "function f() {\n    const a = 1\n    return a\n}\n"
    // 模型给的是 2 空格缩进,文件里是 4 空格 —— 逐字不匹配
    const find = "  const a = 1\n  return a"
    const r = replace(content, find, "    return 1")
    expect(r.content).toBe("function f() {\n    return 1\n}\n")
    expect(r.replacerIndex).toBe(1)
  })

  test("单行:精确匹配存在时第 1 级先赢,原文空白被保留", () => {
    // 这是刻意验证短路顺序 —— "hello" 逐字存在,轮不到第 2 级
    const content = "a\n  hello   \nb\n"
    const r = replace(content, "hello", "world")
    expect(r.content).toBe("a\n  world   \nb\n")
    expect(r.replacerIndex).toBe(0)
  })

  test("notFound 是粘性的:定位到过但都不唯一 → multiple", () => {
    // 逐字 "  x" 存在两处 → 第 1 级就落到 multiple,不是 not found
    const content = "  x  \n  x  \n"
    expect(() => replace(content, "x", "y")).toThrow(ERR_MULTIPLE)
  })

  test("跨级粘性:第 1 级完全不命中、后续级别命中多处 → multiple 而非 not found", () => {
    // find 带首尾空格,在原文里逐字不存在(原文是 tab 缩进);
    // trim 后两行都匹配 → notFound 被置 false → 最终必须报 multiple
    const content = "\tfoo()\n\tfoo()\n"
    expect(() => replace(content, "  foo()  ", "bar()")).toThrow(ERR_MULTIPLE)
  })
})

describe("第 3 级 BlockAnchorReplacer", () => {
  test("首尾行当锚,中间行凭印象重写也能命中", () => {
    const content = ["function calc(a, b) {", "  const sum = a + b", "  return sum", "}", ""].join("\n")
    // 中间两行模型写得不一样,但首尾锚对得上、行数也对得上
    const find = ["function calc(a, b) {", "  const total = a + b", "  return total", "}"].join("\n")
    const r = replace(content, find, "function calc(a, b) {\n  return a + b\n}")
    expect(r.content).toBe("function calc(a, b) {\n  return a + b\n}\n")
    expect(r.replacerIndex).toBe(2)
  })

  test("少于 3 行不进这一级", () => {
    expect(() => replace("aaa\nbbb\n", "aaa\nzzz\n", "q")).toThrow(ERR_NOT_FOUND)
  })
})

describe("第 4 级 WhitespaceNormalizedReplacer", () => {
  test("行内空白被规整时仍能命中", () => {
    const content = "call(  a,   b )\nother()\n"
    // 模型把行内多余空格压掉了 —— 前三级都对不上
    const r = replace(content, "call( a, b )", "call(a, b)")
    expect(r.content).toBe("call(a, b)\nother()\n")
    expect(r.replacerIndex).toBe(3)
  })
})

describe("第 5 级 TrimmedBoundaryReplacer", () => {
  test("多行 find 前后各带空行 —— 这是第 4 级够不着的盲区", () => {
    // 第 4 级把 \n 也折叠成空格,多行 find 归一成单行后与任何窗口都对不上;
    // 只有保留内部换行结构的第 5 级能命中
    const content = "foo\nbar\n"
    const r = replace(content, "\n\nfoo\nbar\n\n", "baz")
    expect(r.content).toBe("baz\n")
    expect(r.replacerIndex).toBe(4)
  })
})

describe("isDisproportionateMatch 防误删", () => {
  test("行数膨胀命中", () => {
    expect(isDisproportionateMatch("a\nb\nc\nd\ne\nf", "a\nb")).toBe(true)
  })

  test("单行 oldString 不走字符数判据", () => {
    expect(isDisproportionateMatch("x".repeat(5000), "y")).toBe(false)
  })

  test("多行字符数膨胀命中", () => {
    const old = "aa\nbb"
    const search = "aa\n" + "z".repeat(2000)
    expect(isDisproportionateMatch(search, old)).toBe(true)
  })

  test("首尾锚之间夹一大坨时,BlockAnchor 的 maxLineDelta 先把它挡住", () => {
    // 这条守的是「不能静默删掉几十行」这个结果,而不是某个具体函数被调用。
    // 当前级联下拦截发生在候选收集阶段(行数差 > 25%),压根到不了
    // isDisproportionateMatch —— 所以这里断言的是 not found,不是 disproportionate。
    // 将来加了 ContextAware 之类的松级别,这条应该改成断言 ERR_DISPROPORTIONATE。
    const body = Array.from({ length: 40 }, (_, i) => `  line${i}`).join("\n")
    const content = `{\n${body}\n}\n`
    const find = "{\n  lineA\n}"
    expect(() => replace(content, find, "{}")).toThrow(ERR_NOT_FOUND)
    expect(ERR_DISPROPORTIONATE).toContain("Refusing replacement")
  })
})

describe("行尾与 BOM", () => {
  test("检测文件级行尾", () => {
    expect(detectLineEnding("a\r\nb\n")).toBe("\r\n")
    expect(detectLineEnding("a\nb\n")).toBe("\n")
  })

  test("CRLF 文件替换后仍是纯 CRLF", () => {
    const original = "const a = 1\r\nconst b = 2\r\n"
    const ending = detectLineEnding(original)
    const lf = normalizeLineEndings(original)
    const replaced = replace(lf, "const a = 1", "const a = 42").content
    const out = convertToLineEnding(replaced, ending)
    expect(out).toBe("const a = 42\r\nconst b = 2\r\n")
    expect(out.includes("\n\r")).toBe(false)
    expect(out.split("\r\n").length - 1).toBe(2)
  })

  test("BOM 往返不丢", () => {
    const withBom = "﻿hello"
    const split = bomSplit(withBom)
    expect(split.bom).toBe("﻿")
    expect(split.text).toBe("hello")
    expect(bomJoin(split.text, split.bom)).toBe(withBom)
  })

  test("bomJoin 不重复加 BOM", () => {
    expect(bomJoin("﻿x", "﻿")).toBe("﻿x")
  })

  // ⚠ 守的是「edit 会整份写回」这件事。宽松解码把不合法字节变成 U+FFFD,
  //    写回时那些原字节就永久没了 —— 而且被毁的往往是 edit 没碰的那一行,
  //    审批 diff 又是从已解码文本算的,所以在批准界面上根本看不见。
  test("★ 非 UTF-8 文件:严格解码必须拒绝,不能悄悄变成 U+FFFD", () => {
    // "// caf<0xe9>\nconst a = 1\n" —— Latin-1 的 é
    const latin1 = new Uint8Array([
      0x2f, 0x2f, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a,
      0x63, 0x6f, 0x6e, 0x73, 0x74, 0x20, 0x61, 0x20, 0x3d, 0x20, 0x31, 0x0a,
    ])
    expect(() => decodeWithBomStrict(latin1, "legacy.ts")).toThrow(/not valid UTF-8/)
    // 宽松那个照旧宽松 —— write 只拿它算 diff 预览,不回写没读懂的东西
    expect(decodeWithBom(latin1).text).toContain("\uFFFD")
  })

  test("严格解码不影响正常文件,BOM 照旧认得出来", () => {
    const utf8 = new TextEncoder().encode("// café\nconst a = 1\n")
    expect(decodeWithBomStrict(utf8, "x.ts").text).toBe("// café\nconst a = 1\n")
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("hello")])
    expect(decodeWithBomStrict(withBom, "x.ts")).toEqual({ bom: "\uFEFF", text: "hello" })
  })
})
