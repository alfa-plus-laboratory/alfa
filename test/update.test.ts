/**
 * The release channel and version comparison.
 *
 * What's tested here is **judgment**, not the network: whether the platform is
 * recognized correctly, what counts as "newer", and when to give up without a word. A
 * wrong judgment costs something concrete and hard to trace — hand an arm64 build to an
 * armv7 user and what they get is "cannot execute binary file", with no clue in it.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { assetName, assetURL, currentPlatform, isNewer, latestRelease, VERSION } from "../src/update/release.ts"

describe("platform", () => {
  test("the four recognized combinations", () => {
    expect(currentPlatform("linux", "x64")?.key).toBe("linux-x64")
    expect(currentPlatform("linux", "arm64")?.key).toBe("linux-arm64")
    expect(currentPlatform("darwin", "arm64")?.key).toBe("darwin-arm64")
    expect(currentPlatform("win32", "x64")).toEqual({ key: "windows-x64", ext: ".exe" })
  })

  test("★ unrecognized means no guessing — the error from a wrong build carries no clue at all", () => {
    expect(currentPlatform("linux", "arm")).toBeUndefined()
    expect(currentPlatform("freebsd", "x64")).toBeUndefined()
    expect(currentPlatform("sunos", "x64")).toBeUndefined()
    // Windows ships x64 only: shipping a build nobody has verified means it fails one day
    // in a way nobody can reproduce
    expect(currentPlatform("win32", "arm64")).toBeUndefined()
  })

  test("asset name and download URL", () => {
    expect(assetName({ key: "linux-x64", ext: "" })).toBe("alfa-linux-x64")
    expect(assetName({ key: "windows-x64", ext: ".exe" })).toBe("alfa-windows-x64.exe")
    expect(assetURL("v1.2.3", "alfa-linux-x64", "o/r")).toBe(
      "https://github.com/o/r/releases/download/v1.2.3/alfa-linux-x64",
    )
  })
})

describe("version comparison", () => {
  test("compares major.minor.patch segment by segment", () => {
    expect(isNewer("0.4.0", "0.3.9")).toBe(true)
    expect(isNewer("0.3.10", "0.3.9")).toBe(true)
    expect(isNewer("1.0.0", "0.99.99")).toBe(true)
    expect(isNewer("0.3.0", "0.3.0")).toBe(false)
    expect(isNewer("0.2.9", "0.3.0")).toBe(false)
  })

  test("★ an rc ranks below its own release but above lower versions — keeping rcs from being offered is latestRelease's job", () => {
    expect(isNewer("0.4.0-rc.1", "0.3.0")).toBe(true) // the higher version really is higher
    expect(isNewer("0.3.0-rc.1", "0.3.0")).toBe(false) // an rc of the same version isn't newer
    expect(isNewer("0.3.0", "0.3.0-rc.1")).toBe(true)
  })

  test("an unrecognized version string counts as oldest, not newest", () => {
    expect(isNewer("garbage", VERSION)).toBe(false)
  })
})

describe("looking up the latest release", () => {
  const stub = (body: unknown, ok = true) =>
    (async () => ({ ok, json: async () => body }) as unknown as Response) as unknown as typeof fetch

  test("gets the tag, stripping the v prefix", async () => {
    const found = await latestRelease({ fetchImpl: stub({ tag_name: "v1.2.3" }) })
    expect(found).toEqual({ tag: "v1.2.3", version: "1.2.3" })
  })

  test("★ draft and prerelease are always rejected", async () => {
    expect(await latestRelease({ fetchImpl: stub({ tag_name: "v9.0.0", draft: true }) })).toBeUndefined()
    expect(await latestRelease({ fetchImpl: stub({ tag_name: "v9.0.0", prerelease: true }) })).toBeUndefined()
  })

  test("unreachable, malformed, network blown up: all return undefined", async () => {
    expect(await latestRelease({ fetchImpl: stub({}, false) })).toBeUndefined()
    expect(await latestRelease({ fetchImpl: stub({ tag_name: "nightly" }) })).toBeUndefined()
    expect(await latestRelease({ fetchImpl: stub({}) })).toBeUndefined()
    const boom = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    expect(await latestRelease({ fetchImpl: boom })).toBeUndefined()
  })
})

describe("★ when api.github.com can't answer, there's a second route", () => {
  // The unauthenticated API allows 60 requests/hour per IP; when a whole office sits behind
  // one egress IP, that quota belongs to someone else. Some networks also just block the
  // api subdomain while github.com itself gets through
  const redirect = (location: string) =>
    new Response(null, { status: 302, headers: { location } }) as unknown as Response

  test("on API 403 (quota exhausted), follows the web page's redirect", async () => {
    const calls: string[] = []
    const latest = await latestRelease({
      fetchImpl: (async (url: string | URL) => {
        calls.push(String(url))
        if (String(url).includes("api.github.com")) return new Response("rate limited", { status: 403 })
        return redirect("https://github.com/o/r/releases/tag/v1.2.3")
      }) as unknown as typeof fetch,
    })
    expect(latest?.version).toBe("1.2.3")
    expect(calls[0]).toContain("api.github.com")
    expect(calls[1]).toContain("github.com/alfa-plus-laboratory/alfa/releases/latest")
  })

  test("an API that can't be reached at all takes that route too", async () => {
    const latest = await latestRelease({
      fetchImpl: (async (url: string | URL) => {
        if (String(url).includes("api.github.com")) throw new Error("ENOTFOUND")
        return redirect("/alfa-plus-laboratory/alfa/releases/tag/v0.9.0")
      }) as unknown as typeof fetch,
    })
    expect(latest?.tag).toBe("v0.9.0")
  })

  test("only both routes failing counts as unknown — then it must be undefined, never pretend to know", async () => {
    const latest = await latestRelease({
      fetchImpl: (async () => {
        throw new Error("offline")
      }) as unknown as typeof fetch,
    })
    expect(latest).toBeUndefined()
  })

  test("a redirect pointing somewhere that doesn't look like a version is rejected", async () => {
    const latest = await latestRelease({
      fetchImpl: (async (url: string | URL) =>
        String(url).includes("api.github.com")
          ? new Response("nope", { status: 500 })
          : redirect("https://github.com/o/r/releases")) as unknown as typeof fetch,
    })
    expect(latest).toBeUndefined()
  })
})

describe("★ the tag gets spliced into the download URL, so its shape is a security boundary", () => {
  // Dropping one $ doesn't just mean "accepting a few odd tags": this string goes straight
  // into assetURL, so v9.9.9/../../attacker/evil/... passes the prefix match and
  // traverses out, and checksums.txt goes through the same poisoned tag — the digest comes
  // from the attacker too, so verification still passes.
  const redirectTo = (location: string): typeof fetch =>
    (async (url: unknown) =>
      String(url).startsWith("https://api.github.com")
        ? new Response("", { status: 403 })
        : new Response("", { status: 302, headers: { location } })) as unknown as typeof fetch

  test("path traversal in a tampered Location is always rejected", async () => {
    const evil = "/o/r/releases/tag/v9.9.9%2F..%2F..%2F..%2Fattacker%2Fevil%2Freleases%2Fdownload%2Fv1"
    expect(await latestRelease({ fetchImpl: redirectTo(evil) })).toBeUndefined()
  })

  test("a slash in the decoded tag is rejected — never decode after the regex has passed", async () => {
    // an unencoded slash is stopped by [^/?#]+$; an encoded one must **never** be let back
    // in by decoding
    expect(await latestRelease({ fetchImpl: redirectTo("/o/r/releases/tag/v1.2.3%2Fx") })).toBeUndefined()
  })

  test("normal tags and prerelease suffixes are still recognized", async () => {
    expect(await latestRelease({ fetchImpl: redirectTo("/o/r/releases/tag/v1.2.3") })).toEqual({
      tag: "v1.2.3",
      version: "1.2.3",
    })
    expect(await latestRelease({ fetchImpl: redirectTo("/o/r/releases/tag/v1.2.3-rc.1") })).toEqual({
      tag: "v1.2.3-rc.1",
      version: "1.2.3-rc.1",
    })
  })
})

describe("the version has a single source", () => {
  test("the version in the binary == package.json", async () => {
    const pkg = (await Bun.file("package.json").json()) as { version: string }
    expect(VERSION).toBe(pkg.version)
  })
})
