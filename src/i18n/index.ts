/**
 * 多语言。两个**互不相干**的设置:
 *
 *   interface —— 这个程序自己的文案(面板标题、状态行、帮助)
 *   reply     —— 模型用什么语言回答你
 *
 * 分开是刻意的。在日本上班的中文母语者要英文界面配中文回答,这不是边角情况,
 * 是常态。把两者绑在一个开关上,总有一半人要将就。
 *
 * ── 界面文案怎么取 ──
 * `t` 是 **ESM 活绑定**:`setInterfaceLanguage()` 改的是这个模块里的变量,
 * 所有 `import { t }` 的地方下一次读取就是新语言。
 *
 * ⚠ 所以**不许解构**:`const { paneFiles } = t` 会把当时那个值抠出来存住,
 *   之后切语言它不跟着变。要用就写 `t.paneFiles`,每次现取。
 *
 * ── reply 只影响模型,不影响界面 ──
 * 它被翻译成一句**英文指令**塞进 system prompt、判官和摘要 agent。用英文写
 * 指令而不是用目标语言写,是因为指令本身要被模型当指令读 —— 一段日文的
 * 「请用日文回答」和一段日文的用户输入混在一起,反而更容易被当成对话内容。
 */
import { en, type Catalog } from "./en.ts"
import { ja } from "./ja.ts"
import { zh } from "./zh.ts"

/** 真正有目录的语言。auto 不在这里 —— 它是「怎么选」,不是一种语言。 */
export const LANGUAGES = ["en", "zh", "ja"] as const
export type Language = (typeof LANGUAGES)[number]

/** 界面/回答两个设置各自的取值。auto 的含义两边不一样,见下面两个 resolve。 */
export const LANGUAGE_CHOICES = ["auto", ...LANGUAGES] as const
export type LanguageChoice = (typeof LANGUAGE_CHOICES)[number]

const CATALOGS: Record<Language, Catalog> = { en, zh, ja }

/**
 * 当前界面文案。**别解构**,见文件头。
 */
export let t: Catalog = en

let interfaceLanguage: Language = "en"

export function setInterfaceLanguage(choice: LanguageChoice): Language {
  const resolved = choice === "auto" ? detectLanguage() : choice
  interfaceLanguage = resolved
  t = CATALOGS[resolved]
  return resolved
}

export function currentInterfaceLanguage(): Language {
  return interfaceLanguage
}

export function isLanguageChoice(value: string): value is LanguageChoice {
  return (LANGUAGE_CHOICES as readonly string[]).includes(value)
}

/** 给用户看的语言名,本身也是要翻译的 —— 日文界面里该写「中国語」而不是「中文」。 */
export function languageLabel(choice: LanguageChoice): string {
  switch (choice) {
    case "auto":
      return t.languageAuto
    case "en":
      return t.languageEnglish
    case "zh":
      return t.languageChinese
    case "ja":
      return t.languageJapanese
  }
}

/**
 * 从终端 locale 猜界面语言。
 *
 * 只认前缀,不认地区:`zh_TW` 也给简体目录 —— 有一份能读的总比掉回英文好,
 * 真有人要繁体再加一份目录,而不是在这里做半吊子的转换。
 *
 * 认不出来一律英文。猜错语言比不猜更糟:一个日本用户看到半懂不懂的中文界面,
 * 第一反应是程序坏了。
 */
export function detectLanguage(env: NodeJS.ProcessEnv = process.env): Language {
  const raw = env["LC_ALL"] || env["LC_MESSAGES"] || env["LANG"] || ""
  const tag = raw.toLowerCase().replace("_", "-")
  if (tag.startsWith("zh")) return "zh"
  if (tag.startsWith("ja")) return "ja"
  return "en"
}

/**
 * 塞给模型的回答语言指令。auto 也给一句 —— 提示词本身是英文的,不说的话
 * 模型有真实概率用英文回一个用中文提问的人。
 *
 * 「代码、标识符、路径、命令输出保持原样」这条必须写死:少了它,模型会开始
 * 翻译变量名和报错信息,那比语言不对更难收拾。
 */
/**
 * 从用户自己写的字里认语言。认不出来返回 undefined。
 *
 * ── 为什么要自己认 ──
 * 摘要和判词的提示词整个是英文的,里面那句「跟用户的语言走」在一片英文里
 * 没有锚点 —— 模型十有八九就用英文回了。用户看到的现象是「我全程说中文,
 * 上面那段总结是英文的」。与其调措辞让它猜,不如我们判完直接点名。
 *
 * 有假名就是日文;只有汉字没假名当中文。这条顺序不能反 —— 日文里本来就有
 * 大量汉字,先判汉字的话日文会被当成中文。
 *
 * 拉丁字母一律返回 undefined:英语、法语、德语在这里分不出来,而**分不出来
 * 就别装作分得出来** —— 那种情况把「跟随用户」原样交给模型才是对的。
 */
export function detectTextLanguage(text: string): Language | undefined {
  if (/[぀-ヿ]/.test(text)) return "ja"
  if (/[㐀-䶿一-鿿]/.test(text)) return "zh"
  return undefined
}

/**
 * auto 档下,拿用户自己说的话当依据挑一条指令。
 *
 * 显式指定过语言的话它说了算 —— 用户设成英文回答,就算他用中文提问也该给英文。
 */
export function replyInstructionFor(choice: LanguageChoice, sample: string): string {
  if (choice !== "auto") return replyInstruction(choice)
  return replyInstruction(detectTextLanguage(sample) ?? "auto")
}

export function replyInstruction(choice: LanguageChoice): string {
  const keep =
    "Code, identifiers, file paths, command output, and quoted text stay exactly as they are — never translate them."
  switch (choice) {
    case "auto":
      return `Reply in the same language the user writes in. ${keep}`
    case "en":
      return `Always reply in English, whatever language the user writes in. ${keep}`
    case "zh":
      return `Always reply in Simplified Chinese (简体中文), whatever language the user writes in. ${keep}`
    case "ja":
      return `Always reply in Japanese (日本語), whatever language the user writes in. ${keep}`
  }
}
