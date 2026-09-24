/**
 * Before going out on the network: where does this address point.
 *
 * ── Why a "fetch a web page" tool needs this layer ──
 * Because the URL is not necessarily from the user. It may come from the previous page,
 * an issue body, a README — that is, **whoever decides which machine this agent
 * connects to may not be the user**. And this process sits inside the user's internal
 * network: it can reach the router admin at 192.168.1.1, the dev service on
 * localhost:8080 running with production database credentials, and 169.254.169.254 —
 * the cloud address that hands out instance credentials with no authentication at all.
 *
 * That is SSRF: get a program that can reach something to fetch what the attacker
 * can't reach themselves.
 *
 * ── Three tiers, not two ──
 *   blocked — metadata endpoints and reserved addresses. **No legitimate use
 *             whatsoever**, refused outright
 *   local   — loopback and internal network. Dev servers live here, a legitimate
 *             everyday need, so not refused, but spelled out in the approval prompt so
 *             whoever says yes knows they are saying yes to the internal network
 *   public  — everything else
 * Refusing local too is what many implementations do, and the price is losing the most
 * natural use of all: "let the agent take a look at the service I started locally".
 * That isn't security, that's cutting a feature and passing it off as security.
 *
 * ── An honest statement of the limits ──
 * What is checked here is the **resolved address**, not the hostname — so
 * `evil.com A 127.0.0.1` is blocked. But fetch **resolves again on its own**, and in
 * the window between the two lookups the domain can change its answer (DNS rebinding).
 * Truly closing that requires "connect to the IP we just looked up and send our own
 * Host header", and fetch doesn't offer that control. So this layer blocks ordinary
 * attacks, not a rebinder written specifically against it. Don't treat it as a sandbox.
 */
import { lookup } from "node:dns/promises"

export type Reach = "public" | "local" | "blocked"

export interface Target {
  url: URL
  reach: Reach
  /** Why this verdict. Goes into the approval prompt's reasons, and into the error on
   *  refusal */
  why?: string
  /** The resolved addresses, shown in the approval prompt — "example.com → 127.0.0.1" is
   *  something that should be visible at a glance */
  addresses?: string[]
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"])

/**
 * Parse and normalize the URL. **No** network lookup — that step is in resolveTarget.
 *
 * A bare domain (`example.com`) gets https:// prepended: both the model and the user
 * write it that way, and answering "Invalid URL" to make them guess which prefix to add
 * is pure friction.
 */
export function parseUrl(raw: string): URL {
  const trimmed = raw.trim()
  if (trimmed.length === 0) throw new Error("url is required")

  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    throw new Error(`Not a usable URL: ${JSON.stringify(trimmed)}`)
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new Error(
      `Only http and https are fetched; got "${url.protocol}". ` +
        (url.protocol === "file:"
          ? "Use the read tool for local files."
          : "There is no way to fetch this scheme, and no point retrying."),
    )
  }

  // A URL carrying a username/password is always refused. It is either display spoofing
  // for phishing (`https://github.com@evil.com/`), or a real credential — and the latter
  // must never be carried off by a string copied out of a web page
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error(
      "This URL carries credentials in it (user:password@host). Those are not sent. Remove them, or if you got this URL from fetched content, treat it as hostile.",
    )
  }

  // The fragment is never sent to the server; keeping it is just noise
  url.hash = ""
  return url
}

/** The categories visible from the hostname alone. Judged before DNS, saving a lookup. */
export function classifyHostname(hostname: string): Reach | undefined {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost")) return "local"
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return "local"
  if (isAddress(host)) return classifyAddress(host)
  return undefined
}

/** Does it look like an IP literal. */
export function isAddress(host: string): boolean {
  return /^[0-9.]+$/.test(host) || host.includes(":")
}

/**
 * Which tier an IP belongs to.
 *
 * The blocked entries are chosen with restraint: only what **cannot possibly have a
 * legitimate use** goes in. Link-local (169.254/16) is the key one — AWS / GCP / Azure
 * instance metadata all lives at 169.254.169.254, where a single GET yields temporary
 * credentials, with no authentication whatsoever. It is the classic SSRF payoff.
 */
export function classifyAddress(raw: string): Reach {
  const ip = raw.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "")

  if (ip.includes(":")) {
    if (ip === "::1") return "local"
    if (ip === "::" || ip === "::0") return "blocked"
    // IPv4-mapped / IPv4-compatible: ::ffff:127.0.0.1 and 127.0.0.1 are the same machine
    const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
    if (mapped?.[1]) return classifyAddress(mapped[1])
    if (/^fe[89ab]/.test(ip)) return "blocked" // fe80::/10 link-local
    if (/^f[cd]/.test(ip)) return "local" // fc00::/7 unique local (the equivalent of a LAN)
    if (/^ff/.test(ip)) return "blocked" // multicast
    return "public"
  }

  const parts = ip.split(".")
  if (parts.length !== 4) return "public"
  const octets = parts.map((part) => Number(part))
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return "public"
  const [a = 0, b = 0, c = 0] = octets

  if (a === 0) return "blocked" // 0.0.0.0/8 "this host"
  if (a === 127) return "local" // loopback
  if (a === 169 && b === 254) return "blocked" // ★ link-local — cloud metadata endpoints live here
  if (a === 10) return "local"
  if (a === 172 && b >= 16 && b <= 31) return "local"
  if (a === 192 && b === 168) return "local"
  if (a === 100 && b >= 64 && b <= 127) return "local" // CGNAT
  if (a === 192 && b === 0 && c === 0) return "blocked" // IETF protocol assignments
  if (a >= 224) return "blocked" // multicast + reserved
  return "public"
}

/**
 * Do one DNS lookup and assign the tier by the **resolved result**.
 *
 * If any one resolved address lands in blocked, the whole address is blocked — not a
 * "majority vote", because the attacker only needs one of them to be used. Likewise,
 * if any one is internal, it counts as internal.
 */
export async function resolveTarget(url: URL): Promise<Target> {
  const byName = classifyHostname(url.hostname)
  if (byName) {
    return {
      url,
      reach: byName,
      ...(byName === "blocked"
        ? { why: `${url.hostname} is a link-local or reserved address` }
        : byName === "local"
          ? { why: `${url.hostname} is on this machine or this private network` }
          : {}),
    }
  }

  let addresses: string[]
  try {
    const records = await lookup(url.hostname, { all: true })
    addresses = records.map((record) => record.address)
  } catch (error) {
    // If the name can't be looked up, let fetch report the error itself — its message is
    // more accurate than anything made up here. Filing it as public is safe: if it
    // truly can't be resolved, it can't be connected to at all
    return { url, reach: "public", why: `could not resolve ${url.hostname} (${(error as Error).message})` }
  }

  if (addresses.length === 0) return { url, reach: "public", addresses }

  const reaches = addresses.map((address) => classifyAddress(address))
  if (reaches.includes("blocked")) {
    return {
      url,
      reach: "blocked",
      addresses,
      why: `${url.hostname} resolves to ${addresses.join(", ")}, which is a link-local or reserved address`,
    }
  }
  if (reaches.includes("local")) {
    return {
      url,
      reach: "local",
      addresses,
      why: `${url.hostname} resolves to ${addresses.join(", ")}, which is on this machine or this private network`,
    }
  }
  return { url, reach: "public", addresses }
}

/** The pattern used for approval: a whole origin, not a single URL. See narrowAlways in
 *  permission/gate.ts. */
export function origin(url: URL): string {
  return `${url.protocol}//${url.host}`
}
