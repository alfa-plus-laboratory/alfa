/**
 * 搜索。四个后端,自动挑一个。
 *
 * ── 免 key 那个是兜底,不是首选 ──
 * DuckDuckGo 的 HTML 端点**开箱就能用**,所以它是没配任何东西时的兜底。但它
 * 会限流,而且限流的样子是回一个验证码页面 —— 于是"搜不到"和"没让我搜"长得
 * 一模一样。真要天天用,配一个正经的搜索 API:
 *
 *   GOOGLE_CSE_KEY + GOOGLE_CSE_CX   Google Programmable Search(推荐)
 *   BRAVE_API_KEY                    Brave Search API
 *   TAVILY_API_KEY                   Tavily
 *
 * Google 那条排第一,因为它是这几个里唯一一个**不用绑信用卡**就能拿到的正经
 * API。变量名用的是 Google Programmable Search 自己文档里那两个 —— 已经在别处
 * 配过的机器,这边直接就能用,不用为一个工具再记一套新名字。
 *
 * ── 解析失败绝不许报成"没搜到" ──
 * 抓 HTML 意味着对面改一次版式这里就得跟着改。而"没有结果"和"没查成"对模型
 * 是完全不同的两件事:前者会让它得出"这东西不存在"的结论,后者只是让它重试。
 * 见 duckduckgo() 末尾那两句 note。
 *
 * ── 搜索结果是不可信内容 ──
 * 标题和摘要是**别人写的字**,而且是专门为了被排到前面而写的字。往搜索结果里
 * 塞指令(SEO 投毒的变种)对攻击者来说比攻破一个网站便宜得多。所以这里只负责
 * 取回来,装信封和扫注入由 websearch.ts 统一做 —— 和网页正文走同一条路。
 */
import { decodeEntities } from "./html.ts"

export interface SearchHit {
  title: string
  url: string
  snippet: string
  /**
   * 页面自己声明的时间。
   *
   * 值钱在**时效性问题**上:"某某最近怎么了"、"这个库还维护吗"、"现在最新版
   * 是几"——这类问题里,一条 2019 年的结果和一条上周的结果价值差着数量级,
   * 而光看标题和摘要分不出来。拿不到就没有,不猜。
   */
  published?: string
  /** 站点名,给模型判断来源权重用(官方文档 vs 内容农场) */
  source?: string
}

export type SearchProvider = "google" | "duckduckgo" | "brave" | "tavily"

export interface SearchOutcome {
  provider: SearchProvider
  hits: SearchHit[]
  /** 空结果时的解释。**必须有** —— 见文件头 */
  note?: string
}

const TIMEOUT_MS = 20_000

/**
 * 用哪个后端。配了 key 的优先 —— 它们更准、不会被限流,而且是用户自己选的。
 *
 * Google 排最前:它是这一套里唯一一个既有正经配额、又能给出发布时间的。
 */
export function chooseProvider(): { provider: SearchProvider; key?: string; cx?: string } {
  // 用官方文档里那两个名字 —— 配过一次的机器不用再配第二次
  const googleKey = process.env["GOOGLE_CSE_KEY"]
  const googleCx = process.env["GOOGLE_CSE_CX"]
  if (googleKey && googleCx) return { provider: "google", key: googleKey, cx: googleCx }
  const brave = process.env["BRAVE_API_KEY"] || process.env["BRAVE_SEARCH_API_KEY"]
  if (brave) return { provider: "brave", key: brave }
  const tavily = process.env["TAVILY_API_KEY"]
  if (tavily) return { provider: "tavily", key: tavily }
  return { provider: "duckduckgo" }
}

/** 一句话:现在配了什么、还能配什么。空结果和报错都要带上它 */
export function providerHint(): string {
  const { provider } = chooseProvider()
  if (provider !== "duckduckgo") return `Searching with ${provider}.`
  return (
    "Searching with DuckDuckGo's unauthenticated endpoint, which rate-limits and answers with a challenge page when it does. " +
    "Setting GOOGLE_CSE_KEY + GOOGLE_CSE_CX (Google Programmable Search), BRAVE_API_KEY, or TAVILY_API_KEY switches to a real API automatically — worth telling the user if this keeps happening."
  )
}

export interface SearchInput {
  query: string
  count: number
  signal: AbortSignal
  /** 1 起。翻页只有 Google 真支持,别的后端忽略它 */
  page?: number
}

export async function search(input: SearchInput): Promise<SearchOutcome> {
  const { provider, key, cx } = chooseProvider()
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(TIMEOUT_MS)])

  switch (provider) {
    case "google":
      return google(input, key!, cx!, signal)
    case "brave":
      return { provider, hits: await brave(input, key!, signal) }
    case "tavily":
      return { provider, hits: await tavily(input, key!, signal) }
    default:
      return duckduckgo(input, signal)
  }
}

// ─────────────────────────────────────────────── Google Programmable Search

/**
 * Google 的 Custom Search JSON API。
 *
 * 一页最多 10 条(API 的硬限制,不是这里定的),`start` 从 1 起算 —— 传条数
 * 不行,传的是**起始序号**。免费额度每天 100 次查询。
 *
 * 发布时间藏在 `pagemap.metatags` 里,而那是页面自己写的 meta 标签的转录 ——
 * 所以取得到就取,取不到不猜。见 SearchHit.published。
 */
async function google(input: SearchInput, key: string, cx: string, signal: AbortSignal): Promise<SearchOutcome> {
  const page = Math.max(1, Math.trunc(input.page ?? 1))
  const perPage = Math.min(10, input.count)
  const url = new URL("https://www.googleapis.com/customsearch/v1")
  url.searchParams.set("q", input.query)
  url.searchParams.set("key", key)
  url.searchParams.set("cx", cx)
  url.searchParams.set("num", String(perPage))
  url.searchParams.set("start", String((page - 1) * 10 + 1))

  const response = await fetch(url, { signal, headers: { accept: "application/json" } })
  if (!response.ok) {
    // ★ 报错正文里可能有 key(Google 会把请求 URL 回显在 error.message 里)。
    //   只带状态码,别把响应原样往上抛
    if (response.status === 400 || response.status === 403) {
      throw new Error(
        `Google Programmable Search rejected the request (${response.status}). GOOGLE_CSE_KEY or GOOGLE_CSE_CX is wrong, the key is restricted, or the daily quota (100 free queries) is used up. Tell the user; do not retry.`,
      )
    }
    if (response.status === 429) throw new Error("Google Programmable Search is rate-limiting this key (429).")
    throw new Error(`Google Programmable Search failed with ${response.status}.`)
  }

  const body = (await response.json()) as {
    items?: Array<Record<string, unknown>>
    searchInformation?: { totalResults?: string }
  }
  const hits = (body.items ?? []).map((item): SearchHit => {
    const pagemap = (item["pagemap"] ?? {}) as Record<string, unknown>
    const metatags = (Array.isArray(pagemap["metatags"]) ? pagemap["metatags"][0] : {}) as Record<string, unknown>
    const published =
      text(metatags["article:published_time"]) ||
      text(metatags["og:updated_time"]) ||
      text(metatags["date"]) ||
      text(metatags["pubdate"])
    return {
      title: text(item["title"]),
      url: text(item["link"]),
      snippet: stripTags(text(item["snippet"])),
      ...(published ? { published } : {}),
      ...(text(item["displayLink"]) ? { source: text(item["displayLink"]) } : {}),
    }
  })

  if (hits.length > 0) return { provider: "google", hits }
  return {
    provider: "google",
    hits: [],
    note:
      (body.searchInformation?.totalResults === "0"
        ? "Google returned zero matches for this query. That is a real answer — but try broader words before concluding the subject does not exist."
        : `Google returned no items on page ${page}.`) +
      (page > 1 ? " There may simply be no more pages." : ""),
  }
}

// ─────────────────────────────────────────────── DuckDuckGo(免 key)

async function duckduckgo(input: SearchInput, signal: AbortSignal): Promise<SearchOutcome> {
  const response = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "Mozilla/5.0 (compatible; alfa/0.1)",
      accept: "text/html",
    },
    body: new URLSearchParams({ q: input.query }).toString(),
  })

  if (!response.ok) {
    throw new Error(`DuckDuckGo answered ${response.status}. ${providerHint()}`)
  }

  const html = await response.text()
  const hits = parseDuckDuckGo(html).slice(0, input.count)
  if (hits.length > 0) return { provider: "duckduckgo", hits }

  // ★ 空结果和解析失败是两件完全不同的事,而模型分不出来 —— 除非这里说。
  //   报成"没搜到"会让它得出"这东西不存在"的结论,那比报错糟糕得多
  return {
    provider: "duckduckgo",
    hits: [],
    note:
      (/captcha|unusual traffic|anomaly/i.test(html)
        ? "DuckDuckGo returned a challenge page instead of results — it does this to unauthenticated clients that search too often. This is NOT evidence that nothing matched. "
        : "No results were parsed out of the response. That may mean nothing matched, or that the page layout changed and this parser is stale. Do not conclude the subject does not exist. ") + providerHint(),
  }
}

/**
 * 从 DDG 的 HTML 里抠结果。
 *
 * 标题和摘要分别抓、按顺序配对 —— 不去还原 DOM 结构。版式一变配对可能会歪,
 * 但比整块靠嵌套结构去切要耐操得多。
 */
export function parseDuckDuckGo(html: string): SearchHit[] {
  const titles: Array<{ url: string; title: string }> = []
  const titleRe = /<a\b([^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi
  for (const match of html.matchAll(titleRe)) {
    const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(match[1] ?? "")
    const raw = decodeEntities(href?.[2] ?? href?.[3] ?? "")
    const url = unwrapRedirect(raw)
    const title = stripTags(match[2] ?? "")
    if (url && title) titles.push({ url, title })
  }

  const snippets: string[] = []
  const snippetRe = /\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td|span)>/gi
  for (const match of html.matchAll(snippetRe)) snippets.push(stripTags(match[1] ?? ""))

  return titles.map((one, index) => ({ ...one, snippet: snippets[index] ?? "" }))
}

/** DDG 把外链包成 `//duckduckgo.com/l/?uddg=<编码过的真地址>`。 */
function unwrapRedirect(href: string): string {
  if (href.length === 0) return ""
  const normalized = href.startsWith("//") ? `https:${href}` : href
  try {
    const url = new URL(normalized, "https://duckduckgo.com")
    const target = url.searchParams.get("uddg")
    if (target) return target
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : ""
  } catch {
    return ""
  }
}

function stripTags(html: string): string {
  return decodeEntities(html.replaceAll(/<[^>]*>/g, "")).replaceAll(/\s+/g, " ").trim()
}

// ─────────────────────────────────────────────── Brave

async function brave(input: SearchInput, key: string, signal: AbortSignal): Promise<SearchHit[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search")
  url.searchParams.set("q", input.query)
  url.searchParams.set("count", String(Math.min(20, input.count)))

  const response = await fetch(url, {
    signal,
    headers: { accept: "application/json", "x-subscription-token": key },
  })
  if (!response.ok) throw new Error(apiError("Brave", response.status, "BRAVE_API_KEY"))

  const body = (await response.json()) as { web?: { results?: Array<Record<string, unknown>> } }
  return (body.web?.results ?? []).map((one): SearchHit => {
    const published = text(one["page_age"]) || text(one["age"])
    return {
      title: text(one["title"]),
      url: text(one["url"]),
      snippet: stripTags(text(one["description"])),
      ...(published ? { published } : {}),
    }
  })
}

// ─────────────────────────────────────────────── Tavily

async function tavily(input: SearchInput, key: string, signal: AbortSignal): Promise<SearchHit[]> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: input.query, max_results: Math.min(20, input.count), search_depth: "basic" }),
  })
  if (!response.ok) throw new Error(apiError("Tavily", response.status, "TAVILY_API_KEY"))

  const body = (await response.json()) as { results?: Array<Record<string, unknown>> }
  return (body.results ?? []).map((one) => ({
    title: text(one["title"]),
    url: text(one["url"]),
    snippet: stripTags(text(one["content"])),
  }))
}

function apiError(name: string, status: number, variable: string): string {
  if (status === 401 || status === 403) {
    return `${name} rejected the API key in ${variable} (${status}). Tell the user; do not retry.`
  }
  if (status === 429) return `${name} is rate-limiting this key (429). Wait before searching again.`
  return `${name} search failed with ${status}.`
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}
