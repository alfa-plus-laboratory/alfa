/**
 * Credential persistence.
 *
 * ── About the early "credentials never touch a file" constraint ──
 * The first version deliberately read only from environment variables, on the stated
 * grounds that "a key that can be written to a file will sooner or later get committed".
 * That wasn't accurate: the real risk is **writing the key into the project directory**,
 * not "any file". Storing it in the home directory, 0600, never visible from a project,
 * is standard practice for gh / aws / opencode.
 *
 * So what is kept here is the part of the original concern that actually holds, turned
 * into three hard rules:
 *
 * 1. **Only ever write an absolute path under the home directory**, never touch cwd. The
 *    file cannot appear inside a project, so it cannot be `git add`ed.
 * 2. **0600 from the moment of creation**, not create-then-chmod — that leaves a window
 *    where someone else can read it. The directory is 0700 too. If on read we find the
 *    permissions have been loosened, say so.
 * 3. **Secrets live in their own file.** config.json holds not a single byte of a secret,
 *    so it can safely be versioned, pasted to a colleague, or put in a dotfiles repo.
 *
 * Also: never print a full key, only the mask. There is no --show-key switch or the like.
 */
import { chmodSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { ensureDirSync } from "../fs/dir.ts"
import { dirname, join } from "node:path"
import { dataDir } from "../util/xdg.ts"

export interface Credential {
  apiKey: string
}

/** provider id → credential */
export type AuthStore = Record<string, Credential>

export function authPath(): string {
  return join(dataDir(), "auth.json")
}

export function loadAuth(path = authPath()): AuthStore {
  if (!existsSync(path)) return {}

  warnIfWorldReadable(path)

  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Don't silently treat a corrupt file as "no credentials" — then the user sees
    // "no credentials" and has no way to guess the file is broken.
    // No program name: this file sits below the cli layer and can't get the name the user
    // actually typed (see cli/program.ts), and hard-coding a name that may not exist is
    // worse than leaving it out
    throw new Error(`${path} is not valid JSON. Fix it, or delete it and log in again.`)
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}

  const out: AuthStore = {}
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue
    const apiKey = (value as Record<string, unknown>)["apiKey"]
    if (typeof apiKey === "string" && apiKey.length > 0) out[id] = { apiKey }
  }
  return out
}

export function saveAuth(store: AuthStore, path = authPath()): void {
  writeSecret(path, JSON.stringify(store, null, 2) + "\n")
}

export function setCredential(id: string, credential: Credential, path = authPath()): AuthStore {
  const store = loadAuth(path)
  store[id] = credential
  saveAuth(store, path)
  return store
}

export function removeCredential(id: string, path = authPath()): boolean {
  const store = loadAuth(path)
  if (!(id in store)) return false
  delete store[id]
  saveAuth(store, path)
  return true
}

// ─────────────────────────────────────────────── Writing to disk

/**
 * Atomic write + 0600 from creation.
 *
 * Write a temp file, then rename: if we crash midway the original file is still whole,
 * rather than leaving half a JSON that loses every credential at once. The mode goes
 * through writeFileSync's option rather than a chmod afterwards — change it afterwards
 * and the file is 0644 between creation and chmod, readable by other users on the same
 * machine.
 */
function writeSecret(path: string, contents: string): void {
  const dir = dirname(path)
  ensureDirSync(dir, { mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, contents, { mode: 0o600 })
    renameSync(tmp, path)
    // writeFileSync's mode only applies when it creates the file: a leftover tmp (an
    // earlier crash that got the same pid) keeps whatever mode it had, and the rename
    // carries that over. Set it explicitly once more
    chmodSync(path, 0o600)
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      // Failing to clean up the temp file doesn't affect the main flow
    }
    throw new Error(`Cannot write ${path}: ${(error as Error).message}`)
  }
}

function warnIfWorldReadable(path: string): void {
  let mode: number
  try {
    mode = statSync(path).mode
  } catch {
    return
  }
  if ((mode & 0o077) === 0) return
  process.stderr.write(
    `warning: ${path} is readable by other users (mode ${(mode & 0o777).toString(8)}). ` +
      `Fix with: chmod 600 ${path}\n`,
  )
}

// ─────────────────────────────────────────────── Display

/**
 * Key mask. First 6 and last 4, the middle elided.
 *
 * Both ends are kept so the user can recognize "which key is this" (the prefix tells
 * providers apart, the suffix tells several keys from the same provider apart), without
 * being enough to reconstruct the value. Anything too short is masked entirely — showing
 * both ends of a short key is showing all of it.
 */
export function maskKey(key: string): string {
  if (key.length < 16) return "*".repeat(Math.max(4, key.length))
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}
