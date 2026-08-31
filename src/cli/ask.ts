/**
 * 「它问你一句」这件事的内容与交互。
 *
 * ── 和 confirm.ts 的分工完全一样 ──
 * 这里出**内容**(问题怎么摆、选项怎么标号、提示行写什么)和**状态机**
 * (按了一个键之后光标在哪、勾了哪几个、是不是正在打字),两套界面共用:
 * 全屏那个模态框在 tui/panes/question.ts,`--plain` 那条在本文件末尾。
 * 各写一遍的话,总有一天两种界面问的不是同一件事,或者同一个键在两边意思相反。
 *
 * ── 为什么两套界面的交互**不完全**一样(而这是可以的) ──
 * 全屏下有合成器,可以每按一下就重画,所以有光标、有勾选;`--plain` 保留
 * 终端滚动缓冲,写出去的字就钉死在那儿了,没法重画。所以那边退化成
 * 「问题写一遍,按编号回答」。**编号是两边共用的**(全屏下数字键同样直选),
 * 用户在两种界面里学到的是同一件事,只是一边多了个光标。
 *
 * ── 永远留一档自己打字 ──
 * 见 tool/ask.ts:选项之外那一档不是补丁,是这个工具能不能用的前提。
 */
import { Editor } from "./editor.ts"
import type { Key } from "./keys.ts"
import { theme } from "./theme.ts"
import { t } from "../i18n/index.ts"
import type { Answer, Question } from "../tool/types.ts"
import { charWidth, displayWidth, wrapToWidth } from "./width.ts"

/** 只用到这两个方法,写成结构类型省得测试里造一个真的活动区。见 confirm.ts */
export interface Suspendable {
  suspend(): void
  resume(): void
}

export interface AskDeps {
  /** stdin 的持有者。没有(或不是 TTY)就是「这里没人可问」 */
  keyboard?: { usable: boolean; attached: boolean; push(handler: (key: Key) => void): () => void }
  /** 默认 process.stdout */
  output?: NodeJS.WriteStream
  /** 问话期间让出屏幕的底部活动区 */
  region?: Suspendable
  /** 中断时立刻收摊 */
  signal?: AbortSignal
}

export type QuestionKeyResult =
  | { kind: "answer"; answer: Answer }
  | { kind: "update" }
  | { kind: "ignore" }

/**
 * 一次提问的界面状态。**纯的** —— 进去一个按键,出来新状态和一个可选答案,
 * 不碰终端、不碰时间。所以它能被完整单测(见 test/ask.test.ts),而光标、
 * 勾选、打字这三档之间的切换恰恰是最容易写错的地方。
 */
export class QuestionState {
  /** 0..options.length,最后那个是「自己打字」那一行 */
  cursor = 0
  private readonly picked = new Set<number>()
  /** 不是 undefined 就说明正在打字。复用行编辑器:中日韩宽度、粘贴、词移动都现成 */
  private editor: Editor | undefined
  /**
   * 上次自己打的那段话(回头改的时候才有)。
   *
   * 它**不直接进编辑器**:进了的话这道题一打开就在打字状态,而那时候 ← 是
   * 移动光标不是回上一题 —— 用户想接着往回翻就得先按一下 esc。所以它先当成
   * 那一行的现值摆着,回车就是"还用它",按 o / 空格才进去改。
   */
  private restored: string | undefined

  constructor(readonly question: Question) {
    // 回头改的时候把上次的状态摆回去。见 Question.previous
    const previous = question.previous
    if (previous?.kind === "picked") {
      for (const choice of previous.choices) {
        const at = question.options.findIndex((option) => option.label === choice)
        if (at >= 0) this.picked.add(at)
      }
      const first = [...this.picked].sort((a, b) => a - b)[0]
      if (first !== undefined) this.cursor = first
    } else if (previous?.kind === "typed") {
      this.restored = previous.text
      this.cursor = this.freeRow
    }
  }

  /** 前面还有别的题吗 —— 有的话 ← 能回去。见 key() 里那一条 */
  get canGoBack(): boolean {
    return (this.question.position?.index ?? 1) > 1
  }

  /** 自己打字那一行的下标。它永远是最后一行 */
  get freeRow(): number {
    return this.question.options.length
  }

  get typing(): boolean {
    return this.editor !== undefined
  }

  /** 已经勾上的选项文本,按选项本身的顺序 —— 不是按勾选的先后 */
  get chosen(): string[] {
    return this.question.options.filter((_, index) => this.picked.has(index)).map((option) => option.label)
  }

  key(key: Key): QuestionKeyResult {
    if (this.editor) return this.typedKey(key, this.editor)

    if (key.ctrl && (key.name === "c" || key.name === "d")) return dismiss()
    if (key.name === "escape") return dismiss()
    if (key.name === "up") return this.move(-1)
    if (key.name === "down" || key.name === "tab") return this.move(1)
    // ← 回上一题。一次问三个的时候,答到第三个才想起来"刚才第一个我选的是啥",
    // 而在这之前唯一的办法是把整组都取消掉重来一遍。
    // ★ 只在**没在打字**的时候是导航:编辑器里的 ← 是移动光标,那个不能抢
    if (key.name === "left" && this.canGoBack) return { kind: "answer", answer: { kind: "back" } }
    if (key.name === "enter") return this.commit()

    if (key.ctrl || key.meta) return { kind: "ignore" }

    // 数字直选。**两种界面同一套编号** —— 全屏下它是快捷键,--plain 下它是
    // 唯一的选法,而用户学到的是同一件事
    if (/^[1-9]$/.test(key.name)) {
      const index = Number(key.name) - 1
      if (index >= this.question.options.length) return { kind: "ignore" }
      this.cursor = index
      if (!this.question.multiple) return { kind: "answer", answer: { kind: "picked", choices: [this.label(index)] } }
      this.toggle(index)
      return { kind: "update" }
    }

    if (key.name === " ") {
      if (this.cursor === this.freeRow) return this.startTyping()
      if (!this.question.multiple) {
        return { kind: "answer", answer: { kind: "picked", choices: [this.label(this.cursor)] } }
      }
      this.toggle(this.cursor)
      return { kind: "update" }
    }

    if (key.name.toLowerCase() === "o") return this.startTyping()

    return { kind: "ignore" }
  }

  /**
   * 画出来。**已经折好行**,调用方只管往框里塞。
   *
   * 折行放在这里而不是让宿主折:每一行前面有标号和记号,续行必须挂着缩进对齐,
   * 而宿主看到的只是一堆字符串,它没法知道哪一行是续的。
   */
  lines(width: number): string[] {
    const out: string[] = []
    const inner = Math.max(12, width)

    for (const line of wrapToWidth(titleLine(this.question), inner)) out.push(line)
    out.push("")

    this.question.options.forEach((option, index) => {
      const here = this.cursor === index && !this.typing
      const head = `${here ? theme.cyan("▸") : " "} ${theme.dim(`${index + 1}`)} ${this.mark(index)} `
      const label = this.picked.has(index) || here ? theme.bold(option.label) : option.label
      out.push(...hang(head, label, inner, 5))
      if (option.description) {
        out.push(...hang("     ", theme.dim(option.description), inner, 5))
      }
    })

    // 自己打字那一行。没在打字时它就是一档普通选项 —— 用户得先看见它存在,
    // 才会在三个选项都不对的时候想起来还能这样
    const here = this.cursor === this.freeRow
    const head = `${here ? theme.cyan("▸") : " "} ${theme.dim("o")} ${theme.cyan("✎")} `
    if (this.editor) {
      out.push(...hang(head, this.field(), inner, 5))
    } else if (this.restored !== undefined) {
      // 回头改:上次打的那段话就摆在这一行上。看不见的话,用户回来是为了确认
      // "我当时写了什么",而屏幕上写着「something else」
      out.push(...hang(head, here ? theme.bold(this.restored) : theme.cyan(this.restored), inner, 5))
    } else {
      out.push(...hang(head, here ? theme.bold(t.askSomethingElse) : theme.dim(t.askSomethingElse), inner, 5))
    }

    out.push("")
    // 提示行也要折:它是这几行里最长的一条,而窄终端(三栏都开着时中间栏
    // 只有四十列)下超出去的那一截会把框顶破
    for (const line of wrapToWidth(theme.dim(this.hint()), inner)) out.push(line)
    return out
  }

  /** 提示行。三档状态三句话 —— 写死一句的话,打字的时候它还在教你按空格 */
  hint(): string {
    if (this.typing) return t.askHintTyping
    const base = this.question.multiple ? t.askHintMultiple : t.askHintSingle
    // 「能回去」这件事只在真的能回去的时候说。第一题上写着 ← 回上一题,
    // 按下去没反应 —— 那比不写更糟
    return this.canGoBack ? `${base} · ${t.askHintBack}` : base
  }

  // ───────────────────────────────────────────── 内部

  private typedKey(key: Key, editor: Editor): QuestionKeyResult {
    // 空着回车 = 什么都没说,退回选项。**必须拦在编辑器前面** —— 它对空输入
    // 的回答是"什么都没发生"(见 editor.ts 的 submit),而在这里"什么都没发生"
    // 等于按了没反应。当成取消也不对:用户只是想反悔打字这个决定,不是不答了
    if (key.name === "enter" && editor.empty) {
      this.editor = undefined
      return { kind: "update" }
    }
    const action = editor.handle(key)
    if (!action) return { kind: "update" }
    switch (action.type) {
      // ⚠ 文本只能从 action 上取:editor.submit() 交出文本的同时会把自己清空,
      //   回头去读 editor.text 拿到的是空串
      case "submit":
        return { kind: "answer", answer: { kind: "typed", text: action.text.trim() } }
      case "escape":
        // esc 分两级:第一下退出打字回到选项,第二下才是关掉问题。打了半句话
        // 想改主意的时候,不该连问题一起消失
        this.editor = undefined
        return { kind: "update" }
      case "interrupt":
      case "eof":
        return dismiss()
    }
  }

  private startTyping(): QuestionKeyResult {
    this.cursor = this.freeRow
    this.editor = new Editor()
    // 回头改的时候接着上次那段往下改,而不是从空白开始重打一遍
    if (this.restored !== undefined) this.editor.setText(this.restored)
    return { kind: "update" }
  }

  private move(delta: number): QuestionKeyResult {
    const rows = this.freeRow + 1
    this.cursor = (this.cursor + delta + rows) % rows
    return { kind: "update" }
  }

  private commit(): QuestionKeyResult {
    if (this.cursor === this.freeRow) {
      // 回头改回来、又什么都没动:回车就是"还用上次那段话"。逼他重打一遍
      // 才能确认,是在惩罚一次纯粹的查看
      if (this.restored !== undefined) return { kind: "answer", answer: { kind: "typed", text: this.restored } }
      return this.startTyping()
    }
    if (!this.question.multiple) {
      return { kind: "answer", answer: { kind: "picked", choices: [this.label(this.cursor)] } }
    }
    // 一个都没勾就回车:按光标那一条算。报错("请先勾一个")换来的只是多按一下,
    // 而这里的意图完全没有歧义
    const choices = this.picked.size > 0 ? this.chosen : [this.label(this.cursor)]
    return { kind: "answer", answer: { kind: "picked", choices } }
  }

  private toggle(index: number): void {
    if (this.picked.has(index)) this.picked.delete(index)
    else this.picked.add(index)
  }

  private label(index: number): string {
    return this.question.options[index]?.label ?? ""
  }

  private mark(index: number): string {
    if (this.question.multiple) return this.picked.has(index) ? theme.green("[x]") : theme.dim("[ ]")
    return this.cursor === index && !this.typing ? theme.green("●") : theme.dim("○")
  }

  /** 打字那一行:文本 + 一个反色光标块。反色是因为终端里画不了真光标 */
  private field(): string {
    const editor = this.editor
    if (!editor) return ""
    const text = editor.text
    const at = Math.max(0, Math.min(editor.cursor, text.length))
    const under = text.slice(at, at + 1) || " "
    return text.slice(0, at) + theme.inverse(under) + text.slice(at + under.length)
  }
}

/**
 * 问题那一行。
 *
 * 一次问好几个时前面挂上 `2/3` —— 答完一个又冒出一个框,不写这个的话用户
 * 不知道后面还有几个,而"还有两个"和"它又想起来一个"是完全不同的心情。
 */
function titleLine(question: Question): string {
  const at = question.position
  const mark = at && at.total > 1 ? theme.dim(`${at.index}/${at.total} `) : ""
  return `${mark}${theme.bold(`? ${question.question}`)}`
}

/** 挂着缩进折行:头一行带标号,续行对齐到正文 */
function hang(head: string, body: string, width: number, indent: number): string[] {
  const room = Math.max(4, width - displayWidth(head))
  const rows = wrapToWidth(body, room)
  if (rows.length === 0) return [head]
  return rows.map((row, index) => (index === 0 ? head + row : " ".repeat(indent) + row))
}

function dismiss(): QuestionKeyResult {
  return { kind: "answer", answer: { kind: "cancelled" } }
}

// ─────────────────────────────────────────────── --plain 那条路

/**
 * 没有合成器的那种问法:写一遍,按编号回答。
 *
 * ⚠ 这里**不重画**。写进滚动缓冲的字是钉死的,擦不掉 —— 想画一个会动的光标,
 *   就得发光标控制序列,而那正是 --plain 模式刻意不做的事(它要让终端自己的
 *   滚动、选中、tmux copy mode 照常可用)。所以这边只回显用户按了什么。
 */
export async function askInPlain(question: Question, deps: AskDeps = {}): Promise<Answer> {
  const output = deps.output ?? process.stdout

  // ★ 没人可问的时候**一个字都不写**。
  //
  //   这条路在 -p 和管道里也会走到,而那两种形态的 stdout 是要被别的程序吃掉的:
  //   往里灌一个没人会回答的问题,等于污染它的输出。模型那边照旧收到"这儿没人"
  //   (见 tool/ask.ts 的 Answer),而屏幕上那次调用本身有卡片,不会无声无息。
  if (!deps.keyboard?.usable || !deps.keyboard.attached) return { kind: "unavailable" }

  deps.region?.suspend()
  try {
    output.write(renderQuestion(question))
    const answer = await readAnswer(question, deps, output)
    output.write("\n")
    return answer
  } finally {
    deps.region?.resume()
  }
}

/** 问题本身,写进滚动缓冲的那一份。 */
export function renderQuestion(question: Question): string {
  const lines: string[] = ["", `  ${titleLine(question)}`, ""]
  question.options.forEach((option, index) => {
    lines.push(`  ${theme.cyan(`${index + 1}`)} ${option.label}`)
    if (option.description) lines.push(`    ${theme.dim(option.description)}`)
  })
  lines.push(`  ${theme.cyan("o")} ${theme.dim(t.askSomethingElse)}`)
  lines.push("")
  const hint = question.multiple ? t.askPlainHintMultiple : t.askPlainHintSingle
  // 前面还有别的题才写 ← :第一题上写着「回上一题」按下去没反应,比不写更糟
  const back = (question.position?.index ?? 1) > 1 ? ` · ${t.askPlainHintBack}` : ""
  lines.push("  " + theme.dim(hint + back))
  return lines.join("\n") + " "
}

/**
 * 读一个答案。
 *
 * 单选按一下就完;复选攒数字,回车收口。键盘的接管必须在**所有**退出路径上
 * 归还(包括抛异常和中断),否则底下的输入框再也收不到按键 —— 所以用
 * keyboard.push 返回的 dispose,而不是自己去 on/off stdin。
 */
function readAnswer(question: Question, deps: AskDeps, output: NodeJS.WriteStream): Promise<Answer> {
  const keyboard = deps.keyboard!
  return new Promise((resolve) => {
    let settled = false
    let release: (() => void) | undefined
    /** 复选时已经按下的编号 */
    const picked = new Set<number>()
    /** 打字那一档:不是 undefined 就说明在收自由输入 */
    let typed: string | undefined

    const finish = (answer: Answer, echo: string) => {
      if (settled) return
      settled = true
      output.write(echo)
      deps.signal?.removeEventListener("abort", onAbort)
      release?.()
      resolve(answer)
    }

    const labels = () => question.options.filter((_, index) => picked.has(index)).map((option) => option.label)

    const onKey = (key: Key) => {
      if (key.ctrl && (key.name === "c" || key.name === "d")) return finish({ kind: "cancelled" }, theme.dim("^C"))

      if (typed !== undefined) {
        if (key.name === "escape") return finish({ kind: "cancelled" }, theme.dim(" (dismissed)"))
        if (key.name === "enter") {
          const text = typed.trim()
          if (text.length === 0) return finish({ kind: "cancelled" }, theme.dim(" (dismissed)"))
          return finish({ kind: "typed", text }, "")
        }
        if (key.name === "backspace") {
          const last = [...typed].pop()
          if (!last) return
          typed = typed.slice(0, typed.length - last.length)
          // 宽字符要退两格,不然屏幕上会留下半个字
          output.write("\b \b".repeat(charWidth(last)))
          return
        }
        if (key.name === "paste") {
          const text = (key.text ?? "").replaceAll(/\s+/g, " ")
          typed += text
          output.write(text)
          return
        }
        if (key.ctrl || key.meta || [...key.name].length !== 1) return
        typed += key.name
        output.write(key.name)
        return
      }

      if (key.name === "escape") return finish({ kind: "cancelled" }, theme.dim("(dismissed)"))
      // ← 回上一题。这边没有重画,所以"回去"就是把上一题**再写一遍** ——
      // 滚动缓冲里于是留着两份,而那正好是这种界面下最诚实的表示法:
      // 屏幕上从来不会有一行字被偷偷改掉
      if (key.name === "left" && (question.position?.index ?? 1) > 1) {
        return finish({ kind: "back" }, theme.dim("←"))
      }
      if (key.name === "enter") {
        if (!question.multiple) {
          // 光标在全屏那边默认停在第一条,这里没有光标,但**默认必须是同一个** ——
          // 提示行上因此明写着 ⏎ = 1
          const first = question.options[0]
          return first
            ? finish({ kind: "picked", choices: [first.label] }, theme.green("1"))
            : finish({ kind: "cancelled" }, "")
        }
        if (picked.size === 0) return finish({ kind: "cancelled" }, theme.dim("(dismissed)"))
        return finish({ kind: "picked", choices: labels() }, "")
      }
      if (key.ctrl || key.meta) return
      if (key.name.toLowerCase() === "o") {
        typed = ""
        output.write(theme.cyan("o ") + theme.dim("› "))
        return
      }
      if (!/^[1-9]$/.test(key.name)) return
      const index = Number(key.name) - 1
      if (index >= question.options.length) return
      if (!question.multiple) {
        return finish({ kind: "picked", choices: [question.options[index]!.label] }, theme.green(key.name))
      }
      // 复选:同一个数字按第二下是取消。屏幕上擦不掉,所以回显写清楚是加还是减
      if (picked.has(index)) {
        picked.delete(index)
        output.write(theme.dim(`-${key.name} `))
      } else {
        picked.add(index)
        output.write(theme.green(`${key.name} `))
      }
    }

    const onAbort = () => finish({ kind: "cancelled" }, theme.dim("^C"))

    release = keyboard.push(onKey)
    if (deps.signal?.aborted) return onAbort()
    deps.signal?.addEventListener("abort", onAbort, { once: true })
  })
}
