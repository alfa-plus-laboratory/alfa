/**
 * 发布渠道与版本比较。
 *
 * 这里测的是**判断**,不是网络:平台认得对不对、什么算"更新"、什么情况该
 * 一声不吭地放弃。判断错的代价具体而难查 —— 把 arm64 的包给 armv7 用户,
 * 他拿到的是一句 "cannot execute binary file",里面没有任何线索。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { assetName, assetURL, currentPlatform, isNewer, latestRelease, VERSION } from "../src/update/release.ts"

describe("平台", () => {
  test("认得的四个组合", () => {
    expect(currentPlatform("linux", "x64")?.key).toBe("linux-x64")
    expect(currentPlatform("linux", "arm64")?.key).toBe("linux-arm64")
    expect(currentPlatform("darwin", "arm64")?.key).toBe("darwin-arm64")
    expect(currentPlatform("win32", "x64")).toEqual({ key: "windows-x64", ext: ".exe" })
  })

  test("★ 认不出来就不猜 —— 给错包的报错里没有任何线索", () => {
    expect(currentPlatform("linux", "arm")).toBeUndefined()
    expect(currentPlatform("freebsd", "x64")).toBeUndefined()
    expect(currentPlatform("sunos", "x64")).toBeUndefined()
    // Windows 只出 x64:出一个没人验证过的包,会在某天以谁也复现不了的方式失败
    expect(currentPlatform("win32", "arm64")).toBeUndefined()
  })

  test("资产名和下载地址", () => {
    expect(assetName({ key: "linux-x64", ext: "" })).toBe("alfa-linux-x64")
    expect(assetName({ key: "windows-x64", ext: ".exe" })).toBe("alfa-windows-x64.exe")
    expect(assetURL("v1.2.3", "alfa-linux-x64", "o/r")).toBe(
      "https://github.com/o/r/releases/download/v1.2.3/alfa-linux-x64",
    )
  })
})

describe("版本比较", () => {
  test("按 major.minor.patch 逐段比", () => {
    expect(isNewer("0.4.0", "0.3.9")).toBe(true)
    expect(isNewer("0.3.10", "0.3.9")).toBe(true)
    expect(isNewer("1.0.0", "0.99.99")).toBe(true)
    expect(isNewer("0.3.0", "0.3.0")).toBe(false)
    expect(isNewer("0.2.9", "0.3.0")).toBe(false)
  })

  test("★ 预发布不算更新 —— 没人该被一个他没主动要过的 rc 升上去", () => {
    expect(isNewer("0.4.0-rc.1", "0.3.0")).toBe(true) // 大版本确实更大
    expect(isNewer("0.3.0-rc.1", "0.3.0")).toBe(false) // 同版本的 rc 不算新
    expect(isNewer("0.3.0", "0.3.0-rc.1")).toBe(true)
  })

  test("认不出的版本串当成最旧,不当成最新", () => {
    expect(isNewer("garbage", VERSION)).toBe(false)
  })
})

describe("查最新发布", () => {
  const stub = (body: unknown, ok = true) =>
    (async () => ({ ok, json: async () => body }) as unknown as Response) as unknown as typeof fetch

  test("拿 tag,顺带去掉前缀 v", async () => {
    const found = await latestRelease({ fetchImpl: stub({ tag_name: "v1.2.3" }) })
    expect(found).toEqual({ tag: "v1.2.3", version: "1.2.3" })
  })

  test("★ draft 和 prerelease 一律不认", async () => {
    expect(await latestRelease({ fetchImpl: stub({ tag_name: "v9.0.0", draft: true }) })).toBeUndefined()
    expect(await latestRelease({ fetchImpl: stub({ tag_name: "v9.0.0", prerelease: true }) })).toBeUndefined()
  })

  test("拿不到、格式不对、网络炸了,全都返回 undefined", async () => {
    expect(await latestRelease({ fetchImpl: stub({}, false) })).toBeUndefined()
    expect(await latestRelease({ fetchImpl: stub({ tag_name: "nightly" }) })).toBeUndefined()
    expect(await latestRelease({ fetchImpl: stub({}) })).toBeUndefined()
    const boom = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    expect(await latestRelease({ fetchImpl: boom })).toBeUndefined()
  })
})

describe("★ api.github.com 答不了的时候还有第二条路", () => {
  // 未认证的 API 是按 IP 算 60 次/小时的,一个出口 IP 后面坐着一整间公司时
  // 那个额度是别人的;也有网络干脆把 api 这个子域挡掉,而 github.com 本身通
  const redirect = (location: string) =>
    new Response(null, { status: 302, headers: { location } }) as unknown as Response

  test("API 403(额度用光)时跟网页版的重定向", async () => {
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

  test("API 整个连不上也走那条路", async () => {
    const latest = await latestRelease({
      fetchImpl: (async (url: string | URL) => {
        if (String(url).includes("api.github.com")) throw new Error("ENOTFOUND")
        return redirect("/alfa-plus-laboratory/alfa/releases/tag/v0.9.0")
      }) as unknown as typeof fetch,
    })
    expect(latest?.tag).toBe("v0.9.0")
  })

  test("两条都不通才算问不到 —— 那时候必须是 undefined,不能装作知道", async () => {
    const latest = await latestRelease({
      fetchImpl: (async () => {
        throw new Error("offline")
      }) as unknown as typeof fetch,
    })
    expect(latest).toBeUndefined()
  })

  test("重定向指到一个不像版本号的地方就不认", async () => {
    const latest = await latestRelease({
      fetchImpl: (async (url: string | URL) =>
        String(url).includes("api.github.com")
          ? new Response("nope", { status: 500 })
          : redirect("https://github.com/o/r/releases")) as unknown as typeof fetch,
    })
    expect(latest).toBeUndefined()
  })
})

describe("★ tag 会被拼进下载地址,所以它的形状是安全边界", () => {
  // 少一个 $ 的后果不是"多认几个奇怪 tag":这个字符串直接进 assetURL,
  // 于是 v9.9.9/../../attacker/evil/... 前缀匹配通过、路径穿越出去,
  // 而 checksums.txt 走同一个被污染的 tag —— 摘要也是攻击者给的,校验照样过。
  const redirectTo = (location: string): typeof fetch =>
    (async (url: unknown) =>
      String(url).startsWith("https://api.github.com")
        ? new Response("", { status: 403 })
        : new Response("", { status: 302, headers: { location } })) as unknown as typeof fetch

  test("被改写过的 Location 里的路径穿越一律不认", async () => {
    const evil = "/o/r/releases/tag/v9.9.9%2F..%2F..%2F..%2Fattacker%2Fevil%2Freleases%2Fdownload%2Fv1"
    expect(await latestRelease({ fetchImpl: redirectTo(evil) })).toBeUndefined()
  })

  test("解出来的 tag 里出现斜杠就不认 —— 别在正则通过之后再 decode", async () => {
    // 未编码的斜杠会被 [^/?#]+$ 挡掉;编码过的那个则**绝不能**被 decode 放回来
    expect(await latestRelease({ fetchImpl: redirectTo("/o/r/releases/tag/v1.2.3%2Fx") })).toBeUndefined()
  })

  test("正常 tag 和预发布后缀照旧认得出来", async () => {
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

describe("版本号只有一个来源", () => {
  test("二进制里的版本 == package.json", async () => {
    const pkg = (await Bun.file("package.json").json()) as { version: string }
    expect(VERSION).toBe(pkg.version)
  })
})
