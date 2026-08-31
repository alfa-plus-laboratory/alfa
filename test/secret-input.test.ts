/**
 * 逐行读输入。
 *
 * ★ 这里只盯一件事:**一次 data 事件里换行后面的字符不许丢**。
 *
 * raw 模式下一个 chunk 常常带来不止一个字符 —— 粘贴、SSH 上的合包、敲得快
 * 一点都会。原来的实现读到换行就 resolve,同一个 chunk 里剩下的直接扔掉。
 * 后果落在**连着两问**的地方(引导、第一次进一个文件夹那张卡片):把两个答案
 * 一起粘进去,第二问收到空串、静默取默认值。
 *
 * ⚠ 而那张卡片上的第二问正是「要不要信任这个文件夹」,默认是"信任" ——
 *   也就是说这个丢字符的 bug 在一道安全提问上是 fail open 的。
 */
import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { InputCancelled, readLine } from "../src/cli/secret-input.ts"

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

describe("★ 换行后面的字符留给下一问", () => {
  test("两个答案一次送进来,两问各拿各的", async () => {
    const tty = fakeTTY()
    const first = readLine("a: ", tty)
    tty.emitter.emit("data", "3\n2\n")
    expect(await first).toBe("3")
    // 第二次读**不再发任何数据** —— 它必须自己从上一次剩下的里面取
    expect(await readLine("b: ", tty)).toBe("2")
  })

  test("剩下的那半句也留着,等它自己的换行", async () => {
    const tty = fakeTTY()
    const first = readLine("a: ", tty)
    tty.emitter.emit("data", "1\nhalf")
    expect(await first).toBe("1")
    const second = readLine("b: ", tty)
    tty.emitter.emit("data", "-done\n")
    expect(await second).toBe("half-done")
  })

  test("回车分两次来也一样(每个字符自己一个事件)", async () => {
    const tty = fakeTTY()
    const answer = readLine("a: ", tty)
    tty.emitter.emit("data", "4")
    tty.emitter.emit("data", "\r")
    expect(await answer).toBe("4")
  })

  // 用户按的是"不弄了",不是"这几个字给下一问"
  test("★ Ctrl-C 把剩下的丢掉,不带进下一问", async () => {
    const tty = fakeTTY()
    const first = readLine("a: ", tty)
    tty.emitter.emit("data", "\u0003leftover\n")
    await expect(first).rejects.toBeInstanceOf(InputCancelled)

    const second = readLine("b: ", tty)
    tty.emitter.emit("data", "clean\n")
    expect(await second).toBe("clean")
  })

  test("退格照旧只吃自己那一段", async () => {
    const tty = fakeTTY()
    const answer = readLine("a: ", tty)
    tty.emitter.emit("data", "12\u007f3\n")
    expect(await answer).toBe("13")
  })
})
