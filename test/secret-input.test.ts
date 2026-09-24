/**
 * Reading input line by line.
 *
 * ★ This watches exactly one thing: **characters after a newline within one data event
 * must not be lost**.
 *
 * In raw mode a single chunk often carries more than one character — pasting, packet
 * coalescing over SSH, or just typing a bit fast all do it. The original implementation
 * resolved as soon as it read a newline and threw away the rest of the same chunk. The
 * damage landed wherever **two questions come back to back** (onboarding, the card shown
 * the first time you enter a folder): paste both answers in at once, and the second
 * question gets an empty string and silently takes the default.
 *
 * ⚠ And the second question on that card is exactly "trust this folder?", with "trust"
 *   as the default — meaning this dropped-characters bug fails open on a security prompt.
 */
import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { InputCancelled, readLine, readSecret } from "../src/cli/secret-input.ts"

function fakeTTY() {
  const emitter = new EventEmitter()
  const input = Object.assign(emitter, {
    isTTY: true,
    isRaw: false,
    setRawMode() {},
    setEncoding() {},
    resume() {},
    pause() {},
  }) as unknown as NodeJS.ReadStream
  const written: string[] = []
  const output = { write: (text: string) => written.push(text) } as unknown as NodeJS.WriteStream
  return { input, output, emitter, echoed: () => written.join("") }
}

describe("★ characters after a newline are kept for the next question", () => {
  test("two answers sent at once go one to each question", async () => {
    const tty = fakeTTY()
    const first = readLine("a: ", tty)
    tty.emitter.emit("data", "3\n2\n")
    expect(await first).toBe("3")
    // the second read **sends no data at all** — it must take from what the first one
    // left over
    expect(await readLine("b: ", tty)).toBe("2")
  })

  test("a leftover partial line is kept until its own newline", async () => {
    const tty = fakeTTY()
    const first = readLine("a: ", tty)
    tty.emitter.emit("data", "1\nhalf")
    expect(await first).toBe("1")
    const second = readLine("b: ", tty)
    tty.emitter.emit("data", "-done\n")
    expect(await second).toBe("half-done")
  })

  test("same when Enter arrives separately (one event per character)", async () => {
    const tty = fakeTTY()
    const answer = readLine("a: ", tty)
    tty.emitter.emit("data", "4")
    tty.emitter.emit("data", "\r")
    expect(await answer).toBe("4")
  })

  // what the user pressed means "forget it", not "give these to the next question"
  test("★ Ctrl-C discards the rest instead of carrying it into the next question", async () => {
    const tty = fakeTTY()
    const first = readLine("a: ", tty)
    tty.emitter.emit("data", "\u0003leftover\n")
    await expect(first).rejects.toBeInstanceOf(InputCancelled)

    const second = readLine("b: ", tty)
    tty.emitter.emit("data", "clean\n")
    expect(await second).toBe("clean")
  })

  test("backspace still only erases within its own answer", async () => {
    const tty = fakeTTY()
    const answer = readLine("a: ", tty)
    tty.emitter.emit("data", "12\u007f3\n")
    expect(await answer).toBe("13")
  })
})


test("endpoint and key pasted together: the hidden input consumes the key, never echoed at the next question", async () => {
  const tty = fakeTTY()
  const endpoint = readLine("URL: ", tty)
  tty.emitter.emit("data", "https://fixture.invalid/v1\nfake-secret-for-regression\n\n")
  expect(await endpoint).toBe("https://fixture.invalid/v1")
  expect(await readSecret("API key: ", tty)).toBe("fake-secret-for-regression")
  expect(await readLine("Header: ", tty)).toBe("")
  expect(tty.echoed()).not.toContain("fake-secret-for-regression")
})


test("terminal echo is off before the key prompt appears, so even an instant paste can't leak", async () => {
  const tty = fakeTTY()
  let raw = false
  tty.input.setRawMode = ((value: boolean) => { raw = value; return tty.input })
  const written: string[] = []
  const output = { write(text: string) {
    written.push(text)
    if (text === "paste key: ") {
      expect(raw).toBe(true)
      tty.emitter.emit("data", "fake-fast-paste-secret\n")
    }
    return true
  } } as unknown as NodeJS.WriteStream
  expect(await readSecret("paste key: ", { input: tty.input, output })).toBe("fake-fast-paste-secret")
  expect(written.join("")).not.toContain("fake-fast-paste-secret")
  expect(raw).toBe(false)
})
