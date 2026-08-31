/**
 * `/setting` 那一屏:内容(cli/settings.ts)和画面(tui/panes/settings.ts)。
 *
 * 这一屏最容易坏在两处:**值和候选对不上**(画的是 label、切的是 value,
 * 两边一旦不一致,按左右键会跳到一个用户没选过的值上),和**改完没落到真地方**
 * (改了 config 里那份、没改按文件夹那份,用户回来发现又变回去了)。
 * 所以这两件事各有一组直接的断言。
 */
import { describe, expect, test } from "bun:test"
import { buildPage, createSettings, type ProviderRow, type SettingsHost } from "../src/cli/settings.ts"
import {
  cycleValue,
  flatRows,
  renderSettings,
  settingsKey,
  type SettingRow,
} from "../src/tui/panes/settings.ts"
import { setColorEnabled } from "../src/cli/theme.ts"
import { displayWidth, stripAnsi } from "../src/cli/width.ts"
import type { Key } from "../src/cli/keys.ts"

setColorEnabled(false)

const key = (name: string, ctrl = false): Key => ({ name, ctrl, meta: false, shift: false })

/** 一个把每一次写都记下来的假宿主。默认值挑的是"和缺省不一样"的那几个 */
function fakeHost(overrides: Partial<SettingsHost> = {}) {
  const wrote: Array<[string, unknown]> = []
  const state = {
    view: "session" as "session" | "stream",
    panels: false,
    trust: "trusted" as "trusted" | "untrusted" | "checking",
    mode: "default" as "confirm" | "default" | "trust",
    thinking: false,
    flow: false as number | false,
    autoCompact: true,
    check: true,
    language: { interface: "auto", reply: "auto" } as Record<string, string>,
    model: "anthropic/claude-sonnet-4-5",
    keys: new Map<string, string>([["anthropic", "sk-ant-real-key"]]),
  }
  const host: SettingsHost = {
    view: () => state.view,
    setView: (view) => {
      state.view = view
      wrote.push(["view", view])
    },
    panels: () => state.panels,
    setPanels: (on) => {
      state.panels = on
      wrote.push(["panels", on])
    },
    trust: () => state.trust,
    trustedAt: () => "2026-08-31",
    setTrust: (next) => {
      state.trust = next
      wrote.push(["trust", next])
    },
    checkTrust: () => {
      wrote.push(["checkTrust", true])
      return undefined
    },
    mode: () => state.mode,
    setMode: (mode) => {
      state.mode = mode
      wrote.push(["mode", mode])
    },
    thinking: () => state.thinking,
    setThinking: (value) => {
      state.thinking = value
      wrote.push(["thinking", value])
    },
    agentflow: () => state.flow,
    setAgentflow: (value) => {
      state.flow = value
      wrote.push(["agentflow", value])
    },
    autoCompact: () => state.autoCompact,
    setAutoCompact: (value) => {
      state.autoCompact = value
      wrote.push(["autoCompact", value])
    },
    checkCommand: () => "bun run typecheck",
    checkEnabled: () => state.check,
    setCheckEnabled: (value) => {
      state.check = value
      wrote.push(["check", value])
    },
    language: (kind) => state.language[kind] as never,
    setLanguage: (kind, value) => {
      state.language[kind] = value
      wrote.push([`language.${kind}`, value])
    },
    model: () => state.model,
    modelChoices: () => ["anthropic/claude-opus-4-1", "anthropic/claude-sonnet-4-5"],
    switchModel: (spec) => {
      state.model = spec
      wrote.push(["model", spec])
      return undefined
    },
    modelBlockedBy: () => undefined,
    providers: (): ProviderRow[] => [
      { id: "anthropic", type: "anthropic", source: "file", masked: "sk-ant…key" },
      { id: "env-one", type: "openai-compat", source: "env", masked: "sk-env…9911" },
      { id: "dry", type: "openai-compat", source: "none" },
    ],
    setKey: (id, apiKey) => {
      state.keys.set(id, apiKey)
      wrote.push([`key.${id}`, apiKey])
      return undefined
    },
    clearKey: (id) => {
      state.keys.delete(id)
      wrote.push([`key.${id}`, undefined])
    },
    ...overrides,
  }
  return { host, wrote, state }
}

function rowOf(page: ReturnType<typeof buildPage>, id: string): SettingRow {
  const row = flatRows(page!).find((one) => one.id === id)
  if (!row) throw new Error(`no row ${id}`)
  return row
}

describe("设置的内容", () => {
  test("★ 每一格都是现取的 —— 别处改过之后再打开,画的是现在", () => {
    const { host, state } = fakeHost()
    expect(rowOf(buildPage("root", host), "thinking").value).toBe("off")
    state.thinking = true
    expect(rowOf(buildPage("root", host), "thinking").value).toBe("on")
  })

  /**
   * ★ 画的是 label、切的是 value。存 label 的话左右键就得反查一遍文字,
   *   而两处一旦不一致,按左右键会跳到一个用户没选过的值上。
   */
  test("★ 每一条 choice 行的当前值都在自己的候选里", () => {
    const { host } = fakeHost()
    for (const row of flatRows(buildPage("root", host)!)) {
      if (row.kind !== "choice") continue
      expect(row.choices?.map((one) => one.value)).toContain(row.value)
    }
  })

  test("左右键在候选里转圈,到头绕回来", () => {
    const { host } = fakeHost()
    const view = rowOf(buildPage("root", host), "view")
    expect(cycleValue(view, 1)).toBe("stream")
    expect(cycleValue({ ...view, value: "stream" }, 1)).toBe("session")
    expect(cycleValue(view, -1)).toBe("stream")
  })

  test("改一条就落到宿主上,回执写的是改完之后的样子", () => {
    const { host, wrote } = fakeHost()
    const settings = createSettings(host)
    expect(settings.choose("root", "view", "stream").note).toContain("stream")
    expect(settings.choose("root", "panels", "on").note).toBeDefined()
    expect(wrote).toEqual([
      ["view", "stream"],
      ["panels", true],
    ])
  })

  // agentflow 的"开"是一个数(同时几个),不是 true —— 那个数就是它的全部代价
  test("★ agentflow 开的时候记的是缺省窗口,不是 true", () => {
    const { host, state } = fakeHost()
    createSettings(host).choose("root", "agentflow", "on")
    expect(typeof state.flow).toBe("number")
    createSettings(host).choose("root", "agentflow", "off")
    expect(state.flow).toBe(false)
  })

  // 「先看一眼」不是一个状态,是一个动作:它要派人出去
  test("★ 信任那一格选 check 是派人去读,不是直接把标记翻过来", () => {
    const { host, wrote, state } = fakeHost()
    createSettings(host).choose("root", "trust", "checking")
    expect(wrote).toEqual([["checkTrust", true]])
    expect(state.trust).toBe("trusted")
  })

  test("换模型:换成了就退回上一层,换的是同一个就只说一声", () => {
    const { host } = fakeHost()
    const settings = createSettings(host)
    expect(settings.choose("model", "anthropic/claude-sonnet-4-5", "").back).toBeUndefined()
    const done = settings.choose("model", "anthropic/claude-opus-4-1", "")
    expect(done.back).toBe(true)
    expect(done.error).toBeUndefined()
  })

  test("换不过去时留在原地,而且说得出为什么", () => {
    const { host } = fakeHost({ switchModel: () => "no credentials for openai" })
    const result = createSettings(host).choose("model", "openai/gpt-5", "")
    expect(result.error).toBe("no credentials for openai")
    expect(result.back).toBeUndefined()
  })

  // ★ 粘贴里夹着换行/空格是最常见的一种"key 明明是对的却报 401"
  test("★ 密钥:空的和带空白的都当场挡下,不存", () => {
    const { host, wrote } = fakeHost()
    const settings = createSettings(host)
    expect(settings.choose("provider:anthropic", "paste", "   ").error).toBeDefined()
    expect(settings.choose("provider:anthropic", "paste", "sk-a bc").error).toBeDefined()
    expect(wrote).toEqual([])
    expect(settings.choose("provider:anthropic", "paste", "  sk-ant-new  ").note).toBeDefined()
    expect(wrote).toEqual([["key.anthropic", "sk-ant-new"]])
  })

  test("环境变量压着的那一家灰掉,但**留在清单里** —— 抠掉的话用户会以为自己没配过", () => {
    const { host } = fakeHost()
    const row = rowOf(buildPage("provider:env-one", host), "paste")
    expect(row.locked).toBe(true)
    expect(row.hint).toContain("env-one")
    // 没有 key 的那家不给"删掉"这一行 —— 一个点了没反应的按钮比没有按钮糟
    expect(flatRows(buildPage("provider:dry", host)!).map((one) => one.id)).toEqual(["paste"])
    expect(flatRows(buildPage("provider:anthropic", host)!).map((one) => one.id)).toEqual(["paste", "clear"])
  })

  // 清单里全是长得差不多的模型名。光标停在第一行的话,用户第一件事是先找
  // 自己在哪 —— 而那正是这一页已经用 ● 标出来的东西
  test("★ 换模型那一页光标落在当前那个上", () => {
    const { host } = fakeHost()
    const page = buildPage("model", host)!
    expect(page.selected).toBe(1)
    expect(flatRows(page)[page.selected!]!.id).toBe("anthropic/claude-sonnet-4-5")
  })

  test("不认识的页返回 undefined,不返回一页空的", () => {
    const { host } = fakeHost()
    expect(buildPage("nope", host)).toBeUndefined()
  })
})

describe("设置这一屏怎么画", () => {
  const { host } = fakeHost()
  const root = buildPage("root", host)!

  test("★ 行数正好等于给的高度,每一行都不超宽", () => {
    for (const width of [36, 48, 60, 80]) {
      for (const height of [10, 16, 26]) {
        const lines = renderSettings(root, { selected: 3, width, height })
        expect(lines).toHaveLength(height)
        for (const line of lines) expect(displayWidth(stripAnsi(line))).toBeLessThanOrEqual(width)
      }
    }
  })

  // 一整页装不下时,选中项必须在窗口里 —— 看不见的高亮等于没有高亮
  test("★ 长页滚动时选中那一行一定在画面里", () => {
    const rows = flatRows(root)
    for (const selected of rows.map((_, index) => index)) {
      const lines = renderSettings(root, { selected, width: 60, height: 12 }).map(stripAnsi)
      expect(lines.some((line) => line.startsWith(" ▸ "))).toBe(true)
    }
  })

  test("★ 密钥打字时画的是圆点,不是字", () => {
    const page = buildPage("provider:anthropic", host)!
    const painted = renderSettings(page, { selected: 0, width: 60, height: 10, typed: "sk-ant-secret" }).join("\n")
    expect(painted).not.toContain("sk-ant-secret")
    expect(painted).toContain("•")
  })

  // 一页里一条能左右切的都没有时不写「←→ change」—— 一条按了没反应的提示,
  // 比不写更让人怀疑是不是自己按错了
  test("键位提示跟着这一页有什么行走", () => {
    const models = renderSettings(buildPage("model", host)!, { selected: 0, width: 60, height: 10 }).join("\n")
    expect(models).not.toContain("←→")
    expect(renderSettings(root, { selected: 0, width: 60, height: 20 }).join("\n")).toContain("←→")
  })

  // 换模型那一页整页都没有值可写,标签就该占满整行 —— 固定在 30 列的话
  // `anthropic/claude-sonnet-4-5` 会被截成 `…-4…`,而末尾几位正是两代的差别
  test("★ 一页都没有值可写时,标签占满整行", () => {
    const painted = renderSettings(buildPage("model", host)!, { selected: 0, width: 46, height: 10 }).join("\n")
    expect(painted).toContain("anthropic/claude-sonnet-4-5")
  })

  test("空页写一句话,不留一片空白", () => {
    const empty = { id: "x", title: "x", sections: [], empty: "nothing here yet" }
    expect(renderSettings(empty, { selected: 0, width: 40, height: 8 }).join("\n")).toContain("nothing here yet")
  })
})

describe("设置这一屏的按键", () => {
  test("打字的时候是另一套 —— q 是一个字符,不是「关掉」", () => {
    expect(settingsKey(key("q"), { editing: false })).toEqual({ kind: "pass" })
    expect(settingsKey(key("q"), { editing: true })).toEqual({ kind: "type", text: "q" })
    expect(settingsKey(key("escape"), { editing: true })).toEqual({ kind: "back" })
    expect(settingsKey(key("enter"), { editing: true })).toEqual({ kind: "submit" })
  })

  // 一个 API key 是粘进来的,没人会手打
  test("★ 粘贴块整段收下", () => {
    const paste: Key = { name: "paste", ctrl: false, meta: false, shift: false, text: "sk-ant-123" }
    expect(settingsKey(paste, { editing: true })).toEqual({ kind: "type", text: "sk-ant-123" })
  })

  test("上下选、左右改、回车进去、esc 退一层", () => {
    expect(settingsKey(key("down"), { editing: false })).toEqual({ kind: "move", delta: 1 })
    expect(settingsKey(key("right"), { editing: false })).toEqual({ kind: "cycle", delta: 1 })
    expect(settingsKey(key("enter"), { editing: false })).toEqual({ kind: "enter" })
    expect(settingsKey(key("escape"), { editing: false })).toEqual({ kind: "back" })
    expect(settingsKey(key("c", true), { editing: false })).toEqual({ kind: "close" })
  })
})
