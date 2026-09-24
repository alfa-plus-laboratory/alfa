/**
 * Persisting "don't ask again".
 *
 * ── Why the first version deliberately didn't persist, and why it does now ──
 * The reason for not persisting was "forgetting on process exit is safer". Six months
 * in, the real effect of that was: in the same repo, `npm test` had to be re-approved
 * every day, and **after pressing the same y ten times a day, people stop reading the
 * box**. A confirmation box that has been trained into a reflex is far more dangerous
 * than a rule that is remembered.
 *
 * So it persists, but the cost is bought back with three things:
 *   ① Stored per workspace — paths in rules are **relative to the workspace** (see
 *      narrowAlways); mixed together, a `src/*` approved in repo A would take effect
 *      in repo B, and the two src dirs have nothing to do with each other
 *   ② Only allows are stored — the file has no action field, so hand-editing it can
 *      never produce a deny, nor turn an ask into anything else
 *   ③ Visible and deletable — `/permission` lists them, `/permission forget` clears
 *      them. A stored security decision that can't be looked up or revoked is worse
 *      than not storing it at all
 *
 * ── Why dataDir and not configDir ──
 * config.json is the kind of thing that "can go into a dotfiles repo, can be pasted to a
 * colleague" (see config.ts). This file isn't: it is this machine's history of decisions
 * about these particular directories, and carrying it around with you would only end up
 * allowing, on someone else's machine, commands they never looked at.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { ensureDirSync } from "../fs/dir.ts"
import { dirname, join } from "node:path"
import { dataDir } from "../util/xdg.ts"
import type { Rule, Ruleset } from "./rules.ts"

/** One stored allow. action is always allow, so it isn't in the file — see header ②. */
export interface ApprovalRecord {
  permission: string
  pattern: string
  /** When it was approved. Used to show "3 days ago" in the list */
  time: number
}

/**
 * At most this many per workspace. Past that, the oldest go — once it's too old to
 * remember why it was approved, it should be asked again
 */
const MAX_PER_WORKSPACE = 200
/** How many workspaces in total. Past that, drop the one untouched the longest */
const MAX_WORKSPACES = 64

export function approvalsPath(): string {
  return join(dataDir(), "approvals.json")
}

/**
 * Read the allows stored for this workspace.
 *
 * A broken / unreadable file always yields empty: losing a few allows costs a few more
 * presses of y, whereas blowing up at startup over a cache file is wildly out of
 * proportion.
 */
export function loadApprovals(root: string, path = approvalsPath()): ApprovalRecord[] {
  const all = readFile(path)
  const list = all[root]
  if (!Array.isArray(list)) return []
  return list.filter(isUsable).slice(-MAX_PER_WORKSPACE)
}

/**
 * Append a few and persist. **Never throws on failure** — what the user pressed was
 * "don't ask again", not "write a file". When the data directory is read-only (a
 * read-only volume mount is common in containers), this one is still allowed as usual;
 * it will just be asked again next time.
 */
export function rememberApprovals(root: string, rules: Ruleset, path = approvalsPath()): void {
  const fresh = rules
    .filter((rule) => rule.action === "allow")
    .map((rule): ApprovalRecord => ({ permission: rule.permission, pattern: rule.pattern, time: Date.now() }))
    .filter(isUsable)
  if (fresh.length === 0) return

  try {
    const all = readFile(path)
    const kept = (all[root] ?? []).filter(isUsable).filter((old) => !fresh.some((one) => same(one, old)))
    all[root] = [...kept, ...fresh].slice(-MAX_PER_WORKSPACE)
    writeFile(path, evict(all))
  } catch {
    // See above: failing to remember beats interrupting what's in progress
  }
}

/** Clear every allow for this workspace; returns how many were cleared. */
export function forgetApprovals(root: string, path = approvalsPath()): number {
  try {
    const all = readFile(path)
    const count = (all[root] ?? []).filter(isUsable).length
    if (count === 0) return 0
    delete all[root]
    writeFile(path, all)
    return count
  } catch {
    return 0
  }
}

/** Stored records → rules the gate understands. action is added here, always allow. */
export function toRuleset(records: readonly ApprovalRecord[]): Ruleset {
  return records.map((record): Rule => ({ permission: record.permission, pattern: record.pattern, action: "allow" }))
}

// ───────────────────────────────────────────── private

type Stored = Record<string, ApprovalRecord[]>

/**
 * Whether a record is usable.
 *
 * `permission: "*"` is always dropped: this program can't possibly have written it
 * itself (permission always comes from the id of some real tool), so its presence means
 * a hand edit — and that one entry would allow **every tool added in the future** along
 * with the rest, including ones the user has never seen.
 */
function isUsable(record: unknown): record is ApprovalRecord {
  if (!record || typeof record !== "object") return false
  const value = record as Record<string, unknown>
  if (typeof value["permission"] !== "string" || value["permission"].length === 0) return false
  if (value["permission"] === "*") return false
  if (typeof value["pattern"] !== "string" || value["pattern"].length === 0) return false
  if (typeof value["time"] !== "number" || !Number.isFinite(value["time"])) return false
  return true
}

function same(a: ApprovalRecord, b: ApprovalRecord): boolean {
  return a.permission === b.permission && a.pattern === b.pattern
}

function readFile(path: string): Stored {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const workspaces = (parsed as Record<string, unknown>)["workspaces"]
    if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) return {}
    return workspaces as Stored
  } catch {
    return {}
  }
}

function writeFile(path: string, workspaces: Stored): void {
  ensureDirSync(dirname(path))
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify({ version: 1, workspaces }, null, 2) + "\n")
  renameSync(tmp, path)
}

/**
 * Too many workspaces: drop the ones untouched the longest — a deleted repo shouldn't
 * hold a slot forever.
 */
function evict(all: Stored): Stored {
  const roots = Object.keys(all)
  if (roots.length <= MAX_WORKSPACES) return all
  const newest = (root: string) => (all[root] ?? []).reduce((max, one) => Math.max(max, one.time), 0)
  const kept = roots.sort((a, b) => newest(b) - newest(a)).slice(0, MAX_WORKSPACES)
  const out: Stored = {}
  for (const root of kept) out[root] = all[root] ?? []
  return out
}
