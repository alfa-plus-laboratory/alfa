/**
 * 发布渠道:这台机器该下哪个文件,以及最新版是几。
 *
 * ── 为什么这里不需要任何认证 ──
 * 仓库是公开的,所以问最新版和下二进制都是匿名请求。这一条是**下面那两条路
 * 的前提**:latestRelease 拿不到 token,也不该拿。
 *
 * 历史上不是这样 —— 代码仓私有的那阵子,二进制得推到一个单独的公开分发仓
 * (apcode-dist),因为私有仓的 release 资产每次下载都要带 token,而"装个东西"
 * 这件事不该以配置密钥开头。仓库转公开之后那个理由消失了,分发仓、跨仓 PAT、
 * 以及"空仓发不了 release"那一整段兜底一起删掉了。
 *
 * ── 版本号只有一个来源 ──
 * package.json。二进制里那个是 bun 在编译时把 JSON 内联进去的同一个值,
 * 而 CI 发版前会核对它和 tag 一致(见 .github/workflows/release.yml)。
 * 三处各写一份的话,迟早出现"横幅说 0.3.0、release 页写着 v0.4.0"。
 */
import { version as PACKAGE_VERSION } from "../../package.json"

/** 发布所在的仓库。公开,所以下面两条路都不带认证 */
export const REPO = "alfa-plus-laboratory/alfa"

/** 这个二进制自己的版本。横幅、`alfa -v`、更新比较都用它 */
export const VERSION: string = PACKAGE_VERSION

export interface Platform {
  /** 资产名里的那一段,如 "linux-x64" */
  key: string
  /** Windows 上的可执行后缀 */
  ext: string
}

/**
 * 当前平台对应的资产名。
 *
 * 认不出来就 undefined —— 让一个 32 位 armv7 用户下走 arm64 的包,
 * 得到的是一句 "cannot execute binary file",而那句话没有任何线索。
 */
export function currentPlatform(
  os: string = process.platform,
  arch: string = process.arch,
): Platform | undefined {
  const system = os === "darwin" ? "darwin" : os === "linux" ? "linux" : os === "win32" ? "windows" : undefined
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : undefined
  if (!system || !cpu) return undefined
  // Windows 只出 x64:arm64 的 Windows 机器少,而出一个没人验证过的包
  // 比不出更糟 —— 它会在某天以一种谁也复现不了的方式失败
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
  /** 形如 v0.4.0 */
  tag: string
  /** 去掉前缀 v 的版本号 */
  version: string
}

/**
 * 问一次分发仓最新发布了什么。问不到一律 undefined。
 *
 * ── 两条路,不是一条 ──
 * 先问 API,不成再跟一次网页版的重定向。理由是 **api.github.com 会答不了**:
 * 未认证的调用是按 IP 算的 60 次/小时,一个出口 IP 后面坐着一整间公司的时候
 * 那个额度是别人的;有些网络干脆把 api 这个子域挡掉,而 github.com 本身通。
 *
 * `github.com/<repo>/releases/latest` 会 302 到 `/releases/tag/vX.Y.Z` ——
 * 一个不花额度、也不需要认证的答案,Location 头里就是版本号。
 *
 * 公开仓,两条路都不带任何认证 —— 这正是把二进制放在那儿的理由。
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

/** 网页版那条:302 的 Location 里带着 tag。GitHub 算 latest 时同样跳过预发布 */
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
    // ★ **不要**在这儿 decodeURIComponent。
    //
    //   `[^/?#]+$` 挡的是"tag 里不许有斜杠",而 decode 会把 `%2F` 变回 `/` ——
    //   挡完再放回来,等于没挡。一个被改写过的 Location:
    //
    //     …/releases/tag/v9.9.9%2F..%2F..%2F..%2Fattacker%2Fevil%2Freleases%2Fdownload%2Fv1
    //
    //   decode 之后 parseTag 认它(旧正则没锚),assetURL 拼出来的是
    //   github.com/**attacker/evil**/releases/download/v1/alfa-linux-x64,
    //   而 checksums.txt 走同一个 tag —— 攻击者给一份对得上的摘要,校验就过了。
    //   真实的 tag 里不会有需要转义的字符(parseTag 只认 vX.Y.Z),
    //   所以这里丢掉 decode 没有代价。
    return parseTag(match?.[1] ?? "")
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 认一个 tag,认不出就 undefined。
 *
 * ⚠ 正则**必须两头都锚**。少一个 `$` 的后果不是"多认几个奇怪的 tag" ——
 *   这个字符串会被直接拼进下载地址,于是 `v9.9.9/../../attacker/evil/...`
 *   前缀匹配通过,路径穿越出去,而二进制和它的 checksums.txt 走的是同一个
 *   被污染的 tag(所以摘要也是攻击者给的,校验照样过)。
 *
 *   预发布后缀(-rc.1、+build)是真实存在的,所以留一段受限的尾巴,
 *   但里面**不许有斜杠**,也不许有别的路径元字符。
 */
function parseTag(tag: string): LatestRelease | undefined {
  if (!/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) return undefined
  return { tag, version: tag.replace(/^v/, "") }
}

/**
 * a 比 b 新吗。
 *
 * 只按 major.minor.patch 比,预发布后缀(-rc.1)一律当成"比正式版旧" ——
 * 这和 latestRelease 里过滤掉 prerelease 是同一条立场:没人应该被一个
 * 他没主动要过的预发布版悄悄升上去。
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
