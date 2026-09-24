/**
 * Multiple languages.
 *
 * A missing translation doesn't even get past the types (zh/ja are both declared as
 * Catalog), so what's guarded here are the things types can't watch: **the live binding
 * really is live** (after switching language, modules that already imported t change
 * too), **the parameterized entries really do use their parameters**, and the "don't
 * translate code" line in the reply instruction hasn't gone missing.
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
import { optionsLine } from "../src/cli/confirm.ts"
import { stripAnsi } from "../src/cli/width.ts"
import { authUsage } from "../src/cli/auth.ts"

const started = currentInterfaceLanguage()
afterAll(() => setInterfaceLanguage(started))

const CATALOGS = { en, zh, ja }

describe("catalogs", () => {
  test("★ all three catalogs have every key, with matching types", () => {
    for (const [name, catalog] of Object.entries(CATALOGS)) {
      for (const [key, value] of Object.entries(en)) {
        const mine = (catalog as Record<string, unknown>)[key]
        expect(`${name}.${key}: ${typeof mine}`).toBe(`${name}.${key}: ${typeof value}`)
      }
      expect(Object.keys(catalog).length).toBe(Object.keys(en).length)
    }
  })

  test("no empty strings — an empty string on screen means that spot was never done", () => {
    for (const [name, catalog] of Object.entries(CATALOGS)) {
      for (const [key, value] of Object.entries(catalog)) {
        if (typeof value === "string") expect(`${name}.${key}`.length && value.length).toBeGreaterThan(0)
      }
    }
  })

  test("★ parameterized entries really use their parameters", () => {
    for (const catalog of Object.values(CATALOGS)) {
      expect(catalog.queuedStatus(7)).toContain("7")
      expect(catalog.toolsEarlier(3)).toContain("3")
      expect(catalog.unknownMode("xyz", "a, b")).toContain("xyz")
      expect(catalog.retrying("boom", "1.5s", 2, 8)).toContain("boom")
      expect(catalog.retrying("boom", "1.5s", 2, 8)).toContain("1.5s")
    }
  })

  test("key names and mode names are not translated — translated, the user can't press or search for them", () => {
    for (const catalog of Object.values(CATALOGS)) {
      expect(catalog.recallFiles).toContain("ctrl-b")
      expect(catalog.modeAuto).toBe("auto")
    }
  })
})

describe("interface language", () => {
  test("★ t is a live binding: after a language switch, modules that imported it earlier change too", () => {
    setInterfaceLanguage("ja")
    expect(t.paneFiles).toBe(ja.paneFiles)
    // modeInfo reads t in **another module** — if it had pulled the value out and stored
    // it once, this is where it would show
    expect(modeInfo("auto").hint).toBe(ja.modeAutoHint)
    setInterfaceLanguage("zh")
    expect(t.paneFiles).toBe(zh.paneFiles)
    expect(modeInfo("auto").hint).toBe(zh.modeAutoHint)
  })

  test("command hints follow the language", () => {
    setInterfaceLanguage("en")
    const english = commands().find((command) => command.name === "/view")?.hint
    setInterfaceLanguage("ja")
    expect(commands().find((command) => command.name === "/view")?.hint).not.toBe(english)
  })

  test("the standalone auth screen follows the saved interface language", () => {
    setInterfaceLanguage("zh")
    expect(authUsage()).toContain("用法")
    expect(authUsage()).toContain("不会回显")
    setInterfaceLanguage("ja")
    expect(authUsage()).toContain("使用方法")
  })

  test("language names are translated too — the Japanese UI names Chinese in Japanese", () => {
    setInterfaceLanguage("ja")
    expect(languageLabel("zh")).toBe(ja.languageChinese)
    setInterfaceLanguage("zh")
    expect(languageLabel("zh")).toBe(zh.languageChinese)
  })

  test("auto follows the terminal locale", () => {
    expect(detectLanguage({ LANG: "zh_CN.UTF-8" } as NodeJS.ProcessEnv)).toBe("zh")
    expect(detectLanguage({ LANG: "ja_JP.UTF-8" } as NodeJS.ProcessEnv)).toBe("ja")
    expect(detectLanguage({ LC_ALL: "ja_JP.UTF-8", LANG: "en_US" } as NodeJS.ProcessEnv)).toBe("ja")
    // Traditional Chinese gets the Simplified catalog too: something readable beats
    // falling back to English
    expect(detectLanguage({ LANG: "zh_TW.UTF-8" } as NodeJS.ProcessEnv)).toBe("zh")
  })

  test("★ anything unrecognized means English — guessing the wrong language is worse than not guessing", () => {
    expect(detectLanguage({} as NodeJS.ProcessEnv)).toBe("en")
    expect(detectLanguage({ LANG: "de_DE.UTF-8" } as NodeJS.ProcessEnv)).toBe("en")
    expect(detectLanguage({ LANG: "C" } as NodeJS.ProcessEnv)).toBe("en")
  })

  test("auto is not a language, it resolves to one of the three", () => {
    expect(LANGUAGES).toContain(setInterfaceLanguage("auto"))
    expect(isLanguageChoice("auto")).toBe(true)
    expect(isLanguageChoice("fr")).toBe(false)
  })
})

describe("reply language instruction", () => {
  test("a forced choice names that language", () => {
    expect(replyInstruction("zh")).toContain("简体中文")
    expect(replyInstruction("ja")).toContain("日本語")
    expect(replyInstruction("en")).toContain("English")
  })

  test("★ auto still gets a line — the prompt is English, and without it the model really answers Chinese questions in English", () => {
    expect(replyInstruction("auto")).toContain("same language the user writes in")
  })

  test("★ every choice includes 'never translate code and paths'", () => {
    for (const choice of ["auto", "en", "zh", "ja"] as const) {
      expect(replyInstruction(choice)).toContain("never translate")
    }
  })
})

describe("/language two-level completion", () => {
  const values = (text: string): string[] => complete(text, text.length)?.items.map((item) => item.value) ?? []

  test("first choose interface or reply", () => {
    // the first entry is "leave it as is" (empty value), see commands.test.ts
    expect(values("/language ")).toEqual(["", "interface", "reply"])
  })

  test("★ then the specific language — one level of completion isn't enough here", () => {
    expect(values("/language reply ")).toEqual(["auto", "en", "zh", "ja"])
    expect(values("/language interface z")).toEqual(["zh"])
  })

  test("a wrong turn gets no candidates, no guessing", () => {
    expect(values("/language nonsense ")).toEqual([])
  })

  test("picking the first level appends a space — another level follows", () => {
    const found = complete("/language", 9)
    expect(found?.items[0]?.more).toBe(true)
  })
})

/**
 * ★ English hard-coded around `t.*`.
 *
 * The keys of the three catalogs line up exactly (the types watch that), so what slips
 * through is never "some key wasn't translated" but **some sentence never went through
 * this mechanism at all**. Where that hurts most is the permission prompt: it is the one
 * screen in this program where "the user presses before they've had time to read" costs
 * the most, and `optionsLine` is the copy **shared** by --plain and full screen.
 *
 * The other kind is "the same thing in a different language in each of the two modes":
 * the `--plain` status line hard-coded "N queued" and "press twice to exit" in English,
 * while the full-screen side always went through i18n.
 *
 * The criterion is **the sentence really changes after switching language**, not "does a
 * key exist".
 */
describe("★ no UI string may bypass i18n", () => {
  const request = {
    tool: "bash",
    patterns: ["bash:rm"],
    alwaysPatterns: ["bash:rm"],
    metadata: { command: "rm -rf x" },
  } as unknown as Parameters<typeof optionsLine>[0]

  test("★ the permission prompt line — the copy both hosts share", () => {
    setInterfaceLanguage("en")
    const english = optionsLine(request)
    setInterfaceLanguage("zh")
    const chinese = optionsLine(request)
    expect(english).not.toBe(chinese)
    expect(stripAnsi(chinese)).toContain(zh.promptAllowOnce)
    // ★ key names aren't translated: translate what has to be pressed and it can't be
    // pressed anymore
    for (const line of [english, chinese]) {
      expect(stripAnsi(line)).toContain("[⏎ y]")
      expect(stripAnsi(line)).toContain("[esc n]")
    }
  })

  test("★ the --plain status line says the same thing as full screen", () => {
    setInterfaceLanguage("ja")
    // N queued: full screen uses queuedStatus; --plain once glued together its own
    // English version
    expect(t.queuedStatus(3)).toBe(ja.queuedStatus(3))
    expect(t.plainExitHint).toBe(ja.plainExitHint)
    expect(t.plainExitHint).not.toBe(en.plainExitHint)
  })

  test("the file tree's empty-directory text and /reset's three explanations follow the language", () => {
    setInterfaceLanguage("zh")
    for (const key of ["treeEmpty", "resetConfigWhat", "resetDataWhat", "resetProjectWhat"] as const) {
      expect(t[key]).toBe(zh[key])
      expect(t[key]).not.toBe(en[key])
    }
  })
})
