/**
 * 底部活动区。
 *
 * 这里只有一个真正致命的量:**擦除时往上退几行**。退少了会往上啃已经打出去
 * 的输出,退多了会把活动区自己复制一份留在屏幕上。两种都是不可逆的画面损坏,
 * 而且只在特定宽度/特定内容下出现 —— 肉眼在真终端上很难复现,只能靠断言盯。
 */
import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { LiveRegion } from "../src/cli/live.ts"

const ESC = String.fromCharCode(27)
const up = (n: number) => `${ESC}[${n}A`
const CLEAR_DOWN = `${ESC}[0J`

function fakeTerminal(columns = 40, rows = 24) {
  const chunks: string[] = []
  const emitter = new EventEmitter()
  const stream = Object.assign(emitter, {
    isTTY: true,
    columns,
    rows,
    write(text: string) {
      chunks.push(text)
      return true
    },
  }) as unknown as NodeJS.WriteStream
  return {
    stream,
    chunks,
    last: () => chunks[chunks.length - 1] ?? "",
    all: () => chunks.join(""),
    reset: () => {
      chunks.length = 0
    },
    resize(next: number) {
      ;(stream as unknown as { columns: number }).columns = next
      emitter.emit("resize")
    },
  }
}

describe("退化模式(非 TTY)", () => {
  const plain = () => {
    const term = fakeTerminal()
    return { term, region: new LiveRegion({ output: term.stream, enabled: false }) }
  }

  test("★ 一个转义序列都不发 —— 管道和日志里不能有光标控制", () => {
    const { term, region } = plain()
    region.write("hello\n")
    region.set(["should be ignored"])
    region.close()
    expect(term.all()).toBe("hello\n")
    expect(term.all()).not.toContain(ESC)
  })

  test("atLineStart 照样准", () => {
    const { term, region } = plain()
    expect(region.atLineStart).toBe(true)
    region.write("half")
    expect(region.atLineStart).toBe(false)
    region.write(" line\n")
    expect(region.atLineStart).toBe(true)
    expect(term.all()).toBe("half line\n")
  })

  test("close 时把没换行的半行冲出去", () => {
    const { term, region } = plain()
    region.write("dangling")
    region.close()
    expect(term.all()).toBe("dangling\n")
  })
})

describe("活动区", () => {
  const live = (columns = 40, rows = 24) => {
    const term = fakeTerminal(columns, rows)
    return { term, region: new LiveRegion({ output: term.stream, enabled: true }) }
  }

  test("内容宽度留最后一列不用", () => {
    const { region } = live(40)
    expect(region.width).toBe(39)
  })

  test("第一帧不需要擦除", () => {
    const { term, region } = live()
    region.set(["A", "B"])
    expect(term.last()).toContain("A\nB")
    expect(term.last()).not.toContain(CLEAR_DOWN)
  })

  test("★ 第二帧往上退的行数 = 上一帧的高度 - 1", () => {
    const { term, region } = live()
    region.set(["A", "B", "C"])
    term.reset()
    region.set(["X", "Y"])
    // 上一帧三行,光标停在最后一行 → 退 2 行再清到屏幕尾
    expect(term.last()).toContain(up(2))
    expect(term.last()).toContain(CLEAR_DOWN)
  })

  test("单行时不发 cursor-up(退 0 行是错的序列)", () => {
    const { term, region } = live()
    region.set(["only"])
    term.reset()
    region.set(["next"])
    expect(term.last()).toContain(CLEAR_DOWN)
    expect(term.last()).not.toContain(`${ESC}[0A`)
  })

  test("★ 内容没变就一个字节都不发 —— spinner 每 100ms 跑一次,不能每次全量重绘", () => {
    const { term, region } = live()
    region.set(["same"])
    term.reset()
    region.set(["same"])
    expect(term.chunks.length).toBe(0)
  })

  test("★ 光标变了就必须发东西 —— 只比内容的话方向键就废了", () => {
    const { term, region } = live()
    region.set(["hello"], { row: 0, col: 5 })
    term.reset()
    region.set(["hello"], { row: 0, col: 3 }) // 内容一模一样,只是 ← 了两下
    expect(term.chunks.length).toBeGreaterThan(0)
    expect(term.last()).toContain(`${ESC}[3C`)
  })

  test("只挪光标时不重画内容,只发一小段移动", () => {
    const { term, region } = live()
    region.set(["hello"], { row: 0, col: 5 })
    term.reset()
    region.set(["hello"], { row: 0, col: 2 })
    expect(term.last()).not.toContain("hello")
    expect(term.last()).not.toContain(CLEAR_DOWN)
  })

  test("光标也没变才真的一个字节都不发", () => {
    const { term, region } = live()
    region.set(["hello"], { row: 0, col: 2 })
    term.reset()
    region.set(["hello"], { row: 0, col: 2 })
    expect(term.chunks.length).toBe(0)
  })

  test("跨行挪光标:往上用 A,往下用 B", () => {
    const { term, region } = live()
    region.set(["a", "b", "c"], { row: 2, col: 0 })
    term.reset()
    region.set(["a", "b", "c"], { row: 0, col: 0 })
    expect(term.last()).toContain(`${ESC}[2A`)
    term.reset()
    region.set(["a", "b", "c"], { row: 1, col: 0 })
    expect(term.last()).toContain(`${ESC}[1B`)
  })

  test("★ 半行文本会被折进活动区,行数要算对", () => {
    // 注意 columns 有 20 的下限(再窄的终端画什么都没意义),所以这里用 24
    const { term, region } = live(24) // 可用宽度 23
    region.write("x".repeat(50)) // 23 + 23 + 4 = 3 行
    term.reset()
    region.set(["box"])
    // 上一帧是那 3 行,光标在第 3 行 → 退 2 行
    expect(term.last()).toContain(up(2))
  })

  test("完整的行提交进滚动区,半行留在活动区里", () => {
    const { term, region } = live()
    region.set(["BOX"])
    term.reset()
    region.write("done line\nhalf")
    const frame = term.last()
    expect(frame).toContain("done line\n")
    expect(frame).toContain("half")
    expect(frame).toContain("BOX")
    expect(region.atLineStart).toBe(false)
  })

  test("光标定位到调用方指定的位置", () => {
    const { term, region } = live()
    region.set(["line0", "line1", "line2"], { row: 1, col: 3 })
    // 画完停在第 2 行末尾 → 往上退 1 行,再往右 3 列
    expect(term.last()).toContain(up(1))
    expect(term.last()).toContain(`${ESC}[3C`)
  })

  test("★ 装不下时从上面丢,输入框保完整", () => {
    const { term, region } = live(40, 6) // 最多 5 行
    region.write("a\nb\n") // 这些进滚动区
    region.set(["1", "2", "3", "4", "5", "6", "7"])
    const frame = term.last()
    expect(frame).toContain("7")
    expect(frame).not.toContain("1\n2") // 顶上那几行被丢了
  })

  test("suspend 让出屏幕,resume 拿回来", () => {
    const { term, region } = live()
    region.set(["BOX"])
    region.suspend()
    expect(term.last()).toContain(CLEAR_DOWN)
    expect(region.active).toBe(false)

    term.reset()
    region.write("question?\n") // 挂起期间直接落滚动区
    expect(term.all()).toBe("question?\n")

    region.resume()
    expect(term.last()).toContain("BOX")
  })

  test("suspend 时把半行也冲出去,免得确认框接在它屁股后面", () => {
    const { term, region } = live()
    region.write("thinking")
    region.suspend()
    expect(term.all()).toContain("thinking\n")
  })

  test("close 之后不再画,活动区被擦掉", () => {
    const { term, region } = live()
    region.set(["BOX"])
    term.reset()
    region.close()
    expect(term.all()).toContain(CLEAR_DOWN)
    term.reset()
    region.set(["NOPE"])
    expect(term.chunks.length).toBe(0)
  })

  test("改大小之后按新宽度重画", () => {
    const { term, region } = live(40)
    region.set(["box"])
    term.reset()
    term.resize(20)
    expect(region.width).toBe(19)
    expect(term.chunks.length).toBeGreaterThan(0)
  })

  test("passthrough 发完控制序列后重画活动区", () => {
    const { term, region } = live()
    region.set(["BOX"])
    term.reset()
    region.passthrough(`${ESC}[2J`)
    expect(term.all()).toContain(`${ESC}[2J`)
    expect(term.all()).toContain("BOX")
  })
})
