/**
 * 全屏界面的地基:合成器、布局、对话缓冲、右栏。
 *
 * 这里盯的是那种「肉眼在真终端上看不出来、但会慢慢把画面啃烂」的错:
 *   - 差分算错 → 上一帧的字从新内容底下露出来
 *   - 宽字符被拆成两半 → 那一行之后所有列都错位
 *   - 样式没归一化 → 差分永远认为有变化,每帧全量重绘,等于没做差分
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { computeLayout, LAYOUT_LIMITS } from "../src/tui/layout.ts"
import { inputDivider } from "../src/tui/chrome.ts"
import { JobsPane, JOB_LINGER_MS } from "../src/tui/panes/jobs.ts"
import { AgentsPane } from "../src/tui/panes/agents.ts"
import type { JobSnapshot } from "../src/tool/bash/jobs.ts"
import { Screen } from "../src/tui/screen.ts"
import { attachScrollbar, offsetForRow, scrollbarColumn } from "../src/tui/scrollbar.ts"
import { Transcript } from "../src/tui/transcript.ts"
import { DetailPane } from "../src/tui/panes/detail.ts"
import { TreePane } from "../src/tui/panes/tree.ts"
import { decisionLine, promptKey, renderPrompt } from "../src/tui/panes/prompt.ts"
import { completionRows, renderCompletion } from "../src/tui/panes/complete.ts"
import { App } from "../src/tui/app.ts"
import { ChatPane } from "../src/tui/panes/chat.ts"
import { ChatModel } from "../src/tui/chat/model.ts"
import type { CopyTarget } from "../src/tui/panes/copy.ts"
import { Editor } from "../src/cli/editor.ts"
import { Keyboard } from "../src/cli/keyboard.ts"
import { EventEmitter } from "node:events"
import type { PromptRequest } from "../src/permission/gate.ts"
import type { PermissionMode } from "../src/permission/mode.ts"
import type { Key } from "../src/cli/keys.ts"
import { setColorEnabled } from "../src/cli/theme.ts"
import { displayWidth, stripAnsi } from "../src/cli/width.ts"
import { homePath, workspaceLabel, type WorkspaceLabel } from "../src/fs/workspace.ts"
import type { SessionInfo } from "../src/session/store.ts"

setColorEnabled(false)

const ESC = String.fromCharCode(27)

function fakeOut(columns = 40, rows = 12) {
  const chunks: string[] = []
  const stream = {
    isTTY: true,
    columns,
    rows,
    write(text: string) {
      chunks.push(text)
      return true
    },
    on() {},
    off() {},
  } as unknown as NodeJS.WriteStream
  return {
    stream,
    chunks,
    all: () => chunks.join(""),
    last: () => chunks[chunks.length - 1] ?? "",
    reset: () => {
      chunks.length = 0
    },
  }
}

/** 把发出去的序列还原成屏幕内容,只关心字符不关心颜色。 */
function paint(width: number, height: number, output: string): string[] {
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => " "))
  let x = 0
  let y = 0
  let index = 0
  while (index < output.length) {
    if (output[index] === ESC) {
      const csi = /^\u001b\[([0-9;?]*)([A-Za-z])/.exec(output.slice(index))
      if (!csi) {
        index += 1
        continue
      }
      const args = (csi[1] ?? "").split(";").map((p) => Number(p) || 0)
      if (csi[2] === "H") {
        y = Math.max(0, (args[0] || 1) - 1)
        x = Math.max(0, (args[1] || 1) - 1)
      } else if (csi[2] === "J" && (args[0] ?? 0) === 2) {
        for (const row of grid) row.fill(" ")
      }
      index += csi[0].length
      continue
    }
    const point = output.codePointAt(index)!
    const ch = String.fromCodePoint(point)
    index += ch.length
    const w = displayWidth(ch)
    if (y < height && x < width) {
      grid[y]![x] = ch
      // 后半格标成空串,渲染时跳过 —— 填空格的话 "中文" 会读成 "中 文 "
      for (let i = 1; i < w; i++) if (x + i < width) grid[y]![x + i] = ""
    }
    x += w
  }
  return grid.map((row) => row.filter((cell) => cell !== "").join("").replace(/\s+$/, ""))
}

// ───────────────────────────────────────────── 合成器

describe("Screen 差分", () => {
  const make = (width = 20, height = 5) => {
    const out = fakeOut(width, height)
    const screen = new Screen(out.stream)
    screen.enter()
    out.reset()
    return { out, screen }
  }

  test("blit 之后屏幕上就是那些字", () => {
    const { out, screen } = make()
    screen.begin()
    screen.blit({ x: 0, y: 0, width: 20, height: 2 }, ["hello", "world"])
    screen.end()
    const rows = paint(20, 5, out.all())
    expect(rows[0]).toBe("hello")
    expect(rows[1]).toBe("world")
  })

  /**
   * ★ resync 一度不存在,而 invalidate 写好了却**全仓一处都没调用**。
   *
   * 后果:一旦我们记错了屏幕现在长什么样(带肤色的 emoji、组合符、终端把
   * ambiguous 当双宽),那一行往后的列就整体错位 —— 而差分从此永远拿一份
   * 错的 front 去比,那几格再也不会被重画。用户手里一个办法都没有。
   */
  test("★ resync 之后下一帧是全量的,而且先清屏", () => {
    const { out, screen } = make()
    screen.begin()
    screen.blit({ x: 0, y: 0, width: 20, height: 1 }, ["same"])
    screen.end()

    screen.resync()
    out.reset()
    screen.begin()
    screen.blit({ x: 0, y: 0, width: 20, height: 1 }, ["same"])
    screen.end()

    // 内容一个字没变,但**照样重画** —— 这正是它和普通一帧的区别
    expect(out.chunks.length).toBeGreaterThan(0)
    expect(paint(20, 5, out.all())[0]).toBe("same")
  })

  test("★ resync 当场就把屏幕清了,不是等下一帧", () => {
    const { out, screen } = make()
    screen.begin()
    screen.blit({ x: 0, y: 0, width: 20, height: 1 }, ["garbage"])
    screen.end()
    out.reset()
    screen.resync()
    expect(out.all()).toContain("\u001b[2J")
    // 滚动区也还原 —— 被外部程序设歪过的话,我们的行号从此全是错的
    expect(out.all()).toContain("\u001b[r")
  })

  test("★ 内容一样就一个字节都不发", () => {
    const { out, screen } = make()
    screen.begin()
    screen.blit({ x: 0, y: 0, width: 20, height: 1 }, ["same"])
    screen.end()
    out.reset()
    screen.begin()
    screen.blit({ x: 0, y: 0, width: 20, height: 1 }, ["same"])
    screen.end()
    expect(out.chunks.length).toBe(0)
  })

  test("★ 只改一个字就只发那一小段,不是整屏", () => {
    const { out, screen } = make(40, 5)
    screen.begin()
    screen.blit({ x: 0, y: 0, width: 40, height: 3 }, ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"])
    screen.end()
    out.reset()
    screen.begin()
    screen.blit({ x: 0, y: 0, width: 40, height: 3 }, ["aaaaaaaaaa", "bbbbbXbbbb", "cccccccccc"])
    screen.end()
    const sent = out.all()
    expect(sent).toContain("X")
    expect(sent).not.toContain("aaaa")
    expect(sent).not.toContain("cccc")
    // 一次定位 + 一个字符,不该超过百来字节
    expect(sent.length).toBeLessThan(120)
  })

  test("★ blit 会把没写满的部分补空格 —— 否则上一帧的字会从底下露出来", () => {
    const { out, screen } = make()
    screen.begin()
    screen.blit({ x: 0, y: 0, width: 20, height: 1 }, ["LONG CONTENT HERE"])
    screen.end()
    screen.begin()
    screen.blit({ x: 0, y: 0, width: 20, height: 1 }, ["hi"])
    screen.end()
    expect(paint(20, 5, out.all())[0]).toBe("hi")
  })

  test("★ 宽字符占两格,后面的字不会往左错位", () => {
    const { out, screen } = make(20, 3)
    screen.begin()
    screen.blit({ x: 0, y: 0, width: 20, height: 1 }, ["中文abc"])
    screen.end()
    const row = paint(20, 3, out.all())[0]!
    expect(row.startsWith("中文abc")).toBe(true)
    expect(displayWidth(row)).toBe(displayWidth("中文abc"))
  })

  test("★ 宽字符只换了字(颜色没变)时整个字一起重画,不留半个", () => {
    const { out, screen } = make(20, 3)
    screen.begin()
    screen.blit({ x: 0, y: 0, width: 20, height: 1 }, ["中文"])
    screen.end()
    out.reset()
    screen.begin()
    screen.blit({ x: 0, y: 0, width: 20, height: 1 }, ["中华"])
    screen.end()
    // 只有第二个字变了,重画范围必须覆盖它的两格
    expect(out.all()).toContain("华")
    expect(paint(20, 3, out.all())[0]).toContain("华")
  })

  test("装不下的双宽字符宁可不画,也不画半个", () => {
    const { out, screen } = make(20, 3)
    screen.begin()
    // 宽度 5 的框里塞 "ab中":a b 各 1 列,中要 2 列,正好到边界
    screen.blit({ x: 0, y: 0, width: 3, height: 1 }, ["ab中"])
    screen.end()
    expect(paint(20, 3, out.all())[0]).toBe("ab")
  })

  test("resize 之后下一帧全画", () => {
    const { out, screen } = make(20, 5)
    screen.begin()
    screen.blit({ x: 0, y: 0, width: 20, height: 1 }, ["keep"])
    screen.end()
    ;(out.stream as unknown as { columns: number }).columns = 30
    expect(screen.resize()).toBe(true)
    out.reset()
    screen.begin()
    screen.blit({ x: 0, y: 0, width: 30, height: 1 }, ["keep"])
    screen.end()
    expect(out.all()).toContain("keep") // 没被差分吃掉
  })

  test("进出 alternate screen 成对", () => {
    const out = fakeOut()
    const screen = new Screen(out.stream)
    screen.enter()
    expect(out.all()).toContain(`${ESC}[?1049h`)
    out.reset()
    screen.leave()
    expect(out.all()).toContain(`${ESC}[?1049l`)
    expect(out.all()).toContain(`${ESC}[?25h`) // 光标要还回去
  })

  test("★ 样式归一化:红完之后要等于「没上色」", () => {
    setColorEnabled(true)
    try {
      const { out, screen } = make(20, 3)
      screen.begin()
      screen.blit({ x: 0, y: 0, width: 20, height: 1 }, [`${ESC}[31mab${ESC}[39mcd`])
      screen.end()
      out.reset()
      // 同样的可见内容,但这次一开始就没上色 —— cd 两格的样式必须被认为没变
      screen.begin()
      screen.blit({ x: 0, y: 0, width: 20, height: 1 }, [`${ESC}[31mab${ESC}[39mcd`])
      screen.end()
      expect(out.chunks.length).toBe(0)
    } finally {
      setColorEnabled(false)
    }
  })
})

// ───────────────────────────────────────────── 布局

describe("布局", () => {
  const layout = (width: number, height = 30, inputHeight = 1) =>
    computeLayout({ width, height, inputHeight })


  test("够宽就是三栏", () => {
    const l = layout(140)
    expect(l.tree).toBeDefined()
    expect(l.detail).toBeDefined()
    expect(l.collapsed).toEqual([])
  })

  test("★ 三栏加上边框正好铺满整宽,不多不少", () => {
    for (const width of [140, 120, 100, 96, 80, 72, 60, 50, 40, 28]) {
      const l = layout(width)
      const panes = (l.tree?.width ?? 0) + l.chat.width + (l.detail?.width ?? 0)
      const seams = 2 + (l.tree ? 1 : 0) + (l.detail ? 1 : 0) // 左右外框 + 每多一栏一条竖线
      expect(panes + seams).toBe(width)
    }
  })

  test("★ 窄了先收右栏,再收左栏", () => {
    expect(layout(72).detail).toBeUndefined()
    expect(layout(72).tree).toBeDefined()
    const narrow = layout(50)
    expect(narrow.detail).toBeUndefined()
    expect(narrow.tree).toBeUndefined()
    expect(narrow.collapsed).toEqual(["detail", "tree"])
  })

  test("对话栏永远在,永远不小于下限(除非终端本身就那么窄)", () => {
    for (const width of [140, 100, 80, 60, 45]) {
      expect(layout(width).chat.width).toBeGreaterThanOrEqual(LAYOUT_LIMITS.CHAT_MIN - 2)
    }
  })

  test("手动关掉的栏不算「被折叠」—— 状态行不该提示去打开它", () => {
    const l = computeLayout({ width: 140, height: 30, inputHeight: 1, hidden: new Set(["tree"]) })
    expect(l.tree).toBeUndefined()
    expect(l.collapsed).toEqual([])
  })

  test("多行输入把 body 压矮,但压不到 0", () => {
    const tall = layout(120, 24, 8)
    expect(tall.input.height).toBe(8)
    expect(tall.chat.height).toBeGreaterThan(0)
    const absurd = layout(120, 24, 100)
    expect(absurd.chat.height).toBeGreaterThan(0)
    expect(absurd.rowBottom).toBeLessThan(24)
  })

  test("竖线位置和面板边界对得上", () => {
    const l = layout(140)
    expect(l.dividers[0]).toBe(0)
    expect(l.dividers.at(-1)).toBe(139)
    expect(l.dividers).toContain(l.tree!.x + l.tree!.width)
    expect(l.dividers).toContain(l.chat.x + l.chat.width)
  })

  test("矮终端也不炸", () => {
    const l = layout(80, 6, 1)
    expect(l.chat.height).toBeGreaterThan(0)
    expect(l.rowBottom).toBeLessThan(6 + 1)
  })
})

describe("★ 命令候选占的是布局里的行,不是浮层", () => {
  const withCompletion = (rows: number, height = 30) =>
    computeLayout({ width: 120, height, inputHeight: 1, completionHeight: rows })

  test("开着的时候夹在那条线和输入框之间,和输入同宽", () => {
    const l = withCompletion(4)
    expect(l.completion).toBeDefined()
    expect(l.completion!.y).toBe(l.inputRule + 1)
    expect(l.completion!.height).toBe(4)
    expect(l.completion!.x).toBe(l.input.x)
    expect(l.completion!.width).toBe(l.input.width)
  })

  test("★ 输入框被推到候选下面,不是被盖住", () => {
    const l = withCompletion(4)
    expect(l.input.y).toBe(l.completion!.y + 4)
    // 输入是 body 的最后一块;它下面是状态那条线(没有状态行时就是下框)
    expect(l.input.y + l.input.height).toBe(l.statusRule >= 0 ? l.statusRule : l.rowBottom)
  })

  test("★ 挤短的是上面的面板,而且候选和面板不重叠", () => {
    const open = withCompletion(4)
    const closed = withCompletion(0)
    expect(open.chat.height).toBe(closed.chat.height - 4)
    // 对话整个在那条线以上,候选整个在它以下
    expect(open.chat.y + open.chat.height).toBeLessThanOrEqual(open.inputRule)
    expect(open.completion!.y).toBeGreaterThan(open.inputRule)
  })

  test("关掉就没有这块地方", () => {
    expect(withCompletion(0).completion).toBeUndefined()
  })

  test("★ 留的行数 = 真会画出来的行数", () => {
    // 一度是拿 items.length 去留位置的,而 renderCompletion 最多只画 MAX_ROWS+1 行 ——
    // 敲一个 `/` 列出十几条命令时,输入框上方就凭空多出一截空白,候选越多越大
    for (const count of [0, 1, 3, 6, 7, 13, 40]) {
      const completion = {
        items: Array.from({ length: count }, (_, i) => ({ value: `/c${i}`, hint: "x" })),
        from: 0,
        to: 1,
        trailingSpace: false,
      }
      const drawn = count === 0 ? 0 : renderCompletion(completion, 0, 80).lines.length
      expect(completionRows(count)).toBe(drawn)
    }
  })

  test("★ 屏幕矮的时候先削候选 —— 面板至少留一行", () => {
    const l = withCompletion(20, 10)
    expect(l.chat.height).toBeGreaterThanOrEqual(1)
    expect(l.rowBottom).toBeLessThan(l.height)
    expect(l.completion!.height).toBeLessThan(20)
  })

  test("每一块都还在框里", () => {
    for (const height of [8, 12, 24, 40]) {
      const l = withCompletion(6, height)
      // ★ 状态行**在框里**:线、字、下框,三行依次排在最底下
      if (l.statusRow >= 0) {
        expect(l.statusRule).toBe(l.statusRow - 1)
        expect(l.rowBottom).toBe(l.statusRow + 1)
      }
      expect(l.rowBottom).toBeLessThan(l.height)
      if (l.completion) expect(l.completion.y + l.completion.height).toBe(l.input.y)
    }
  })
})

// ───────────────────────────────────────────── 对话缓冲

describe("Transcript", () => {
  test("按当前宽度折行,不是存的时候折", () => {
    const t = new Transcript()
    t.write("abcdefghij\n")
    expect(t.view(5, 10)).toEqual(["abcde", "fghij"])
    expect(t.view(10, 10)).toEqual(["abcdefghij"])
  })

  test("★ 改宽度之后历史跟着重排 —— 存屏幕行的话它们会按旧宽度僵住", () => {
    const t = new Transcript()
    for (let i = 0; i < 5; i++) t.write(`line ${i} with some text\n`)
    const narrow = t.totalRows(10)
    const wide = t.totalRows(60)
    expect(narrow).toBeGreaterThan(wide)
    expect(wide).toBe(5)
  })

  test("半行留在末尾,atLineStart 跟着变", () => {
    const t = new Transcript()
    expect(t.atLineStart).toBe(true)
    t.write("half")
    expect(t.atLineStart).toBe(false)
    expect(t.view(20, 5)).toEqual(["half"])
    t.write(" done\n")
    expect(t.atLineStart).toBe(true)
    expect(t.view(20, 5)).toEqual(["half done"])
  })

  test("★ 空行要留着 —— 段落之间的呼吸全靠它", () => {
    const t = new Transcript()
    t.write("a\n\nb\n")
    expect(t.view(20, 5)).toEqual(["a", "", "b"])
  })

  test("不够一屏时顶在上面,不是撑到底", () => {
    const t = new Transcript()
    t.write("one\ntwo\n")
    expect(t.view(20, 5)).toEqual(["one", "two"])
  })

  test("滚动:往上翻、翻到底、跟随状态", () => {
    const t = new Transcript()
    for (let i = 0; i < 20; i++) t.write(`row${i}\n`)
    expect(t.view(20, 5)).toEqual(["row15", "row16", "row17", "row18", "row19"])
    expect(t.following).toBe(true)
    t.scrollBy(5)
    expect(t.following).toBe(false)
    expect(t.view(20, 5)).toEqual(["row10", "row11", "row12", "row13", "row14"])
    t.scrollToBottom()
    expect(t.view(20, 5).at(-1)).toBe("row19")
  })

  test("滚过头会被夹住,不会翻出内容之外", () => {
    const t = new Transcript()
    for (let i = 0; i < 8; i++) t.write(`row${i}\n`)
    t.scrollToTop()
    expect(t.view(20, 5)).toEqual(["row0", "row1", "row2", "row3", "row4"])
    t.scrollBy(100)
    expect(t.view(20, 5)[0]).toBe("row0")
  })

  test("replaceTail:提交整行 + 换掉半行,一次做完", () => {
    const t = new Transcript()
    t.replaceTail(["done one", "done two"], "still typ")
    expect(t.view(20, 5)).toEqual(["done one", "done two", "still typ"])
    expect(t.atLineStart).toBe(false)
    // 半行是**替换**不是追加 —— markdown 会随着后面的字符重渲染整条
    t.replaceTail([], "STILL TYPING")
    expect(t.view(20, 5)).toEqual(["done one", "done two", "STILL TYPING"])
    t.replaceTail(["STILL TYPING done"], "")
    expect(t.atLineStart).toBe(true)
    expect(t.view(20, 5).at(-1)).toBe("STILL TYPING done")
  })

  test("★ 多行的半行(markdown 攒着的表格)也要按当前宽度分别折", () => {
    const t = new Transcript()
    t.replaceTail([], "| a |\n| bbbbbbbb |")
    expect(t.view(20, 5)).toEqual(["| a |", "| bbbbbbbb |"])
    expect(t.view(6, 5)).toEqual(["| a |", "| bbbb", "bbbb |"])
  })
})

describe("★ Transcript 悬挂缩进", () => {
  /** 折行结果里的续行,前导空格保留 */
  const rows = (line: string, width: number): string[] => {
    const t = new Transcript()
    t.write(line + "\n")
    return t.view(width, 10)
  }

  test("列表项折下来对齐到内容,不顶回第 0 列", () => {
    expect(rows("• aaaa bbbb cccc", 8)).toEqual(["• aaaa b", "  bbb cc", "  cc"])
  })

  test("有序列表按序号宽度缩进", () => {
    expect(rows("10. abcdefgh", 8)).toEqual(["10. abcd", "    efgh"])
  })

  test("纯缩进的行(工具卡片、diff)也跟着缩", () => {
    expect(rows("    abcdefgh", 8)).toEqual(["    abcd", "    efgh"])
  })

  test("★ 代码块的竖线在每条续行上接着画,不然折下来的半段像掉出了块外", () => {
    const out = rows("  │ abcdefgh", 8)
    expect(out[0]).toBe("  │ abcd")
    expect(stripAnsi(out[1]!)).toBe("  │ efgh")
  })

  test("没有前缀的普通段落照旧顶格", () => {
    expect(rows("abcdefghij", 5)).toEqual(["abcde", "fghij"])
  })

  test("★ 缩进吃掉大半个宽度就放弃悬挂 —— 剩下的空间放不了几个字", () => {
    // 缩进 10、宽度 12:悬挂之后每行只剩 2 列,还不如顶格
    expect(rows("          abcdefgh", 12)).toEqual(["          ab", "cdefgh"])
  })

  test("★ diff 的减号不算列表符号 —— 缩进它会让人以为那行内容变了", () => {
    // 只按前导空格缩进(4),不因为 `-` 再多缩一格
    expect(rows("    - abcdefgh", 10)).toEqual(["    - abcd", "    efgh"])
  })
})

// ───────────────────────────────────────────── 右栏

describe("★ 右栏的语法高亮", () => {
  const withFile = (name: string, body: string, fn: (path: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "apc-hl-"))
    const path = join(dir, name)
    writeFileSync(path, body)
    setColorEnabled(true)
    try {
      fn(path)
    } finally {
      setColorEnabled(false)
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test("认得出语言就上色", () => {
    withFile("a.ts", "const x = 1\n", (path) => {
      const pane = new DetailPane("/")
      pane.set({ kind: "file", path })
      expect(pane.render(60, 3)[0]).toContain("\u001b[35m") // const 是关键字
    })
  })

  test("★ 认不出语言就原样,不瞎猜", () => {
    withFile("a.unknownext", "const x = 1\n", (path) => {
      const pane = new DetailPane("/")
      pane.set({ kind: "file", path })
      expect(pane.render(60, 3)[0]).not.toContain("\u001b[35m")
    })
  })

  test("★ 上色不能改变显示宽度 —— 改了右栏就开始错位", () => {
    withFile("a.ts", 'const 名字 = "中文" // 注释\n', (path) => {
      const pane = new DetailPane("/")
      pane.set({ kind: "file", path })
      for (const row of pane.render(60, 2)) expect(displayWidth(row)).toBeLessThanOrEqual(60)
      expect(stripAnsi(pane.render(60, 2)[0]!)).toContain('const 名字 = "中文" // 注释')
    })
  })

  test("★ 放不下被截断时颜色也要留着", () => {
    withFile("a.ts", `const x = "${"y".repeat(200)}"\n`, (path) => {
      const pane = new DetailPane("/")
      pane.set({ kind: "file", path })
      const painted = pane.render(40, 2)[0]!
      // const 还在:截断没顺手把整行洗成白的
      expect(painted).toContain("\u001b[35m")
      // 最后一列是滚动条那一格,内容到它前面为止
      expect(stripAnsi(painted).slice(0, -1).trimEnd().endsWith("…")).toBe(true)
      expect(displayWidth(painted)).toBeLessThanOrEqual(40)
    })
  })

  test("★ 块注释跨行:第二行也得是注释色", () => {
    withFile("a.ts", "/* open\nstill comment\n*/\nconst x = 1\n", (path) => {
      const pane = new DetailPane("/")
      pane.set({ kind: "file", path })
      const rows = pane.render(60, 4)
      expect(rows[1]).toContain("\u001b[2m")
      expect(rows[1]).not.toContain("\u001b[35m")
    })
  })
})

describe("DetailPane", () => {
  const withDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "apc-detail-"))
    try {
      fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test("空的时候给一句人话,不是一片黑", () => {
    const pane = new DetailPane("/repo")
    expect(pane.render(40, 6).join("\n")).toContain("nothing to show")
    expect(pane.title).toBe("detail")
  })

  test("文件带行号,标题是相对路径", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "a.ts"), "const a = 1\nconst b = 2\n")
      const pane = new DetailPane(dir)
      pane.set({ kind: "file", path: join(dir, "a.ts") })
      expect(pane.title).toBe("a.ts")
      const lines = pane.render(40, 4)
      expect(lines[0]).toContain("1 const a = 1")
      expect(lines[1]).toContain("2 const b = 2")
    })
  })

  test("读不到的文件报错,不是崩", () => {
    const pane = new DetailPane("/repo")
    pane.set({ kind: "file", path: "/definitely/not/here.ts" })
    expect(pane.render(60, 3)[0]).toContain("!")
  })

  test("二进制不往终端上糊", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "bin"), Buffer.from([0x00, 0x01, 0x02]))
      const pane = new DetailPane(dir)
      pane.set({ kind: "file", path: join(dir, "bin") })
      expect(pane.render(40, 3)[0]).toContain("binary")
    })
  })

  test("diff 标题带 diff 字样", () => {
    const pane = new DetailPane("/repo")
    pane.set({ kind: "diff", path: "/repo/a.ts", patch: "@@ -1 +1 @@\n-old\n+new" })
    expect(pane.title).toBe("a.ts  diff")
    expect(pane.render(40, 5).join("\n")).toContain("+new")
  })

  test("★ 锁住之后不再跟工具走,但用户自己点还是能切", () => {
    const pane = new DetailPane("/repo")
    pane.toggleLock()
    pane.follow({ kind: "text", title: "bash", body: "x" })
    expect(pane.title).toBe("detail")
    pane.set({ kind: "text", title: "manual", body: "y" })
    expect(pane.title).toBe("manual")
  })

  test("★ 实时输出钉在底部 —— 否则永远只看得到命令刚开始那几行", () => {
    const pane = new DetailPane("/repo")
    pane.stream("bash", Array.from({ length: 30 }, (_, i) => `tick ${i}`).join("\n"))
    expect(pane.render(30, 3).join("\n")).toContain("tick 29")
    pane.stream("bash", Array.from({ length: 40 }, (_, i) => `tick ${i}`).join("\n"))
    expect(pane.render(30, 3).join("\n")).toContain("tick 39")
  })

  test("用户一动手就不再自动跟到底", () => {
    const pane = new DetailPane("/repo")
    pane.stream("bash", Array.from({ length: 30 }, (_, i) => `tick ${i}`).join("\n"))
    pane.render(30, 3)
    pane.scrollBy(-20)
    pane.stream("bash", Array.from({ length: 31 }, (_, i) => `tick ${i}`).join("\n"))
    expect(pane.render(30, 3).join("\n")).not.toContain("tick 30")
  })

  test("render 永远返回正好 height 行", () => {
    const pane = new DetailPane("/repo")
    pane.set({ kind: "text", title: "t", body: "one\ntwo" })
    expect(pane.render(20, 7).length).toBe(7)
  })
})


// ───────────────────────────────────────────── 权限模态框

const request = (over: Partial<PromptRequest> = {}): PromptRequest => ({
  permission: "bash",
  patterns: ["rm -rf build"],
  alwaysPatterns: ["rm *"],
  forbidAlways: false,
  metadata: { command: "rm -rf build" },
  ...over,
})

const key = (name: string, mods: Partial<Key> = {}): Key => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
  ...mods,
})

describe("权限模态框", () => {
  test("框宽一致,内容和选项都在", () => {
    const view = renderPrompt(request(), 0, 100, 20)
    for (const line of view.lines) expect(displayWidth(line)).toBe(view.width)
    const text = view.lines.join("\n")
    expect(text).toContain("permission required: bash")
    expect(text).toContain("rm -rf build")
    // 大写的那个 = 回车会选的那个
    expect(text).toContain("[Y] allow once")
    expect(text).toContain("[n] reject")
  })

  test("★ 命令跑在别处时把目录写出来 —— 同一条 rm -rf build 在哪跑是两件事", () => {
    const text = renderPrompt(
      request({ metadata: { command: "rm -rf build", workdirLabel: "packages/web" } }),
      0,
      100,
      20,
    ).lines.join("\n")
    expect(text).toContain("in:")
    expect(text).toContain("packages/web")
  })

  test("跑在仓库根时不占那一行", () => {
    const text = renderPrompt(request({ metadata: { command: "rm -rf build" } }), 0, 100, 20).lines.join("\n")
    expect(text).not.toContain("in:")
  })

  test("★ forbidAlways 时不显示 always —— 不是显示了再拒绝", () => {
    const text = renderPrompt(request({ forbidAlways: true }), 0, 100, 20).lines.join("\n")
    expect(text).not.toContain("[a] always")
  })

  test("窄终端里也不越界", () => {
    for (const width of [40, 60, 120, 200]) {
      const view = renderPrompt(request(), 0, width, 20)
      expect(view.width).toBeLessThanOrEqual(width)
      for (const line of view.lines) expect(displayWidth(line)).toBe(view.width)
    }
  })

  test("★ 内容超高时截断并说明还有多少,不是默默吞掉", () => {
    const long = { preview: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"), command: "write x" }
    const view = renderPrompt(request({ metadata: long }), 0, 100, 12)
    expect(view.height).toBeLessThanOrEqual(12)
    expect(view.hidden).toBeGreaterThan(0)
    expect(view.lines.join("\n")).toContain("more")
  })

  test("能往下翻", () => {
    const long = { preview: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"), command: "write x" }
    const top = renderPrompt(request({ metadata: long }), 0, 100, 12).lines.join("\n")
    const down = renderPrompt(request({ metadata: long }), 20, 100, 12).lines.join("\n")
    expect(top).not.toBe(down)
    expect(down).toContain("line 2")
  })
})

describe("★ 模态框按键 —— 放行只有两个键,走人有四个", () => {
  test("y / 回车 = 放行一次", () => {
    expect(promptKey(key("y"), false)).toEqual({ kind: "decide", decision: "once" })
    expect(promptKey(key("Y"), false)).toEqual({ kind: "decide", decision: "once" })
    expect(promptKey(key("enter"), false)).toEqual({ kind: "decide", decision: "once" })
    expect(promptKey(key("a"), false)).toEqual({ kind: "decide", decision: "always" })
  })

  test("★ Esc / Ctrl-C / Ctrl-D / n 都是拒绝 —— 「算了」和「确认」永远是不同的键", () => {
    for (const k of [key("escape"), key("c", { ctrl: true }), key("d", { ctrl: true }), key("n")]) {
      expect(promptKey(k, false)).toEqual({ kind: "decide", decision: "reject" })
    }
  })

  test("forbidAlways 时 a 被忽略,不是当成放行", () => {
    expect(promptKey(key("a"), true)).toEqual({ kind: "ignore" })
  })

  test("其它键一律无视 —— 误触不该决定文件系统的命运", () => {
    for (const k of [key("z"), key("tab"), key("paste"), key("f5"), key("中")]) {
      expect(promptKey(k, false).kind).toBe("ignore")
    }
  })

  test("翻页键只翻页", () => {
    expect(promptKey(key("pagedown"), false)).toEqual({ kind: "scroll", delta: 5 })
    expect(promptKey(key("up"), false)).toEqual({ kind: "scroll", delta: -1 })
  })

  test("记录行写清楚批了什么", () => {
    expect(decisionLine(request(), "once")).toContain("allowed once")
    expect(decisionLine(request(), "reject")).toContain("rejected")
    expect(decisionLine(request(), "always")).toContain("rm -rf build")
  })
})


/**
 * 状态行是**倒数第二行** —— 最后一行是下框。
 *
 * 写成函数而不是到处写 `screen()[23]`:状态行搬进框里的时候,那个下标全错了,
 * 而每一处的现象都是「断言的内容不在这一行里」,查起来像是内容出了问题。
 */
/**
 * 文件树那一栏现在展开着吗。
 *
 * ★ 判据是"第一行有没有一个可展开的目录箭头",不是"第一行叫不叫 bin"。
 *   一度写死过仓库根下第一个条目的名字 —— 于是往仓库里加一个排序更靠前的
 *   目录(`.github/`),四条和文件树八竿子打不着的测试一起红了。
 *   一条会因为**别处**的正常改动而失败的断言,是在训练人忽略红色。
 */
function treeOpen(rows: string[]): boolean {
  return /[▸▾]/.test(rows[1] ?? "")
}

function statusOf(rows: string[]): string | undefined {
  return rows[rows.length - 2]
}

function makeApp(
  workspace: WorkspaceLabel = { name: "alfa-workspace", path: "~/code/alfa-workspace" },
  columns = 100,
  onSubmit: (text: string) => void = () => {},
  files?: (query: string) => Array<{ value: string; hint: string; more?: boolean }>,
  options: {
    jobs?: () => readonly JobSnapshot[]
    agents?: () => readonly JobSnapshot[]
    agentflow?: () => number | false
    label?: () => string
    onSubmitBusy?: (text: string) => boolean
    panels?: boolean
    onPanelsChanged?: (visible: boolean) => void
    copyTargets?: () => CopyTarget[]
  } = {},
) {
  let mode: PermissionMode = "default"
  const picked: SessionInfo[] = []
  const out = fakeOut(columns, 24)
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode() {},
    setEncoding() {},
    resume() {},
    pause() {},
  }) as unknown as NodeJS.ReadStream
  const keyboard = new Keyboard(input, out.stream)
  const transcript = new Transcript()
  const editor = new Editor()
  // 收据要同时进两个投影,所以 App 拿到的是 ChatPane 而不是裸 Transcript
  const chat = new ChatPane({
    model: new ChatModel({ root: process.cwd() }),
    transcript,
    view: "session",
    line: (text) => transcript.push(text),
  })
  const app = new App({
    screen: new Screen(out.stream),
    ...(options.jobs ? { jobs: options.jobs } : {}),
    ...(options.agents ? { agents: options.agents } : {}),
    ...(options.agentflow ? { agentflow: options.agentflow } : {}),
    keyboard,
    editor,
    chat,
    root: process.cwd(),
    workspace,
    label: options.label ?? (() => "test/model"),
    mouse: false,
    ...(options.panels !== undefined ? { panels: options.panels } : {}),
    ...(options.onPanelsChanged ? { onPanelsChanged: options.onPanelsChanged } : {}),
    ...(options.copyTargets ? { copyTargets: options.copyTargets } : {}),
    ...(files ? { files } : {}),
    onSubmit,
    ...(options.onSubmitBusy ? { onSubmitBusy: options.onSubmitBusy } : {}),
    onCancel: () => {},
    onExit: () => {},
    onPickSession: (info) => picked.push(info),
    mode: () => mode,
    setMode: (next) => {
      mode = next
    },
  })
  app.start()
  return {
    app,
    chat,
    transcript,
    editor,
    mode: () => mode,
    press: (bytes: string) => (input as unknown as EventEmitter).emit("data", bytes),
    /** 挑选浮层里被选中的那几场(按顺序) */
    picked,
    /** 当前这一帧还原成的屏幕内容 */
    screen: () => paint(columns, 24, out.all()),
    dispose: () => app.dispose(),
  }
}

/**
 * 等一帧画完 —— App 把绘制合并起来,start() 之后不是立刻就有画面。
 *
 * ★ 必须等够 FRAME_MS(见 tui/app.ts 那个常量)。绘制不只是合并到微任务,
 *   还**限速**:距上一帧不到一帧的时间就挂个定时器等到点。原来这里是
 *   `setTimeout(0)`,只够接住第一帧 —— 连着要第二帧时它静默地什么都不画,
 *   而断言拿到的是**上一帧**的画面,报错看起来像"按键没生效"。
 */
const FRAME_WAIT_MS = 25
async function frame(app: App): Promise<void> {
  app.requestFrame()
  await new Promise((resolve) => setTimeout(resolve, FRAME_WAIT_MS))
}

describe("★ 模态框在 App 里的排队", () => {

  test("★ 并行发起两条也不会互相顶掉 —— 后来的排队", async () => {
    const { app, press } = makeApp()
    try {
      const first = app.askPermission(request({ metadata: { command: "one" } }))
      const second = app.askPermission(request({ metadata: { command: "two" } }))
      press("y")
      expect(await first).toBe("once")
      press("n")
      expect(await second).toBe("reject")
    } finally {
      app.dispose()
    }
  })

  test("决定之后往对话里留痕", async () => {
    const { app, transcript, press } = makeApp()
    try {
      const answer = app.askPermission(request())
      press("y")
      await answer
      expect(transcript.view(200, 20).join("\n")).toContain("allowed once")
    } finally {
      app.dispose()
    }
  })

  test("★ 中断当前 turn 时挂着的问题一起收掉,否则那条工具永远等下去", async () => {
    const { app } = makeApp()
    try {
      const controller = new AbortController()
      const answer = app.askPermission(request(), controller.signal)
      controller.abort()
      expect(await answer).toBe("reject")
    } finally {
      app.dispose()
    }
  })

  test("★ 退出时把还挂着的问题都拒掉 —— 不然 drain 等不到,程序退不出去", async () => {
    const { app } = makeApp()
    const first = app.askPermission(request())
    const second = app.askPermission(request())
    app.dispose()
    expect(await first).toBe("reject")
    expect(await second).toBe("reject")
  })

  test("已经 abort 的信号立刻返回拒绝", async () => {
    const { app } = makeApp()
    try {
      const controller = new AbortController()
      controller.abort()
      expect(await app.askPermission(request(), controller.signal)).toBe("reject")
    } finally {
      app.dispose()
    }
  })
})


// ───────────────────────────────────────────── 文件树

describe("★ 文件树刷新", () => {
  const withTree = (fn: (dir: string, tree: TreePane, rows: () => string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "apc-tree-"))
    try {
      mkdirSync(join(dir, "lib"))
      writeFileSync(join(dir, "lib", "existing.py"), "x = 1\n")
      writeFileSync(join(dir, "top.txt"), "hi\n")
      const tree = new TreePane(dir)
      fn(dir, tree, () => tree.render(40, 20, false).join("\n"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const expandLib = (tree: TreePane) => {
    tree.move(0)
    const lib = tree.selectedNode!
    expect(lib.name).toBe("lib") // 目录排在前面
    tree.toggle(lib)
  }

  test("★ 新文件要出现 —— 而且不依赖 git", () => {
    withTree((dir, tree, rows) => {
      expandLib(tree)
      expect(rows()).not.toContain("hello.py")
      writeFileSync(join(dir, "lib", "hello.py"), "print('hi')\n")
      tree.refresh()
      expect(rows()).toContain("hello.py")
    })
  })

  test("★ 刷新不能把展开状态抹掉", () => {
    withTree((dir, tree, rows) => {
      expandLib(tree)
      expect(rows()).toContain("existing.py")
      writeFileSync(join(dir, "lib", "hello.py"), "print('hi')\n")
      tree.refresh()
      // 收回去的话新文件反而被藏进折叠的目录里,看着就是"什么都没发生"
      expect(rows()).toContain("▾ lib")
      expect(rows()).toContain("existing.py")
    })
  })

  test("嵌套的展开状态也要保住", () => {
    withTree((dir, tree, rows) => {
      mkdirSync(join(dir, "lib", "deep"))
      writeFileSync(join(dir, "lib", "deep", "a.py"), "a\n")
      tree.refresh()
      expandLib(tree)
      tree.move(1)
      tree.toggle(tree.selectedNode!) // deep
      expect(rows()).toContain("a.py")
      writeFileSync(join(dir, "lib", "deep", "b.py"), "b\n")
      tree.refresh()
      expect(rows()).toContain("a.py")
      expect(rows()).toContain("b.py")
    })
  })

  test("刷新之后选中项还在原来那个文件上", () => {
    withTree((dir, tree) => {
      expandLib(tree)
      tree.move(1)
      const before = tree.selectedNode!.path
      writeFileSync(join(dir, "aaa-first.txt"), "x\n") // 排到最前面,下标全变了
      tree.refresh()
      expect(tree.selectedNode!.path).toBe(before)
    })
  })

  test("文件被删掉之后从树里消失,不崩", () => {
    withTree((dir, tree, rows) => {
      expandLib(tree)
      unlinkSync(join(dir, "lib", "existing.py"))
      tree.refresh()
      expect(rows()).not.toContain("existing.py")
    })
  })

  test("展开着的目录被删掉也不崩", () => {
    withTree((dir, tree, rows) => {
      expandLib(tree)
      rmSync(join(dir, "lib"), { recursive: true, force: true })
      tree.refresh()
      expect(rows()).not.toContain("lib")
      expect(rows()).toContain("top.txt")
    })
  })

  test("★ 非 git 目录里 refreshGit 也要把盘重扫一遍", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apc-tree-nogit-"))
    try {
      writeFileSync(join(dir, "a.txt"), "a\n")
      const tree = new TreePane(dir)
      writeFileSync(join(dir, "b.txt"), "b\n")
      // git 命令在这里会失败(不是仓库)。之前的实现只在 git 成功时才重扫,
      // 于是非 git 目录下这棵树从启动起就永久冻结。
      await tree.refreshGit()
      expect(tree.render(40, 10, false).join("\n")).toContain("b.txt")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})


describe("★ 权限模式与斜杠补全", () => {
  const SHIFT_TAB = "\u001b[Z"

  test("shift-tab 从严到松循环", () => {
    const { app, mode, press } = makeApp()
    try {
      expect(mode()).toBe("default")
      press(SHIFT_TAB)
      expect(mode()).toBe("trust")
      press(SHIFT_TAB)
      expect(mode()).toBe("confirm")
      press(SHIFT_TAB)
      expect(mode()).toBe("default")
    } finally {
      app.dispose()
    }
  })

  test("★ 模态框开着时 shift-tab 不换模式 —— 那会儿所有键都归它", () => {
    const { app, mode, press } = makeApp()
    try {
      void app.askPermission(request())
      press(SHIFT_TAB)
      expect(mode()).toBe("default")
    } finally {
      app.dispose()
    }
  })

  test("tab 在补全开着时是「选中」,不开时才是「换面板」", () => {
    const { app, editor, press } = makeApp()
    try {
      press("/pe")
      expect(editor.text).toBe("/pe")
      press("\t")
      expect(editor.text).toBe("/permission ")
      // 参数候选的第一条是「什么都不加」,选中它输入框不动(它的值就是空的)
      press("\t")
      expect(editor.text).toBe("/permission ")
      // 往下一条才是第一个真参数
      press("\u001b[B")
      press("\t")
      expect(editor.text).toBe("/permission confirm")
    } finally {
      app.dispose()
    }
  })

  test("上下键在补全开着时挑候选,不动输入内容", () => {
    const { app, editor, press } = makeApp()
    try {
      press("/")
      press("\u001b[B") // ↓
      press("\t")
      // 第二条候选是 /view,它带参数所以补全时顺手补一个空格
      expect(editor.text).toBe("/view ")
    } finally {
      app.dispose()
    }
  })

  test("★ esc 关掉补全,但不清输入 —— 由近及远地退", async () => {
    const { app, editor, press } = makeApp()
    try {
      press("/pe")
      // 孤立的 ESC 是歧义,keyboard 要等一小会儿超时才当成 escape
      press("\u001b")
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(editor.text).toBe("/pe")
      // 补全已经关掉:这时候 tab 回到「换面板」,不再补内容
      press("\t")
      expect(editor.text).toBe("/pe")
    } finally {
      app.dispose()
    }
  })

  test("★ 回车 = 选中高亮那条 —— 不是把 `/` 当成一句话发出去", () => {
    const sent: string[] = []
    const { app, editor, press } = makeApp(undefined, undefined, (text) => sent.push(text))
    try {
      press("/")
      press("\r")
      expect(editor.text).toBe("/permission ")
      expect(sent).toEqual([]) // 一个字都没发出去
      press("\u001b[B") // ↓ 从「什么都不加」挪到第一个真参数
      press("\u001b[B") // ↓ 再一条
      press("\r")
      expect(editor.text).toBe("/permission default")
    } finally {
      app.dispose()
    }
  })

  test("★ 补完命令名之后直接回车就把它发出去 —— 不用先按退格", () => {
    const sent: string[] = []
    const { app, editor, press } = makeApp(undefined, undefined, (text) => sent.push(text))
    try {
      // 用户的原话:补全「空出一个格子然后回车预补充的就是 check 或者 force」,
      // 于是只有前半就能构成的有效指令反而要先退格再回车。第一条候选是
      // 「什么都不加」之后,那一下回车就是发出去
      press("/upg")
      press("\t")
      expect(editor.text).toBe("/upgrade ")
      press("\r")
      expect(sent).toEqual(["/upgrade"])
      expect(editor.text).toBe("")
    } finally {
      app.dispose()
    }
  })

  test("★ 已经打全了的回车照旧发出去 —— 不逼人多按一次", () => {
    const sent: string[] = []
    const { app, press } = makeApp(undefined, undefined, (text) => sent.push(text))
    try {
      // /clear 没有参数,打全之后浮层自己就收了
      press("/clear")
      press("\r")
      expect(sent).toEqual(["/clear"])
    } finally {
      app.dispose()
    }
  })

  test("★ 带参数的命令打全之后,回车也是发出去(浮层还开着,但内容一模一样)", () => {
    const sent: string[] = []
    const { app, press } = makeApp(undefined, undefined, (text) => sent.push(text))
    try {
      press("/permission")
      press("\r")
      expect(sent).toEqual(["/permission"])
    } finally {
      app.dispose()
    }
  })

  test("★ 打普通话不会被补全抢键", () => {
    const { app, editor, press } = makeApp()
    try {
      press("fix the bug")
      press("\t")
      // 没有补全时 tab 是换面板,输入内容一个字不动
      expect(editor.text).toBe("fix the bug")
    } finally {
      app.dispose()
    }
  })
})

// ───────────────────────────────────────────── @ 引用

describe("★ @ 引用文件", () => {
  const files = (query: string) =>
    ["src/tui/app.ts", "src/tui/panes/app.ts"]
      .filter((path) => path.includes(query))
      .map((path) => ({ value: "@" + path, hint: "", more: true }))

  test("一句话中间敲 @ 也弹,回车选中最上面那条", async () => {
    const { app, editor, press, screen } = makeApp(undefined, 100, () => {}, files)
    try {
      press("看一下 @src/tui/a")
      await frame(app)
      expect(screen().join("\n")).toContain("@src/tui/app.ts")
      press("\r")
      expect(editor.text).toBe("看一下 @src/tui/app.ts ")
    } finally {
      app.dispose()
    }
  })

  test("★ 打全了的回车照旧发出去 —— 和斜杠命令同一条规矩", () => {
    const sent: string[] = []
    const { app, press } = makeApp(undefined, 100, (text) => sent.push(text), files)
    try {
      press("看一下 @src/tui/app.ts")
      press("\r")
      expect(sent).toEqual(["看一下 @src/tui/app.ts"])
    } finally {
      app.dispose()
    }
  })

  test("tab 也能选中,和斜杠一样", () => {
    const { app, editor, press } = makeApp(undefined, 100, () => {}, files)
    try {
      press("@src/tui/pa")
      press("\t")
      expect(editor.text).toBe("@src/tui/panes/app.ts ")
    } finally {
      app.dispose()
    }
  })

  test("★ 一条候选都没有时 tab 回到「换面板」,不吞键", () => {
    const { app, editor, press } = makeApp(undefined, 100, () => {}, files)
    try {
      press("@zzz")
      press("\t")
      expect(editor.text).toBe("@zzz")
    } finally {
      app.dispose()
    }
  })

  test("★ 候选行不许超出浮层 —— 长路径要从左边截", async () => {
    const long = (query: string) =>
      ["src/very/deeply/nested/directory/structure/that/keeps/going/component.ts"]
        .filter((path) => path.includes(query))
        .map((path) => ({ value: "@" + path, hint: "", more: true }))
    const { app, press, screen } = makeApp(undefined, 100, () => {}, long)
    try {
      press("@component")
      await frame(app)
      for (const line of screen()) expect(line.length).toBeLessThanOrEqual(100)
      expect(screen().join("\n")).toContain("component.ts")
    } finally {
      app.dispose()
    }
  })
})

// ───────────────────────────────────────────── 我在哪

describe("★ 界面上必须常驻写着「这是哪」", () => {
  test("home 底下的路径折成 ~ —— 那一截每条路径都一样,占的是有用的位置", () => {
    const home = homedir()
    expect(homePath(join(home, "code", "x"))).toBe("~/code/x")
    expect(homePath(home)).toBe("~")
    expect(homePath("/tmp/x")).toBe("/tmp/x")
  })

  test("名字取根、路径取 cwd —— 在子目录里启动时两样都在屏幕上", () => {
    const label = workspaceLabel("/tmp/repo", "/tmp/repo/src/cli")
    expect(label.name).toBe("repo")
    expect(label.path).toBe("/tmp/repo/src/cli")
    // 根就是 cwd 时退化成同一个
    expect(workspaceLabel("/tmp/repo").path).toBe("/tmp/repo")
  })

  test("★ 文件树的标题是工作区的名字 —— 底下摆着一棵树,写「files」等于没写", async () => {
    const { app, screen, dispose } = makeApp()
    try {
      await frame(app)
      expect(screen()[0]).toContain("alfa-workspace")
    } finally {
      dispose()
    }
  })

  test("★ 状态行第一格就是工作区路径", async () => {
    const { app, screen, dispose } = makeApp()
    try {
      await frame(app)
      const status = statusOf(screen()) ?? ""
      expect(status).toContain("~/code/alfa-workspace")
      // 路径在模型名前面:挤的时候先掉的该是右边那些提示
      expect(status.indexOf("~/code")).toBeLessThan(status.indexOf("test/model"))
    } finally {
      dispose()
    }
  })

  test("★ 模型名每帧现取 —— /model 换完之后状态行必须跟着变", async () => {
    let spec = "anthropic/claude-sonnet-4-5"
    const { app, screen, dispose } = makeApp(undefined, 100, undefined, undefined, { label: () => spec })
    try {
      await frame(app)
      expect(statusOf(screen()) ?? "").toContain("claude-sonnet-4-5")
      // 换掉。捕获一份存住的地方会永远停在旧的那个
      spec = "minimax/MiniMax-M3"
      await frame(app)
      const status = statusOf(screen()) ?? ""
      expect(status).toContain("MiniMax-M3")
      expect(status).not.toContain("claude-sonnet")
    } finally {
      dispose()
    }
  })

  test("★ 窄屏上路径从左边收,而且宁可整条丢掉键位提示也不截模型名", async () => {
    const workspace = { name: "alfa-workspace", path: "~/code/alfa-labs/subtools/alfa-workspace" }
    const { app, screen, dispose } = makeApp(workspace, 60)
    try {
      await frame(app)
      const status = statusOf(screen()) ?? ""
      expect(status).toContain("…/alfa-workspace") // 尾巴留着,头上那截扔掉
      expect(status).toContain("test/model")
      expect(status).not.toContain("ctrl-c") // 键位提示是这一行里唯一能牺牲的
      expect(displayWidth(status)).toBeLessThanOrEqual(60)
    } finally {
      dispose()
    }
  })
})

describe("★ 换一场会话接着聊", () => {
  const info = (id: string, preview: string): SessionInfo => ({
    id,
    title: "",
    directory: "/repo",
    timeCreated: 0,
    timeUpdated: 0,
    summary: "",
    messages: 6,
    preview,
  })

  test("浮层里列出会话,回车把选中的那场交出去", async () => {
    const { app, screen, picked, press, dispose } = makeApp()
    try {
      app.openSessionPicker([info("a", "第一场"), info("b", "第二场")], "a")
      await frame(app)
      expect(screen().join("\n")).toContain("第二场")
      press(String.fromCharCode(27) + "[B") // ↓
      press("\r")
      expect(picked.map((s) => s.id)).toEqual(["b"])
    } finally {
      dispose()
    }
  })

  test("esc 是不挑了 —— 而且不能顺手把输入框里的草稿清掉", async () => {
    const { app, editor, picked, press, dispose } = makeApp()
    try {
      editor.setText("写了一半的话")
      app.openSessionPicker([info("a", "第一场")], "a")
      await frame(app)
      press(String.fromCharCode(27))
      expect(picked).toEqual([])
      expect(editor.text).toBe("写了一半的话")
    } finally {
      dispose()
    }
  })

  test("★ 跑着的时候不给换:这一轮的工具还在往当前这场里写", async () => {
    const { app, screen, dispose } = makeApp()
    try {
      app.setBusy(true)
      app.openSessionPicker([info("a", "第一场")], "a")
      await frame(app)
      expect(screen().join("\n")).not.toContain("第一场")
      expect(statusOf(screen()) ?? "").toContain("esc")
    } finally {
      dispose()
    }
  })
})

describe("★ 滚动条", () => {
  const plain = (input: { total: number; height: number; offset: number }) =>
    scrollbarColumn(input).map((cell) => stripAnsi(cell)).join("")

  test("装得下就不画 —— 空槽也不会说谎:它就是「没有东西被藏起来」", () => {
    expect(plain({ total: 3, height: 10, offset: 0 })).toBe(" ".repeat(10))
    expect(plain({ total: 10, height: 10, offset: 0 })).toBe(" ".repeat(10))
  })

  test("滑块长度按可见比例走", () => {
    // 20 行内容显示 10 行 → 滑块占一半
    expect(plain({ total: 20, height: 10, offset: 0 })).toBe("█████┊┊┊┊┊")
  })

  test("★ 在顶就贴顶,在底就贴底 —— 差一行会让人以为下面还剩一点没看", () => {
    expect(plain({ total: 20, height: 10, offset: 0 }).startsWith("█")).toBe(true)
    expect(plain({ total: 20, height: 10, offset: 10 }).endsWith("█")).toBe(true)
    expect(plain({ total: 20, height: 10, offset: 10 })).toBe("┊┊┊┊┊█████")
  })

  test("★ 一万行也留得下滑块 —— 按比例算出来是 0 行的话等于没有滚动条", () => {
    expect(plain({ total: 10_000, height: 10, offset: 0 })).toContain("█")
  })

  test("越界的 offset 夹住,不画到框外", () => {
    expect(plain({ total: 20, height: 10, offset: 999 })).toBe("┊┊┊┊┊█████")
    expect(plain({ total: 20, height: 10, offset: -5 })).toBe("█████┊┊┊┊┊")
  })

  test("★ 贴上去之后每行正好是面板宽度 —— 超一列就盖穿隔壁面板", () => {
    const lines = attachScrollbar(["ab", "", "很长很长很长的一行内容"], scrollbarColumn({ total: 9, height: 3, offset: 0 }), 10)
    for (const line of lines) expect(displayWidth(line)).toBe(10)
  })
})

describe("★ 滚动条能拖", () => {
  test("点哪儿滑块就居中到哪儿:顶上一行 → 0,最下一行 → 到底", () => {
    expect(offsetForRow(0, { total: 100, height: 10 })).toBe(0)
    expect(offsetForRow(9, { total: 100, height: 10 })).toBe(90)
    // 装得下的时候拖不动 —— 没有东西被藏起来
    expect(offsetForRow(5, { total: 4, height: 10 })).toBe(0)
  })

  test("拖出面板上下边就停在两头,不会算出负数或者越过末尾", () => {
    expect(offsetForRow(-20, { total: 100, height: 10 })).toBe(0)
    expect(offsetForRow(999, { total: 100, height: 10 })).toBe(90)
  })

  const withBigTree = (fn: (tree: TreePane) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "apc-bar-"))
    try {
      for (let i = 0; i < 30; i++) writeFileSync(join(dir, `f${String(i).padStart(2, "0")}.txt`), "x\n")
      fn(new TreePane(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test("文件树:拖到底就看得到最后那个文件", () => {
    withBigTree((tree) => {
      expect(tree.render(30, 10, false).join("\n")).toContain("f00.txt")
      tree.scrubTo(9, 10)
      const rows = tree.render(30, 10, false).join("\n")
      expect(rows).toContain("f29.txt")
      expect(rows).not.toContain("f00.txt")
    })
  })

  test("★ 手动滚开之后,选中项不许再把视野拽回去 —— 用户是在看别处", () => {
    withBigTree((tree) => {
      // 选中项还在第一行,视野拖到了最下面
      tree.scrubTo(9, 10)
      expect(tree.render(30, 10, false).join("\n")).toContain("f29.txt")
      // 再画一帧也不能跳回去
      expect(tree.render(30, 10, false).join("\n")).toContain("f29.txt")
      // 但键盘一动选中项,视野就该跟过去
      tree.move(1)
      expect(tree.render(30, 10, false).join("\n")).toContain("f01.txt")
    })
  })

  test("★ 点在滚动条那一列上是「滚」,不是「选中那一行」", async () => {
    const { app, screen, press, dispose } = makeApp()
    try {
      await frame(app)
      const before = app.tree.selectedNode?.name
      // 树的最右边一列(布局:左栏 x=1..26,滚动条在 0 基的 26 → SGR 里是 27)
      press(String.fromCharCode(27) + "[<0;27;5M")
      press(String.fromCharCode(27) + "[<0;27;5m")
      await frame(app)
      // 那一下没有选中第 5 行 —— 它是拿来滚的
      expect(app.tree.selectedNode?.name).toBe(before)
      expect(treeOpen(screen())).toBe(true)
    } finally {
      dispose()
    }
  })

  test("点在面板里(不是滚动条那一列)照旧是选中那一行", async () => {
    const { app, press, dispose } = makeApp()
    try {
      await frame(app)
      press(String.fromCharCode(27) + "[<0;5;4M")
      await frame(app)
      expect(app.tree.selectedNode?.name).not.toBe("bin") // 点的是第 3 行
    } finally {
      dispose()
    }
  })
})


// ───────────────────────────────────────────── 左下角的计划

describe("★ 计划在会话栏里", () => {
  const withPlan = (planRows: number, height = 30, width = 120) =>
    computeLayout({ width, height, inputHeight: 1, planRows })

  test("有计划才切,切完两块加中间那条线正好等于原来的高度", () => {
    const none = withPlan(0)
    expect(none.plan).toBeUndefined()
    expect(none.planRule).toBe(-1)

    const some = withPlan(5)
    expect(some.plan).toBeDefined()
    // 对话 + 横线 + 计划 = 原来整栏的高度。差一行就是整个中间栏错位
    expect(some.chat.height + 1 + some.plan!.height).toBe(none.chat.height)
    expect(some.planRule).toBe(some.chat.y + some.chat.height)
    expect(some.plan!.y).toBe(some.planRule + 1)
    // ★ 它和对话同宽、同一列 —— 左栏现在只剩文件树
    expect(some.plan!.x).toBe(some.chat.x)
    expect(some.tree!.height).toBe(none.tree!.height)
  })

  test("★ 对话 / 计划 / 输入,三块严丝合缝", () => {
    const l = computeLayout({ width: 120, height: 34, inputHeight: 1, planRows: 4 })
    expect(l.plan).toBeDefined()
    expect(l.chat.y + l.chat.height).toBe(l.planRule)
    expect(l.plan!.y + l.plan!.height).toBe(l.inputRule)
  })

  test("★ 对话至少留几行 —— 再挤就轮到计划让", () => {
    for (let height = 8; height <= 40; height++) {
      const l = withPlan(20, height)
      if (!l.plan) continue
      expect(l.chat.height).toBeGreaterThanOrEqual(LAYOUT_LIMITS.CHAT_MIN_ROWS)
    }
  })

  test("计划再长也不许超过这一栏一半", () => {
    const l = withPlan(99, 30)
    const column = l.chat.height + 1 + l.plan!.height
    expect(l.plan!.height).toBeLessThanOrEqual(Math.floor(column / 2))
  })

  test("★ 窄屏没了左栏,计划照样在 —— 它现在长在对话那一栏里", () => {
    const l = withPlan(5, 30, 50)
    expect(l.tree).toBeUndefined()
    expect(l.plan).toBeDefined()
    expect(l.plan!.x).toBe(l.chat.x)
  })

  test("★ 收起来只留标题那一行 —— 那一行右端的 [+] 就是再展开的入口", () => {
    const hidden = computeLayout({
      width: 120,
      height: 30,
      inputHeight: 1,
      planRows: 5,
      hidden: new Set(["plan" as const]),
    })
    expect(hidden.plan).toBeUndefined()
    // 横线还在(planRule >= 0),正文没了 —— 这就是「收起来的那一档」
    expect(hidden.planRule).toBeGreaterThan(0)
    expect(hidden.chat.height).toBe(computeLayout({ width: 120, height: 30, inputHeight: 1 }).chat.height - 1)
  })

  test("这一场根本没有计划时,连那条横线也不画", () => {
    const none = computeLayout({ width: 120, height: 30, inputHeight: 1, planRows: 0, hidden: new Set(["plan" as const]) })
    expect(none.planRule).toBe(-1)
    expect(none.chat.height).toBe(computeLayout({ width: 120, height: 30, inputHeight: 1 }).chat.height)
  })
})

describe("★ 每一块都收得起来,也都找得回来", () => {
  const todo = (text: string) => ({
    type: "tool.state" as const,
    part: {
      id: "p1",
      sessionID: "s",
      messageID: "m",
      timeCreated: 0,
      type: "tool" as const,
      callID: "p1",
      tool: "todo",
      state: {
        status: "completed" as const,
        input: {},
        output: "plan",
        time: { start: 0, end: 1 },
        metadata: { todos: [{ text, status: "active" }] },
      },
    },
  })

  test("★ 点标题也能收 —— 快捷键写在 /help 里,没人为了收一栏去翻帮助", async () => {
    const { app, press, screen, dispose } = makeApp()
    try {
      await frame(app)
      expect(treeOpen(screen())).toBe(true)
      // 点第 0 行(标题那行)左栏范围内的一格
      press("\u001b" + "[<0;6;1M")
      await frame(app)
      expect(treeOpen(screen())).toBe(false)
      // 收完原地留着那条轨,顶上一个 [+] —— 状态行因此不必再说一遍
      expect(screen()[0] ?? "").toContain("[+]")
    } finally {
      dispose()
    }
  })
})


// ───────────────────────────────────────────── 独立出去的工具看板

describe("★ 工具是回答过程的一部分,不是一块面板", () => {
  const call = (id: string, name: string) => ({
    type: "tool.state" as const,
    part: {
      id,
      sessionID: "s",
      messageID: "m",
      timeCreated: 0,
      type: "tool" as const,
      callID: id,
      tool: "bash",
      state: {
        status: "completed" as const,
        input: { command: name },
        output: "",
        time: { start: 0, end: 1 },
        metadata: { exit: 0 },
      },
    },
  })

  test("★ 一串调用就接在回答底下列出来,没有单独的一块", async () => {
    const { app, chat, screen, dispose } = makeApp(undefined, 120)
    try {
      for (let i = 0; i < 8; i++) chat.handle(call(`c${i}`, `step-${i}`))
      await frame(app)
      const painted = screen()
      const at = (text: string) => painted.findIndex((line) => line.includes(text))
      // 一次调用一行,按发生顺序往下接 —— 它是一条经过,不是一块面板
      expect(at("step-0")).toBeGreaterThan(0)
      expect(at("step-7")).toBeGreaterThan(at("step-0"))
      // 没有 `├─ tools ──┤` 那条横线了
      expect(painted.join("\n")).not.toContain("tools")
    } finally {
      dispose()
    }
  })

  test("★ 换一场就没了 —— 它讲的是这一轮在干什么", async () => {
    const { app, chat, screen, dispose } = makeApp(undefined, 120)
    try {
      chat.handle(call("c1", "bun test"))
      await frame(app)
      expect(screen().join("\n")).toContain("bun test")
      chat.clear()
      await frame(app)
      expect(screen().join("\n")).not.toContain("bun test")
    } finally {
      dispose()
    }
  })
})


// ───────────────────────────────────────────── 收起来之后留下的把手

describe("★ 收起来的栏在原地留一个 [+]", () => {
  const todo = (text: string) => ({
    type: "tool.state" as const,
    part: {
      id: "p1", sessionID: "s", messageID: "m", timeCreated: 0, type: "tool" as const, callID: "p1", tool: "todo",
      state: {
        status: "completed" as const, input: {}, output: "plan", time: { start: 0, end: 1 },
        metadata: { todos: [{ text, status: "active" }] },
      },
    },
  })
  const bash = (command: string) => ({
    type: "tool.state" as const,
    part: {
      id: "b1", sessionID: "s", messageID: "m", timeCreated: 0, type: "tool" as const, callID: "b1", tool: "bash",
      state: {
        status: "completed" as const, input: { command }, output: "", time: { start: 0, end: 1 },
        metadata: { exit: 0 },
      },
    },
  })

  test("★ ctrl-p 收计划:内容没了,但那条横线和 [+] 还在", async () => {
    const { app, chat, press, screen, dispose } = makeApp(undefined, 120)
    try {
      chat.handle(todo("把滚动条拆出去"))
      await frame(app)
      expect(screen().join("\n")).toContain("把滚动条拆出去")

      press("\u0010")
      await frame(app)
      const painted = screen().join("\n")
      // 内容确实没了(也没有偷偷挪到中间栏去)
      expect(painted).not.toContain("把滚动条拆出去")
      // 但原地留着把手:标题 + [+]
      expect(painted).toContain("[+]")
      expect(painted).toContain("plan")

      press("\u0010")
      await frame(app)
      expect(screen().join("\n")).toContain("把滚动条拆出去")
    } finally {
      dispose()
    }
  })

  test("★ ctrl-b 收文件树:原地留一条三列宽的轨,顶上一个 [+]", async () => {
    const { app, press, screen, dispose } = makeApp(undefined, 120)
    try {
      await frame(app)
      expect(treeOpen(screen())).toBe(true)
      press("\u0002")
      await frame(app)
      expect(treeOpen(screen())).toBe(false)
      // 顶上那一行就是把手
      expect(screen()[0] ?? "").toContain("[+]")
    } finally {
      dispose()
    }
  })

  test("★ 点那条轨就展开回来 —— 不必去够顶上那三格", async () => {
    const { app, press, screen, dispose } = makeApp(undefined, 120)
    try {
      await frame(app)
      press("\u0002")
      await frame(app)
      expect(treeOpen(screen())).toBe(false)
      // 轨在最左边(x=1..3),点它中间那一行
      press("\u001b" + "[<0;3;6M")
      await frame(app)
      expect(treeOpen(screen())).toBe(true)
    } finally {
      dispose()
    }
  })

  test("★ 原地留了把手就不在状态行上再说一遍", async () => {
    const { app, press, screen, dispose } = makeApp(undefined, 120)
    try {
      await frame(app)
      press("\u0002")
      await frame(app)
      // 轨已经在原地了,状态行不该再挂一个 [ctrl-b files]
      expect(statusOf(screen()) ?? "").not.toContain("ctrl-b")
    } finally {
      dispose()
    }
  })
})


describe("★ 收起来的轨上写着这是什么", () => {
  test("★ 两栏都收了也分得清哪条是哪条 —— 三个 [+] 长得一模一样", async () => {
    const { app, press, screen, dispose } = makeApp(undefined, 120)
    try {
      await frame(app)
      press("\u0002")
      press("\u001d")
      await frame(app)
      const painted = screen()
      // 栏名竖着写在轨上,一行一个字
      const column = (x: number) =>
        painted
          .slice(1, 12)
          .map((line) => line[x] ?? " ")
          .join("")
          .trim()
      // 左边那条(x=1..3,字在正中那一列)
      expect(column(2)).toContain("f")
      expect(column(2)).toContain("s")
      // 右边那条在最右侧
      const right = painted[0] ?? ""
      expect(right.lastIndexOf("[+]")).toBeGreaterThan(right.indexOf("[+]"))
    } finally {
      dispose()
    }
  })

  test("轨窄到写不下也不会超宽", async () => {
    const { app, press, screen, dispose } = makeApp(undefined, 120)
    try {
      await frame(app)
      press("\u0002")
      await frame(app)
      for (const line of screen()) expect(line.length).toBeLessThanOrEqual(120)
    } finally {
      dispose()
    }
  })
})

describe("★ 后台任务排在计划下面", () => {
  const job = (id: string, over: Partial<JobSnapshot> = {}): JobSnapshot => ({
    id,
    kind: "process",
    command: "npm run dev",
    workdir: "/repo",
    status: "running",
    startedAt: 0,
    pending: 0,
    ...over,
  })

  test("对话 / 计划 / 任务 / 输入,自上而下严丝合缝", () => {
    const l = computeLayout({ width: 120, height: 40, inputHeight: 1, planRows: 4, jobRows: 2 })
    expect(l.plan).toBeDefined()
    expect(l.jobs).toBeDefined()
    expect(l.chat.y + l.chat.height).toBe(l.planRule)
    expect(l.plan!.y + l.plan!.height).toBe(l.jobRule)
    expect(l.jobs!.y + l.jobs!.height).toBe(l.inputRule)
    // 和对话同宽同列 —— 它长在中间栏里
    expect(l.jobs!.x).toBe(l.chat.x)
  })

  test("没有在跑的就整块不画,连横线也没有", () => {
    const l = computeLayout({ width: 120, height: 40, inputHeight: 1, planRows: 4, jobRows: 0 })
    expect(l.jobs).toBeUndefined()
    expect(l.jobRule).toBe(-1)
    // 这一块不占地方时,高度要原封不动还给对话
    const same = computeLayout({ width: 120, height: 40, inputHeight: 1, planRows: 4 })
    expect(l.chat.height).toBe(same.chat.height)
  })

  test("没有计划也能单独出现 —— 两块互不依赖", () => {
    const l = computeLayout({ width: 120, height: 40, inputHeight: 1, jobRows: 2 })
    expect(l.plan).toBeUndefined()
    expect(l.jobs).toBeDefined()
    expect(l.chat.y + l.chat.height).toBe(l.jobRule)
  })

  test("★ 挤的时候正文照样留得住", () => {
    for (let height = 8; height <= 44; height++) {
      const l = computeLayout({ width: 120, height, inputHeight: 1, planRows: 8, jobRows: 8 })
      if (!l.jobs && !l.plan) continue
      expect(l.chat.height).toBeGreaterThanOrEqual(LAYOUT_LIMITS.CHAT_MIN_ROWS)
      expect(l.inputRule).toBeGreaterThan(l.chat.y)
    }
  })
})

describe("★ 跑完的任务过几秒自己走", () => {
  const at = 1_000_000
  const snapshot = (over: Partial<JobSnapshot>): JobSnapshot => ({
    id: "j1",
    kind: "process",
    command: "npm run dev",
    workdir: "/repo",
    status: "running",
    startedAt: at,
    pending: 0,
    ...over,
  })

  test("还在跑的一直留着,不倒计时", () => {
    const pane = new JobsPane()
    pane.set([snapshot({})], at + 1_000_000)
    expect(pane.empty).toBe(false)
    expect(pane.retireAt(at)).toBe(0)
  })

  test("★ 跑完先留一会儿(要能看清是成是败),到点才消失", () => {
    const done = snapshot({ status: "exited", endedAt: at, exit: 1 })
    const pane = new JobsPane()

    pane.set([done], at + 100)
    expect(pane.empty).toBe(false)
    // 留着的这几秒要写清怎么结束的 —— 只换个符号的话,成和败长得太像
    expect(stripAnsi(pane.render(40, 4).join("\n"))).toContain("exit 1")
    // 而且要安排一次"到点了叫醒我" —— 空闲时界面根本不重绘
    expect(pane.retireAt(at + 100)).toBe(at + JOB_LINGER_MS)

    pane.set([done], at + JOB_LINGER_MS + 1)
    expect(pane.empty).toBe(true)
  })

  test("跑完的不算进右上角那个数 —— 它数的是「还有几个在跑」", () => {
    const pane = new JobsPane()
    pane.set([snapshot({ id: "j1" }), snapshot({ id: "j2", status: "exited", endedAt: at, exit: 0 })], at + 100)
    expect(pane.note).toBe("1")
  })
})

describe("★ 后台任务那一块画在屏幕上", () => {
  test("画出来在计划下面、输入框上面,而且跑完几秒之后自己没了", async () => {
    const jobs: JobSnapshot[] = [
      { id: "j1", kind: "process", command: "npm run dev", workdir: "/repo", status: "running", startedAt: 0, pending: 0 },
    ]
    const h = makeApp(undefined, undefined, undefined, undefined, { jobs: () => jobs })
    await frame(h.app)

    const shown = h.screen()
    const rule = shown.findIndex((line) => line.includes("background"))
    const row = shown.findIndex((line) => line.includes("npm run dev"))
    expect(rule).toBeGreaterThan(0)
    // 横线在上,任务行紧跟着
    expect(row).toBe(rule + 1)
    // 输入框在它下面 —— 顺序是 对话 / 任务 / 输入
    const input = shown.findIndex((line) => line.includes("›") || line.includes("▌"))
    if (input >= 0) expect(input).toBeGreaterThan(row)
    h.dispose()
  })

  test("一个都没有的时候,那条横线也不该出现", async () => {
    const h = makeApp(undefined, undefined, undefined, undefined, { jobs: () => [] })
    await frame(h.app)
    expect(h.screen().some((line) => line.includes("background"))).toBe(false)
    h.dispose()
  })
})

describe("★ agentflow 开着这件事得一直看得见", () => {
  const agent = (over: Partial<JobSnapshot> = {}): JobSnapshot => ({
    id: "scout",
    kind: "agent",
    command: "look around",
    workdir: "/repo",
    status: "running",
    startedAt: Date.now(),
    pending: 0,
    ...over,
  })

  test("关着的时候输入框上沿什么都不多写", async () => {
    const h = makeApp(undefined, undefined, undefined, undefined, { agentflow: () => false })
    await frame(h.app)
    expect(h.screen().join("\n")).not.toContain("agentflow")
    h.dispose()
  })

  test("★ 开着就钉在输入框正上方 —— 横幅说过一次就滚走了,而这个开关一直生效", async () => {
    const h = makeApp(undefined, undefined, undefined, undefined, { agentflow: () => 6 })
    await frame(h.app)
    const shown = h.screen()
    const chip = shown.findIndex((line) => line.includes("agentflow"))
    expect(chip).toBeGreaterThan(0)
    // 就在输入框那一行的上面 —— 这块牌子的位置本身就是它要说的话
    const input = shown.findIndex((line) => line.includes("›"))
    expect(input).toBe(chip + 1)
    h.dispose()
  })

  test("一有人在跑就换成进度 —— 那个数每秒都在变,它自己就是动效", async () => {
    const h = makeApp(undefined, undefined, undefined, undefined, {
      agentflow: () => 6,
      agents: () => [agent(), agent({ id: "scout-2", status: "exited", endedAt: Date.now(), exit: 0 })],
    })
    await frame(h.app)
    const shown = h.screen().join("\n")
    expect(shown).toContain("agentflow 1/2")
    h.dispose()
  })
})

describe("★ 排队的话一次全取走", () => {
  test("★ 一轮跑完把排着的几句拼成一条,不是一条一条来", async () => {
    const sent: string[] = []
    const h = makeApp(undefined, undefined, (text) => sent.push(text))
    await frame(h.app)

    // 跑起来之后敲三句:全进队列,一句都不发
    h.app.setBusy(true)
    h.press("顺便把测试跑一下\r")
    h.press("还有 README\r")
    h.press("对了别忘了 lint\r")
    expect(sent).toEqual([])

    // 一轮结束:一次取走全部,拼成一条
    const next = h.app.takeQueued()
    expect(next).toBe("顺便把测试跑一下\n还有 README\n对了别忘了 lint")
    // 取完就空了 —— 主循环下一次问会拿到 undefined,于是回去等用户
    expect(h.app.takeQueued()).toBeUndefined()
    h.dispose()
  })

  test("★ 跑着的时候插一句:直接递进这一轮,不再排队等它结束", async () => {
    const sent: string[] = []
    const live: string[] = []
    const h = makeApp(undefined, undefined, (text) => sent.push(text), undefined, {
      onSubmitBusy: (text) => {
        live.push(text)
        return true
      },
    })
    await frame(h.app)

    h.app.setBusy(true)
    h.press("先别看那个了,跑一下测试\r")
    expect(live).toEqual(["先别看那个了,跑一下测试"])
    expect(sent).toEqual([])
    // 已经递进去了,这一轮结束时**不能再发一遍** —— 它上一轮就被答过了
    expect(h.app.takeQueued()).toBeUndefined()
    h.dispose()
  })

  test("★ 递进去的那句照旧挂在「你说的话」下面 —— 敲完就没痕迹的话,用户以为字丢了", async () => {
    const h = makeApp(undefined, undefined, () => {}, undefined, { onSubmitBusy: () => true })
    await frame(h.app)
    h.app.setBusy(true)
    h.press("顺便把 README 也改了\r")
    await frame(h.app)
    expect(h.screen().join("\n")).toContain("顺便把 README 也改了")
    h.dispose()
  })

  test("宿主说这句递不进去(斜杠命令)就照老规矩排队", async () => {
    const h = makeApp(undefined, undefined, () => {}, undefined, { onSubmitBusy: () => false })
    await frame(h.app)
    h.app.setBusy(true)
    h.press("/clear\r")
    expect(h.app.takeQueued()).toBe("/clear")
    h.dispose()
  })

  test("没接 onSubmitBusy 的宿主照旧全排队", async () => {
    const h = makeApp()
    await frame(h.app)
    h.app.setBusy(true)
    h.press("一句话\r")
    expect(h.app.takeQueued()).toBe("一句话")
    h.dispose()
  })

  test("没排队就是没有", async () => {
    const h = makeApp()
    await frame(h.app)
    expect(h.app.takeQueued()).toBeUndefined()
    h.dispose()
  })

  test("排着的那几句同时挂在「你说的话」下面", async () => {
    const h = makeApp()
    await frame(h.app)
    h.app.setBusy(true)
    h.chat.said("改一下 live.ts")
    h.press("顺便把测试跑一下\r")
    await frame(h.app)
    expect(h.screen().join("\n")).toContain("顺便把测试跑一下")
    h.dispose()
  })
})

// ─────────────────────────────────────────────── 子 agent 那一块

describe("★ 子 agent 自己那一块", () => {
  const at = 1_000_000
  const agent = (over: Partial<JobSnapshot> = {}): JobSnapshot => ({
    id: "audit",
    kind: "agent",
    command: "audit auth flow",
    workdir: "/repo",
    status: "running",
    startedAt: at,
    pending: 0,
    steps: 3,
    tokensIn: 34_000,
    tokensOut: 1_200,
    ...over,
  })

  test("一行里有名字、跑了多久、进出各多少 —— 这三个数就是它存在的理由", () => {
    const pane = new AgentsPane()
    pane.set([agent()], at + 72_000)
    const line = stripAnsi(pane.render(72, 4, at + 72_000).join("\n"))
    expect(line).toContain("audit")
    expect(line).toContain("1m12s")
    expect(line).toContain("34k")
    expect(line).toContain("1.2k")
    expect(line).toContain("audit auth flow")
  })

  test("★ 秒表要有人叫醒它 —— 空闲时界面不重绘,不安排的话时长会停在上次按键那一刻", () => {
    const pane = new AgentsPane()
    pane.set([agent()], at + 500)
    const next = pane.retireAt(at + 500)
    expect(next).toBeGreaterThan(at + 500)
    expect(next - (at + 500)).toBeLessThanOrEqual(1000)
  })

  test("跑完留一会儿再走,而账单在那几秒里还看得见", () => {
    const pane = new AgentsPane()
    const done = agent({ status: "exited", endedAt: at + 5_000, exit: 0 })
    pane.set([done], at + 6_000)
    expect(pane.empty).toBe(false)
    expect(stripAnsi(pane.render(72, 4, at + 6_000).join("\n"))).toContain("34k")
    // 到点之后自己消失
    pane.set([done], at + 5_000 + 60_000)
    expect(pane.empty).toBe(true)
  })

  test("挂在横线上那个数只算**还在跑的** —— 刚跑完那几秒不该让它变大", () => {
    const pane = new AgentsPane()
    pane.set([agent(), agent({ id: "scout", status: "exited", endedAt: at + 1_000, exit: 0 })], at + 2_000)
    expect(pane.note).toBe("1")
  })

  test("窄栏下先丢那句活儿,名字和时长永远留着", () => {
    const pane = new AgentsPane()
    pane.set([agent()], at + 72_000)
    const line = stripAnsi(pane.render(26, 4, at + 72_000)[0]!)
    expect(line.length).toBeLessThanOrEqual(26)
    expect(line).toContain("audit")
    expect(line).toContain("1m12s")
  })

  test("排队那一行不写秒表,写它在等谁 —— 「为什么它不动」是这一格唯一的问题", () => {
    const pane = new AgentsPane()
    pane.set([agent({ id: "verify", status: "queued", after: ["scout", "scout-2"] })], at + 30_000)
    const line = stripAnsi(pane.render(72, 4, at + 30_000)[0]!)
    expect(line).toContain("verify")
    expect(line).toContain("waiting for scout, scout-2")
    // 从排进队列就开始走的钟,读起来像"它干了 30 秒",而它一个请求都没发
    expect(line).not.toContain("30s")
  })

  // ── 第八个开始换成方格 ──

  const many = (n: number, over: (i: number) => Partial<JobSnapshot> = () => ({})): JobSnapshot[] =>
    Array.from({ length: n }, (_, i) => agent({ id: `job-${i}`, ...over(i) }))

  test("七个还是一行一个,第八个开始换成方格", () => {
    const pane = new AgentsPane()
    pane.set(many(7), at)
    expect(pane.rowsNeeded(76)).toBe(7)
    pane.set(many(8), at)
    // 一行总进度 + 两行方格(四列)
    expect(pane.rowsNeeded(76)).toBe(3)
  })

  test("★ 十六个占五行 —— 一行一个的画法在这儿会被截成「还有 N 个」", () => {
    const pane = new AgentsPane()
    pane.set(many(16), at)
    expect(pane.rowsNeeded(76)).toBe(5)
    const rows = pane.render(76, 5, at)
    expect(rows).toHaveLength(5)
    for (const row of rows) expect(stripAnsi(row).length).toBeLessThanOrEqual(76)
  })

  test("方格里三种状态是三种填充度:排队 ░、在跑 ▒▓、完了 █", () => {
    const pane = new AgentsPane()
    pane.set(
      many(8, (i) =>
        i < 3
          ? { status: "exited", endedAt: at + 1_000, exit: 0 }
          : i < 6
            ? { status: "running" }
            : { status: "queued" },
      ),
      at + 2_000,
    )
    const grid = stripAnsi(pane.render(76, 3, at + 2_000).slice(1).join("\n"))
    expect(grid.match(/█/g)).toHaveLength(3)
    expect((grid.match(/▒/g) ?? []).length + (grid.match(/▓/g) ?? []).length).toBe(3)
    expect(grid.match(/░/g)).toHaveLength(2)
  })

  test("跑挂的那格照旧是实心的,但记号是 ✗ —— 填满了不等于办成了", () => {
    const pane = new AgentsPane()
    pane.set(many(8, (i) => (i === 0 ? { status: "exited", endedAt: at + 1_000, exit: 1 } : {})), at + 2_000)
    const cells = stripAnsi(pane.render(76, 3, at + 2_000)[1]!)
    expect(cells.startsWith(" █ job-0")).toBe(true)
    expect(cells).toContain("✗")
  })

  test("★ 头一行写总进度和**总花费** —— 一格一格的方阵自己说不出 9/16", () => {
    const pane = new AgentsPane()
    // 先全在跑,再有九个跑完 —— 这一趟是这么走过来的
    pane.set(many(16), at)
    pane.set(many(16, (i) => (i < 9 ? { status: "exited", endedAt: at + 1_000, exit: 0 } : {})), at + 82_000)
    const head = stripAnsi(pane.render(90, 5, at + 82_000)[0]!)
    expect(head).toContain("9/16")
    // 16 × 34k 进 / 16 × 1.2k 出
    expect(head).toContain("544k in")
    expect(head).toContain("19k out")
    expect(head).toContain("1m22s")
    expect(pane.note).toBe("9/16")
  })

  test("★ 已经跑完的那些**不能边跑边掉**,否则总进度永远是 3/5", () => {
    const pane = new AgentsPane()
    const flow = many(16, (i) => (i < 9 ? { status: "exited", endedAt: at + 1_000, exit: 0 } : {}))
    // 那九个跑完已经过去一分钟了,而这一趟还没散 —— 它们必须还在方阵里
    pane.set(many(16), at)
    pane.set(flow, at + 61_000)
    expect(stripAnsi(pane.render(90, 5, at + 61_000)[0]!)).toContain("9/16")

    // 全停下来之后一起过 linger,然后整块消失
    const done = flow.map((job) => ({ ...job, status: "exited" as const, endedAt: at + 62_000, exit: 0 }))
    pane.set(done, at + 63_000)
    expect(stripAnsi(pane.render(90, 5, at + 63_000)[0]!)).toContain("16/16")
    pane.set(done, at + 200_000)
    expect(pane.empty).toBe(true)
  })

  test("在跑的那几格要呼吸,而全跑完之后不再要帧 —— 动效不该白烧 CPU", () => {
    const pane = new AgentsPane()
    pane.set(many(8), at)
    const soon = pane.retireAt(at)
    expect(soon - at).toBeLessThanOrEqual(500)

    pane.set(many(8, () => ({ status: "exited", endedAt: at + 1_000, exit: 0 })), at + 2_000)
    // 剩下的只有"该散场了"那一下,不是每 450 毫秒一帧
    expect(pane.retireAt(at + 2_000) - (at + 2_000)).toBeGreaterThan(500)
  })

  test("窄栏减列,不减内容", () => {
    const pane = new AgentsPane()
    pane.set(many(8), at)
    // 30 列只放得下两格
    expect(pane.rowsNeeded(30)).toBe(1 + 4)
    for (const row of pane.render(30, 5, at)) expect(stripAnsi(row).length).toBeLessThanOrEqual(30)
  })
})

// ─────────────────────────────────────────────── 画面花了怎么办

/**
 * ★ `Screen.invalidate()` 一度是**写好了但全仓一处都没调用**的:一旦我们
 *   记错了屏幕现在长什么样(带肤色的 emoji、组合符、终端把 ambiguous 当双宽),
 *   那一行往后的列就整体错位,而差分从此永远拿一份错的 front 去比 ——
 *   那几格再也不会被重画。用户手里一个办法都没有。
 *
 *   ctrl-l 是那个办法。这个键在终端里的含义几十年没变过(readline、vim、
 *   less、tmux 全是它),画面花了的人会反射性地按它。
 */
describe("★ ctrl-l 重画", () => {
  test("★ 按完之后说一句 —— 不说的话它看起来什么都没发生", async () => {
    const { app, press, screen, dispose } = makeApp()
    try {
      await frame(app)
      press("\u000c")
      await frame(app)
      expect(screen().join("\n")).toContain("screen repainted")
    } finally {
      dispose()
    }
  })

  // ctrl-l 之前是「锁住右栏」。一个画面已经花了的人按下去,得到的是一个更花的
  // 画面加一个他没打算改的状态
  test("★ 锁右栏搬到了 ctrl-o", async () => {
    const { app, press, screen, dispose } = makeApp()
    try {
      await frame(app)
      press("\u000f") // ctrl-o
      await frame(app)
      expect(screen().join("\n")).toContain("detail locked")
    } finally {
      dispose()
    }
  })
})

describe("★ 侧栏按文件夹记", () => {
  test("panels: false 进来时两栏一起收 —— 只收一半看着像 bug", async () => {
    const { app, screen, dispose } = makeApp(undefined, 100, () => {}, undefined, { panels: false })
    try {
      await frame(app)
      const painted = screen().join("\n")
      // 树的内容和右栏的兜底文案都不该在 —— 标题写的是工作区名,不是 "files"
      expect(painted).not.toContain("▸ src")
      expect(painted).not.toContain("nothing to show yet")
    } finally {
      dispose()
    }
  })

  test("默认(不给这个键)照旧是三栏 —— 升级不该悄悄拿走谁的文件树", async () => {
    const { app, screen, dispose } = makeApp()
    try {
      await frame(app)
      const painted = screen().join("\n")
      expect(painted).toContain("▸ src")
      expect(painted).toContain("nothing to show yet")
    } finally {
      dispose()
    }
  })

  test("★ 在界面上开关过要报出去,不然下次进来又回到卡片上那个答案", async () => {
    const seen: boolean[] = []
    const { app, press, dispose } = makeApp(undefined, 100, () => {}, undefined, {
      panels: false,
      onPanelsChanged: (visible) => seen.push(visible),
    })
    try {
      await frame(app)
      press("\u0002") // ctrl-b:把文件树叫回来
      await frame(app)
      expect(seen).toEqual([true])
    } finally {
      dispose()
    }
  })
})

describe("★ ctrl-y 复制单子", () => {
  const targets: CopyTarget[] = [
    { kind: "code", label: "ts", hint: "const a = 1", text: "const a = 1" },
    { kind: "reply", label: "reply", hint: "here you go", text: "here you go" },
  ]

  test("列出来,而且键位提示写在框里", async () => {
    const { app, press, screen, dispose } = makeApp(undefined, 100, () => {}, undefined, {
      copyTargets: () => targets,
    })
    try {
      await frame(app)
      press("\u0019") // ctrl-y
      await frame(app)
      const painted = screen().join("\n")
      expect(painted).toContain("const a = 1")
      expect(painted).toContain("enter copy")
    } finally {
      dispose()
    }
  })

  test("再按一次 ctrl-y 关掉 —— 开它和关它是同一个键", async () => {
    const { app, press, screen, dispose } = makeApp(undefined, 100, () => {}, undefined, {
      copyTargets: () => targets,
    })
    try {
      await frame(app)
      press("\u0019")
      await frame(app)
      press("\u0019")
      await frame(app)
      expect(screen().join("\n")).not.toContain("enter copy")
    } finally {
      dispose()
    }
  })

  // 一个点了没反应的入口比没有入口更糟
  test("★ 没东西可复制时不开空框,状态行上说一句", async () => {
    const { app, press, screen, dispose } = makeApp(undefined, 100, () => {}, undefined, {
      copyTargets: () => [],
    })
    try {
      await frame(app)
      press("\u0019")
      await frame(app)
      const painted = screen().join("\n")
      expect(painted).not.toContain("enter copy")
      expect(painted).toContain("nothing to copy")
    } finally {
      dispose()
    }
  })

  test("状态行上那块牌子常驻 —— 看不见的复制功能等于没有", async () => {
    const { app, screen, dispose } = makeApp(undefined, 100, () => {}, undefined, {
      copyTargets: () => targets,
    })
    try {
      await frame(app)
      expect(screen().join("\n")).toContain("copy")
    } finally {
      dispose()
    }
  })
})

// ─────────────────────────────────────────────── 窄屏那一段的断崖

/**
 * ★ 86–95 列之间,把窗口**拉宽一列**会让对话栏塌掉一半。
 *
 * 「留哪几栏」是拿 `TREE.min`(16)算的,而分配拿的是 `TREE.ideal`(26) ——
 * 差的那 10 列没有别的来源,全从对话身上出。85 列时右栏被判成塞不下、整个
 * 收掉,对话拿到 56;86 列时三栏都留,对话只剩 26,而 `CHAT_MIN` 写着 36。
 *
 * 而 86~95 正是很常见的 tmux 分屏宽度。
 */
describe("★ 窄屏时对话栏的下限不许被破", () => {
  const { CHAT_MIN } = LAYOUT_LIMITS

  test("★ 80–160 列全程 chat ≥ CHAT_MIN", () => {
    const broken: Array<{ width: number; chat: number }> = []
    for (let width = 80; width <= 160; width++) {
      const l = computeLayout({ width, height: 40, inputHeight: 1 })
      if (l.chat.width < CHAT_MIN) broken.push({ width, chat: l.chat.width })
    }
    expect(broken).toEqual([])
  })

  /**
   * 断崖的形状。加宽一列而对话**变窄**,只允许发生在**多出一栏**的那一刻 ——
   * 那时候变窄是这一栏的代价,读得出因果。而 86 列那次不是:三栏在 85→86
   * 之间从两栏变三栏,同时对话掉到了 26,**低于它自己写着的下限**。
   *
   * 所以这里守的是「变窄必须有理由」,不是「永远不变窄」。
   */
  test("★ 对话变窄只能是因为多出了一栏", () => {
    const bad: Array<{ width: number; from: number; to: number; panes: number }> = []
    let previous = { chat: 0, panes: 0 }
    for (let width = 80; width <= 160; width++) {
      const l = computeLayout({ width, height: 40, inputHeight: 1 })
      const panes = 1 + (l.tree ? 1 : 0) + (l.detail ? 1 : 0)
      if (width > 80 && l.chat.width < previous.chat && panes <= previous.panes) {
        bad.push({ width, from: previous.chat, to: l.chat.width, panes })
      }
      previous = { chat: l.chat.width, panes }
    }
    expect(bad).toEqual([])
  })

  test("86 列上三栏都在,而且三条下限一条不破", () => {
    const l = computeLayout({ width: 86, height: 40, inputHeight: 1 })
    expect(l.tree).toBeDefined()
    expect(l.detail).toBeDefined()
    expect(l.tree!.width).toBeGreaterThanOrEqual(LAYOUT_LIMITS.TREE.min)
    expect(l.detail!.width).toBeGreaterThanOrEqual(LAYOUT_LIMITS.DETAIL.min)
    expect(l.chat.width).toBeGreaterThanOrEqual(CHAT_MIN)
  })

  test("宽下去之后树自己长回理想宽度", () => {
    expect(computeLayout({ width: 160, height: 40, inputHeight: 1 }).tree!.width).toBe(LAYOUT_LIMITS.TREE.ideal)
  })
})

/**
 * ★ 输入框上沿那条线**超宽**。
 *
 * 原来是 `fill = max(0, width - used - w(note) - 4)`,而 fill 夹到 0 之后总宽
 * 变成 `used + w(note) + 4`,和 width 再没有关系 —— 放不下的时候它不截断,
 * 只是不再补横线。合成器里超宽的一行会把右边框顶出去(README「四条规矩」第一条)。
 *
 * 现场是窄屏 + `/agentflow` 开着:左端那块牌子占 9 列,而右端量表的预算是
 * 调用方按 `ruleWidth - 8` 算的 —— 它不知道左边还挂着一块牌子。
 */
describe("★ 输入框上沿那条线永远不超宽", () => {
  const gauge = "▓▓░░░░░░░░░ ~18%"
  const flow = "agentflow 3/6"

  test("★ 窄到放不下时截断,而不是把边框顶出去", () => {
    for (let width = 8; width <= 60; width++) {
      for (const note of ["", gauge]) {
        for (const lead of ["", flow]) {
          const line = stripAnsi(inputDivider(width, note, lead))
          expect({ width, note, lead, got: displayWidth(line) }).toEqual({ width, note, lead, got: width })
        }
      }
    }
  })

  test("装得下的时候量表照旧完整出现", () => {
    expect(stripAnsi(inputDivider(60, gauge, flow))).toContain(gauge)
    expect(stripAnsi(inputDivider(60, gauge, flow))).toContain(flow)
  })

  // 一个被截成 `agent…` 的模式牌既读不出是什么,又照样占着位置
  test("★ 牌子放不下就整块不要,不截半个", () => {
    const line = stripAnsi(inputDivider(10, gauge, flow))
    expect(line).not.toContain("agent")
    expect(displayWidth(line)).toBe(10)
  })
})
