/**
 * 多语言。
 *
 * 漏译在类型上就过不了(zh/ja 都声明成 Catalog),所以这里守的是类型看不住的
 * 那几件事:**活绑定真的活**(切完语言之后已经 import 过 t 的模块也跟着变)、
 * **参数化的那些确实用上了参数**、以及 reply 指令里那句「代码不要翻译」没丢。
 */
import { afterAll, describe, expect, test } from "bun:test"
import { en } from "../src/i18n/en.ts"
import { ja } from "../src/i18n/ja.ts"
import { zh } from "../src/i18n/zh.ts"
import {
  currentInterfaceLanguage,
  detectLanguage,
  isLanguageChoice,
  LANGUAGES,
  languageLabel,
  replyInstruction,
  setInterfaceLanguage,
  t,
} from "../src/i18n/index.ts"
import { commands, complete } from "../src/cli/commands.ts"
import { modeInfo } from "../src/permission/mode.ts"

const started = currentInterfaceLanguage()
afterAll(() => setInterfaceLanguage(started))

const CATALOGS = { en, zh, ja }

describe("目录", () => {
  test("★ 三份目录一个键都不差,类型也对得上", () => {
    for (const [name, catalog] of Object.entries(CATALOGS)) {
      for (const [key, value] of Object.entries(en)) {
        const mine = (catalog as Record<string, unknown>)[key]
        expect(`${name}.${key}: ${typeof mine}`).toBe(`${name}.${key}: ${typeof value}`)
      }
      expect(Object.keys(catalog).length).toBe(Object.keys(en).length)
    }
  })

  test("★ 思考措辞每种语言一样多 —— 少一条,那门语言就永远走不到最后那几档", () => {
    for (const [name, catalog] of Object.entries(CATALOGS)) {
      expect(`${name}: ${catalog.thinkingPhases.length}`).toBe(`${name}: ${en.thinkingPhases.length}`)
      // 每一条都得不一样,否则「换了词」这件事在屏幕上看不出来
      expect(new Set(catalog.thinkingPhases).size).toBe(catalog.thinkingPhases.length)
    }
  })

  test("没有空文案 —— 空字符串在界面上等于这一处没做", () => {
    for (const [name, catalog] of Object.entries(CATALOGS)) {
      for (const [key, value] of Object.entries(catalog)) {
        if (typeof value === "string") expect(`${name}.${key}`.length && value.length).toBeGreaterThan(0)
      }
    }
  })

  test("★ 带参数的必须真的把参数用上", () => {
    for (const catalog of Object.values(CATALOGS)) {
      expect(catalog.queuedStatus(7)).toContain("7")
      expect(catalog.toolsEarlier(3)).toContain("3")
      expect(catalog.summaryFailed("timed out")).toContain("timed out")
      expect(catalog.unknownMode("xyz", "a, b")).toContain("xyz")
      expect(catalog.retrying("boom", "1.5s", 2, 8)).toContain("boom")
      expect(catalog.retrying("boom", "1.5s", 2, 8)).toContain("1.5s")
    }
  })

  test("按键名和模式名不翻译 —— 翻了用户就按不出来、也搜不到", () => {
    for (const catalog of Object.values(CATALOGS)) {
      expect(catalog.recallFiles).toContain("ctrl-b")
      expect(catalog.modeTrust).toBe("trust")
      expect(catalog.viewStream).toBe("stream")
      expect(catalog.helpTui).toContain("/permission")
    }
  })
})

describe("界面语言", () => {
  test("★ t 是活绑定:切完语言,早就 import 过它的地方也跟着变", () => {
    setInterfaceLanguage("ja")
    expect(t.paneFiles).toBe(ja.paneFiles)
    // modeInfo 在**另一个模块**里读 t —— 它要是把值抠出来存过一次,这里就露馅
    expect(modeInfo("trust").hint).toBe(ja.modeTrustHint)
    setInterfaceLanguage("zh")
    expect(t.paneFiles).toBe(zh.paneFiles)
    expect(modeInfo("trust").hint).toBe(zh.modeTrustHint)
  })

  test("命令说明跟着语言走", () => {
    setInterfaceLanguage("en")
    const english = commands().find((command) => command.name === "/view")?.hint
    setInterfaceLanguage("ja")
    expect(commands().find((command) => command.name === "/view")?.hint).not.toBe(english)
  })

  test("语言名本身也要翻译 —— 日文界面里该写「中国語」", () => {
    setInterfaceLanguage("ja")
    expect(languageLabel("zh")).toBe(ja.languageChinese)
    setInterfaceLanguage("zh")
    expect(languageLabel("zh")).toBe(zh.languageChinese)
  })

  test("auto 跟着终端的 locale", () => {
    expect(detectLanguage({ LANG: "zh_CN.UTF-8" } as NodeJS.ProcessEnv)).toBe("zh")
    expect(detectLanguage({ LANG: "ja_JP.UTF-8" } as NodeJS.ProcessEnv)).toBe("ja")
    expect(detectLanguage({ LC_ALL: "ja_JP.UTF-8", LANG: "en_US" } as NodeJS.ProcessEnv)).toBe("ja")
    // 繁体也给简体目录:有一份能读的好过掉回英文
    expect(detectLanguage({ LANG: "zh_TW.UTF-8" } as NodeJS.ProcessEnv)).toBe("zh")
  })

  test("★ 认不出来一律英文 —— 猜错语言比不猜更糟", () => {
    expect(detectLanguage({} as NodeJS.ProcessEnv)).toBe("en")
    expect(detectLanguage({ LANG: "de_DE.UTF-8" } as NodeJS.ProcessEnv)).toBe("en")
    expect(detectLanguage({ LANG: "C" } as NodeJS.ProcessEnv)).toBe("en")
  })

  test("auto 不是一种语言,解析之后落在三种里", () => {
    expect(LANGUAGES).toContain(setInterfaceLanguage("auto"))
    expect(isLanguageChoice("auto")).toBe(true)
    expect(isLanguageChoice("fr")).toBe(false)
  })
})

describe("回答语言指令", () => {
  test("强制时点名那门语言", () => {
    expect(replyInstruction("zh")).toContain("简体中文")
    expect(replyInstruction("ja")).toContain("日本語")
    expect(replyInstruction("en")).toContain("English")
  })

  test("★ auto 也要给一句 —— 提示词是英文的,不说它真会用英文回中文提问", () => {
    expect(replyInstruction("auto")).toContain("same language the user writes in")
  })

  test("★ 每一档都带「代码和路径不要翻译」", () => {
    for (const choice of ["auto", "en", "zh", "ja"] as const) {
      expect(replyInstruction(choice)).toContain("never translate")
    }
  })
})

describe("/language 的两级补全", () => {
  const values = (text: string): string[] => complete(text, text.length)?.items.map((item) => item.value) ?? []

  test("先选 interface 还是 reply", () => {
    // 头一条是「什么都不加」(值为空),见 commands.test.ts
    expect(values("/language ")).toEqual(["", "interface", "reply"])
  })

  test("★ 再选具体语言 —— 一级补全在这里是不够的", () => {
    expect(values("/language reply ")).toEqual(["auto", "en", "zh", "ja"])
    expect(values("/language interface z")).toEqual(["zh"])
  })

  test("走岔了就不给候选,别乱猜", () => {
    expect(values("/language nonsense ")).toEqual([])
  })

  test("第一级选完自动补空格 —— 后面还有一级", () => {
    const found = complete("/language", 9)
    expect(found?.items[0]?.more).toBe(true)
  })
})
