/**
 * 按键解码。
 *
 * 最要紧的一组是「序列被切成两块」。终端不保证一次 read 给一条完整序列,
 * 按住方向键或者粘贴大段文本时,`ESC [` 和 `A` 落在两个 chunk 里是常事。
 * 漏掉这条的表现很有迷惑性:平时都对,只在快速操作时冒出几个乱码字符,
 * 看起来像终端的毛病。
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

describe("★ Ctrl 加符号", () => {
  test("★ ctrl-] 要能解出来 —— 它的码位不在字母那一段里", () => {
    // 这条曾经是坏的:0x1d 落在 1..26 之外,被「其它控制字符无视」吃掉,
    // 而界面上「ctrl-] 开关右栏」照样写着,按了没反应也不报错
    expect(decodeKeys(String.fromCharCode(0x1d)).keys).toEqual([
      { name: "]", ctrl: true, meta: false, shift: false },
    ])
  })

  test("同一段里的另外三个", () => {
    expect(decodeKeys(String.fromCharCode(0x1c)).keys[0]?.name).toBe("\\")
    expect(decodeKeys(String.fromCharCode(0x1e)).keys[0]?.name).toBe("^")
    expect(decodeKeys(String.fromCharCode(0x1f)).keys[0]?.name).toBe("_")
  })

  test("0x1b 还是 escape,没被抢走", () => {
    expect(decodeKeys(String.fromCharCode(0x1b)).keys[0]?.name ?? "pending").not.toBe("[")
  })
})

describe("普通字符", () => {
  test("ASCII 一个一个来", () => {
    expect(names("abc")).toEqual(["a", "b", "c"])
  })

  test("★ 多字节字符是一个键,不是三个", () => {
    expect(names("中文")).toEqual(["中", "文"])
  })

  test("★ emoji(代理对)也是一个键", () => {
    expect(names("😀")).toEqual(["😀"])
  })

  test("半个代理对退回去等下一片", () => {
    const high = String.fromCharCode(0xd83d)
    const result = decodeKeys(high)
    expect(result.keys).toEqual([])
    expect(result.rest).toBe(high)
    // 拼上低位就认出来了
    expect(names(high + String.fromCharCode(0xde00))).toEqual(["😀"])
  })
})

describe("控制键", () => {
  test("回车 / Tab / 退格", () => {
    expect(names("\r")).toEqual(["enter"])
    expect(names("\t")).toEqual(["tab"])
    expect(names(DEL)).toEqual(["backspace"])
    expect(names("\b")).toEqual(["backspace"])
  })

  test("Ctrl 组合", () => {
    expect(one(String.fromCharCode(3))).toMatchObject({ name: "c", ctrl: true })
    expect(one(String.fromCharCode(4))).toMatchObject({ name: "d", ctrl: true })
    expect(one(String.fromCharCode(23))).toMatchObject({ name: "w", ctrl: true })
  })

  test("★ Ctrl-J 和回车必须分得开 —— 一个换行一个提交", () => {
    expect(one("\r")).toMatchObject({ name: "enter", ctrl: false })
    expect(one("\n")).toMatchObject({ name: "j", ctrl: true })
  })
})

describe("转义序列", () => {
  test("方向键", () => {
    expect(names(`${ESC}[A${ESC}[B${ESC}[C${ESC}[D`)).toEqual(["up", "down", "right", "left"])
  })

  test("应用键盘模式的方向键(SS3)", () => {
    expect(names(`${ESC}OA`)).toEqual(["up"])
  })

  test("Home / End / Delete", () => {
    expect(names(`${ESC}[H`)).toEqual(["home"])
    expect(names(`${ESC}[F`)).toEqual(["end"])
    expect(names(`${ESC}[3~`)).toEqual(["delete"])
    expect(names(`${ESC}[1~`)).toEqual(["home"])
  })

  test("修饰符:Ctrl-Right 是 1;5C", () => {
    expect(one(`${ESC}[1;5C`)).toMatchObject({ name: "right", ctrl: true, meta: false })
    expect(one(`${ESC}[1;3D`)).toMatchObject({ name: "left", meta: true, ctrl: false })
  })

  test("CSI-u:Shift-Enter 要能和 Enter 分开", () => {
    expect(one(`${ESC}[13;2u`)).toMatchObject({ name: "enter", shift: true })
  })

  test("Alt + 字母 / Alt-Backspace / Alt-Enter", () => {
    expect(one(`${ESC}b`)).toMatchObject({ name: "b", meta: true })
    expect(one(`${ESC}${DEL}`)).toMatchObject({ name: "backspace", meta: true })
    expect(one(`${ESC}\r`)).toMatchObject({ name: "enter", meta: true })
  })

  test("认不出来的序列整条丢掉,不会变成一串可见垃圾字符", () => {
    expect(names(`${ESC}[99Xa`)).toEqual(["unknown", "a"])
  })
})

describe("★ 孤立 ESC", () => {
  test("单独一个 ESC 是歧义,退回去等超时", () => {
    const result = decodeKeys(ESC)
    expect(result.keys).toEqual([])
    expect(result.rest).toBe(ESC)
    expect(result.pendingEscape).toBe(true)
  })

  test("前面有字符时也要标出来", () => {
    const result = decodeKeys(`ab${ESC}`)
    expect(result.keys.map((k) => k.name)).toEqual(["a", "b"])
    expect(result.pendingEscape).toBe(true)
  })
})

describe("★ 跨 chunk 的半条序列", () => {
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

  test("方向键被切成两半", () => {
    expect(feed([`${ESC}[`, "A"])).toEqual(["up"])
  })

  test("切在参数中间", () => {
    expect(feed([`${ESC}[1;`, "5C"])).toEqual(["right"])
  })

  test("切在 SS3 中间", () => {
    expect(feed([`${ESC}O`, "B"])).toEqual(["down"])
  })

  test("一次到达多个键,最后一个不完整", () => {
    expect(feed([`ab${ESC}[`, `Ccd`])).toEqual(["a", "b", "right", "c", "d"])
  })
})

describe("★ SGR 1006 鼠标", () => {
  test("左键按下与抬起,坐标从 1 起转成 0 起", () => {
    const press = one(`${ESC}[<0;10;5M`)
    expect(press.name).toBe("mouse")
    expect(press.mouse).toMatchObject({ button: "left", action: "press", x: 9, y: 4 })
    expect(one(`${ESC}[<0;10;5m`).mouse).toMatchObject({ action: "release" })
  })

  test("滚轮", () => {
    expect(one(`${ESC}[<64;1;1M`).mouse).toMatchObject({ button: "wheel-up" })
    expect(one(`${ESC}[<65;1;1M`).mouse).toMatchObject({ button: "wheel-down" })
  })

  test("修饰符与拖动", () => {
    expect(one(`${ESC}[<16;1;1M`).mouse).toMatchObject({ ctrl: true })
    expect(one(`${ESC}[<32;1;1M`).mouse).toMatchObject({ action: "drag" })
  })

  test("三位数坐标不会溢出(老 X10 协议 223 列就废了)", () => {
    expect(one(`${ESC}[<0;250;60M`).mouse).toMatchObject({ x: 249, y: 59 })
  })

  test("★ 切成两半也要拼回来", () => {
    let buffer = ""
    const names: string[] = []
    for (const chunk of [`${ESC}[<0;10`, ";5M"]) {
      const result = decodeKeys(buffer + chunk)
      names.push(...result.keys.map((k) => k.name))
      buffer = result.rest
    }
    expect(names).toEqual(["mouse"])
  })

  test("鼠标序列不会被当成可打印字符塞进输入框", () => {
    expect(names(`${ESC}[<0;10;5Mx`)).toEqual(["mouse", "x"])
  })
})

describe("★ 括号粘贴", () => {
  const paste = (text: string) => `${ESC}[200~${text}${ESC}[201~`

  test("整块进来算一个 paste 键", () => {
    const key = one(paste("hello world"))
    expect(key.name).toBe("paste")
    expect(key.text).toBe("hello world")
  })

  test("★ 里面的换行是文本,不是四次回车", () => {
    const key = one(paste("a\nb\nc\nd"))
    expect(key.name).toBe("paste")
    expect(key.text).toBe("a\nb\nc\nd")
  })

  test("收不全就整块退回,等下一片", () => {
    const result = decodeKeys(`${ESC}[200~half`)
    expect(result.keys).toEqual([])
    expect(result.rest).toBe(`${ESC}[200~half`)
  })

  test("分三片到达也能拼回来", () => {
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

  test("粘贴块后面跟着的按键照常解码", () => {
    expect(names(paste("x") + "\r")).toEqual(["paste", "enter"])
  })
})

describe("★ 老式鼠标上报(ESC [ M + 三个字节)", () => {
  // 打开鼠标追踪的是 `?1000h`,`?1006h` 只是**请求**换成 SGR 格式。终端不认
  // 1006 时照样上报,用的就是这个老格式 —— 而它长得像一条普通 CSI。
  // 被当成 CSI 吃掉的话,后面那三个字节会被当成可见字符打进输入框:
  // 用户看到的现象就是「点一下聊天框冒出一串乱码」。
  const legacy = (button: number, x: number, y: number) =>
    ESC + "[M" + String.fromCharCode(button + 32, x + 32, y + 32)

  test("★ 整条吃掉,一个字节都不许漏出去", () => {
    expect(names(legacy(0, 20, 5))).toEqual(["mouse"])
  })

  test("坐标转成 0 起", () => {
    expect(one(legacy(0, 20, 5)).mouse).toMatchObject({ x: 19, y: 4, button: "left", action: "press" })
  })

  test("低两位是 3 表示松开", () => {
    expect(one(legacy(3, 20, 5)).mouse?.action).toBe("release")
  })

  test("滚轮认得出来", () => {
    expect(one(legacy(64, 1, 1)).mouse?.button).toBe("wheel-up")
    expect(one(legacy(65, 1, 1)).mouse?.button).toBe("wheel-down")
  })

  test("★ 后面紧跟的普通输入不受影响 —— 漏字节的话这里会多出几个可见字符", () => {
    expect(names(legacy(0, 10, 3) + "ab")).toEqual(["mouse", "a", "b"])
  })

  test("★ 三个字节没到齐就等,不吐半条", () => {
    const first = decodeKeys(ESC + "[M")
    expect(first.keys).toEqual([])
    expect(names(first.rest + String.fromCharCode(32, 42, 37))).toEqual(["mouse"])
  })
})
