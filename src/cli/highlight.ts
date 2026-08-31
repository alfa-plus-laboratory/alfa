/**
 * 语法高亮。
 *
 * ── 为什么是自己写的、而不是找个库 ──
 * 这个项目不引运行时依赖。而且真正需要的东西很窄:**逐行**上色、只吐 SGR、
 * 不改变显示宽度。现成的高亮库基本都要先把整份源码解析成树,拿不到"给我这
 * 一行,状态从上一行接着来"这种接口 —— 而流式代码块和右栏滚动都要这个。
 *
 * ── 一条硬约束:不许改变显示宽度 ──
 * 输出只能多出 SGR 序列。多一个可见字符,右栏的截断、对话区的折行就全错位。
 * 所以这里永远是「把原文切成片段,每片包一层颜色」,不做任何替换或补空格。
 *
 * ── 状态在行之间传递 ──
 * 块注释和多行字符串跨行。所以 Highlighter 是有状态的:一行一行喂,顺序不能乱。
 * 预览未定稿的半行要用 peek() —— 它会把状态原样还回去。
 *
 * ── 不认识的语言就不上色 ──
 * 猜错语言比不上色难受得多:关键字标在不是关键字的地方,人会开始怀疑自己看错了。
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
 * 配色。
 *
 * 只用 8 色里的前景色,不用背景色 —— 用户的终端主题是深是浅我们不知道,
 * 背景色在其中一半上会糊成一块。注释用 dim 而不是某个颜色,是因为它要
 * 「退到后面去」,而不是变成又一种需要分辨的颜色。
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
  /** 省略表示和 open 相同 */
  close?: string
  /** 反斜杠转义 */
  escape?: boolean
  /** 能跨行(python 的三引号、js 的模板串、go 的反引号) */
  multiline?: boolean
}

interface Spec {
  line?: string[]
  block?: readonly [string, string]
  strings?: StringRule[]
  keywords?: string
  types?: string
  literals?: string
  /** 关键字不分大小写(SQL) */
  ignoreCase?: boolean
  /** 标识符后面紧跟 `(` 就当函数名 */
  calls?: boolean
  /** `$VAR` / `${VAR}`(shell) */
  dollarVars?: boolean
  /** `<tag` `</tag` `>`(HTML/XML) */
  tags?: boolean
  /** 冒号前面的字符串或标识符当键名(JSON / YAML) */
  keys?: boolean
  /** 行首指令:装饰器、预处理、属性 */
  meta?: RegExp
}

export interface Language extends Spec {
  id: string
  keywordSet: Set<string>
  typeSet: Set<string>
  literalSet: Set<string>
}

// ───────────────────────────────────────────── 语言表

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

/** 扩展名 / 围栏标签 → 语言 id。认不出来的一律不上色。 */
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
 * 从文件路径或围栏标签认语言。
 *
 * 认不出来返回 undefined,调用方原样显示 —— 猜错语言的高亮比没有高亮更糟:
 * 关键字被标在不是关键字的地方,人会开始怀疑是自己看错了。
 */
export function languageFor(hint: string): Language | undefined {
  const cleaned = hint.trim().toLowerCase()
  if (cleaned.length === 0) return undefined
  // 围栏标签可能带参数:```python title=x
  const tag = cleaned.split(/[\s,{(]/)[0] ?? ""
  const direct = ALIASES[tag]
  if (direct) return build(direct)
  // 文件名:先试扩展名,再试整个文件名(Makefile、Dockerfile 这类没有扩展名的)
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

// ───────────────────────────────────────────── 扫描

const IDENT_START = /[A-Za-z_$À-￿]/
const IDENT = /[A-Za-z0-9_$À-￿]/
const DIGIT = /[0-9]/

interface State {
  block: boolean
  /** 正在一个跨行字符串里 */
  string: StringRule | undefined
}

/**
 * 有状态的逐行高亮器。**行必须按顺序喂** —— 块注释和多行字符串靠状态接续。
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

  /** 高亮一行,并把状态推进到下一行。 */
  line(text: string): string {
    if (!this.language) return text
    return scan(text, this.language, this.state)
  }

  /** 高亮一行但**不动状态**。未定稿的半行每帧都要重画,不能让它推进状态。 */
  peek(text: string): string {
    if (!this.language) return text
    const snapshot: State = { block: this.state.block, string: this.state.string }
    return scan(text, this.language, snapshot)
  }
}

/** 整段代码一次高亮。返回逐行结果,行数和输入一致。 */
export function highlightLines(code: string, hint: string | undefined): string[] {
  const rows = code.split("\n")
  const language = hint === undefined ? undefined : languageFor(hint)
  if (!language) return rows
  const highlighter = new Highlighter(language)
  return rows.map((row) => highlighter.line(row))
}

/**
 * 扫一行。
 *
 * 输出只由「原文片段 + SGR」组成,拼起来剥掉颜色必须逐字等于输入 ——
 * 少一个字符右栏就开始错位,而那种错位看起来像是文件本身有问题。
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

  // 上一行没收口的块注释 / 多行字符串,先把这一行属于它的部分吃掉
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

  // 行首指令:装饰器、#include、#[derive]、[section]
  if (i === 0 && lang.meta) {
    const meta = lang.meta.exec(text)
    if (meta && meta.index === 0) {
      emit(meta[0], "meta")
      i = meta[0].length
    }
  }

  while (i < text.length) {
    const rest = text.slice(i)

    // 行注释:吃到行尾
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

    // 字符串。长的定界符要先试(python 的 """ 必须排在 " 前面)
    const rule = lang.strings?.find((candidate) => rest.startsWith(candidate.open))
    if (rule) {
      const from = i + rule.open.length
      const end = findClose(text, from, rule)
      if (end === -1) {
        if (rule.multiline) state.string = rule
        emit(rest, "string")
        return out + plain
      }
      // JSON 的键本身就是字符串,和值一个颜色的话整份配置就是一片绿,
      // 层级结构全靠缩进认 —— 键名单独一个颜色,扫起来快得多
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

    // 数字。前一个字符是标识符的一部分时不算 —— `utf8` 里的 8 不是数字字面量
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

/** 冒号前面的东西是键名(JSON / YAML / TOML)。 */
function isKey(text: string, from: number): boolean {
  let i = from
  while (text[i] === " " || text[i] === "\t") i++
  return text[i] === ":" || text[i] === "="
}

/**
 * 找字符串的收尾位置(返回**闭合定界符之后**的下标),没找到返回 -1。
 *
 * 反斜杠转义要成对数:`"a\\"` 里那个反斜杠转义的是反斜杠本身,后面的引号
 * 是真正的收尾。只看「前一个字符是不是反斜杠」会在这里判错。
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
