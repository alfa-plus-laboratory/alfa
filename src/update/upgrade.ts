/**
 * `alfa upgrade` —— 把自己换成最新的那个二进制。
 *
 * ── 这是整个程序里唯一一处"改自己"的代码,所以有三条硬规矩 ──
 *
 * 1. **先校验再替换。** 下完先算 sha256 和 checksums.txt 对,对不上一个字节
 *    都不写过去。一个被截断的下载(网络中途断了、磁盘满了)如果直接盖上去,
 *    用户下次敲 alfa 得到的是 "cannot execute binary file",而他手里再没有
 *    一个能跑的 alfa 去修这件事。
 *
 * 2. **原子替换。** 先写到同目录下的临时文件,再 rename 过去。rename 在同一个
 *    文件系统上是原子的 —— 中途断电要么是旧的要么是新的,不会是半个。
 *    写到 /tmp 再 mv 不行:跨文件系统的 mv 是"复制+删除",复制到一半就是半个。
 *
 * 3. **跑源码时拒绝。** `bun run src/cli/main.ts` 的 process.execPath 是 bun
 *    自己 —— 照着往上写就是把用户的 bun 换成 alfa。这个错误无法挽回,
 *    所以宁可什么都不做。
 *
 * ── 两个入口,同一段代码 ──
 * `alfa upgrade` 和会话里的 `/upgrade`(见 cli/main.ts)走的是这个函数。
 * 换掉的是磁盘上那个文件,**正在跑的这个进程照旧是老的** —— POSIX 上它握着的是
 * inode,所以会话能一路聊完不受影响,但要跑新的那个得重启。这句话由显示的一方
 * 去说(那边才知道用户是在终端里还是在会话里)。
 */
import { chmodSync, copyFileSync, createWriteStream, renameSync, rmSync, statSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { assetName, assetURL, currentPlatform, latestRelease, VERSION, isNewer } from "./release.ts"

/** 两次进度回报之间至少隔多久 */
const PROGRESS_INTERVAL_MS = 120

export type UpgradeOutcome =
  | { status: "current"; version: string }
  | { status: "updated"; from: string; to: string; path: string }
  | {
      status: "blocked"
      why: string
      /**
       * 机器可读的那一档。**只给"根本没问到"用**。
       *
       * 界面要用用户的语言说这句话(见 i18n 的 upgradeUnreachable),而 why 是
       * 一句英文。靠字符串匹配去认它是最脆的那种写法 —— 改一个词就悄悄失效
       */
      reason?: "unreachable"
    }
  /**
   * 用户自己按 esc 停的。
   *
   * 和 blocked 分开:那是"出事了",这是"我不下了"—— 报成失败的话,用户会去
   * 找一个根本不存在的错误。而这条路必须存在:一个卡在 3% 的下载如果没法取消,
   * 那个独占浮层就成了一个用户出不来的房间
   */
  | { status: "cancelled" }

/**
 * 进度事件。**故意不是一行现成的字。**
 *
 * 这个模块不该拥有用户看见的措辞:同一次升级既可能发生在 `alfa upgrade`
 * (那时候界面语言还没解析出来,一律英文),也可能发生在会话里的 `/upgrade`
 * (那时候用户很可能正开着中文或日文界面)。给事件、由显示的一方翻译,
 * 两条路才不会一条是中文一条是英文(见 cli/main.ts 的 upgradeLine)。
 */
export type UpgradeEvent =
  | { phase: "checking" }
  | { phase: "downloading"; tag: string; asset: string }
  /**
   * 下载进度。**这一条是这个功能的重点**:九十多兆在慢网上要几分钟,而在此之前
   * 界面上只有一句"downloading …" —— 用户不盯着看根本不知道它在动,更不知道
   * 还要多久。total 可能没有(服务器不给 Content-Length),那时候只能报已下多少
   */
  | { phase: "progress"; received: number; total?: number }
  | { phase: "verifying" }
  /** 校验过了,正在原子替换。这一步很快,但它是唯一一步"在改你机器上的文件" */
  | { phase: "installing" }

export interface UpgradeOptions {
  /** 强行装,即使版本号看起来已经是最新的 */
  force?: boolean
  /** 一步一步的进度。谁显示谁翻译 */
  onProgress?: (event: UpgradeEvent) => void
  /** 中途放弃。界面上那个浮层靠它退出(见 UpgradeOutcome 的 cancelled) */
  signal?: AbortSignal
}

export async function upgrade(options: UpgradeOptions = {}): Promise<UpgradeOutcome> {
  const say = options.onProgress ?? (() => {})
  const signal = options.signal
  const cancelled = (): boolean => signal?.aborted === true

  const self = process.execPath
  // 单文件二进制的 execPath 是它自己;bun 跑源码时是 bun。名字里带 bun 就别动
  if (/(^|[/\\])bun(\.exe)?$/.test(self)) {
    return { status: "blocked", why: "running from source — upgrade only works on an installed binary" }
  }

  const platform = currentPlatform()
  if (!platform) {
    return { status: "blocked", why: `no build for ${process.platform}/${process.arch}` }
  }

  say({ phase: "checking" })
  const latest = await latestRelease()
  if (cancelled()) return { status: "cancelled" }
  if (!latest) return { status: "blocked", why: "could not reach the release feed", reason: "unreachable" }
  if (!options.force && !isNewer(latest.version, VERSION)) {
    return { status: "current", version: VERSION }
  }

  const name = assetName(platform)
  const target = join(dirname(self), `.${name}.download`)
  try {
    say({ phase: "downloading", tag: latest.tag, asset: name })
    // ★ 先要摘要,再下九十多兆。要不到就在这儿停 —— 没有"那就不校验了"这条路,
    //   理由见 fetchChecksum 的头注释
    const expected = await fetchChecksum(latest.tag, name)
    if (!expected.ok) return { status: "blocked", why: expected.why, reason: "unreachable" }
    const digest = await download(assetURL(latest.tag, name), target, say, signal)
    if (cancelled()) return { status: "cancelled" }
    say({ phase: "verifying" })
    if (digest !== expected.digest) {
      // 校验不过就当没下过。**绝不**"要不要还是装上试试" —— 那是把一个
      // 已知损坏的文件放到用户唯一能用的位置上
      return {
        status: "blocked",
        why: `checksum mismatch — expected ${expected.digest.slice(0, 12)}…, got ${digest.slice(0, 12)}…`,
      }
    }

    say({ phase: "installing" })
    chmodSync(target, 0o755)
    // ★ Windows 上不能覆盖正在运行的可执行文件,先把自己挪开(那个 .old 留在
    //   原地,下次 upgrade 时清掉)。POSIX 上直接 rename —— 正在跑的进程握着
    //   的是 inode,不是路径,换掉路径下面那个文件对它毫无影响
    if (process.platform === "win32") {
      const parked = `${self}.old`
      try {
        rmSync(parked, { force: true })
      } catch {
        // 上一次留下的还被占着。不致命,换个名字接着来
      }
      renameSync(self, parked)
      try {
        renameSync(target, self)
      } catch (error) {
        // 换回去,别让用户手里连个能跑的都没有
        renameSync(parked, self)
        throw error
      }
    } else {
      renameSync(target, self)
    }
    return { status: "updated", from: VERSION, to: latest.version, path: self }
  } catch (error) {
    // abort 抛出来的是 AbortError,那不是失败 —— 是用户自己按的
    if (cancelled()) return { status: "cancelled" }
    return { status: "blocked", why: (error as Error).message }
  } finally {
    try {
      unlinkSync(target)
    } catch {
      // 成功那条路上它已经被 rename 走了,没有才是正常
    }
  }
}

/**
 * 下载到磁盘,同时算 sha256。
 *
 * 边下边算,不先读进内存:二进制有 90 多兆,而这个进程同时还挂着一整场
 * 会话的上下文。
 */
async function download(
  url: string,
  target: string,
  say: (event: UpgradeEvent) => void,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(url, { redirect: "follow", ...(signal ? { signal } : {}) })
  if (!response.ok || !response.body) throw new Error(`download failed (HTTP ${response.status})`)

  const header = response.headers.get("content-length")
  const total = header ? Number(header) : undefined
  let received = 0
  // 进度**按时间节流**,不按字节:一个 90MB 的下载有上万个 chunk,每个都往界面
  // 报一次的话,画进度条本身就成了瓶颈。120ms 比一帧长一点,肉眼看着是连续的
  let lastReport = 0

  const hasher = new Bun.CryptoHasher("sha256")
  const file = createWriteStream(target)
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      hasher.update(chunk)
      received += chunk.byteLength
      const now = Date.now()
      if (now - lastReport >= PROGRESS_INTERVAL_MS) {
        lastReport = now
        say(total !== undefined && Number.isFinite(total) ? { phase: "progress", received, total } : { phase: "progress", received })
      }
      if (!file.write(chunk)) await new Promise((resolve) => file.once("drain", resolve))
    }
    // 最后一次一定要报满:节流会把结尾那一段吞掉,进度条停在 97% 上
    say(total !== undefined && Number.isFinite(total) ? { phase: "progress", received, total } : { phase: "progress", received })
  } finally {
    await new Promise<void>((resolve, reject) => file.end((error?: Error) => (error ? reject(error) : resolve())))
  }
  // 下成了个 0 字节:多半是被代理拦了或者磁盘满了,而它 chmod +x 之后
  // 看起来和一个正常文件没区别
  if (statSync(target).size === 0) throw new Error("downloaded file is empty")
  return hasher.digest("hex")
}

/**
 * 取这次发布的 checksums.txt 里属于这个文件的那一行。
 *
 * ★ 拿不到就**拿不到**,不许降级成"那就不校验了"。
 *
 *   这条曾经是 `Promise<string | undefined>`,而调用方写的是
 *   `if (expected && digest !== expected)` —— 取不到时整个比对被跳过,
 *   只在快速滚动的进度框里印一行暗色提示,然后 chmod 0755 + rename。
 *   于是一个伪造不了证书的中间人,只要把 **checksums.txt 这一个请求**
 *   RST 掉或者回 404,就能把一次"已校验升级"变成未校验的 —— 而 README
 *   把这条写成硬规矩:「对不上一个字节都不写过去」。
 *
 *   没有逃生开关是有意的:这个升级器只认 GitHub release,而 CI 每次发布
 *   都生成 checksums.txt(见 .github/workflows/release.yml)。取不到本身
 *   就是信号。网络抖了的话,重跑一次 upgrade 的代价远小于装一个没验过的二进制。
 */
type ChecksumLookup = { ok: true; digest: string } | { ok: false; why: string }

async function fetchChecksum(tag: string, name: string): Promise<ChecksumLookup> {
  let text: string
  try {
    const response = await fetch(assetURL(tag, "checksums.txt"), { redirect: "follow" })
    if (!response.ok) return { ok: false, why: `checksums.txt returned HTTP ${response.status}` }
    text = await response.text()
  } catch (error) {
    return { ok: false, why: `could not fetch checksums.txt (${(error as Error).message})` }
  }
  for (const line of text.split("\n")) {
    // `<sha256>  <name>` —— sha256sum 的标准格式,两个空格
    const [digest, file] = line.trim().split(/\s+/)
    if (file === name && digest) return { ok: true, digest: digest.toLowerCase() }
  }
  return { ok: false, why: `checksums.txt has no entry for ${name}` }
}

/**
 * 上一次 upgrade 在 Windows 上留下的 `.old`。
 *
 * 留着是必要的(正在跑的那个进程还握着它),但**留一辈子就是垃圾**。
 * 下次启动时顺手清掉:那时候它已经不再被任何进程占着了。
 */
export function sweepParkedBinary(): void {
  if (process.platform !== "win32") return
  try {
    rmSync(`${process.execPath}.old`, { force: true })
  } catch {
    // 还占着就下次再说
  }
}

/** 给测试用:把一个文件原子地换成另一个 */
export function replaceFile(from: string, to: string): void {
  copyFileSync(from, `${to}.tmp`)
  renameSync(`${to}.tmp`, to)
}
