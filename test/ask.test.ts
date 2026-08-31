/**
 * 「它问你一句」。
 *
 * 分两块测:状态机(按了一个键之后光标在哪、勾了什么、是不是在打字)和工具本身
 * (四种回答分别翻译成什么话)。状态机是纯的,所以这里喂按键、断言状态 ——
 * 光标、勾选、打字这三档之间的切换是最容易写错的地方,而在真终端上肉眼看
 * 只能看出"它没反应",看不出是哪一档吞了这个键。
 */
import { describe, expect, test } from "bun:test"
import { askInPlain, QuestionState } from "../src/cli/ask.ts"
import { AskTool } from "../src/tool/ask.ts"
import type { Key } from "../src/cli/keys.ts"
import type { Answer, Question, ToolContext } from "../src/tool/types.ts"
import { stripAnsi } from "../src/cli/width.ts"

const key = (name: string, over: Partial<Key> = {}): Key => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
  ...over,
})

const question = (over: Partial<Question> = {}): Question => ({
  question: "Which database?",
  options: [{ label: "Postgres", description: "already in the stack" }, { label: "SQLite" }, { label: "MySQL" }],
  multiple: false,
  ...over,
})

function answerOf(result: ReturnType<QuestionState["key"]>): Answer | undefined {
  return result.kind === "answer" ? result.answer : undefined
}

// ─────────────────────────────────────────────── 回上一题

describe("回上一题", () => {
  const second = (over: Partial<Question> = {}) => question({ position: { index: 2, total: 3 }, ...over })

  test("★ 只有前面真的还有题时 ← 才是导航 —— 第一题上按了没反应比不写更糟", () => {
    expect(new QuestionState(question()).canGoBack).toBe(false)
    expect(new QuestionState(question({ position: { index: 1, total: 3 } })).canGoBack).toBe(false)
    expect(new QuestionState(second()).canGoBack).toBe(true)
  })

  test("← 交出「回上一题」,第一题上原样吞掉", () => {
    expect(answerOf(new QuestionState(second()).key(key("left")))).toEqual({ kind: "back" })
    expect(new QuestionState(question()).key(key("left")).kind).toBe("ignore")
  })

  test("★ 打字的时候 ← 是移动光标,不能被导航抢走", () => {
    const state = new QuestionState(second())
    state.key(key("o"))
    state.key(key("a"))
    expect(state.key(key("left")).kind).toBe("update")
    expect(state.typing).toBe(true)
  })

  test("回去的时候勾过的还勾着,光标停在第一个选中的上面", () => {
    const state = new QuestionState(
      second({ multiple: true, previous: { kind: "picked", choices: ["SQLite", "MySQL"] } }),
    )
    expect(state.chosen).toEqual(["SQLite", "MySQL"])
    expect(state.cursor).toBe(1)
    // 直接回车 = 还用上次那两个
    expect(answerOf(state.key(key("enter")))).toEqual({ kind: "picked", choices: ["SQLite", "MySQL"] })
  })

  test("★ 上次自己打的那段话摆在那一行上,回车就是「还用它」", () => {
    const state = new QuestionState(second({ previous: { kind: "typed", text: "用 DuckDB" } }))
    expect(state.cursor).toBe(state.freeRow)
    expect(stripAnsi(state.lines(60).join("\n"))).toContain("用 DuckDB")
    // 没进打字状态 —— 进了的话 ← 就变成移动光标,再想往回翻得先按 esc
    expect(state.typing).toBe(false)
    expect(answerOf(state.key(key("enter")))).toEqual({ kind: "typed", text: "用 DuckDB" })
  })

  test("按 o 接着上次那段往下改,不是从空白重打", () => {
    const state = new QuestionState(second({ previous: { kind: "typed", text: "用 DuckDB" } }))
    state.key(key("o"))
    expect(state.typing).toBe(true)
    expect(stripAnsi(state.lines(60).join("\n"))).toContain("用 DuckDB")
  })

  test("认不出来的旧选项(模型改了选项文本)就当没选过,而不是留一个空勾", () => {
    const state = new QuestionState(second({ previous: { kind: "picked", choices: ["Oracle"] } }))
    expect(state.chosen).toEqual([])
    expect(state.cursor).toBe(0)
  })

  test("提示行上只在能回去的时候写 ←", () => {
    expect(new QuestionState(second()).hint()).toContain("←")
    expect(new QuestionState(question()).hint()).not.toContain("←")
  })
})

// ─────────────────────────────────────────────── 单选

describe("单选", () => {
  test("回车选中光标那一条,默认停在第一条", () => {
    const state = new QuestionState(question())
    expect(answerOf(state.key(key("enter")))).toEqual({ kind: "picked", choices: ["Postgres"] })
  })

  test("↑↓ 移动,而且是绕圈的 —— 到底了再按一下回到顶上,不是卡住", () => {
    const state = new QuestionState(question())
    state.key(key("down"))
    state.key(key("down"))
    expect(answerOf(state.key(key("enter")))).toEqual({ kind: "picked", choices: ["MySQL"] })

    const other = new QuestionState(question())
    // 往上一格 = 最后一行(自己打字那一档),再往上一格才是最后一个选项
    other.key(key("up"))
    other.key(key("up"))
    expect(answerOf(other.key(key("enter")))).toEqual({ kind: "picked", choices: ["MySQL"] })
  })

  test("数字直选,不用先挪光标", () => {
    const state = new QuestionState(question())
    expect(answerOf(state.key(key("2")))).toEqual({ kind: "picked", choices: ["SQLite"] })
  })

  test("超出范围的数字什么都不做 —— 不能瞎选一个", () => {
    const state = new QuestionState(question())
    expect(state.key(key("7")).kind).toBe("ignore")
  })

  test("esc / ctrl-c 是「不答」,不是选了什么", () => {
    expect(answerOf(new QuestionState(question()).key(key("escape")))).toEqual({ kind: "cancelled" })
    expect(answerOf(new QuestionState(question()).key(key("c", { ctrl: true })))).toEqual({ kind: "cancelled" })
  })
})

// ─────────────────────────────────────────────── 复选

describe("复选", () => {
  test("空格勾选,回车一次全交出去,顺序按选项本身而不是勾选先后", () => {
    const state = new QuestionState(question({ multiple: true }))
    state.key(key("3"))
    state.key(key("1"))
    expect(answerOf(state.key(key("enter")))).toEqual({ kind: "picked", choices: ["Postgres", "MySQL"] })
  })

  test("同一条按第二下是取消勾选", () => {
    const state = new QuestionState(question({ multiple: true }))
    state.key(key("2"))
    state.key(key("2"))
    state.key(key("1"))
    expect(answerOf(state.key(key("enter")))).toEqual({ kind: "picked", choices: ["Postgres"] })
  })

  test("★ 一个都没勾就回车 = 光标那一条。报错只是多按一下,而这里意图毫无歧义", () => {
    const state = new QuestionState(question({ multiple: true }))
    state.key(key("down"))
    expect(answerOf(state.key(key("enter")))).toEqual({ kind: "picked", choices: ["SQLite"] })
  })
})

// ─────────────────────────────────────────────── 自己打字

describe("自己打字那一档", () => {
  test("o 进去,打完回车回来的是 typed 而不是 picked", () => {
    const state = new QuestionState(question())
    state.key(key("o"))
    expect(state.typing).toBe(true)
    for (const char of "neither, use redis") state.key(key(char))
    expect(answerOf(state.key(key("enter")))).toEqual({ kind: "typed", text: "neither, use redis" })
  })

  test("★ esc 分两级:第一下退回选项,第二下才关掉问题", () => {
    const state = new QuestionState(question())
    state.key(key("o"))
    state.key(key("x"))
    expect(state.key(key("escape")).kind).toBe("update")
    expect(state.typing).toBe(false)
    expect(answerOf(state.key(key("escape")))).toEqual({ kind: "cancelled" })
  })

  test("空着回车退回选项,不是取消 —— 用户只是反悔了打字这个决定", () => {
    const state = new QuestionState(question())
    state.key(key("o"))
    expect(state.key(key("enter")).kind).toBe("update")
    expect(state.typing).toBe(false)
  })

  test("打字的时候数字是字,不是快捷键", () => {
    const state = new QuestionState(question())
    state.key(key("o"))
    for (const char of "2 or 3") state.key(key(char))
    expect(answerOf(state.key(key("enter")))).toEqual({ kind: "typed", text: "2 or 3" })
  })
})

// ─────────────────────────────────────────────── 画出来

describe("画出来", () => {
  test("问题、每个选项、以及「自己打字」那一档都在,一行都不许超宽", () => {
    const state = new QuestionState(question())
    const lines = state.lines(40)
    const flat = lines.join("\n")
    expect(flat).toContain("Which database?")
    expect(flat).toContain("Postgres")
    expect(flat).toContain("SQLite")
    expect(flat).toContain("MySQL")
    // 编号两边界面共用,所以它必须画出来
    expect(flat).toContain("1")
    for (const line of lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(40)
  })

  test("提示行跟着状态走 —— 打字的时候不能还在教人按空格", () => {
    const single = new QuestionState(question())
    const multi = new QuestionState(question({ multiple: true }))
    expect(single.hint()).not.toBe(multi.hint())
    single.key(key("o"))
    expect(single.hint()).toContain("esc")
    expect(single.hint()).not.toContain("1-9")
  })
})

// ─────────────────────────────────────────────── 工具

describe("ask 工具", () => {
  const context = (over: Partial<ToolContext> = {}): ToolContext => ({
    cwd: "/tmp",
    root: "/tmp",
    sessionID: "s",
    messageID: "m",
    callID: "c",
    abortSignal: new AbortController().signal,
    ask: async () => {},
    onProgress: () => {},
    metadata: () => {},
    ...over,
  })

  const args = {
    questions: [{ question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] }],
  }

  test("★ 没人可问的时候立刻回话,而且说的是「你自己定」,不是报错", async () => {
    const result = await AskTool.execute(args, context())
    expect(result.output).toContain("nobody to answer")
    expect(result.output).toContain("Decide it yourself")
    expect(result.metadata["unavailable"]).toBe(true)
  })

  test("选项少于两个直接退回去 —— 那不是一个问题", async () => {
    await expect(
      AskTool.execute({ questions: [{ question: "Which database?", options: [{ label: "Postgres" }] }] }, context()),
    ).rejects.toThrow(/fewer than 2 options/)
  })

  test("重复的选项被合掉:两条一模一样的会让用户以为自己看错了", async () => {
    let asked: Question | undefined
    await AskTool.execute(
      {
        questions: [
          {
            question: "Which database?",
            options: [{ label: "Postgres" }, { label: "postgres" }, { label: "SQLite" }],
          },
        ],
      },
      context({
        inquire: async (input) => {
          asked = input
          return { kind: "cancelled" }
        },
      }),
    )
    expect(asked?.options.map((option) => option.label)).toEqual(["Postgres", "SQLite"])
  })

  test("挑了就原样把**选项文本**回给模型,不是下标", async () => {
    const patches: Record<string, unknown>[] = []
    const result = await AskTool.execute(
      args,
      context({
        inquire: async () => ({ kind: "picked", choices: ["SQLite"] }),
        metadata: (patch) => patches.push(patch),
      }),
    )
    expect(result.output).toContain("SQLite")
    // 卡片上那一行读的是 metadata(见 cli/render.ts 的 outcomeLine)
    expect(patches.some((patch) => patch["answer"] === "SQLite")).toBe(true)
  })

  test("★ 自己打的那段是**新指令**,回话里必须这么说 —— 不然它会当成第三个选项", async () => {
    const result = await AskTool.execute(
      args,
      context({ inquire: async () => ({ kind: "typed", text: "use redis" }) }),
    )
    expect(result.output).toContain("use redis")
    expect(result.output).toContain("instruction")
  })

  test("没答 = 别再问一遍,自己挑一个往下走", async () => {
    const result = await AskTool.execute(
      args,
      context({ inquire: async () => ({ kind: "cancelled" }) }),
    )
    expect(result.output).toMatch(/do not ask it again/i)
    expect(result.metadata["answered"]).toBe(false)
  })

  test("被门卫拒了就抛出去 —— 「从不打断我」是一条正当的规则", async () => {
    await expect(
      AskTool.execute(
        args,
        context({
          ask: async () => {
            throw new Error("Permission denied")
          },
        }),
      ),
    ).rejects.toThrow(/Permission denied/)
  })
})

// ─────────────────────────────────────────────── --plain 那条路

describe("--plain 的问法", () => {
  /** 假键盘:按 push 收下处理器,测试自己往里喂键 */
  function fakeKeyboard() {
    let handler: ((key: Key) => void) | undefined
    return {
      usable: true,
      attached: true,
      push(next: (key: Key) => void) {
        handler = next
        return () => {
          handler = undefined
        }
      },
      press(name: string, over: Partial<Key> = {}) {
        handler?.(key(name, over))
      },
    }
  }

  function fakeOutput() {
    const chunks: string[] = []
    return {
      chunks,
      stream: { write: (text: string) => chunks.push(text) } as unknown as NodeJS.WriteStream,
    }
  }

  test("★ 没人可问的时候一个字都不写 —— -p 的 stdout 是要给别的程序吃的", async () => {
    const out = fakeOutput()
    const answer = await askInPlain(question(), { output: out.stream })
    expect(answer).toEqual({ kind: "unavailable" })
    expect(out.chunks.join("")).toBe("")
  })

  test("问题和编号写出去,按编号答", async () => {
    const keyboard = fakeKeyboard()
    const out = fakeOutput()
    const pending = askInPlain(question(), { keyboard, output: out.stream })
    await Promise.resolve()
    expect(out.chunks.join("")).toContain("Which database?")
    keyboard.press("2")
    expect(await pending).toEqual({ kind: "picked", choices: ["SQLite"] })
  })

  test("复选攒编号,回车一次交出去", async () => {
    const keyboard = fakeKeyboard()
    const out = fakeOutput()
    const pending = askInPlain(question({ multiple: true }), { keyboard, output: out.stream })
    await Promise.resolve()
    keyboard.press("1")
    keyboard.press("3")
    keyboard.press("enter")
    expect(await pending).toEqual({ kind: "picked", choices: ["Postgres", "MySQL"] })
  })

  test("o 之后打的字按 typed 回去", async () => {
    const keyboard = fakeKeyboard()
    const out = fakeOutput()
    const pending = askInPlain(question(), { keyboard, output: out.stream })
    await Promise.resolve()
    keyboard.press("o")
    for (const char of "redis") keyboard.press(char)
    keyboard.press("enter")
    expect(await pending).toEqual({ kind: "typed", text: "redis" })
  })

  test("中断信号一来就收摊 —— 不然那条工具会一直等一个没人在的终端", async () => {
    const keyboard = fakeKeyboard()
    const out = fakeOutput()
    const controller = new AbortController()
    const pending = askInPlain(question(), { keyboard, output: out.stream, signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    expect(await pending).toEqual({ kind: "cancelled" })
  })
})

// ─────────────────────────────────────────────── 一次问好几个

describe("一次问好几个", () => {
  const context = (over: Partial<ToolContext> = {}): ToolContext => ({
    cwd: "/tmp",
    root: "/tmp",
    sessionID: "s",
    messageID: "m",
    callID: "c",
    abortSignal: new AbortController().signal,
    ask: async () => {},
    onProgress: () => {},
    metadata: () => {},
    ...over,
  })

  const three = {
    questions: [
      { question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
      { question: "Include migrations?", options: [{ label: "yes" }, { label: "no" }] },
      { question: "Which runtime?", options: [{ label: "bun" }, { label: "node" }] },
    ],
  }

  test("★ 三个问题一次调用就问完 —— 省下的是三轮重发整段历史", async () => {
    const seen: Question[] = []
    const result = await AskTool.execute(
      three,
      context({
        inquire: async (question) => {
          seen.push(question)
          return { kind: "picked", choices: [question.options[0]!.label] }
        },
      }),
    )
    expect(seen).toHaveLength(3)
    expect(result.output).toContain("1. Which database?")
    expect(result.output).toContain("3. Which runtime?")
    expect(result.output).toContain("Postgres")
    expect(result.metadata["questions"]).toBe(3)
  })

  test("界面上要知道这是第几个 —— 不然用户以为它又想起来一个", async () => {
    const seen: Question[] = []
    await AskTool.execute(
      three,
      context({
        inquire: async (question) => {
          seen.push(question)
          return { kind: "picked", choices: ["x"] }
        },
      }),
    )
    expect(seen.map((question) => question.position)).toEqual([
      { index: 1, total: 3 },
      { index: 2, total: 3 },
      { index: 3, total: 3 },
    ])
  })

  test("★ 按 ← 回上一题,而且带着上次的答案回去 —— 用户回去正是为了确认自己选了什么", async () => {
    const seen: Array<{ index: number; previous: Answer | undefined }> = []
    let step = 0
    const result = await AskTool.execute(
      three,
      context({
        inquire: async (question) => {
          seen.push({ index: question.position!.index, previous: question.previous })
          step++
          // 答完 1、答完 2,在第三题上回头,把第二题改掉,再一路答完
          if (step === 3) return { kind: "back" }
          if (step === 4) return { kind: "picked", choices: ["no"] }
          return { kind: "picked", choices: [question.options[0]!.label] }
        },
      }),
    )
    expect(seen.map((each) => each.index)).toEqual([1, 2, 3, 2, 3])
    // 回到第二题时,上次选的那个跟着回来
    expect(seen[3]!.previous).toEqual({ kind: "picked", choices: ["yes"] })
    // 第三题是第一次答,没有 previous(它上次是被 ← 跳过的,不是答过的)
    expect(seen[4]!.previous).toBeUndefined()
    // 模型看到的是改过之后那份,「回上一题」这件事一个字都不进它的上下文
    expect(result.output).toContain("no")
    expect(result.output).not.toContain("back")
    expect(result.metadata["questions"]).toBe(3)
  })

  test("★ 没人可问的话不再接着问剩下的 —— 后面每个的答案都会是同一句", async () => {
    let asked = 0
    const result = await AskTool.execute(
      three,
      context({
        inquire: async () => {
          asked++
          return { kind: "unavailable" }
        },
      }),
    )
    expect(asked).toBe(1)
    expect(result.metadata["unavailable"]).toBe(true)
    // 没问出口的那几个要报上去,不然模型只知道第一个没答成
    expect(result.output).toContain("Include migrations?")
  })

  test("★ 用户中断这一轮之后不再往下弹 —— 那是在跟一个刚按了 Ctrl-C 的人较劲", async () => {
    const controller = new AbortController()
    let asked = 0
    const result = await AskTool.execute(
      three,
      context({
        abortSignal: controller.signal,
        inquire: async () => {
          asked++
          controller.abort()
          return { kind: "cancelled" }
        },
      }),
    )
    expect(asked).toBe(1)
    expect(result.metadata["questions"]).toBe(1)
  })

  test("答案混着来的时候,每一种都说清是哪一种", async () => {
    const answers: Answer[] = [
      { kind: "picked", choices: ["Postgres"] },
      { kind: "typed", text: "use redis" },
      { kind: "cancelled" },
    ]
    let at = 0
    const result = await AskTool.execute(three, context({ inquire: async () => answers[at++]! }))
    expect(result.output).toContain("Postgres")
    expect(result.output).toContain("in their own words) use redis")
    expect(result.output).toContain("dismissed without answering")
    expect(result.output).toMatch(/replaces the options/)
  })
})
