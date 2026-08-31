/**
 * 斜杠命令补全。
 *
 * 最要紧的一组是「什么时候**不该**弹」。一个在打路径时冒出来挡视线的补全框
 * 比没有补全烦人得多,而它还会顺手把 tab / 上下键抢走。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { apply, BARE_LABEL, commands, complete, lookup, setModelChoices } from "../src/cli/commands.ts"

const values = (text: string, cursor = text.length): string[] =>
  complete(text, cursor)?.items.map((item) => item.value) ?? []

describe("命令表", () => {
  test("每条都带斜杠、带一句说明", () => {
    for (const command of commands()) {
      expect(command.name.startsWith("/")).toBe(true)
      expect(command.hint.length).toBeGreaterThan(0)
    }
  })

  test("别名能查到,但不出现在候选里", () => {
    expect(lookup("/quit")?.name).toBe("/exit")
    expect(values("/")).not.toContain("/quit")
    expect(lookup("/models")?.name).toBe("/model")
    expect(values("/")).not.toContain("/models")
  })
})

describe("补全命令名", () => {
  test("单个斜杠列出全部", () => {
    expect(values("/")).toEqual([
      "/permission",
      "/view",
      "/language",
      "/think",
      "/agentflow",
      "/model",
      "/resume",
      "/summary",
      "/context",
      "/compact",
      "/check",
      "/init",
      "/mcp",
      "/trust",
      "/skills",
      "/upgrade",
      "/history-clean",
      "/reset",
      "/help",
      "/clear",
      "/exit",
    ])
  })

  test("按前缀收窄", () => {
    expect(values("/pe")).toEqual(["/permission"])
    // ★ 改名之前它叫 /clean-history,于是 `/cl` 会同时弹出「删掉大半年的历史」和
    //   「开一场新对话」—— 两条挨在一起,而后果差着一个数量级
    expect(values("/cl")).toEqual(["/clear"])
    expect(values("/c")).toEqual(["/context", "/compact", "/check", "/clear"])
    expect(values("/h")).toEqual(["/history-clean", "/help"])
  })

  test("/content 是 /context 的别名:能查到,但不出现在候选里", () => {
    expect(lookup("/content")?.name).toBe("/context")
    expect(values("/co")).not.toContain("/content")
  })

  test("大小写不敏感", () => {
    expect(values("/PE")).toEqual(["/permission"])
  })

  test("★ 打全了而且没有参数就不再弹 —— 框留着只会挡视线", () => {
    expect(complete("/clear", 6)).toBeUndefined()
  })

  test("★ 打全了但有参数,继续提示参数", () => {
    expect(values("/permission")).toEqual(["/permission"])
    // 第一条是「什么都不加」(值为空),见下面那组
    expect(values("/permission ")).toEqual(["", "confirm", "default", "trust", "forget"])
  })

  test("★ /upgrade 只列 force —— check 照收但不列,它和不带参数是同一件事", () => {
    expect(values("/upgrade ")).toEqual(["", "force"])
    // 列一条和不带参数一模一样的候选,读的人只会停下来想它们差在哪
    expect(values("/upgrade c")).toEqual([])
  })

  test("★ 「什么都不加」是第一条候选 —— 否则最常用的那个用法反而按不出来", () => {
    const found = complete("/upgrade ", 9)!
    const first = found.items[0]!
    expect(first.value).toBe("")
    expect(first.label).toBe(BARE_LABEL)
    expect(first.hint.length).toBeGreaterThan(0)
    // ★ 这条候选靠的是既有规则,不是特例分支:输入框里那一段(from..to)是空的,
    //   高亮那条的值也是空的 —— 补全据此判成"已经打全了",回车就此放行去提交。
    //   见 tui/app.ts 的 completionKey
    expect("/upgrade ".slice(found.from, found.to)).toBe(first.value)
  })

  test("打了字它就该消失 —— 那时候用户要的是某个参数", () => {
    expect(values("/upgrade f")).toEqual(["force"])
    expect(values("/permission tr")).toEqual(["trust"])
  })

  test("★ 只给第一级 —— `/language interface` 本身不是一条完整命令", () => {
    expect(values("/language ")).toEqual(["", "interface", "reply"])
    expect(values("/language interface ")).toEqual(["auto", "en", "zh", "ja"])
  })

  test("没有参数候选的命令照旧什么都不弹 —— /reset 就是", () => {
    expect(complete("/reset ", 7)).toBeUndefined()
  })

  test("选中它之后输入框一个字都不动", () => {
    const found = complete("/upgrade ", 9)!
    expect(apply("/upgrade ", found, found.items[0]!)).toBe("/upgrade ")
  })

  test("对不上就不弹", () => {
    expect(complete("/zzz", 4)).toBeUndefined()
  })
})

describe("★ 什么时候不该弹", () => {
  test("不是以斜杠开头的普通句子", () => {
    expect(complete("fix the /etc thing", 18)).toBeUndefined()
    expect(complete("", 0)).toBeUndefined()
  })

  test("★ 光标不在末尾时不弹 —— 补上去的内容会插到用户没预期的地方", () => {
    expect(complete("/help", 2)).toBeUndefined()
  })

  test("★ 多行输入里的斜杠不是命令", () => {
    expect(complete("/help\nsecond line", 17)).toBeUndefined()
  })

  test("参数已经打完一个词再打第二个就不弹", () => {
    expect(complete("/permission trust x", 19)).toBeUndefined()
  })

  test("没有参数的命令不提示参数", () => {
    expect(complete("/help ", 6)).toBeUndefined()
  })

  test("参数对不上也不弹", () => {
    expect(complete("/permission zz", 14)).toBeUndefined()
  })
})

describe("填回输入框", () => {
  test("命令名替换整段", () => {
    const completion = complete("/pe", 3)!
    expect(apply("/pe", completion, completion.items[0]!)).toBe("/permission ")
  })

  test("★ 有参数的命令顺手补个空格,少按一次", () => {
    const completion = complete("/", 1)!
    const permission = completion.items.find((item) => item.value === "/permission")!
    const help = completion.items.find((item) => item.value === "/help")!
    expect(apply("/", completion, permission)).toBe("/permission ")
    expect(apply("/", completion, help)).toBe("/help")
  })

  test("参数只替换参数那一段", () => {
    const completion = complete("/permission tr", 14)!
    expect(apply("/permission tr", completion, completion.items[0]!)).toBe("/permission trust")
  })
})

// ─────────────────────────────────────────────── /model

describe("★ /model 的候选", () => {
  afterEach(() => setModelChoices([]))

  test("没灌过候选时不给 args —— 空框看起来像「没有能选的模型」,而不是「没人配过」", () => {
    expect(lookup("/model")?.args).toBeUndefined()
    // 命令本身照旧在,自由输入一直能用。打全了又没有参数时框会收起来 ——
    // 那是既有的规矩(见 complete 里的 only),不是这条命令的特例
    expect(values("/mod")).toEqual(["/model"])
    expect(values("/model")).toEqual([])
  })

  test("灌过就列出来,按前缀收窄", () => {
    setModelChoices(["anthropic/claude-opus-4-1", "minimax/MiniMax-M3"])
    expect(values("/model ")).toEqual(["", "anthropic/claude-opus-4-1", "minimax/MiniMax-M3"])
    expect(values("/model min")).toEqual(["minimax/MiniMax-M3"])
  })

  test("★ 大小写不敏感 —— 模型名不是小写的,照原样比一个都匹配不上", () => {
    setModelChoices(["minimax/MiniMax-M3"])
    expect(values("/model minimax/mini")).toEqual(["minimax/MiniMax-M3"])
  })

  test("补进去的是原样的大小写,不是用户打的那个", () => {
    setModelChoices(["minimax/MiniMax-M3"])
    const completion = complete("/model minimax/mini", 19)!
    expect(apply("/model minimax/mini", completion, completion.items[0]!)).toBe("/model minimax/MiniMax-M3")
  })
})
