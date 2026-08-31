/**
 * 行编辑器与输入框。
 *
 * 两类断言值得单独说:
 *   - **中文**。删一个「中」要退一个字符不是一个字节,光标列要按 2 算。
 *     这是这个项目的常态输入,不是边角料。
 *   - **框的每一行都必须正好是 width 列**。少一列右边框就歪,多一列终端
 *     自动换行,活动区的行数就算错了 —— 那是整个界面开始烂掉的起点。
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

/** 一串字符逐个敲进去。 */
function type(editor: Editor, text: string, width?: number): void {
  for (const char of text) editor.handle(key(char), width)
}

const plainStyle = {
  border: (t: string) => t,
  marker: (t: string) => t,
  placeholder: (t: string) => t,
}

describe("插入与删除", () => {
  test("敲字", () => {
    const editor = new Editor()
    type(editor, "hello")
    expect(editor.text).toBe("hello")
    expect(editor.cursor).toBe(5)
  })

  test("★ 中文一次删一个字,不是一个字节", () => {
    const editor = new Editor()
    type(editor, "你好世界")
    editor.handle(key("backspace"))
    expect(editor.text).toBe("你好世")
    expect(editor.cursor).toBe(3)
  })

  test("★ emoji 一次删一整个,不留半个代理项", () => {
    const editor = new Editor()
    type(editor, "ok")
    editor.handle(key("😀"))
    expect(editor.text).toBe("ok😀")
    editor.handle(key("backspace"))
    expect(editor.text).toBe("ok")
  })

  test("光标在中间插入", () => {
    const editor = new Editor()
    type(editor, "helo")
    editor.handle(key("left"))
    editor.handle(key("l"))
    expect(editor.text).toBe("hello")
  })

  test("空输入上按退格不出事", () => {
    const editor = new Editor()
    editor.handle(key("backspace"))
    expect(editor.text).toBe("")
    expect(editor.cursor).toBe(0)
  })

  test("delete 往右删", () => {
    const editor = new Editor()
    type(editor, "abc")
    editor.handle(key("home"))
    editor.handle(key("delete"))
    expect(editor.text).toBe("bc")
  })
})

describe("移动与整行操作", () => {
  test("Ctrl-A / Ctrl-E 到行首行尾", () => {
    const editor = new Editor()
    type(editor, "hello")
    editor.handle(key("a", { ctrl: true }))
    expect(editor.cursor).toBe(0)
    editor.handle(key("e", { ctrl: true }))
    expect(editor.cursor).toBe(5)
  })

  test("Ctrl-U 删到行首,Ctrl-K 删到行尾", () => {
    const editor = new Editor()
    type(editor, "hello world")
    editor.handle(key("left"))
    editor.handle(key("left"))
    editor.handle(key("k", { ctrl: true }))
    expect(editor.text).toBe("hello wor")
    editor.handle(key("u", { ctrl: true }))
    expect(editor.text).toBe("")
  })

  test("Ctrl-W 删一个词", () => {
    const editor = new Editor()
    type(editor, "fix the failing test")
    editor.handle(key("w", { ctrl: true }))
    expect(editor.text).toBe("fix the failing ")
  })

  test("词边界:中文算词字符", () => {
    expect(wordLeft("hello world", 11)).toBe(6)
    expect(wordRight("hello world", 0)).toBe(5)
    expect(wordLeft("修改 render.ts", 3)).toBe(0)
  })
})

describe("提交与换行", () => {
  test("回车提交并清空", () => {
    const editor = new Editor()
    type(editor, "run the tests")
    expect(editor.handle(key("enter"))).toEqual({ type: "submit", text: "run the tests" })
    expect(editor.text).toBe("")
  })

  test("★ 全是空白不提交,直接清掉", () => {
    const editor = new Editor()
    type(editor, "   ")
    expect(editor.handle(key("enter"))).toBeUndefined()
    expect(editor.text).toBe("")
  })

  test("★ Ctrl-J 插换行,不提交", () => {
    const editor = new Editor()
    type(editor, "line1")
    expect(editor.handle(key("j", { ctrl: true }))).toBeUndefined()
    type(editor, "line2")
    expect(editor.text).toBe("line1\nline2")
  })

  test("Alt-Enter 也是换行", () => {
    const editor = new Editor()
    type(editor, "a")
    editor.handle(key("enter", { meta: true }))
    expect(editor.text).toBe("a\n")
  })

  test("行尾反斜杠 = 续行,和 shell 一样", () => {
    const editor = new Editor()
    type(editor, "first \\")
    expect(editor.handle(key("enter"))).toBeUndefined()
    expect(editor.text).toBe("first \n")
  })

  test("多行内容整体提交", () => {
    const editor = new Editor()
    type(editor, "a")
    editor.handle(key("j", { ctrl: true }))
    type(editor, "b")
    expect(editor.handle(key("enter"))).toEqual({ type: "submit", text: "a\nb" })
  })
})

describe("★ 中断语义", () => {
  test("Ctrl-C 带出「有没有内容」,由上层决定怎么处理", () => {
    const editor = new Editor()
    expect(editor.handle(key("c", { ctrl: true }))).toEqual({ type: "interrupt", hasText: false })
    type(editor, "half a sentence")
    expect(editor.handle(key("c", { ctrl: true }))).toEqual({ type: "interrupt", hasText: true })
    // 编辑器自己不清空 —— 跑着的时候 Ctrl-C 该去中断,不该吞掉草稿
    expect(editor.text).toBe("half a sentence")
  })

  test("Esc 同理", () => {
    const editor = new Editor()
    type(editor, "x")
    expect(editor.handle(key("escape"))).toEqual({ type: "escape", hasText: true })
  })

  test("空输入的 Ctrl-D 是 eof,有内容时是右删", () => {
    const editor = new Editor()
    expect(editor.handle(key("d", { ctrl: true }))).toEqual({ type: "eof" })
    type(editor, "ab")
    editor.handle(key("home"))
    expect(editor.handle(key("d", { ctrl: true }))).toBeUndefined()
    expect(editor.text).toBe("b")
  })
})

describe("粘贴", () => {
  test("★ 整块进来,换行不触发提交", () => {
    const editor = new Editor()
    expect(editor.handle({ ...key("paste"), text: "line1\nline2\nline3" })).toBeUndefined()
    expect(editor.text).toBe("line1\nline2\nline3")
  })

  test("CRLF 归一 —— 留着 \\r 光标会算错位", () => {
    const editor = new Editor()
    editor.handle({ ...key("paste"), text: "a\r\nb\rc" })
    expect(editor.text).toBe("a\nb\nc")
  })

  test("制表符展开成空格", () => {
    const editor = new Editor()
    editor.handle({ ...key("paste"), text: "a\tb" })
    expect(editor.text).toBe("a  b")
  })
})

describe("历史", () => {
  test("↑ 翻上一条,↓ 翻回来还草稿", () => {
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

  test("翻到头就停住", () => {
    const editor = new Editor(["only"])
    editor.handle(key("up"))
    editor.handle(key("up"))
    expect(editor.text).toBe("only")
  })

  test("提交过的话下次 ↑ 能翻到", () => {
    const editor = new Editor()
    type(editor, "hello")
    editor.handle(key("enter"))
    editor.handle(key("up"))
    expect(editor.text).toBe("hello")
  })

  test("连着提交同一句不重复记", () => {
    const editor = new Editor()
    for (let i = 0; i < 3; i++) {
      type(editor, "same")
      editor.handle(key("enter"))
    }
    editor.handle(key("up"))
    expect(editor.text).toBe("same")
    editor.handle(key("up"))
    expect(editor.text).toBe("same") // 只有一条
  })

  test("★ 多行内容里 ↑ 先在行间走,到顶了才翻历史", () => {
    const editor = new Editor(["old"])
    type(editor, "a")
    editor.handle(key("j", { ctrl: true }))
    type(editor, "b")
    editor.handle(key("up"))
    expect(editor.text).toBe("a\nb") // 还在框里,没翻历史
    editor.handle(key("up"))
    expect(editor.text).toBe("old")
  })

  test("★ 折行的长文本里 ↑ 走屏幕行,不是一步跳去翻历史", () => {
    const editor = new Editor(["old"])
    const width = 10
    type(editor, "abcdefghijklmnopqrst", width) // 20 列 → 折成两行
    editor.handle(key("up"), width)
    expect(editor.text).toBe("abcdefghijklmnopqrst")
    expect(editor.cursor).toBe(10)
  })
})

describe("折行与光标坐标", () => {
  test("按显示宽度折,记住每行起点", () => {
    const rows = layoutRows("abcdef", 3)
    expect(rows.map((r) => r.text)).toEqual(["abc", "def"])
    expect(rows.map((r) => r.start)).toEqual([0, 3])
  })

  test("显式换行", () => {
    const rows = layoutRows("ab\ncd", 10)
    expect(rows.map((r) => r.start)).toEqual([0, 3])
  })

  test("★ 中文的列 = 字数 × 2", () => {
    const rows = layoutRows("你好", 10)
    expect(cursorPosition(rows, 2)).toEqual({ row: 0, col: 4 })
  })

  test("光标停在折行处时落到下一行开头", () => {
    const rows = layoutRows("abcdef", 3)
    expect(cursorPosition(rows, 3)).toEqual({ row: 1, col: 0 })
  })

  test("末尾的换行留一个空行给光标站", () => {
    const rows = layoutRows("a\n", 10)
    expect(rows.length).toBe(2)
    expect(cursorPosition(rows, 2)).toEqual({ row: 1, col: 0 })
  })
})

describe("★ 输入框", () => {
  const box = (text: string, width = 40, cursor = text.length, maxRows?: number) =>
    renderBox({ text, cursor, width, style: plainStyle, ...(maxRows ? { maxRows } : {}) })

  test("每一行都正好是 width 列", () => {
    for (const width of [28, 40, 80, 120]) {
      for (const line of box("hello", width).lines) {
        expect(displayWidth(line)).toBe(width)
      }
    }
  })

  test("★ 中文内容也不会把框撑歪", () => {
    for (const line of box("帮我看下 render.ts 的宽度计算", 40).lines) {
      expect(displayWidth(line)).toBe(40)
    }
  })

  test("空的时候显示占位符,但不影响框宽", () => {
    const result = renderBox({ text: "", cursor: 0, width: 40, style: plainStyle, placeholder: "Ask anything" })
    expect(result.lines[1]).toContain("Ask anything")
    expect(displayWidth(result.lines[1]!)).toBe(40)
  })

  test("光标坐标:第一行要算上边框和提示符", () => {
    // 上边框 1 行 + 「│ 」2 列 + 「› 」2 列
    expect(box("ab").cursor).toEqual({ row: 1, col: 6 })
  })

  test("★ 中文光标列按 2 算", () => {
    expect(box("你好").cursor).toEqual({ row: 1, col: 4 + 4 })
  })

  test("多行:框长出来,光标在对的那一行", () => {
    const result = box("a\nb\nc", 40, 4)
    expect(result.lines.length).toBe(5) // 上下边框 + 三行
    expect(result.cursor.row).toBe(3)
  })

  test("★ 内容太长时开窗口,光标始终可见", () => {
    const text = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n")
    const result = box(text, 40, text.length, 5)
    expect(result.lines.length).toBe(7) // 上下边框 + 5 行
    expect(result.cursor.row).toBeGreaterThanOrEqual(1)
    expect(result.cursor.row).toBeLessThanOrEqual(5)
    // 被截了要说一声,否则用户不知道上面还有
    expect(result.lines[result.lines.length - 1]).toContain("30 lines")
    for (const line of result.lines) expect(displayWidth(line)).toBe(40)
  })

  test("窄到画不下框就退化成一行提示符", () => {
    const result = box("hi", 20)
    expect(result.lines[0]).toBe("› hi")
    expect(result.cursor).toEqual({ row: 0, col: 4 })
  })
})
