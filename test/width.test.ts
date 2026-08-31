/**
 * 显示宽度。
 *
 * 这里每一条错了都不是"看着别扭",而是底部活动区的行数算错 → 擦除时往上退错
 * 行数 → 界面开始往上啃已经打出去的输出。所以断言写得很死。
 *
 * ESC 用 String.fromCharCode(27) 造,不在源码里放裸控制字符(裸的在 diff 和
 * grep 里是隐形的,这个仓库栽过一次)。
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
  test("ASCII 是 1", () => {
    expect(charWidth("a")).toBe(1)
    expect(charWidth(" ")).toBe(1)
  })

  test("★ 中日韩是 2", () => {
    for (const char of ["中", "文", "日", "本", "한", "あ", "ア"]) {
      expect(charWidth(char)).toBe(2)
    }
  })

  test("全角标点是 2,半角标点是 1", () => {
    expect(charWidth("，")).toBe(2)
    expect(charWidth("。")).toBe(2)
    expect(charWidth(",")).toBe(1)
  })

  test("emoji 是 2", () => {
    expect(charWidth("😀")).toBe(2)
    expect(charWidth("🚀")).toBe(2)
  })

  test("组合记号和零宽字符是 0", () => {
    // 这些字符在编辑器里是隐形的,用码位写出来才看得清在测什么
    expect(charWidth(String.fromCharCode(0x0301))).toBe(0) // 组合锐音符
    expect(charWidth(String.fromCharCode(0x200b))).toBe(0) // 零宽空格
    expect(charWidth(String.fromCharCode(0x200d))).toBe(0) // ZWJ
    expect(charWidth(String.fromCharCode(0xfe0f))).toBe(0) // 变体选择符
  })

  test("控制字符是 0", () => {
    expect(charWidth(String.fromCharCode(7))).toBe(0)
    expect(charWidth(ESC)).toBe(0)
  })

  test("箭头和框线字符是 1 —— 输入框全靠它们对齐", () => {
    for (const char of ["›", "╭", "─", "╮", "│", "╰", "╯", "⠹"]) {
      expect(charWidth(char)).toBe(1)
    }
  })
})

describe("displayWidth", () => {
  test("★ 转义序列不占宽度", () => {
    expect(displayWidth(`${RED}abc${RESET}`)).toBe(3)
    expect(stripAnsi(`${RED}abc${RESET}`)).toBe("abc")
  })

  test("中英混排", () => {
    expect(displayWidth("你好 world")).toBe(4 + 1 + 5)
  })

  test("组合字符按一个算", () => {
    expect(displayWidth("e" + String.fromCharCode(0x0301))).toBe(1)
  })

  test("★ ZWJ 序列宁可偏大 —— 偏小会溢出把界面搞烂", () => {
    // 会连字的终端显示成一个 2 列的字形,不会的显示成三个。这里按不连字算。
    const zwj = String.fromCharCode(0x200d)
    expect(displayWidth(["\u{1F468}", "\u{1F469}", "\u{1F467}"].join(zwj))).toBe(6)
  })
})

describe("wrapToWidth", () => {
  test("按显示宽度折,不是按字符数", () => {
    expect(wrapToWidth("中中中", 4)).toEqual(["中中", "中"])
  })

  test("★ 双宽字符不劈开,塞不下就整个推到下一行", () => {
    // 宽度 3 放不下第二个「中」,那一行只能留 2 列,最后一列空着 ——
    // 终端遇到同样的情况也是这么干的
    expect(wrapToWidth("中中", 3)).toEqual(["中", "中"])
  })

  test("显式换行照断", () => {
    expect(wrapToWidth("ab\ncd", 10)).toEqual(["ab", "cd"])
  })

  test("刚好放满不多折一行", () => {
    expect(wrapToWidth("abcd", 4)).toEqual(["abcd"])
  })

  test("★ 颜色要续行:行尾 reset,新行开头重放", () => {
    const lines = wrapToWidth(`${RED}abcd`, 2)
    expect(lines.length).toBe(2)
    expect(lines[0]).toBe(`${RED}ab${RESET}`)
    expect(lines[1]).toBe(`${RED}cd${RESET}`)
  })

  test("reset 之后不再续色", () => {
    const lines = wrapToWidth(`${RED}ab${RESET}cd`, 2)
    expect(lines[1]).toBe("cd")
  })

  test("每一行的显示宽度都不超上限", () => {
    const text = "你好世界 hello 世界你好 abcdefghij"
    for (const line of wrapToWidth(text, 7)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(7)
    }
  })

  test("宽度非法时原样返回,不死循环", () => {
    expect(wrapToWidth("abc", 0)).toEqual(["abc"])
  })
})

describe("padToWidth / truncateToWidth", () => {
  test("★ 补空格按显示宽度算,不是 length", () => {
    expect(padToWidth("中", 4)).toBe("中  ")
    expect(displayWidth(padToWidth("中文", 10))).toBe(10)
  })

  test("已经够宽就不动", () => {
    expect(padToWidth("abcd", 2)).toBe("abcd")
  })

  test("截断时省略号也算进预算", () => {
    const out = truncateToWidth("abcdefgh", 5)
    expect(displayWidth(out)).toBe(5)
    expect(out.endsWith("…")).toBe(true)
  })

  test("★ 截中文不会截出半个字", () => {
    const out = truncateToWidth("中文中文中文", 5)
    expect(displayWidth(out)).toBeLessThanOrEqual(5)
    expect(out).toBe("中文…")
  })

  test("放得下就原样", () => {
    expect(truncateToWidth("abc", 10)).toBe("abc")
  })

  test("★ 截断要保住颜色 —— 右栏里代码行放不下才是常态", () => {
    const out = truncateToWidth("\u001b[31mabcdefgh\u001b[39m", 5)
    expect(out).toContain("\u001b[31m")
    expect(displayWidth(out)).toBe(5)
    expect(stripAnsi(out)).toBe("abcd…")
  })
})

describe("splitAtWidth", () => {
  test("按显示列切,不是按字符下标", () => {
    expect(splitAtWidth("abcdef", 3)).toEqual(["abc", "def"])
    expect(splitAtWidth("中文中文", 4)).toEqual(["中文", "中文"])
  })

  test("★ 切点落在双宽字符中间时整个字归后段,前段宁可短一列", () => {
    const [head, rest] = splitAtWidth("中文", 1)
    expect(head).toBe("")
    expect(rest).toBe("中文")
  })

  test("★ 颜色不断:前段收尾、后段把还生效的 SGR 重发一遍", () => {
    const [head, rest] = splitAtWidth("\u001b[31mabcdef\u001b[39m", 3)
    expect(head).toBe("\u001b[31mabc\u001b[0m")
    expect(rest).toBe("\u001b[31mdef\u001b[39m")
  })

  test("转义序列不占列,不会被算进切点", () => {
    const [head] = splitAtWidth("\u001b[1m\u001b[31mab", 2)
    expect(displayWidth(head)).toBe(2)
  })

  test("边界", () => {
    expect(splitAtWidth("abc", 0)).toEqual(["", "abc"])
    expect(splitAtWidth("abc", 99)).toEqual(["abc", ""])
  })
})

describe("elideLeft", () => {
  test("塞得下就原样", () => {
    expect(elideLeft("~/code/x", 20)).toBe("~/code/x")
  })

  test("★ 扔的是左边 —— 路径的区分度全在尾巴上", () => {
    const out = elideLeft("~/code/alfa-labs/subtools/alfa-workspace", 26)
    expect(out).toBe("…/subtools/alfa-workspace")
    expect(displayWidth(out)).toBeLessThanOrEqual(26)
  })

  test("断点落在 / 上,不留半个词", () => {
    expect(elideLeft("~/code/alfa-labs/subtools/alfa-workspace", 20)).toBe("…/alfa-workspace")
  })

  test("末节自己都塞不下时才逐字硬截", () => {
    const out = elideLeft("~/code/alfa-workspace", 8)
    expect(out).toBe("…rkspace")
    expect(displayWidth(out)).toBe(8)
  })

  test("双宽字符不劈开,宁可少一列", () => {
    const out = elideLeft("/tmp/中文中文", 5)
    expect(displayWidth(out)).toBeLessThanOrEqual(5)
    expect(out.endsWith("中文")).toBe(true)
  })

  test("边界:窄到只剩省略号", () => {
    expect(elideLeft("abcdef", 1)).toBe("…")
    expect(elideLeft("abcdef", 0)).toBe("")
  })
})
