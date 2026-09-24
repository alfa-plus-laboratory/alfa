/**
 * `alfa upgrade` — replace ourselves with the latest binary.
 *
 * ── The only code in the whole program that "changes itself", hence three hard rules ──
 *
 * 1. **Verify before replacing.** After downloading, compute the sha256 and check it
 *    against checksums.txt; if even one byte doesn't match, nothing is written over. A
 *    truncated download (network dropped midway, disk full) written straight over the
 *    old one means the next time the user types alfa they get "cannot execute binary
 *    file", and they no longer have a working alfa to fix it with.
 *
 * 2. **Atomic replacement.** Write to a temp file in the same directory first, then
 *    rename it over. rename is atomic within one filesystem — a power cut midway leaves
 *    either the old one or the new one, never half of one. Writing to /tmp and then mv
 *    won't do: mv across filesystems is "copy + delete", and a copy cut off halfway is
 *    half a file.
 *
 * 3. **Refuse when running from source.** Under `bun run src/cli/main.ts`,
 *    process.execPath is bun itself — writing over it would replace the user's bun
 *    with alfa. That mistake can't be undone, so better to do nothing at all.
 *
 * ── Two entry points, one piece of code ──
 * `alfa upgrade` and the in-session `/upgrade` (see cli/main.ts) both go through this
 * function. What gets replaced is the file on disk; **the running process stays the old
 * one** — on POSIX it holds the inode, so the session can carry on to the end
 * unaffected, but running the new one takes a restart. Saying so is the displaying
 * side's job (only it knows whether the user is in a terminal or in a session).
 */
import { chmodSync, copyFileSync, createWriteStream, renameSync, rmSync, statSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { assetName, assetURL, currentPlatform, latestRelease, VERSION, isNewer } from "./release.ts"

/** Minimum time between two progress reports */
const PROGRESS_INTERVAL_MS = 120

export type UpgradeOutcome =
  | { status: "current"; version: string }
  | { status: "updated"; from: string; to: string; path: string }
  | {
      status: "blocked"
      why: string
      /**
       * The machine-readable category. **Only for "couldn't reach it at all"**.
       *
       * The UI has to say this in the user's language (see upgradeUnreachable in
       * i18n), while why is an English sentence. Recognizing it by string matching is
       * the most brittle way to do it — change one word and it silently stops working
       */
      reason?: "unreachable"
    }
  /**
   * The user stopped it themselves with esc.
   *
   * Kept apart from blocked: that one is "something went wrong", this one is "I'm not
   * downloading after all" — reported as a failure, the user would go hunting for an
   * error that doesn't exist. And this path has to exist: if a download stuck at 3%
   * can't be cancelled, that exclusive overlay becomes a room the user can't get out of
   */
  | { status: "cancelled" }

/**
 * Progress events. **Deliberately not a ready-made line of text.**
 *
 * This module shouldn't own wording the user sees: the same upgrade can happen via
 * `alfa upgrade` (when the UI language hasn't been resolved yet, so everything is
 * English) or via the in-session `/upgrade` (when the user may well have a Chinese or
 * Japanese UI open). Emitting events and letting the displaying side translate is the
 * only way the two paths don't end up one in Chinese and one in English (see
 * upgradeLine in cli/main.ts).
 */
export type UpgradeEvent =
  | { phase: "checking" }
  | { phase: "downloading"; tag: string; asset: string }
  /**
   * Download progress. **This one is the point of the feature**: ninety-odd MB takes
   * minutes on a slow network, and before this the UI only had a "downloading …" line —
   * unless the user stared at it they couldn't tell it was moving, let alone how long
   * it had left. total may be missing (the server sends no Content-Length), in which
   * case all we can report is how much has arrived
   */
  | { phase: "progress"; received: number; total?: number }
  | { phase: "verifying" }
  /** Verified, now doing the atomic replacement. This step is quick, but it is the only
   *  one that is "changing files on your machine" */
  | { phase: "installing" }

export interface UpgradeOptions {
  /** Install anyway, even if the version number already looks current */
  force?: boolean
  /** Step-by-step progress. Whoever displays it translates it */
  onProgress?: (event: UpgradeEvent) => void
  /** Give up midway. The overlay in the UI exits through this (see cancelled in
   *  UpgradeOutcome) */
  signal?: AbortSignal
}

export async function upgrade(options: UpgradeOptions = {}): Promise<UpgradeOutcome> {
  const say = options.onProgress ?? (() => {})
  const signal = options.signal
  const cancelled = (): boolean => signal?.aborted === true

  const self = process.execPath
  // A single-file binary's execPath is itself; when bun runs the source it is bun. If
  // the name is bun, hands off
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
    // ★ Get the digest first, then download the ninety-odd MB. If we can't get it, stop
    //   here — there is no "then skip verification" path; see fetchChecksum's header
    //   comment for why
    const expected = await fetchChecksum(latest.tag, name)
    if (!expected.ok) return { status: "blocked", why: expected.why, reason: "unreachable" }
    const digest = await download(assetURL(latest.tag, name), target, say, signal)
    if (cancelled()) return { status: "cancelled" }
    say({ phase: "verifying" })
    if (digest !== expected.digest) {
      // Failed verification: treat it as never downloaded. **Never** "maybe install it
      // anyway and see" — that puts a known-corrupt file in the one place the user
      // can't do without
      return {
        status: "blocked",
        why: `checksum mismatch — expected ${expected.digest.slice(0, 12)}…, got ${digest.slice(0, 12)}…`,
      }
    }

    say({ phase: "installing" })
    chmodSync(target, 0o755)
    // ★ On Windows a running executable can't be overwritten, so move ourselves out of
    //   the way first (that .old stays where it is and is cleared on the next upgrade).
    //   On POSIX just rename — the running process holds the inode, not the path, so
    //   swapping the file under that path has no effect on it at all
    if (process.platform === "win32") {
      const parked = `${self}.old`
      try {
        rmSync(parked, { force: true })
      } catch {
        // Most likely the one left last time is still held (an older alfa running). Let the
        // rename below decide: if that path is still taken it throws, and the upgrade
        // reports blocked with nothing replaced
      }
      renameSync(self, parked)
      try {
        renameSync(target, self)
      } catch (error) {
        // Swap it back; don't leave the user without even one that runs
        renameSync(parked, self)
        throw error
      }
    } else {
      renameSync(target, self)
    }
    return { status: "updated", from: VERSION, to: latest.version, path: self }
  } catch (error) {
    // An abort throws AbortError, which is not a failure — the user pressed it
    if (cancelled()) return { status: "cancelled" }
    return { status: "blocked", why: (error as Error).message }
  } finally {
    try {
      unlinkSync(target)
    } catch {
      // On the success path it has already been renamed away; absent is normal
    }
  }
}

/**
 * Download to disk, computing the sha256 along the way.
 *
 * Hash while downloading rather than reading it into memory first: the binary is 90-odd
 * MB, and this process is also holding a whole session's context at the same time.
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
  // Progress is **throttled by time**, not bytes: a 90MB download has tens of thousands
  // of chunks, and reporting each one to the UI would make drawing the progress bar the
  // bottleneck. 120ms is a bit longer than a frame and looks continuous to the eye
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
    // The last report must always be the full amount: throttling swallows the tail end
    // and the bar would stop at 97%
    say(total !== undefined && Number.isFinite(total) ? { phase: "progress", received, total } : { phase: "progress", received })
  } finally {
    await new Promise<void>((resolve, reject) => file.end((error?: Error) => (error ? reject(error) : resolve())))
  }
  // Downloaded 0 bytes: most likely blocked by a proxy or a full disk, and after chmod +x
  // it looks no different from a normal file
  if (statSync(target).size === 0) throw new Error("downloaded file is empty")
  return hasher.digest("hex")
}

/**
 * Get the line for this file from this release's checksums.txt.
 *
 * ★ If it can't be had, it **can't be had** — no degrading to "then skip verification".
 *
 *   This used to be `Promise<string | undefined>`, and the caller was written as
 *   `if (expected && digest !== expected)` — when it couldn't be fetched the whole
 *   comparison was skipped, with only a dim hint printed in the fast-scrolling progress
 *   box, followed by chmod 0755 + rename. So a man-in-the-middle unable to forge a
 *   certificate only had to RST or 404 **that single checksums.txt request** to turn a
 *   "verified upgrade" into an unverified one — while rule 1 in this file's header says
 *   "if even one byte doesn't match, nothing is written over".
 *
 *   Having no escape hatch is deliberate: this upgrader only trusts GitHub releases,
 *   and CI generates checksums.txt for every release (see
 *   .github/workflows/release.yml). Failing to get it is itself a signal. If the
 *   network hiccuped, rerunning upgrade costs far less than installing an unverified
 *   binary.
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
    // `<sha256>  <name>` — sha256sum's standard format, two spaces
    const [digest, file] = line.trim().split(/\s+/)
    if (file === name && digest) return { ok: true, digest: digest.toLowerCase() }
  }
  return { ok: false, why: `checksums.txt has no entry for ${name}` }
}

/**
 * The `.old` left behind on Windows by the previous upgrade.
 *
 * Keeping it is necessary (the running process still holds it), but **kept forever it's
 * garbage**. Clear it in passing at the next startup: by then no process holds it any
 * more.
 */
export function sweepParkedBinary(): void {
  if (process.platform !== "win32") return
  try {
    rmSync(`${process.execPath}.old`, { force: true })
  } catch {
    // Still held; try again next time
  }
}

/** For tests: atomically replace one file with another */
export function replaceFile(from: string, to: string): void {
  copyFileSync(from, `${to}.tmp`)
  renameSync(`${to}.tmp`, to)
}
