/**
 * HTML → 给模型读的正文。
 *
 * ── 为什么不直接把 HTML 丢给模型 ──
 * 一个现代页面里九成以上的字节是给浏览器看的:内联脚本、样式、data URI、
 * 埋点、SVG 路径。整份丢过去,一个 300KB 的页面能吃掉大半个上下文窗口,
 * 而里面真正的正文可能只有两千字。
 *
 * ── 摘掉的东西要**数出来**,不能静默消失 ──
 * 这一条是安全需求不是洁癖。`<script>` 里、HTML 注释里、`display:none` 的
 * 元素里,正是藏指令最舒服的三个地方 —— 因为人打开页面根本看不到它们,
 * 而一个把整份 HTML 喂给模型的实现会一字不落地读进去。所以这里:
 *   - 脚本 / 样式:整块扔掉,只报个数(内容太吵,扫了全是误报)
 *   - 注释 / 藏起来的元素 / noscript:**内容单独收起来**交给注入扫描,
 *     但**不进**给模型的正文 —— 认出来要,照着念不要
 *
 * ── 边界 ──
 * 这不是一个 HTML 解析器,是一个够用的扫描器。畸形嵌套、`<table>` 的复杂
 * 布局、JS 渲染出来的页面,它都处理不好 —— 处理不好的表现是正文难看,
 * 不是漏掉隐藏内容,后者才是这个文件真正的职责。
 */

/** 内容整块丢弃、只报数的标签。 */
const DISCARD = new Set(["script", "style", "svg", "canvas", "template", "iframe", "object", "embed", "math"])
/** 内容不给模型看,但要留给注入扫描的标签。 */
const CONCEAL = new Set(["noscript"])
/** 没有闭合标签的那些。 */
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
])
/** 前后各断一行的块级元素。 */
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "dd", "dt", "fieldset", "figcaption",
  "figure", "footer", "form", "header", "hgroup", "main", "nav", "ol", "p", "section", "summary", "table",
  "tbody", "thead", "tfoot", "ul",
])

/**
 * 页面自己声明的那几件事。
 *
 * ★ 这些全是**页面作者写的字**,和正文一样不可信 —— 所以它们必须和正文一起
 *   进信封,不能当成抓取过程的说明写在信封外面(见 webfetch.ts)。一个
 *   `<title>` 里塞指令的页面是完全做得出来的。
 */
export interface PageMeta {
  description?: string
  /** 站点名(og:site_name) */
  site?: string
  /** 发布 / 更新时间。时效性问题里这条比正文还关键 */
  published?: string
}

export interface Extracted {
  title?: string
  meta: PageMeta
  /** 正文,markdown 味的纯文本 */
  text: string
  /** 藏起来的那些字。**不给模型看**,只用来扫注入 */
  concealed: string
  removed: {
    scripts: number
    styles: number
    comments: number
    /** 被 display:none 之类藏起来的元素 */
    hidden: number
  }
  links: number
}

/** 正文短于这个数就认为 `<main>` 选错了,退回整页。 */
const MAIN_TOO_THIN = 200

export function extractHtml(html: string, baseUrl?: URL): Extracted {
  const tokens = tokenize(html)
  const main = mainRange(tokens)

  // 先按 <main> / <article> 摘一遍。摘出来太少说明这个页面的正文不在那儿
  // (侧栏挂着一个空的 <main>、整站由 JS 渲染),那就退回整页 —— 宁可带一堆
  // 导航,也不要报一句"这页没内容"把模型骗了
  const focused = walk(tokens, main, baseUrl)
  if (main.start === 0 && main.end === tokens.length) return focused
  return focused.text.length >= MAIN_TOO_THIN ? focused : walk(tokens, { start: 0, end: tokens.length }, baseUrl)
}

/**
 * 正文在哪一段。
 *
 * 一个文档站的页面里,导航、侧栏、页脚、Cookie 横幅加起来常常比正文还长 ——
 * 而它们对"这个 API 怎么用"这个问题一点价值都没有,却要按 token 付钱。
 * `<main>` / `<article>` 是这件事唯一靠谱的信号,认它就够了,不去做正文抽取
 * 那种猜密度的启发式:猜错的时候它会**悄悄**丢掉半篇文章。
 */
function mainRange(tokens: Token[]): { start: number; end: number } {
  for (const name of ["main", "article"]) {
    for (let i = 0; i < tokens.length; i++) {
      const one = tokens[i]!
      if (one.kind !== "tag" || one.closing || one.name !== name) continue
      const end = skip(tokens, i, name)
      if (end - i > 20) return { start: i + 1, end }
    }
  }
  return { start: 0, end: tokens.length }
}

function walk(tokens: Token[], range: { start: number; end: number }, baseUrl?: URL): Extracted {
  const removed = { scripts: 0, styles: 0, comments: 0, hidden: 0 }
  const concealed: string[] = []
  const out: string[] = []
  const meta: PageMeta = {}
  let title: string | undefined
  let links = 0

  /** 有序列表的计数器栈 */
  const ordered: number[] = []
  /** 还没闭合的 `<a>` 的 href。`](url)` 要等到 `</a>` 才写得出来 */
  const hrefs: string[] = []
  let preDepth = 0

  // 正文只从 range 里出,但**统计和藏起来的字要扫全页** —— 注入最爱待的地方
  // 恰恰是页脚和导航,而那些在 <main> 外面
  let at = 0
  const emit = (value: string) => {
    if (at >= range.start && at < range.end) out.push(value)
  }

  for (let i = 0; i < tokens.length; i++) {
    at = i
    const token = tokens[i]!

    if (token.kind === "comment") {
      removed.comments++
      // 注释里的字进"藏起来的"那一桶。真正的注入十有八九就在这里
      if (token.value.trim().length > 0) concealed.push(token.value)
      continue
    }

    if (token.kind === "text") {
      if (preDepth > 0) emit(decodeEntities(token.value))
      else {
        const flat = decodeEntities(token.value).replaceAll(/\s+/g, " ")
        if (flat.length > 0) emit(flat)
      }
      continue
    }

    const name = token.name
    if (token.closing) {
      if (name === "pre") {
        preDepth = Math.max(0, preDepth - 1)
        emit("\n```\n\n")
      } else if (name === "code" && preDepth === 0) emit("`")
      else if (name === "a") emit(closeLink())
      else if (name === "ol" || name === "ul") {
        ordered.pop()
        emit("\n\n")
      } else if (name === "td" || name === "th") emit(" | ")
      else if (name === "tr") emit("\n")
      else if (/^h[1-6]$/.test(name)) emit("\n\n")
      else if (BLOCK.has(name) || name === "li") emit("\n")
      continue
    }

    // ── 开标签 ──
    if (name === "title") {
      const text = collectText(tokens, i, name)
      title = decodeEntities(text.body).replaceAll(/\s+/g, " ").trim() || undefined
      i = text.end
      continue
    }

    if (DISCARD.has(name)) {
      if (name === "script") {
        removed.scripts++
        // ld+json 是**结构化数据**不是代码,而发布时间常常只在这里面。
        // 只从里面捞一个日期,内容一个字都不进正文
        if (/ld\+json/i.test(attribute(token.raw, "type") ?? "")) {
          const body = collectText(tokens, i, name).body
          if (!meta.published) {
            const hit = /"date(?:Published|Modified)"\s*:\s*"([^"]{4,40})"/.exec(body)
            if (hit?.[1]) meta.published = hit[1]
          }
        }
      } else if (name === "style") removed.styles++
      i = skip(tokens, i, name)
      continue
    }

    if (CONCEAL.has(name) || isHidden(token.raw)) {
      if (!CONCEAL.has(name)) removed.hidden++
      const text = collectText(tokens, i, name)
      const flat = decodeEntities(text.body).replaceAll(/\s+/g, " ").trim()
      if (flat.length > 0) concealed.push(flat)
      i = text.end
      continue
    }

    if (name === "meta") {
      readMeta(token.raw, meta)
      continue
    }
    if (name === "time" && !meta.published) {
      const stamp = attribute(token.raw, "datetime")
      if (stamp) meta.published = stamp
    }

    switch (name) {
      case "br":
        emit("\n")
        break
      case "hr":
        emit("\n\n---\n\n")
        break
      case "pre":
        preDepth++
        emit("\n\n```\n")
        break
      case "code":
        if (preDepth === 0) emit("`")
        break
      case "ol":
        ordered.push(1)
        emit("\n\n")
        break
      case "ul":
        ordered.push(0)
        emit("\n\n")
        break
      case "li": {
        const counter = ordered[ordered.length - 1]
        if (counter && counter > 0) {
          emit(`\n${counter}. `)
          ordered[ordered.length - 1] = counter + 1
        } else emit("\n- ")
        break
      }
      case "a": {
        const href = attribute(token.raw, "href")
        const resolved = href ? absolute(href, baseUrl) : undefined
        if (resolved) {
          links++
          openLink(resolved)
          emit("[")
        }
        break
      }
      case "img": {
        const alt = attribute(token.raw, "alt")?.trim()
        const src = absolute(attribute(token.raw, "src") ?? "", baseUrl)
        if (alt || src) emit(`![${alt ?? ""}](${src ?? ""})`)
        break
      }
      default:
        if (/^h[1-6]$/.test(name)) emit(`\n\n${"#".repeat(Number(name[1]))} `)
        else if (BLOCK.has(name)) emit("\n\n")
    }
  }

  return {
    ...(title ? { title } : {}),
    meta,
    text: tidy(out.join("")),
    concealed: concealed.join("\n"),
    removed,
    links,
  }

  function openLink(href: string) {
    hrefs.push(href)
  }
  function closeLink(): string {
    const href = hrefs.pop()
    return href ? `](${href})` : ""
  }
}

// ─────────────────────────────────────────────── 扫描器

type Token =
  | { kind: "text"; value: string }
  | { kind: "comment"; value: string }
  | { kind: "tag"; name: string; raw: string; closing: boolean; selfClosing: boolean }

/**
 * 切成记号。
 *
 * 属性值里的 `>` 必须认(`<a title="a > b">`),不认的话标签会在半路被切断,
 * 后半截当成正文吐出来 —— 那正是攻击者会用来夹带内容的缝。
 */
export function tokenize(html: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  let text = ""

  const flush = () => {
    if (text.length > 0) {
      tokens.push({ kind: "text", value: text })
      text = ""
    }
  }

  while (index < html.length) {
    const lt = html.indexOf("<", index)
    if (lt === -1) {
      text += html.slice(index)
      break
    }
    text += html.slice(index, lt)

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4)
      flush()
      tokens.push({ kind: "comment", value: end === -1 ? html.slice(lt + 4) : html.slice(lt + 4, end) })
      index = end === -1 ? html.length : end + 3
      continue
    }

    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt)
      index = end === -1 ? html.length : end + 1
      continue
    }

    const match = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, lt + 64))
    if (!match) {
      // 不是标签的 `<` 就是正文里的小于号
      text += "<"
      index = lt + 1
      continue
    }

    const end = findTagEnd(html, lt)
    const raw = html.slice(lt, end)
    flush()
    tokens.push({
      kind: "tag",
      name: match[2]!.toLowerCase(),
      raw,
      closing: match[1] === "/",
      selfClosing: raw.endsWith("/>"),
    })
    index = end
  }

  flush()
  return tokens
}

/** 找标签的 `>`,跳过引号里的。 */
function findTagEnd(html: string, start: number): number {
  let quote: string | undefined
  for (let i = start + 1; i < html.length; i++) {
    const char = html[i]!
    if (quote) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === ">") return i + 1
  }
  return html.length
}

/** 从 open 标签跳到它的闭合标签之后。同名嵌套要数深度。 */
function skip(tokens: Token[], open: number, name: string): number {
  const token = tokens[open]
  if (token?.kind === "tag" && (token.selfClosing || VOID.has(name))) return open
  let depth = 1
  for (let i = open + 1; i < tokens.length; i++) {
    const one = tokens[i]!
    if (one.kind !== "tag" || one.name !== name) continue
    if (one.closing) {
      depth--
      if (depth === 0) return i
    } else if (!one.selfClosing) depth++
  }
  return tokens.length - 1
}

/** 同上,但把中间的文字收集起来。 */
function collectText(tokens: Token[], open: number, name: string): { body: string; end: number } {
  const end = skip(tokens, open, name)
  const parts: string[] = []
  for (let i = open + 1; i < end; i++) {
    const one = tokens[i]!
    if (one.kind === "text") parts.push(one.value)
    else if (one.kind === "comment") parts.push(one.value)
  }
  return { body: parts.join(" "), end }
}

// ─────────────────────────────────────────────── 属性

export function attribute(raw: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i")
  const hit = pattern.exec(raw)
  if (!hit) return undefined
  return decodeEntities(hit[2] ?? hit[3] ?? hit[4] ?? "")
}

/**
 * 这个元素是不是给人看不见的。
 *
 * 认的是**行内样式**和 hidden 属性。类名(`.sr-only`、`.visually-hidden`)
 * 刻意不认:那些是无障碍文本,屏幕阅读器要念出来的,把它们当攻击是误报;
 * 而外链 CSS 里定义的隐藏,这里根本看不到 —— 这是这一层的已知窟窿。
 */
export function isHidden(raw: string): boolean {
  if (/\shidden(\s|=|>|\/)/i.test(raw)) return true
  if (/aria-hidden\s*=\s*["']?true/i.test(raw)) return true
  const style = attribute(raw, "style")
  if (!style) return false
  return /(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?!\.)|font-size\s*:\s*0|text-indent\s*:\s*-\d{3,}|left\s*:\s*-\d{3,})/i.test(
    style,
  )
}

function absolute(href: string, base?: URL): string | undefined {
  const raw = href.trim()
  if (raw.length === 0) return undefined
  // data: / javascript: 链接对模型没有价值,而 data URI 能有几百 KB
  if (/^(javascript|data|vbscript):/i.test(raw)) return undefined
  let resolved = raw
  if (base) {
    try {
      resolved = new URL(raw, base).href
    } catch {
      return undefined
    }
  }
  return resolved.length > 300 ? resolved.slice(0, 299) + "…" : resolved
}

// ─────────────────────────────────────────────── 实体

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  hellip: "…", middot: "·", bull: "•", copy: "©", reg: "®", trade: "™", deg: "°", plusmn: "±",
  times: "×", divide: "÷", laquo: "«", raquo: "»", euro: "€", pound: "£", yen: "¥", cent: "¢",
  sect: "§", para: "¶", dagger: "†", permil: "‰", larr: "←", rarr: "→", harr: "↔", shy: "",
}

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text
  return text.replaceAll(/&(#x?[0-9a-f]+|[a-z][a-z0-9]{1,31});/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1]?.toLowerCase() === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    return NAMED[body.toLowerCase()] ?? whole
  })
}

/**
 * 收拾空白。
 *
 * ★ 代码块里一个空格都不许动。整篇正文压缩空白是对的 —— 网页里到处是排版用的
 *   缩进 —— 但同一套规则套到 ``` 里面就是在破坏内容:一段 Python、一份 YAML、
 *   一个 diff,缩进就是语义。而读这些的恰好是个写代码的 agent。
 */
function tidy(text: string): string {
  const out: string[] = []
  let fenced = false
  let blanks = 0

  for (const raw of text.split("\n")) {
    if (raw.trimStart().startsWith("```")) {
      fenced = !fenced
      blanks = 0
      out.push("```")
      continue
    }
    if (fenced) {
      out.push(raw.replace(/[ \t]+$/, ""))
      continue
    }
    const line = raw.replaceAll(/[ \t]{2,}/g, " ").trim()
    if (line.length === 0) {
      // 段落之间留一个空行就够,再多是网页排版留下的空壳元素
      if (++blanks > 1) continue
    } else blanks = 0
    out.push(line)
  }

  return out.join("\n").trim()
}

/**
 * 一个 `<meta>` 标签里有没有我们要的东西。
 *
 * 先到先得 —— 页面里同一件事写好几遍是常态(og: 一份、twitter: 一份、
 * 裸 name 一份),而后写的那份没有理由比先写的准。
 */
function readMeta(raw: string, into: PageMeta): void {
  const key = (attribute(raw, "property") ?? attribute(raw, "name") ?? attribute(raw, "itemprop") ?? "").toLowerCase()
  const value = attribute(raw, "content")?.trim()
  if (!key || !value) return

  if (!into.description && (key === "description" || key === "og:description" || key === "twitter:description")) {
    into.description = value
  } else if (!into.site && key === "og:site_name") {
    into.site = value
  } else if (
    !into.published &&
    ["article:published_time", "og:article:published_time", "article:modified_time", "og:updated_time", "datepublished", "publish_date", "pubdate", "date"].includes(key)
  ) {
    into.published = value
  }
}
