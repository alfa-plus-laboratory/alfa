/**
 * Syntax highlighting.
 *
 * ── Why it's hand-written rather than a library ──
 * This project takes no runtime dependencies. And what's actually needed is very narrow:
 * color **line by line**, emit only SGR, never change display width. Off-the-shelf
 * highlighters basically all parse the whole source into a tree first, and don't offer an
 * interface like "here's one line, carry the state over from the previous one" — which
 * streaming code blocks need (markdown.ts colors each line as it's finalized).
 *
 * ── One hard constraint: display width must not change ──
 * The output may only gain SGR sequences. The colored line has to be the source line,
 * character for character: it's what the user selects and copies out of the scrollback,
 * and one substituted or padded character turns the copy into different code. So this
 * is always "cut the original text into pieces and wrap each piece in a color" — never
 * any substitution or space padding.
 *
 * ── State carries across lines ──
 * Block comments and multi-line strings span lines. So Highlighter is stateful: feed it
 * line by line, and the order must not be shuffled. Previewing a not-yet-final half line
 * uses peek() — it hands the state back untouched.
 *
 * ── Unknown languages aren't colored ──
 * Guessing the wrong language is far worse than no color: keywords get marked where there
 * are no keywords, and people start doubting their own eyes.
 */
import { theme } from "./theme.ts"

export type Token =
  | "text"
  | "keyword"
  | "type"
  | "literal"
  | "string"
  | "number"
  | "comment"
  | "function"
  | "meta"

/**
 * The palette.
 *
 * Only foreground colors from the 8-color set, no background colors — we don't know
 * whether the user's terminal theme is dark or light, and background colors turn into a
 * smear on half of them. Comments use dim rather than a color because they should "recede
 * into the background", not become yet another color to tell apart.
 */
const PAINT: Record<Token, (text: string) => string> = {
  text: (text) => text,
  keyword: theme.magenta,
  type: theme.blue,
  literal: theme.yellow,
  string: theme.green,
  number: theme.yellow,
  comment: theme.dim,
  function: theme.cyan,
  meta: theme.dim,
}

interface StringRule {
  open: string
  /** Omitted means the same as open */
  close?: string
  /** Backslash escapes */
  escape?: boolean
  /** Can span lines (python's triple quotes, js template strings, go backticks) */
  multiline?: boolean
}

interface Spec {
  line?: string[]
  block?: readonly [string, string]
  strings?: StringRule[]
  keywords?: string
  types?: string
  literals?: string
  /** Keywords are case-insensitive (SQL) */
  ignoreCase?: boolean
  /** An identifier immediately followed by `(` is treated as a function name */
  calls?: boolean
  /** `$VAR` / `${VAR}`(shell) */
  dollarVars?: boolean
  /** `<tag` `</tag` `>`(HTML/XML) */
  tags?: boolean
  /** A string or identifier before a colon is treated as a key name (JSON / YAML) */
  keys?: boolean
  /** Line-start directives: decorators, preprocessor, attributes */
  meta?: RegExp
}

export interface Language extends Spec {
  id: string
  keywordSet: Set<string>
  typeSet: Set<string>
  literalSet: Set<string>
}

// ───────────────────────────────────────────── language table

const C_KEYWORDS =
  "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while"

const SPECS: Record<string, Spec> = {
  ts: {
    line: ["//"],
    block: ["/*", "*/"],
    strings: [
      { open: '"', escape: true },
      { open: "'", escape: true },
      { open: "`", escape: true, multiline: true },
    ],
    keywords:
      "abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let module namespace new of override package private protected public readonly require return satisfies set static super switch this throw try type typeof var void while with yield",
    types:
      "any bigint boolean never number object string symbol unknown Array ArrayBuffer BigInt Boolean Date Error Function JSON Map Math Number Object Promise Proxy Reflect RegExp Set String Symbol WeakMap WeakSet console globalThis process",
    literals: "true false null undefined NaN Infinity",
    calls: true,
    meta: /^\s*@[A-Za-z_$][\w$]*/,
  },
  py: {
    line: ["#"],
    strings: [
      { open: '"""', multiline: true, escape: true },
      { open: "'''", multiline: true, escape: true },
      { open: '"', escape: true },
      { open: "'", escape: true },
    ],
    keywords:
      "and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield",
    types:
      "bool bytes bytearray classmethod cls complex dict enumerate filter float frozenset getattr hasattr int isinstance issubclass len list map max min object open property range repr reversed round self set setattr sorted staticmethod str sum super tuple type zip print Exception ValueError TypeError KeyError IndexError RuntimeError",
    literals: "True False None Ellipsis NotImplemented",
    calls: true,
    meta: /^\s*@[A-Za-z_][\w.]*/,
  },
  go: {
    line: ["//"],
    block: ["/*", "*/"],
    strings: [
      { open: '"', escape: true },
      { open: "`", multiline: true },
      { open: "'", escape: true },
    ],
    keywords:
      "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
    types:
      "any bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr append cap close complex copy delete imag len make new panic print println real recover",
    literals: "true false nil iota",
    calls: true,
  },
  rust: {
    line: ["//"],
    block: ["/*", "*/"],
    strings: [
      { open: '"', escape: true, multiline: true },
      { open: "'", escape: true },
    ],
    keywords:
      "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct super trait type unsafe use where while yield",
    types:
      "bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32 u64 u128 usize usize String Vec VecDeque HashMap HashSet BTreeMap Option Result Box Rc Arc Cell RefCell Self Some None Ok Err",
    literals: "true false",
    calls: true,
    meta: /^\s*#!?\[[^\]]*\]/,
  },
  c: {
    line: ["//"],
    block: ["/*", "*/"],
    strings: [
      { open: '"', escape: true },
      { open: "'", escape: true },
    ],
    keywords: C_KEYWORDS,
    types: "bool int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t size_t ssize_t FILE NULL",
    literals: "true false NULL",
    calls: true,
    meta: /^\s*#\s*(include|define|ifdef|ifndef|endif|if|else|elif|pragma|undef|error)\b.*/,
  },
  cpp: {
    line: ["//"],
    block: ["/*", "*/"],
    strings: [
      { open: '"', escape: true },
      { open: "'", escape: true },
    ],
    keywords: `${C_KEYWORDS} catch class constexpr const_cast decltype delete dynamic_cast explicit final friend mutable namespace new noexcept nullptr operator override private protected public reinterpret_cast static_assert static_cast template this throw try typeid typename using virtual`,
    types: "bool string vector map set pair size_t uint8_t int32_t int64_t shared_ptr unique_ptr std",
    literals: "true false nullptr NULL",
    calls: true,
    meta: /^\s*#\s*(include|define|ifdef|ifndef|endif|if|else|elif|pragma|undef|error)\b.*/,
  },
  java: {
    line: ["//"],
    block: ["/*", "*/"],
    strings: [
      { open: '"', escape: true },
      { open: "'", escape: true },
    ],
    keywords:
      "abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try var volatile while yield record sealed permits",
    types:
      "boolean byte char double float int long short void Boolean Byte Character Double Float Integer Long Object Short String List Map Set ArrayList HashMap Optional Stream",
    literals: "true false null",
    calls: true,
    meta: /^\s*@[A-Za-z_][\w.]*/,
  },
  sh: {
    line: ["#"],
    strings: [
      { open: '"', escape: true },
      { open: "'" },
    ],
    keywords:
      "if then else elif fi for while until do done case esac function in select time coproc return break continue local export readonly declare typeset source alias unalias unset shift trap set eval exec",
    types: "echo printf read cd pwd test cat sed awk grep find xargs sort uniq head tail cut tr wc mkdir rm cp mv ln chmod chown kill ps curl git",
    literals: "true false",
    dollarVars: true,
  },
  json: {
    strings: [{ open: '"', escape: true }],
    literals: "true false null",
    keys: true,
  },
  yaml: {
    line: ["#"],
    strings: [
      { open: '"', escape: true },
      { open: "'" },
    ],
    literals: "true false null yes no on off",
    keys: true,
  },
  toml: {
    line: ["#"],
    strings: [
      { open: '"""', multiline: true, escape: true },
      { open: '"', escape: true },
      { open: "'" },
    ],
    literals: "true false",
    keys: true,
    meta: /^\s*\[\[?[^\]]*\]\]?/,
  },
  sql: {
    line: ["--"],
    block: ["/*", "*/"],
    strings: [{ open: "'" }, { open: '"' }],
    keywords:
      "select from where insert into values update set delete create table alter drop index view join inner left right outer full on group by order having limit offset union all distinct as and or not null is in exists between like case when then else end begin commit rollback transaction primary key foreign references default constraint unique check cascade returning with recursive",
    types: "int integer bigint smallint serial varchar char text boolean date timestamp time numeric decimal real double json jsonb uuid array",
    literals: "true false null",
    ignoreCase: true,
  },
  css: {
    block: ["/*", "*/"],
    strings: [
      { open: '"', escape: true },
      { open: "'", escape: true },
    ],
    keywords: "important inherit initial unset revert auto none",
    calls: true,
    keys: true,
    meta: /^\s*@[A-Za-z-]+/,
  },
  html: {
    block: ["<!--", "-->"],
    strings: [
      { open: '"', escape: true },
      { open: "'", escape: true },
    ],
    tags: true,
  },
}

/** Extension / fence tag → language id. Anything unrecognized isn't colored. */
const ALIASES: Record<string, string> = {
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts", typescript: "ts",
  js: "ts", jsx: "ts", mjs: "ts", cjs: "ts", javascript: "ts", node: "ts",
  py: "py", pyi: "py", python: "py", python3: "py",
  go: "go", golang: "go",
  rs: "rust", rust: "rust",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", "c++": "cpp",
  java: "java", kt: "java", kts: "java", kotlin: "java", scala: "java", groovy: "java",
  cs: "java", csharp: "java", swift: "java", dart: "java", php: "java",
  sh: "sh", bash: "sh", zsh: "sh", ksh: "sh", shell: "sh", console: "sh", fish: "sh",
  json: "json", jsonc: "json", json5: "json",
  yml: "yaml", yaml: "yaml",
  toml: "toml", ini: "toml", cfg: "toml", conf: "toml",
  sql: "sql", psql: "sql", mysql: "sql",
  css: "css", scss: "css", sass: "css", less: "css",
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html", svelte: "html",
}

const CACHE = new Map<string, Language>()

function build(id: string): Language {
  const cached = CACHE.get(id)
  if (cached) return cached
  const spec = SPECS[id]!
  const set = (words: string | undefined) =>
    new Set((words ?? "").split(" ").filter(Boolean).map((word) => (spec.ignoreCase ? word.toLowerCase() : word)))
  const language: Language = {
    ...spec,
    id,
    keywordSet: set(spec.keywords),
    typeSet: set(spec.types),
    literalSet: set(spec.literals),
  }
  CACHE.set(id, language)
  return language
}

/**
 * Identify the language from a file path or a fence tag.
 *
 * Returns undefined when unrecognized, and the caller shows the text as-is — highlighting
 * in the wrong language is worse than no highlighting: keywords get marked where there are
 * no keywords, and people start doubting their own eyes.
 */
export function languageFor(hint: string): Language | undefined {
  const cleaned = hint.trim().toLowerCase()
  if (cleaned.length === 0) return undefined
  // Fence tags may carry arguments: ```python title=x
  const tag = cleaned.split(/[\s,{(]/)[0] ?? ""
  const direct = ALIASES[tag]
  if (direct) return build(direct)
  // File name: try the extension first, then the whole file name (for extensionless
  // ones like Makefile, Dockerfile)
  const base = tag.split("/").pop() ?? tag
  const dot = base.lastIndexOf(".")
  if (dot > 0) {
    const ext = ALIASES[base.slice(dot + 1)]
    if (ext) return build(ext)
  }
  if (base.startsWith(".") && ALIASES[base.slice(1)]) return build(ALIASES[base.slice(1)]!)
  if (base === "dockerfile" || base === "makefile" || base.endsWith("rc")) return build("sh")
  return undefined
}

// ───────────────────────────────────────────── scanning

const IDENT_START = /[A-Za-z_$À-￿]/
const IDENT = /[A-Za-z0-9_$À-￿]/
const DIGIT = /[0-9]/

interface State {
  block: boolean
  /** Inside a string that spans lines */
  string: StringRule | undefined
}

/**
 * A stateful line-by-line highlighter. **Lines must be fed in order** — block comments
 * and multi-line strings rely on state to carry over.
 */
export class Highlighter {
  private readonly language: Language | undefined
  private state: State = { block: false, string: undefined }

  constructor(language: Language | undefined) {
    this.language = language
  }

  get active(): boolean {
    return this.language !== undefined
  }

  /** Highlight one line and advance the state to the next line. */
  line(text: string): string {
    if (!this.language) return text
    return scan(text, this.language, this.state)
  }

  /**
   * Highlight one line **without touching state**. A not-yet-final half line is redrawn
   * every frame and must not advance the state.
   */
  peek(text: string): string {
    if (!this.language) return text
    const snapshot: State = { block: this.state.block, string: this.state.string }
    return scan(text, this.language, snapshot)
  }
}

/**
 * Scan one line.
 *
 * The output consists only of "original text pieces + SGR"; joined and stripped of color
 * it must equal the input character for character — one character short and the code
 * block on screen is no longer what the model wrote, in a way that looks like the code
 * itself is broken.
 */
function scan(text: string, lang: Language, state: State): string {
  let out = ""
  let plain = ""
  let i = 0

  const emit = (chunk: string, token: Token) => {
    if (plain.length > 0) {
      out += plain
      plain = ""
    }
    if (chunk.length > 0) out += PAINT[token](chunk)
  }

  // A block comment / multi-line string left open by the previous line: first consume
  // the part of this line that belongs to it
  if (state.block && lang.block) {
    const end = text.indexOf(lang.block[1])
    if (end === -1) return PAINT.comment(text)
    emit(text.slice(0, end + lang.block[1].length), "comment")
    i = end + lang.block[1].length
    state.block = false
  } else if (state.string) {
    const rule = state.string
    const end = findClose(text, 0, rule)
    if (end === -1) return PAINT.string(text)
    emit(text.slice(0, end), "string")
    i = end
    state.string = undefined
  }

  // Line-start directives: decorators, #include, #[derive], [section]
  if (i === 0 && lang.meta) {
    const meta = lang.meta.exec(text)
    if (meta && meta.index === 0) {
      emit(meta[0], "meta")
      i = meta[0].length
    }
  }

  while (i < text.length) {
    const rest = text.slice(i)

    // Line comment: consume to end of line
    const lineComment = lang.line?.find((marker) => rest.startsWith(marker))
    if (lineComment !== undefined) {
      emit(rest, "comment")
      return out + plain
    }

    if (lang.block && rest.startsWith(lang.block[0])) {
      const end = text.indexOf(lang.block[1], i + lang.block[0].length)
      if (end === -1) {
        state.block = true
        emit(rest, "comment")
        return out + plain
      }
      emit(text.slice(i, end + lang.block[1].length), "comment")
      i = end + lang.block[1].length
      continue
    }

    // Strings. Longer delimiters are tried first (python's """ must come before ")
    const rule = lang.strings?.find((candidate) => rest.startsWith(candidate.open))
    if (rule) {
      const from = i + rule.open.length
      const end = findClose(text, from, rule)
      if (end === -1) {
        if (rule.multiline) state.string = rule
        emit(rest, "string")
        return out + plain
      }
      // JSON keys are strings themselves; in the same color as values, the whole config is
      // a sheet of green and the hierarchy can only be read from indentation — a separate
      // color for key names makes it much faster to scan
      emit(text.slice(i, end), lang.keys && isKey(text, end) ? "type" : "string")
      i = end
      continue
    }

    const ch = rest[0]!

    if (lang.tags && ch === "<") {
      const tag = /^<\/?[A-Za-z][\w:.-]*|^<\/|^\/?>/.exec(rest)
      if (tag) {
        emit(tag[0], "keyword")
        i += tag[0].length
        continue
      }
    }

    if (lang.dollarVars && ch === "$") {
      const variable = /^\$\{[^}]*\}|^\$[A-Za-z_]\w*|^\$[0-9@*#?$!-]/.exec(rest)
      if (variable) {
        emit(variable[0], "type")
        i += variable[0].length
        continue
      }
    }

    // Numbers. Not when the previous character is part of an identifier — the 8 in `utf8`
    // isn't a numeric literal
    if (DIGIT.test(ch) && !(i > 0 && IDENT.test(text[i - 1]!))) {
      const number = /^0[xXbBoO][0-9a-fA-F_]+n?|^[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?[a-zA-Z_]*/.exec(rest)
      if (number) {
        emit(number[0], "number")
        i += number[0].length
        continue
      }
    }

    if (IDENT_START.test(ch)) {
      let end = i + 1
      while (end < text.length && IDENT.test(text[end]!)) end++
      const word = text.slice(i, end)
      const key = lang.ignoreCase ? word.toLowerCase() : word
      let token: Token = "text"
      if (lang.keywordSet.has(key)) token = "keyword"
      else if (lang.literalSet.has(key)) token = "literal"
      else if (lang.typeSet.has(key)) token = "type"
      else if (lang.keys && isKey(text, end)) token = "type"
      else if (lang.calls && text[end] === "(") token = "function"
      if (token === "text") plain += word
      else emit(word, token)
      i = end
      continue
    }

    plain += ch
    i++
  }

  return out + plain
}

/** What comes before a colon is a key name (JSON / YAML / TOML). */
function isKey(text: string, from: number): boolean {
  let i = from
  while (text[i] === " " || text[i] === "\t") i++
  return text[i] === ":" || text[i] === "="
}

/**
 * Find where a string ends (returns the index **after the closing delimiter**), or -1 if
 * not found.
 *
 * Backslash escapes must be counted in pairs: in `"a\\"` the backslash escapes the
 * backslash itself, and the quote after it is the real end. Only checking "is the previous
 * character a backslash" gets this wrong.
 */
function findClose(text: string, from: number, rule: StringRule): number {
  const close = rule.close ?? rule.open
  let i = from
  while (i < text.length) {
    if (rule.escape && text[i] === "\\") {
      i += 2
      continue
    }
    if (text.startsWith(close, i)) return i + close.length
    i++
  }
  return -1
}
