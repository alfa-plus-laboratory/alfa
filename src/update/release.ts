/**
 * Release channel: which file this machine should download, and what the latest
 * version is.
 *
 * ── Why no authentication is needed here ──
 * The repository is public, so both asking for the latest version and downloading the
 * binary are anonymous requests. This is **the premise of the two paths below**:
 * latestRelease has no token and shouldn't have one.
 *
 * It wasn't always like this — while the code repo was private, binaries had to be
 * pushed to a separate public distribution repo (apcode-dist), because a private
 * repo's release assets need a token on every download, and "installing something"
 * shouldn't start with configuring a secret. Once the repo went public that reason
 * disappeared, and the distribution repo, the cross-repo PAT, and the whole "an empty
 * repo can't publish a release" fallback were deleted together.
 *
 * ── The version number has exactly one source ──
 * package.json. The one in the binary is the same value, inlined from the JSON by bun at
 * compile time, and CI checks it matches the tag before releasing (see
 * .github/workflows/release.yml). With a copy written in three places, sooner or later
 * you get "the banner says 0.3.0, the release page says v0.4.0".
 */
import { version as PACKAGE_VERSION } from "../../package.json"

/** The repository releases live in. Public, so neither path below authenticates */
export const REPO = "alfa-plus-laboratory/alfa"

/** This binary's own version. Used by the banner, `alfa -v`, and update comparison */
export const VERSION: string = PACKAGE_VERSION

export interface Platform {
  /** The segment in the asset name, e.g. "linux-x64" */
  key: string
  /** Executable suffix on Windows */
  ext: string
}

/**
 * The asset name for the current platform.
 *
 * Unrecognized means undefined — letting a 32-bit armv7 user download the arm64
 * package gets them "cannot execute binary file", a message with no clue in it at all.
 */
export function currentPlatform(
  os: string = process.platform,
  arch: string = process.arch,
): Platform | undefined {
  const system = os === "darwin" ? "darwin" : os === "linux" ? "linux" : os === "win32" ? "windows" : undefined
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : undefined
  if (!system || !cpu) return undefined
  // Windows ships x64 only: arm64 Windows machines are rare, and shipping a package
  // nobody has verified is worse than not shipping one — some day it will fail in a
  // way nobody can reproduce
  if (system === "windows" && cpu !== "x64") return undefined
  return { key: `${system}-${cpu}`, ext: system === "windows" ? ".exe" : "" }
}

export function assetName(platform: Platform): string {
  return `alfa-${platform.key}${platform.ext}`
}

export function assetURL(tag: string, name: string, repo = REPO): string {
  return `https://github.com/${repo}/releases/download/${tag}/${name}`
}

export interface LatestRelease {
  /** Of the form v0.4.0 */
  tag: string
  /** The version with the leading v stripped */
  version: string
}

/**
 * Ask REPO — the public code repo, which carries the releases — once what its latest
 * release is. Any failure to get an answer is undefined.
 *
 * ── Two paths, not one ──
 * Ask the API first; failing that, follow the web version's redirect once. The reason
 * is that **api.github.com may not answer**: unauthenticated calls are 60/hour per IP,
 * and when a whole company sits behind one egress IP that quota belongs to someone
 * else; some networks block the api subdomain outright while github.com itself works.
 *
 * `github.com/<repo>/releases/latest` 302s to `/releases/tag/vX.Y.Z` — an answer that
 * costs no quota and needs no authentication, with the version right in the Location
 * header.
 *
 * Public repo, neither path carries any authentication — which is exactly why the
 * binaries are kept there.
 */
export async function latestRelease(
  options: { repo?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<LatestRelease | undefined> {
  const repo = options.repo ?? REPO
  const timeoutMs = options.timeoutMs ?? 5_000
  const impl = options.fetchImpl ?? fetch
  return (await fromAPI(repo, timeoutMs, impl)) ?? (await fromRedirect(repo, timeoutMs, impl))
}

async function fromAPI(repo: string, timeoutMs: number, impl: typeof fetch): Promise<LatestRelease | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await impl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json" },
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown }
    if (body.draft === true || body.prerelease === true) return undefined
    return parseTag(typeof body.tag_name === "string" ? body.tag_name : "")
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** The web path: the 302's Location carries the tag. GitHub skips prereleases when
 *  computing latest here too */
async function fromRedirect(repo: string, timeoutMs: number, impl: typeof fetch): Promise<LatestRelease | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await impl(`https://github.com/${repo}/releases/latest`, {
      redirect: "manual",
      signal: controller.signal,
    })
    const location = response.headers.get("location")
    if (!location) return undefined
    const match = /\/releases\/tag\/([^/?#]+)$/.exec(location)
    // ★ Do **not** decodeURIComponent here.
    //
    //   `[^/?#]+$` enforces "no slashes in a tag", and decoding turns `%2F` back into `/`
    //   — blocking it and then letting it back in is no block at all. A rewritten
    //   Location:
    //
    //     …/releases/tag/v9.9.9%2F..%2F..%2F..%2Fattacker%2Fevil%2Freleases%2Fdownload%2Fv1
    //
    //   After decoding, parseTag accepts it (the old regex wasn't anchored), and assetURL
    //   builds github.com/**attacker/evil**/releases/download/v1/alfa-linux-x64,
    //   while checksums.txt goes through the same tag — the attacker supplies a matching
    //   digest and verification passes. Real tags never contain characters that need
    //   escaping (parseTag only accepts vX.Y.Z), so dropping the decode here costs
    //   nothing.
    return parseTag(match?.[1] ?? "")
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Recognize a tag; undefined if it can't be recognized.
 *
 * ⚠ The regex **must be anchored at both ends**. The consequence of a missing `$` is not
 *   "a few odd tags get accepted" — this string is spliced straight into the download
 *   URL, so `v9.9.9/../../attacker/evil/...` passes on a prefix match and the path
 *   traverses out, while the binary and its checksums.txt go through the same poisoned
 *   tag (so the digest is also the attacker's, and verification passes anyway).
 *
 *   Prerelease suffixes (-rc.1, +build) do exist in practice, so a restricted tail is
 *   allowed, but it **may not contain slashes**, nor any other path metacharacter.
 */
function parseTag(tag: string): LatestRelease | undefined {
  if (!/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) return undefined
  return { tag, version: tag.replace(/^v/, "") }
}

/**
 * Is a newer than b.
 *
 * Compares only major.minor.patch; a prerelease suffix (-rc.1) always counts as "older
 * than the release" — the same stance as filtering out prereleases in latestRelease:
 * nobody should be quietly upgraded to a prerelease they never asked for.
 */
export function isNewer(a: string, b: string): boolean {
  const parse = (text: string): [number, number, number, number] => {
    const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(text.replace(/^v/, ""))
    if (!match) return [0, 0, 0, 1]
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ? 0 : 1]
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 4; i++) {
    if (left[i]! !== right[i]!) return left[i]! > right[i]!
  }
  return false
}
