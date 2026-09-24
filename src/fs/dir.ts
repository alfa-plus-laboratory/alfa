/**
 * "Make sure this directory exists".
 *
 * ── Why not just mkdir(recursive: true) ──
 * By POSIX's account it is idempotent on an existing directory, and **on Windows it
 * isn't**. Seen by a user in a real run:
 *
 *   EEXIST: file already exists, mkdir 'C:\Users\river\Downloads'
 *
 * while that directory was plainly there. On current Windows, `Downloads`, `Documents`
 * and `Desktop` are often not ordinary directories but **reparse points** (OneDrive's
 * Known Folder Move, or the user moved it to another drive and left a junction in
 * place). After recursive mkdir hits EEXIST it has to decide "is the thing already
 * there a directory", and that step looks at the link itself rather than what it points
 * to — so it concludes "there's a non-directory here" and throws EEXIST.
 *
 * What it looks like: the write tool can't create a single file in the user's Downloads
 * directory, while the same code writes fine anywhere else, and `touch` works too — the
 * hardest kind of bug to track down.
 *
 * ── Two lines of defense ──
 * 1. If it's already there, **don't mkdir at all** (existsSync follows links; it's true
 *    on a junction).
 * 2. If EEXIST is thrown anyway, check once more that it's there, and if so treat it as
 *    success — concurrent creation of the same directory takes this path too. Only if
 *    it really isn't there is the error thrown.
 */
import { existsSync, mkdirSync } from "node:fs"
import { mkdir } from "node:fs/promises"

export interface EnsureDirOptions {
  /**
   * Permission bits for a new directory. An existing directory is **not changed** —
   * that's the user's directory, not ours
   */
  mode?: number
}

export async function ensureDir(dir: string, options: EnsureDirOptions = {}): Promise<void> {
  if (existsSync(dir)) return
  try {
    await mkdir(dir, { recursive: true, ...(options.mode === undefined ? {} : { mode: options.mode }) })
  } catch (error) {
    if (!settled(error, dir)) throw error
  }
}

export function ensureDirSync(dir: string, options: EnsureDirOptions = {}): void {
  if (existsSync(dir)) return
  try {
    mkdirSync(dir, { recursive: true, ...(options.mode === undefined ? {} : { mode: options.mode }) })
  } catch (error) {
    if (!settled(error, dir)) throw error
  }
}

/**
 * An error but the directory really is there = it's done (someone else created it first,
 * or the Windows pitfall above)
 */
function settled(error: unknown, dir: string): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return (code === "EEXIST" || code === "EPERM") && existsSync(dir)
}
