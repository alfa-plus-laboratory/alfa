/**
 * Multiple languages. Two **unrelated** settings:
 *
 *   interface — this program's own text (panel titles, status line, help)
 *   reply     — which language the model answers you in
 *
 * Keeping them apart is deliberate. A native Chinese speaker working in Japan wants an
 * English UI with answers in Chinese; that's not an edge case, it's the norm. Tie the
 * two to one switch and half the people always have to make do.
 *
 * ── How the UI text is looked up ──
 * `t` is an **ESM live binding**: `setInterfaceLanguage()` changes the variable in this
 * module, and every place that does `import { t }` reads the new language on its next
 * access.
 *
 * ⚠ So **no destructuring**: `const { paneFiles } = t` pulls out the value at that moment
 *   and keeps it, and it won't follow later language switches. Write `t.paneFiles` and
 *   read it fresh every time.
 *
 * ── reply affects only the model, not the UI ──
 * It is turned into an **English instruction** and put into the system prompt and the
 * compaction agent. The instruction is written in English rather than the target
 * language because the instruction itself has to be read by the model as an instruction
 * — a Japanese "please answer in Japanese" mixed in with Japanese user input is actually
 * more likely to be taken as part of the conversation.
 */
import { en, type Catalog } from "./en.ts"
import { ja } from "./ja.ts"
import { zh } from "./zh.ts"

/**
 * Languages that actually have a catalog. auto isn't here — it's "how to choose", not a
 * language.
 */
export const LANGUAGES = ["en", "zh", "ja"] as const
export type Language = (typeof LANGUAGES)[number]

/**
 * The values for each of the interface/reply settings. auto means something different on
 * each side; see the two resolvers below.
 */
export const LANGUAGE_CHOICES = ["auto", ...LANGUAGES] as const
export type LanguageChoice = (typeof LANGUAGE_CHOICES)[number]

const CATALOGS: Record<Language, Catalog> = { en, zh, ja }

/**
 * The current UI text. **Don't destructure**; see the file header.
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

/**
 * Language names shown to the user are themselves translated — a Japanese UI should say
 * "中国語" (ja.ts), not "中文" (zh.ts), for Chinese.
 */
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
 * Guess the interface language from the terminal locale.
 *
 * Only the prefix counts, not the region: `zh_TW` also gets the Simplified catalog —
 * one you can read beats falling back to English; if someone really wants Traditional,
 * add a catalog for it rather than doing a half-baked conversion here.
 *
 * Anything unrecognized gets English. Guessing the wrong language is worse than not
 * guessing: a Japanese user seeing a half-comprehensible Chinese UI will first think the
 * program is broken.
 */
export function detectLanguage(env: NodeJS.ProcessEnv = process.env): Language {
  const raw = env["LC_ALL"] || env["LC_MESSAGES"] || env["LANG"] || ""
  const tag = raw.toLowerCase().replace("_", "-")
  if (tag.startsWith("zh")) return "zh"
  if (tag.startsWith("ja")) return "ja"
  return "en"
}

/**
 * Identify the language from what the user wrote themselves. Returns undefined if it
 * can't tell.
 *
 * ── Why we identify it ourselves ──
 * The summary and verdict prompts are entirely in English, and the "follow the user's
 * language" line in them has no anchor in a sea of English — nine times out of ten the
 * model answers in English. What the user sees: "I spoke Chinese the whole time, and the
 * summary up there is in English." Rather than tweak wording to make it guess, we decide
 * and name the language outright.
 *
 * Kana means Japanese; kanji with no kana is taken as Chinese. This order must not be
 * reversed — Japanese contains plenty of kanji, so checking kanji first would take
 * Japanese for Chinese.
 *
 * Latin script always returns undefined: English, French and German can't be told apart
 * here, and **if you can't tell, don't pretend you can** — in that case handing "follow
 * the user" to the model as is is the right thing.
 */
export function detectTextLanguage(text: string): Language | undefined {
  if (/[぀-ヿ]/.test(text)) return "ja"
  if (/[㐀-䶿一-鿿]/.test(text)) return "zh"
  return undefined
}

/**
 * In auto mode, pick an instruction based on what the user actually said.
 *
 * An explicitly chosen language has the final say — if the user set replies to English,
 * they get English even if they ask in Chinese.
 */
export function replyInstructionFor(choice: LanguageChoice, sample: string): string {
  if (choice !== "auto") return replyInstruction(choice)
  return replyInstruction(detectTextLanguage(sample) ?? "auto")
}

/**
 * The reply-language instruction given to the model. auto gets one too — the prompt
 * itself is in English, and without saying so there's a real chance the model answers
 * someone who asked in Chinese in English.
 *
 * "Code, identifiers, paths and command output stay as they are" must be hard-coded:
 * without it the model starts translating variable names and error messages, which is
 * harder to clean up than the wrong language.
 */
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

/**
 * New timeline forms reuse the current interface language rather than guessing again
 * from the process environment.
 */
export function uiText(en: string, zh: string, ja: string): string {
  return interfaceLanguage === "zh" ? zh : interfaceLanguage === "ja" ? ja : en
}
