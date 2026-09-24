/**
 * `/reset` — delete everything on this machine that belongs to alfa, back to the
 * freshly-installed state.
 *
 * ── It exists for "going through the first run again" ──
 * Onboarding, `auth login` and model discovery are only reachable when **there's
 * nothing at all**. Without this command, trying again means typing two rm -rf paths by
 * hand — and mistyping one letter in those paths is far more dangerous than this
 * command itself.
 *
 * ── Two-step confirmation, not one ──
 * The first step only **lists** what will be deleted: each directory, its size, what's
 * inside (that key, how many sessions). Only the second step acts. The reason is that
 * this is **irreversible**, and the list is the only chance for someone to notice,
 * before pressing the button, "wait, there's something in there I don't want to lose" —
 * a y/N prompt can't give that chance.
 *
 * ── Why exit after deleting ──
 * The process is holding an already-resolved model, an open sessions.db, a loaded
 * registry. With the files gone but these still around, the program enters a state that
 * "looks normal, but every step is actually operating on things that don't exist" — far
 * harder to track down than just exiting.
 *
 * ── ★ Deletion must happen after store.close() ──
 * SQLite does a WAL checkpoint when closing the database, and writes it even though the
 * database file was deleted — so the just-deleted sessions.db is lying right back where
 * it was, while the user thinks the reset was clean. So this module is only responsible
 * for "working out what to delete" and "deleting"; **when to delete is decided by
 * main.ts, after shutdown**.
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { ALFA_DIR } from "../prompt/init.ts"
import { configDir, dataDir } from "../util/xdg.ts"
import { t } from "../i18n/index.ts"

export interface ResetTarget {
  path: string
  /** A sentence for humans: what's in here */
  what: string
  /** How many bytes it takes. Directories are summed recursively */
  bytes: number
  /** Whether it holds an API key. If so, the confirmation screen calls it out separately */
  hasCredentials?: boolean
}

export interface ResetScope {
  /** Global: config directory + data directory */
  global: ResetTarget[]
  /** The project's .alfa/ (notes, scaffolding). Only `/reset all` touches it */
  project: ResetTarget[]
}

/**
 * Work out what to delete. **Look only, touch nothing**.
 *
 * Directories that don't exist aren't listed: a list saying "(doesn't exist)" would
 * drown out the two lines that are actually going to be deleted.
 */
export function resetScope(root: string): ResetScope {
  const config = configDir()
  const data = dataDir()
  const project = join(root, ALFA_DIR)

  const global: ResetTarget[] = []
  if (existsSync(config)) {
    global.push({ path: config, what: t.resetConfigWhat, bytes: sizeOf(config) })
  }
  if (existsSync(data)) {
    global.push({
      path: data,
      what: t.resetDataWhat,
      bytes: sizeOf(data),
      hasCredentials: existsSync(join(data, "auth.json")),
    })
  }

  const inProject: ResetTarget[] = []
  if (existsSync(project)) {
    inProject.push({ path: project, what: t.resetProjectWhat, bytes: sizeOf(project) })
  }
  return { global, project: inProject }
}

/**
 * Actually delete. Returns which ones were removed.
 *
 * A single failure doesn't abort: deleting halfway and then erroring out leaves the user
 * in a worse state than at the start, without knowing where it's worse. Whatever wasn't
 * deleted gets reported as-is; they can just rm it themselves.
 */
export function performReset(targets: ResetTarget[]): { removed: string[]; failed: Array<{ path: string; why: string }> } {
  const removed: string[] = []
  const failed: Array<{ path: string; why: string }> = []
  for (const target of targets) {
    try {
      rmSync(target.path, { recursive: true, force: true })
      removed.push(target.path)
    } catch (error) {
      failed.push({ path: target.path, why: (error as Error).message })
    }
  }
  return { removed, failed }
}

/**
 * Recursive sum. Anything that can't be measured counts as 0 — the number is only there
 * to give a human a sense of scale
 */
function sizeOf(path: string): number {
  try {
    const stat = statSync(path)
    if (!stat.isDirectory()) return stat.size
    let total = 0
    for (const name of readdirSync(path)) total += sizeOf(join(path, name))
    return total
  } catch {
    return 0
  }
}
