/**
 * The "a new version is out" notice at startup.
 *
 * ── Three self-imposed constraints ──
 *
 * 1. **Never slow down startup.** The check runs in the background and the banner
 *    doesn't wait for it. By the time it comes back the banner is long drawn, so that
 *    line is a receipt **appended afterwards**, not part of the banner. A feature that
 *    makes every startup two seconds slower just to deliver good news has negative net
 *    value.
 *
 * 2. **Ask at most once a day.** The result is cached in the data directory. Someone
 *    opening a terminal twenty times a day would get the same sentence for twenty
 *    network requests.
 *
 * 3. **Tell, don't install.** Auto-update means "is the program I'm using today still
 *    the one I used yesterday" has no answer, and this is a tool that touches the
 *    user's files. When to switch is up to the user typing `alfa upgrade`.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { dataDir } from "../util/xdg.ts"
import { isNewer, latestRelease, VERSION } from "./release.ts"

const CACHE_FILE = "update-check.json"
/** Minimum time between two checks */
const INTERVAL_MS = 24 * 60 * 60 * 1000

interface Cache {
  /** When we last asked */
  at: number
  /** The version we got last time */
  version: string
}

/**
 * Ask once (or use the cached answer). Returns the version if there is an update,
 * otherwise undefined.
 *
 * @param now for injection, pinned in tests
 */
export async function checkForUpdate(options: { now?: number; force?: boolean } = {}): Promise<string | undefined> {
  const now = options.now ?? Date.now()
  const path = join(dataDir(), CACHE_FILE)
  const cached = read(path)

  if (!options.force && cached && now - cached.at < INTERVAL_MS) {
    return isNewer(cached.version, VERSION) ? cached.version : undefined
  }

  const latest = await latestRelease()
  // If we can't get an answer, **update the timestamp anyway**: banging on the network at
  // every startup while it's down just adds delay to an already bad situation (offline)
  write(path, { at: now, version: latest?.version ?? cached?.version ?? VERSION })
  if (!latest) return undefined
  return isNewer(latest.version, VERSION) ? latest.version : undefined
}

function read(path: string): Cache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Cache>
    if (typeof parsed.at !== "number" || typeof parsed.version !== "string") return undefined
    return { at: parsed.at, version: parsed.version }
  } catch {
    return undefined
  }
}

function write(path: string, cache: Cache): void {
  try {
    writeFileSync(path, JSON.stringify(cache))
  } catch {
    // Can't write it (read-only home directory, full disk) — then we just ask every
    // time; not worth an error
  }
}
