/**
 * The bottom live area.
 *
 * There is only one truly fatal quantity here: **how many rows to back up when erasing**.
 * Too few and it eats upward into output already printed; too many and it leaves a copy
 * of the live area itself on screen. Both are irreversible screen corruption, and both
 * show up only at particular widths / with particular content — hard to reproduce by eye
 * on a real terminal, so only assertions can keep watch.
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
    resize(next: number, rows = stream.rows) {
      ;(stream as unknown as { columns: number }).columns = next
      stream.rows = rows
      emitter.emit("resize")
    },
  }
}

describe("fallback mode (non-TTY)", () => {
  const plain = () => {
    const term = fakeTerminal()
    return { term, region: new LiveRegion({ output: term.stream, enabled: false }) }
  }

  test("★ emits no escape sequences — pipes and logs must not get cursor control", () => {
    const { term, region } = plain()
    region.write("hello\n")
    region.set(["should be ignored"])
    region.close()
    expect(term.all()).toBe("hello\n")
    expect(term.all()).not.toContain(ESC)
  })

  test("atLineStart stays accurate", () => {
    const { term, region } = plain()
    expect(region.atLineStart).toBe(true)
    region.write("half")
    expect(region.atLineStart).toBe(false)
    region.write(" line\n")
    expect(region.atLineStart).toBe(true)
    expect(term.all()).toBe("half line\n")
  })

  test("close flushes an unterminated partial line", () => {
    const { term, region } = plain()
    region.write("dangling")
    region.close()
    expect(term.all()).toBe("dangling\n")
  })
})

describe("live area", () => {
  const live = (columns = 40, rows = 24) => {
    const term = fakeTerminal(columns, rows)
    return { term, region: new LiveRegion({ output: term.stream, enabled: true }) }
  }

  test("content width leaves the last column unused", () => {
    const { region } = live(40)
    expect(region.width).toBe(39)
  })

  test("the first frame needs no erase", () => {
    const { term, region } = live()
    region.set(["A", "B"])
    expect(term.last()).toContain("A\nB")
    expect(term.last()).not.toContain(CLEAR_DOWN)
  })

  test("★ the second frame moves up (previous frame height - 1) rows", () => {
    const { term, region } = live()
    region.set(["A", "B", "C"])
    term.reset()
    region.set(["X", "Y"])
    // the previous frame had three rows with the cursor on the last one → back up 2 rows,
    // then clear to the end of screen
    expect(term.last()).toContain(up(2))
    expect(term.last()).toContain(CLEAR_DOWN)
  })

  test("a single row sends no cursor-up (moving up 0 rows is a wrong sequence)", () => {
    const { term, region } = live()
    region.set(["only"])
    term.reset()
    // Two rows so the frame takes the full erase path (same height would rewrite in place)
    region.set(["next", "row"])
    expect(term.last()).toContain(CLEAR_DOWN)
    expect(term.last()).not.toContain(`${ESC}[0A`)
  })

  test("★ same height rewrites only the changed row — an animation tick must not resend the input box", () => {
    const { term, region } = live()
    region.set(["[▮  ] thinking", "› draft", "footer"], { row: 1, col: 7 })
    term.reset()
    region.set(["[ ▮ ] thinking", "› draft", "footer"], { row: 1, col: 7 })
    expect(term.last()).toContain("[ ▮ ] thinking")
    expect(term.last()).toContain(`${ESC}[2K`)
    expect(term.last()).not.toContain("› draft")
    expect(term.last()).not.toContain("footer")
    expect(term.last()).not.toContain(CLEAR_DOWN)
    // from the input row up one to the changed row, then back down to the caret
    expect(term.last()).toContain(up(1))
    expect(term.last()).toContain(`${ESC}[1B`)
    expect(term.last()).toContain(`${ESC}[7C`)
  })

  test("after an in-place rewrite the erase ledger still covers the whole frame", () => {
    const { term, region } = live()
    region.set(["a", "b", "c"])
    region.set(["a", "B", "c"])
    term.reset()
    region.set(["x"])
    // cursor ended on the last row of a three-row frame → back up 2 rows to erase it
    expect(term.last()).toContain(up(2))
    expect(term.last()).toContain(CLEAR_DOWN)
  })

  test("★ unchanged content sends zero bytes — the spinner ticks every 100ms and can't redraw everything each time", () => {
    const { term, region } = live()
    region.set(["same"])
    term.reset()
    region.set(["same"])
    expect(term.chunks.length).toBe(0)
  })

  test("★ a cursor change must send something — comparing content alone would break the arrow keys", () => {
    const { term, region } = live()
    region.set(["hello"], { row: 0, col: 5 })
    term.reset()
    region.set(["hello"], { row: 0, col: 3 }) // identical content, just ← pressed twice
    expect(term.chunks.length).toBeGreaterThan(0)
    expect(term.last()).toContain(`${ESC}[3C`)
  })

  test("moving only the cursor sends a short move, not a redraw", () => {
    const { term, region } = live()
    region.set(["hello"], { row: 0, col: 5 })
    term.reset()
    region.set(["hello"], { row: 0, col: 2 })
    expect(term.last()).not.toContain("hello")
    expect(term.last()).not.toContain(CLEAR_DOWN)
  })

  test("zero bytes only when the cursor is unchanged too", () => {
    const { term, region } = live()
    region.set(["hello"], { row: 0, col: 2 })
    term.reset()
    region.set(["hello"], { row: 0, col: 2 })
    expect(term.chunks.length).toBe(0)
  })

  test("moving the cursor across rows: A for up, B for down", () => {
    const { term, region } = live()
    region.set(["a", "b", "c"], { row: 2, col: 0 })
    term.reset()
    region.set(["a", "b", "c"], { row: 0, col: 0 })
    expect(term.last()).toContain(`${ESC}[2A`)
    term.reset()
    region.set(["a", "b", "c"], { row: 1, col: 0 })
    expect(term.last()).toContain(`${ESC}[1B`)
  })

  test("★ partial-line text wraps into the live area and its rows are counted right", () => {
    // note columns has a floor of 20 (drawing anything on a narrower terminal is
    // pointless), hence 24 here
    const { term, region } = live(24) // usable width 23
    region.write("x".repeat(50)) // 23 + 23 + 4 = 3 rows
    term.reset()
    region.set(["box"])
    // the previous frame is those 3 rows, cursor on row 3 → back up 2 rows
    expect(term.last()).toContain(up(2))
  })

  test("complete lines go to the scrollback, the partial line stays in the live area", () => {
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

  test("the cursor is placed where the caller specifies", () => {
    const { term, region } = live()
    region.set(["line0", "line1", "line2"], { row: 1, col: 3 })
    // drawing ends at the end of row 2 → up 1 row, then right 3 columns
    expect(term.last()).toContain(up(1))
    expect(term.last()).toContain(`${ESC}[3C`)
  })

  test("★ when it doesn't fit, rows drop from the top and the input box stays whole", () => {
    const { term, region } = live(40, 6) // 5 rows at most
    region.write("a\nb\n") // these go into the scrollback
    region.set(["1", "2", "3", "4", "5", "6", "7"])
    const frame = term.last()
    expect(frame).toContain("7")
    expect(frame).not.toContain("1\n2") // the top rows were dropped
  })

  test("suspend yields the screen, resume takes it back", () => {
    const { term, region } = live()
    region.set(["BOX"])
    region.suspend()
    expect(term.last()).toContain(CLEAR_DOWN)
    expect(region.active).toBe(false)

    term.reset()
    region.write("question?\n") // while suspended, goes straight to the scrollback
    expect(term.all()).toBe("question?\n")

    region.resume()
    expect(term.last()).toContain("BOX")
  })

  test("suspend flushes the partial line too, so a confirm prompt doesn't trail after it", () => {
    const { term, region } = live()
    region.write("thinking")
    region.suspend()
    expect(term.all()).toContain("thinking\n")
  })

  test("after close nothing is drawn and the live area is erased", () => {
    const { term, region } = live()
    region.set(["BOX"])
    term.reset()
    region.close()
    expect(term.all()).toContain(CLEAR_DOWN)
    term.reset()
    region.set(["NOPE"])
    expect(term.chunks.length).toBe(0)
  })

  test("redraws at the new width after a resize", async () => {
    const { term, region } = live(40)
    region.set(["box"])
    term.reset()
    term.resize(20)
    await Promise.resolve()
    expect(region.width).toBe(19)
    expect(term.chunks.length).toBeGreaterThan(0)
  })

  test("resize resets the viewport before relayout without erasing by stale rows or clearing scrollback", async () => {
    const term = fakeTerminal(120)
    const widths: number[] = []
    const region = new LiveRegion({ output: term.stream, onResize() {
      widths.push(region.width)
      region.set(["input", "footer"])
    } })
    region.set(["old", "input", "footer", "preview"])
    region.write("committed\n" + "流".repeat(30))
    for (const columns of [40, 100]) {
      term.reset()
      term.resize(columns)
      await Promise.resolve()
      const output = term.all()
      const reset = output.indexOf(`${ESC}[H${ESC}[2J`)
      expect(reset).toBeGreaterThanOrEqual(0)
      expect(output.slice(0, reset)).not.toMatch(/\u001b\[\d+A/)
      expect(output).not.toContain(`${ESC}[3J`)
      expect(output).not.toContain("committed")
      expect(output).toContain("流")
      expect(output).toContain("input\nfooter")
      expect(region.atLineStart).toBe(false)
    }
    expect(widths).toEqual([39, 99])
    term.reset()
    region.write(" tail\n")
    expect(term.all()).toContain("流".repeat(30) + " tail\n")
    expect(region.atLineStart).toBe(true)
    region.close()
  })

  test("resize bursts use the final dimensions once and redraw overlays with a CJK cursor", async () => {
    const term = fakeTerminal(120)
    let calls = 0
    const region = new LiveRegion({ output: term.stream, onResize: () => { calls++ } })
    region.overlay((width, height) => ({ lines: [`${width}x${height}`, "中文"], cursor: { row: 1, col: 4 } }))
    term.reset()
    term.resize(40, 12)
    term.resize(60, 18)
    term.resize(100, 30)
    await Promise.resolve()
    expect(calls).toBe(1)
    expect(term.all().split(`${ESC}[2J`).length - 1).toBe(1)
    expect(term.all()).toContain("99x29\n中文")
    expect(term.all()).toContain(`${ESC}[4C`)
    term.reset()
    region.refresh()
    expect(term.all()).toBe("")
    region.close()
  })

  test("output arriving before the resize microtask cannot use the stale ledger", async () => {
    const { term, region } = live(120)
    region.set(["a", "b", "c"])
    term.reset()
    term.resize(40)
    region.write("next\n")
    await Promise.resolve()
    expect(term.all().split(`${ESC}[2J`).length - 1).toBe(1)
    expect(term.all().indexOf(`${ESC}[2J`)).toBeLessThan(term.all().indexOf("next"))
    region.close()
  })

  test("suspended resize waits for resume and close cancels queued repaint", async () => {
    const { term, region } = live()
    region.set(["box"])
    region.suspend()
    term.reset()
    term.resize(80)
    await Promise.resolve()
    expect(term.all()).toBe("")
    region.resume()
    expect(term.all()).toContain(`${ESC}[2J`)
    term.resize(100)
    region.close()
    term.reset()
    await Promise.resolve()
    expect(term.all()).toBe("")
  })

  test("non-TTY resize emits no controls or callback", async () => {
    const term = fakeTerminal()
    let calls = 0
    const region = new LiveRegion({ output: term.stream, enabled: false, onResize: () => { calls++ } })
    region.write("half")
    term.resize(100)
    await Promise.resolve()
    region.close()
    expect(term.all()).toBe("half\n")
    expect(calls).toBe(0)
  })

  test("passthrough redraws the live area after sending the control sequence", () => {
    const { term, region } = live()
    region.set(["BOX"])
    term.reset()
    region.passthrough(`${ESC}[2J`)
    expect(term.all()).toContain(`${ESC}[2J`)
    expect(term.all()).toContain("BOX")
  })
})
