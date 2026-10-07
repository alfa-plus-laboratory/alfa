/**
 * Search. Three backends, one picked automatically.
 *
 * ── The keyless one is the fallback, not the first choice ──
 * DuckDuckGo's HTML endpoint **works out of the box**, so it is the fallback when
 * nothing is configured. But it rate-limits, and rate-limiting looks like a captcha page
 * — so "found nothing" and "wasn't allowed to search" look exactly the same. For daily
 * use, configure a real search API:
 *
 *   BRAVE_API_KEY                    Brave Search API
 *   TAVILY_API_KEY                   Tavily
 *
 * ★ Google Programmable Search used to come first and was removed. Google closed its
 *   Custom Search JSON API to new customers in 2025 and shuts it down on 2027-01-01, and
 *   engines created since 2026-01-20 can't search the whole web. The tool kept
 *   recommending a key nobody could get, and would have broken for everyone who had one.
 *   The `page` parameter went with it: Google was the only backend that paged, and
 *   on the others it silently returned page one again.
 *
 * ── A parse failure must never be reported as "no results" ──
 * Scraping HTML means every layout change on their side forces a change here. And "no
 * results" and "the search didn't go through" are completely different things to the
 * model: the former leads it to conclude "this thing doesn't exist", the latter just
 * makes it retry. See the two notes at the end of duckduckgo().
 *
 * ── Search results are untrusted content ──
 * Titles and snippets are **text written by someone else**, and written specifically to
 * get ranked on top. Stuffing instructions into search results (a variant of SEO
 * poisoning) is far cheaper for an attacker than compromising a website. So this file
 * only fetches; the envelope and injection scan are done uniformly by websearch.ts —
 * the same path page bodies take.
 */
import { decodeEntities } from "./html.ts"

export interface SearchHit {
  title: string
  url: string
  snippet: string
  /**
   * The time the page declares for itself.
   *
   * It earns its keep on **time-sensitive questions**: "what's been happening with X
   * lately", "is this library still maintained", "what's the latest version now" — for
   * these, a result from 2019 and one from last week differ in value by an order of
   * magnitude, and the title and snippet alone can't tell them apart. If it can't be
   * had, it's absent; no guessing.
   */
  published?: string
  /** Site name, for the model to weigh the source (official docs vs content farm) */
  source?: string
}

export type SearchProvider = "duckduckgo" | "brave" | "tavily"

export interface SearchOutcome {
  provider: SearchProvider
  hits: SearchHit[]
  /** Explanation for an empty result. **Required** — see the file header */
  note?: string
}

const TIMEOUT_MS = 20_000

/**
 * Which backend to use. Ones with a configured key win — they are more accurate, don't
 * get rate-limited, and are the user's own choice.
 *
 * Brave goes first: it gives publish times (SearchHit.published), which Tavily doesn't.
 */
export function chooseProvider(): { provider: SearchProvider; key?: string } {
  const brave = process.env["BRAVE_API_KEY"] || process.env["BRAVE_SEARCH_API_KEY"]
  if (brave) return { provider: "brave", key: brave }
  const tavily = process.env["TAVILY_API_KEY"]
  if (tavily) return { provider: "tavily", key: tavily }
  return { provider: "duckduckgo" }
}

/** One sentence: what is configured now and what else could be. Both empty results and
 *  errors carry it */
export function providerHint(): string {
  const { provider } = chooseProvider()
  if (provider !== "duckduckgo") return `Searching with ${provider}.`
  return (
    "Searching with DuckDuckGo's unauthenticated endpoint, which rate-limits and answers with a challenge page when it does. " +
    "Setting BRAVE_API_KEY or TAVILY_API_KEY (both have a free tier) switches to a real API automatically — worth telling the user if this keeps happening."
  )
}

export interface SearchInput {
  query: string
  count: number
  signal: AbortSignal
}

export async function search(input: SearchInput): Promise<SearchOutcome> {
  const { provider, key } = chooseProvider()
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(TIMEOUT_MS)])

  switch (provider) {
    case "brave":
      return { provider, hits: await brave(input, key!, signal) }
    case "tavily":
      return { provider, hits: await tavily(input, key!, signal) }
    default:
      return duckduckgo(input, signal)
  }
}

// ─────────────────────────────────────────────── DuckDuckGo (keyless)

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

  // ★ An empty result and a parse failure are completely different things, and the
  //   model can't tell them apart — unless we say so here. Reporting "no results"
  //   leads it to conclude "this thing doesn't exist", which is far worse than an error
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
 * Dig the results out of DDG's HTML.
 *
 * Titles and snippets are scraped separately and paired up by order — no attempt to
 * reconstruct the DOM structure. A layout change may skew the pairing, but this is far
 * more robust than slicing whole blocks by their nesting structure.
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

/** DDG wraps outbound links as `//duckduckgo.com/l/?uddg=<encoded real address>`. */
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
