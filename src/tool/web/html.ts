/**
 * HTML → body text for the model to read.
 *
 * ── Why not just hand the HTML to the model ──
 * Over 90% of the bytes in a modern page are for the browser: inline scripts, styles,
 * data URIs, tracking, SVG paths. Hand over the whole thing and a 300KB page can eat
 * most of the context window, while the actual body text may be two thousand words.
 *
 * ── What gets stripped must be **counted**, not silently vanish ──
 * This is a security requirement, not fastidiousness. Inside `<script>`, inside HTML
 * comments, inside `display:none` elements — those are the three comfiest places to
 * hide instructions, because a person opening the page never sees them, while an
 * implementation that feeds the whole HTML to the model reads every word. So here:
 *   - scripts / styles: thrown away wholesale, only the count is reported (the content
 *     is too noisy; scanning it would be nothing but false positives)
 *   - comments / hidden elements / noscript: **the content is set aside separately**
 *     for the injection scan, but **does not go into** the body text given to the
 *     model — we want to recognize it, not read it aloud
 *
 * ── Limits ──
 * This is not an HTML parser, it is a good-enough scanner. Malformed nesting, complex
 * `<table>` layouts, JS-rendered pages — it handles none of them well. Handling them
 * badly shows up as ugly body text, not as missed hidden content; the latter is what
 * this file is really responsible for.
 */

/** Tags whose content is discarded wholesale, only counted. */
const DISCARD = new Set(["script", "style", "svg", "canvas", "template", "iframe", "object", "embed", "math"])
/** Tags whose content is not shown to the model but is kept for the injection scan. */
const CONCEAL = new Set(["noscript"])
/** The ones with no closing tag. */
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
])
/** Block-level elements that get a line break before and after. */
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "dd", "dt", "fieldset", "figcaption",
  "figure", "footer", "form", "header", "hgroup", "main", "nav", "ol", "p", "section", "summary", "table",
  "tbody", "thead", "tfoot", "ul",
])

/**
 * The few things the page declares about itself.
 *
 * ★ All of these are **text written by the page author**, exactly as untrustworthy as
 *   the body — so they must go inside the envelope together with the body, not be
 *   written outside it as if they were notes on the fetch (see webfetch.ts). A page that
 *   stuffs instructions into its `<title>` is entirely possible.
 */
export interface PageMeta {
  description?: string
  /** Site name (og:site_name) */
  site?: string
  /** Published / updated time. For time-sensitive questions this matters more than the
   *  body */
  published?: string
}

export interface Extracted {
  title?: string
  meta: PageMeta
  /** Body text, markdown-flavored plain text */
  text: string
  /** The hidden text. **Not shown to the model**, only used for the injection scan */
  concealed: string
  removed: {
    scripts: number
    styles: number
    comments: number
    /** Elements hidden with display:none and the like */
    hidden: number
  }
  links: number
}

/** Body text shorter than this means `<main>` was the wrong pick; fall back to the whole
 *  page. */
const MAIN_TOO_THIN = 200

export function extractHtml(html: string, baseUrl?: URL): Extracted {
  const tokens = tokenize(html)
  const main = mainRange(tokens)

  // First extract by <main> / <article>. If too little comes out, this page's body isn't
  // there (an empty <main> hanging off a sidebar, a site rendered entirely by JS), so
  // fall back to the whole page — better to drag along a pile of navigation than to
  // report "this page has no content" and mislead the model
  const focused = walk(tokens, main, baseUrl)
  if (main.start === 0 && main.end === tokens.length) return focused
  return focused.text.length >= MAIN_TOO_THIN ? focused : walk(tokens, { start: 0, end: tokens.length }, baseUrl)
}

/**
 * Which stretch holds the body.
 *
 * On a docs-site page, the navigation, sidebar, footer and cookie banner together are
 * often longer than the body — and they are worth nothing for "how do I use this API",
 * yet they are paid for by the token. `<main>` / `<article>` is the only reliable signal
 * for this, and honoring it is enough; we don't do the density-guessing heuristics of
 * body-text extraction: when those guess wrong they **quietly** drop half the article.
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

  /** Counter stack for ordered lists */
  const ordered: number[] = []
  /** hrefs of `<a>` tags not yet closed. `](url)` can only be written at `</a>` */
  const hrefs: string[] = []
  let preDepth = 0

  // Body text comes only from the range, but **the counts and the hidden text scan the
  // whole page** — injections' favorite hangouts are precisely the footer and the
  // navigation, and those are outside <main>
  let at = 0
  const emit = (value: string) => {
    if (at >= range.start && at < range.end) out.push(value)
  }

  for (let i = 0; i < tokens.length; i++) {
    at = i
    const token = tokens[i]!

    if (token.kind === "comment") {
      removed.comments++
      // Comment text goes into the "hidden" bucket. Nine times out of ten, the real
      // injection is right here
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

    // ── Opening tags ──
    if (name === "title") {
      const text = collectText(tokens, i, name)
      title = decodeEntities(text.body).replaceAll(/\s+/g, " ").trim() || undefined
      i = text.end
      continue
    }

    if (DISCARD.has(name)) {
      if (name === "script") {
        removed.scripts++
        // ld+json is **structured data**, not code, and the publish date is often only
        // found in there. Fish out just a date; not one word of it goes into the body
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

// ─────────────────────────────────────────────── Scanner

type Token =
  | { kind: "text"; value: string }
  | { kind: "comment"; value: string }
  | { kind: "tag"; name: string; raw: string; closing: boolean; selfClosing: boolean }

/**
 * Split into tokens.
 *
 * A `>` inside an attribute value must be recognized (`<a title="a > b">`); otherwise
 * the tag is cut off halfway and the back half is spat out as body text — exactly the
 * crack an attacker would use to smuggle content in.
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
      // A `<` that is not a tag is a less-than sign in the body text
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

/** Find the tag's `>`, skipping any inside quotes. */
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

/** Jump from the open tag to past its closing tag. Same-name nesting has to count depth. */
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

/** Same as above, but collects the text in between. */
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

// ─────────────────────────────────────────────── Attributes

export function attribute(raw: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i")
  const hit = pattern.exec(raw)
  if (!hit) return undefined
  return decodeEntities(hit[2] ?? hit[3] ?? hit[4] ?? "")
}

/**
 * Whether this element is invisible to a person.
 *
 * What counts is **inline style** and the hidden attribute. Class names (`.sr-only`,
 * `.visually-hidden`) are deliberately ignored: those are accessibility text that
 * screen readers read aloud, and treating them as attacks would be false positives;
 * hiding defined in external CSS can't be seen here at all — a known hole in this layer.
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
  // data: / javascript: links are worthless to the model, and a data URI can run to
  // hundreds of KB
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

// ─────────────────────────────────────────────── Entities

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
 * Tidy up whitespace.
 *
 * ★ Not a single space inside a code block may be touched. Collapsing whitespace across
 *   the body is right — web pages are full of layout indentation — but applying the same
 *   rule inside ``` destroys content: in a piece of Python, a YAML file, a diff, the
 *   indentation is the meaning. And the one reading these happens to be a coding agent.
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
      // One blank line between paragraphs is enough; more is empty shell elements left
      // over from the page layout
      if (++blanks > 1) continue
    } else blanks = 0
    out.push(line)
  }

  return out.join("\n").trim()
}

/**
 * Whether a `<meta>` tag holds anything we want.
 *
 * First one wins — pages routinely state the same thing several times (once as og:,
 * once as twitter:, once as a bare name), and there is no reason a later copy is more
 * accurate than an earlier one.
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
