/**
 * Key decoding.
 *
 * The group that matters most is "a sequence split in two". The terminal doesn't promise
 * that one read delivers a complete sequence; when holding an arrow key or pasting a big
 * block of text, `ESC [` and `A` landing in two chunks is routine. Missing this has a
 * very misleading symptom: everything is fine normally, a few garbage characters pop up
 * only during fast input, and it looks like a terminal bug.
 */
import { describe, expect, test } from "bun:test"
import { decodeKeys, type Key } from "../src/cli/keys.ts"

const ESC = String.fromCharCode(27)
const DEL = String.fromCharCode(127)

const names = (input: string): string[] => decodeKeys(input).keys.map((k) => k.name)
const one = (input: string): Key => {
  const { keys } = decodeKeys(input)
  expect(keys.length).toBe(1)
  return keys[0]!
}

describe("★ Ctrl plus punctuation", () => {
  test("★ ctrl-] decodes — its code point is outside the letter range", () => {
    // this used to be broken: 0x1d falls outside 1..26 and got eaten by "ignore other
    // control characters", while the UI still said "ctrl-] toggles the right pane" —
    // pressing it did nothing and reported nothing
    expect(decodeKeys(String.fromCharCode(0x1d)).keys).toEqual([
      { name: "]", ctrl: true, meta: false, shift: false },
    ])
  })

  test("the other three in the same range", () => {
    expect(decodeKeys(String.fromCharCode(0x1c)).keys[0]?.name).toBe("\\")
    expect(decodeKeys(String.fromCharCode(0x1e)).keys[0]?.name).toBe("^")
    expect(decodeKeys(String.fromCharCode(0x1f)).keys[0]?.name).toBe("_")
  })

  test("0x1b is still escape, not taken over", () => {
    expect(decodeKeys(String.fromCharCode(0x1b)).keys[0]?.name ?? "pending").not.toBe("[")
  })
})

describe("plain characters", () => {
  test("ASCII decodes one key per character", () => {
    expect(names("abc")).toEqual(["a", "b", "c"])
  })

  test("★ a multi-byte character is one key, not three", () => {
    expect(names("中文")).toEqual(["中", "文"])
  })

  test("★ an emoji (surrogate pair) is also one key", () => {
    expect(names("😀")).toEqual(["😀"])
  })

  test("half a surrogate pair is held back for the next chunk", () => {
    const high = String.fromCharCode(0xd83d)
    const result = decodeKeys(high)
    expect(result.keys).toEqual([])
    expect(result.rest).toBe(high)
    // add the low half and it's recognized
    expect(names(high + String.fromCharCode(0xde00))).toEqual(["😀"])
  })
})

describe("control keys", () => {
  test("Enter / Tab / Backspace", () => {
    expect(names("\r")).toEqual(["enter"])
    expect(names("\t")).toEqual(["tab"])
    expect(names(DEL)).toEqual(["backspace"])
    expect(names("\b")).toEqual(["backspace"])
  })

  test("Ctrl combinations", () => {
    expect(one(String.fromCharCode(3))).toMatchObject({ name: "c", ctrl: true })
    expect(one(String.fromCharCode(4))).toMatchObject({ name: "d", ctrl: true })
    expect(one(String.fromCharCode(23))).toMatchObject({ name: "w", ctrl: true })
  })

  test("★ Ctrl-J and Enter must stay distinct — one is newline, the other submit", () => {
    expect(one("\r")).toMatchObject({ name: "enter", ctrl: false })
    expect(one("\n")).toMatchObject({ name: "j", ctrl: true })
  })
})

describe("escape sequences", () => {
  test("arrow keys", () => {
    expect(names(`${ESC}[A${ESC}[B${ESC}[C${ESC}[D`)).toEqual(["up", "down", "right", "left"])
  })

  test("arrow keys in application cursor mode (SS3)", () => {
    expect(names(`${ESC}OA`)).toEqual(["up"])
  })

  test("Home / End / Delete", () => {
    expect(names(`${ESC}[H`)).toEqual(["home"])
    expect(names(`${ESC}[F`)).toEqual(["end"])
    expect(names(`${ESC}[3~`)).toEqual(["delete"])
    expect(names(`${ESC}[1~`)).toEqual(["home"])
  })

  test("modifiers: Ctrl-Right is 1;5C", () => {
    expect(one(`${ESC}[1;5C`)).toMatchObject({ name: "right", ctrl: true, meta: false })
    expect(one(`${ESC}[1;3D`)).toMatchObject({ name: "left", meta: true, ctrl: false })
  })

  test("CSI-u: Shift-Enter is distinguishable from Enter", () => {
    expect(one(`${ESC}[13;2u`)).toMatchObject({ name: "enter", shift: true })
  })

  test("Alt + letter / Alt-Backspace / Alt-Enter", () => {
    expect(one(`${ESC}b`)).toMatchObject({ name: "b", meta: true })
    expect(one(`${ESC}${DEL}`)).toMatchObject({ name: "backspace", meta: true })
    expect(one(`${ESC}\r`)).toMatchObject({ name: "enter", meta: true })
  })

  test("unrecognized sequences are dropped whole, not turned into visible garbage", () => {
    expect(names(`${ESC}[99Xa`)).toEqual(["unknown", "a"])
  })
})

describe("★ lone ESC", () => {
  test("a lone ESC is ambiguous and is held back until the timeout", () => {
    const result = decodeKeys(ESC)
    expect(result.keys).toEqual([])
    expect(result.rest).toBe(ESC)
    expect(result.pendingEscape).toBe(true)
  })

  test("flagged even when preceded by other characters", () => {
    const result = decodeKeys(`ab${ESC}`)
    expect(result.keys.map((k) => k.name)).toEqual(["a", "b"])
    expect(result.pendingEscape).toBe(true)
  })
})

describe("★ sequences split across chunks", () => {
  const feed = (chunks: string[]): string[] => {
    let buffer = ""
    const all: string[] = []
    for (const chunk of chunks) {
      const result = decodeKeys(buffer + chunk)
      all.push(...result.keys.map((k) => k.name))
      buffer = result.rest
    }
    return all
  }

  test("arrow key split in two", () => {
    expect(feed([`${ESC}[`, "A"])).toEqual(["up"])
  })

  test("split mid-parameter", () => {
    expect(feed([`${ESC}[1;`, "5C"])).toEqual(["right"])
  })

  test("split inside SS3", () => {
    expect(feed([`${ESC}O`, "B"])).toEqual(["down"])
  })

  test("several keys at once, the last one incomplete", () => {
    expect(feed([`ab${ESC}[`, `Ccd`])).toEqual(["a", "b", "right", "c", "d"])
  })
})

describe("★ SGR 1006 mouse", () => {
  test("left press and release; coordinates convert from 1-based to 0-based", () => {
    const press = one(`${ESC}[<0;10;5M`)
    expect(press.name).toBe("mouse")
    expect(press.mouse).toMatchObject({ button: "left", action: "press", x: 9, y: 4 })
    expect(one(`${ESC}[<0;10;5m`).mouse).toMatchObject({ action: "release" })
  })

  test("wheel", () => {
    expect(one(`${ESC}[<64;1;1M`).mouse).toMatchObject({ button: "wheel-up" })
    expect(one(`${ESC}[<65;1;1M`).mouse).toMatchObject({ button: "wheel-down" })
  })

  test("modifiers and drag", () => {
    expect(one(`${ESC}[<16;1;1M`).mouse).toMatchObject({ ctrl: true })
    expect(one(`${ESC}[<32;1;1M`).mouse).toMatchObject({ action: "drag" })
  })

  test("three-digit coordinates don't overflow (the old X10 protocol breaks at column 223)", () => {
    expect(one(`${ESC}[<0;250;60M`).mouse).toMatchObject({ x: 249, y: 59 })
  })

  test("★ reassembled when split in two", () => {
    let buffer = ""
    const names: string[] = []
    for (const chunk of [`${ESC}[<0;10`, ";5M"]) {
      const result = decodeKeys(buffer + chunk)
      names.push(...result.keys.map((k) => k.name))
      buffer = result.rest
    }
    expect(names).toEqual(["mouse"])
  })

  test("mouse sequences never land in the input box as printable characters", () => {
    expect(names(`${ESC}[<0;10;5Mx`)).toEqual(["mouse", "x"])
  })
})

describe("★ bracketed paste", () => {
  const paste = (text: string) => `${ESC}[200~${text}${ESC}[201~`

  test("a whole block counts as one paste key", () => {
    const key = one(paste("hello world"))
    expect(key.name).toBe("paste")
    expect(key.text).toBe("hello world")
  })

  test("★ newlines inside are text, not Enter presses", () => {
    const key = one(paste("a\nb\nc\nd"))
    expect(key.name).toBe("paste")
    expect(key.text).toBe("a\nb\nc\nd")
  })

  test("an incomplete paste is held back whole for the next chunk", () => {
    const result = decodeKeys(`${ESC}[200~half`)
    expect(result.keys).toEqual([])
    expect(result.rest).toBe(`${ESC}[200~half`)
  })

  test("reassembled from three chunks", () => {
    let buffer = ""
    const keys: Key[] = []
    for (const chunk of [`${ESC}[20`, `0~line1\nli`, `ne2${ESC}[201~`]) {
      const result = decodeKeys(buffer + chunk)
      keys.push(...result.keys)
      buffer = result.rest
    }
    expect(keys.length).toBe(1)
    expect(keys[0]!.text).toBe("line1\nline2")
  })

  test("keys following a paste block decode normally", () => {
    expect(names(paste("x") + "\r")).toEqual(["paste", "enter"])
  })
})

describe("★ legacy mouse reports (ESC [ M + three bytes)", () => {
  // What turns mouse tracking on is `?1000h`; `?1006h` merely **requests** the SGR format.
  // A terminal that doesn't know 1006 still reports, in exactly this old format — and it
  // looks like an ordinary CSI. If it gets eaten as a CSI, the three bytes after it get
  // typed into the input box as visible characters: what the user sees is "click the
  // chat box and a string of garbage appears".
  const legacy = (button: number, x: number, y: number) =>
    ESC + "[M" + String.fromCharCode(button + 32, x + 32, y + 32)

  test("★ consumed whole, not a single byte leaks out", () => {
    expect(names(legacy(0, 20, 5))).toEqual(["mouse"])
  })

  test("coordinates convert to 0-based", () => {
    expect(one(legacy(0, 20, 5)).mouse).toMatchObject({ x: 19, y: 4, button: "left", action: "press" })
  })

  test("low two bits = 3 means release", () => {
    expect(one(legacy(3, 20, 5)).mouse?.action).toBe("release")
  })

  test("wheel is recognized", () => {
    expect(one(legacy(64, 1, 1)).mouse?.button).toBe("wheel-up")
    expect(one(legacy(65, 1, 1)).mouse?.button).toBe("wheel-down")
  })

  test("★ input right after is unaffected — leaked bytes would show up as extra visible characters", () => {
    expect(names(legacy(0, 10, 3) + "ab")).toEqual(["mouse", "a", "b"])
  })

  test("★ waits until all three bytes arrive, never emits half", () => {
    const first = decodeKeys(ESC + "[M")
    expect(first.keys).toEqual([])
    expect(names(first.rest + String.fromCharCode(32, 42, 37))).toEqual(["mouse"])
  })
})
