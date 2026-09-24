/**
 * `alfa uninstall` — wipe everything on this machine that belongs to alfa, **the binary
 * itself included**.
 *
 * ── Division of labor with `/reset` ──
 * `/reset` is "go through the first run again": delete config and data, keep the
 * program. This one is "I'm done with it": the same things, plus the file installed on
 * PATH. Before it existed, users who had cleared their data still had to go hunt for
 * where the binary was installed — and the `~/.local/bin` path is written only in the
 * install script.
 *
 * ── ★ Why only a terminal subcommand, no `/uninstall` ──
 * Not because "deleting yourself from inside a session is unseemly"; there are concrete
 * failures:
 *
 * 1. As the header of reset.ts records, deletion must happen after `store.close()` —
 *    SQLite does a WAL checkpoint when closing and writes it even though the database
 *    file was deleted, so the just-deleted sessions.db is lying right back where it
 *    was. Inside a session this ordering is delicate to begin with.
 * 2. Pile "and delete the program that's running right now" on top, and the process
 *    enters a state of carrying on against a self that no longer exists — while still
 *    holding the resolved model, the open database, the loaded registry.
 *
 * So there's only one entry point, and it's outside the session.
 *
 * ── Two steps, the same rule as /reset ──
 * `alfa uninstall` only **lists** what will be deleted; only `alfa uninstall confirm`
 * acts. Not a y/N: this is irreversible, and the list is the only chance for someone to
 * notice, before pressing the button, "wait, there's something in there I don't want
 * to lose".
 *
 * ── Three things deliberately not done ──
 * 1. **No scanning of the home directory** for scattered `.alfa/`. An uninstaller that
 *    walks your whole home deleting things is exactly the kind of thing that shouldn't
 *    exist. Print a find command and let a human look — the same stance as xdg.ts's
 *    "whoever wants to move it runs mv themselves; that's a command you can see".
 * 2. **PATH is not touched**. The install script never wrote anything into rc files
 *    (install.sh only prints a line for the user to add themselves), and `~/.local/bin`
 *    most likely holds other people's tools too.
 * 3. **No detached process spawned on Windows to delete ourselves**. It's true a
 *    running exe can't be deleted, but "leave a process in the background waiting to
 *    delete files" is the first shape a security review would circle. Rename to
 *    `.uninstalled` (not `.old` — that's upgrade's name, and it relies on "the next
 *    launch" to clean up; an uninstall has no next launch), then print the one
 *    remaining command for the user.
 */
import { existsSync, renameSync, rmSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { ALFA_DIR } from "../prompt/init.ts"
import { resetScope, type ResetTarget } from "./reset.ts"

export interface UninstallScope {
  targets: ResetTarget[]
  /** Directory holding the binary, for the "that PATH line can go now" message */
  binaryDir?: string
}

/**
 * When running from source, `process.execPath` is bun itself — deleting that means
 * deleting the user's bun
 */
export function runningFromSource(execPath: string = process.execPath): boolean {
  return /(^|[/\\])bun(\.exe)?$/.test(execPath)
}

/**
 * Work out what to delete. **Look only, touch nothing**.
 *
 * The binary goes last: the two entries above are "your stuff" (config, credentials,
 * sessions), it is "this program". What a human scanning this table should see first
 * is the former — a lost binary can be reinstalled, a lost auth.json can't.
 */
export function uninstallScope(root: string, execPath: string = process.execPath): UninstallScope {
  const scope = resetScope(root)
  const targets = [...scope.global, ...scope.project]

  if (runningFromSource(execPath)) return { targets }
  if (!existsSync(execPath)) return { targets }

  targets.push({
    path: execPath,
    what: "the alfa binary itself",
    bytes: sizeOfFile(execPath),
  })
  return { targets, binaryDir: dirname(execPath) }
}

export interface UninstallResult {
  removed: string[]
  failed: Array<{ path: string; why: string }>
  /**
   * The one that couldn't be deleted on Windows and could only be moved aside. When
   * set, it must be printed — an uninstaller with "one step left after it's done" that
   * doesn't mention that step hasn't uninstalled cleanly
   */
  parked?: string
}

/**
 * Actually delete.
 *
 * A single failure doesn't abort: exiting halfway through the deletes leaves the user
 * in a worse state than at the start, without knowing where it's worse. Whatever wasn't
 * deleted gets reported as-is; they can just rm it themselves.
 *
 * ★ The binary is deleted last. Everything before it is ordinary directories, which
 *   delete without surprises; deleting ourselves is bound to fail on Windows (the file
 *   is locked by our own process) and has to take the move-aside path. With the order
 *   reversed, an uninstall on Windows would get stuck moving the file, with **not
 *   one** of the config and credentials deleted.
 */
export function performUninstall(targets: ResetTarget[], execPath: string = process.execPath): UninstallResult {
  const removed: string[] = []
  const failed: Array<{ path: string; why: string }> = []
  let parked: string | undefined

  const isSelf = (path: string): boolean => path === execPath
  const ordered = [...targets.filter((one) => !isSelf(one.path)), ...targets.filter((one) => isSelf(one.path))]

  for (const target of ordered) {
    try {
      rmSync(target.path, { recursive: true, force: true })
      removed.push(target.path)
    } catch (error) {
      // On POSIX, deleting a running binary is **legal** (the process holds the inode,
      // not the path), so reaching this catch basically means Windows. Moving it aside
      // is the only thing that can be done there
      if (isSelf(target.path)) {
        const moved = `${target.path}.uninstalled`
        try {
          rmSync(moved, { force: true })
          renameSync(target.path, moved)
          parked = moved
          continue
        } catch {
          // Can't even move it; then just say so
        }
      }
      failed.push({ path: target.path, why: (error as Error).message })
    }
  }

  return { removed, failed, ...(parked ? { parked } : {}) }
}

/**
 * The command that finds `.alfa/` dirs scattered across repositories. We don't run it;
 * we only hand it to the user
 */
export function findProjectDirsCommand(home: string, platform: string = process.platform): string {
  if (platform === "win32") {
    return `Get-ChildItem -Path '${home}' -Recurse -Directory -Filter '${ALFA_DIR}' -ErrorAction SilentlyContinue`
  }
  return `find ${home} -type d -name '${ALFA_DIR}' -not -path '*/node_modules/*' 2>/dev/null`
}

/**
 * Size of a single file. Anything that can't be measured counts as 0 — the number is
 * only there to give a human a sense of scale
 */
function sizeOfFile(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
