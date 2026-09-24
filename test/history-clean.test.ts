/**
 * `/history-clean`: deleting old sessions sitting on this machine.
 *
 * Everything here watches the "deleted too much" side — deleting too little just means
 * running it again next time; deleting too much has no second chance:
 *   - deleting the session the user is standing in (cleaning up right after resuming an
 *     old session)
 *   - deleting the sessions of subagents still running → when the loop rereads history on
 *     its next turn, that session is empty
 *   - deleting only the session row and leaving messages and parts in the DB → the DB not
 *     only doesn't shrink, it gains a pile of unreachable rows
 *   - deleting only half of a conversation → the half-history still gets read into the
 *     model, which is far worse than deleting the whole session
 */
import { describe, expect, test } from "bun:test"
import { Store } from "../src/session/store.ts"

const DAY = 86_400_000
/** A fixed "now". Assertions must not follow the clock */
const NOW = 1_700_000_000_000

/**
 * Creates a session that has messages. Times are fixed values — age is the criterion for
 * this entire file
 */
function seed(store: Store, id: string, options: { at: number; directory?: string; parent?: string; messages?: number }): void {
  store.createSession(id, options.directory ?? "/repo", options.parent)
  for (let index = 0; index < (options.messages ?? 1); index++) {
    const messageID = `${id}-m${index}`
    store.upsertMessage({ id: messageID, sessionID: id, role: "user", timeCreated: options.at + index })
    store.upsertPart({
      id: `${id}-p${index}`,
      sessionID: id,
      messageID,
      timeCreated: options.at + index,
      type: "text",
      text: "hello",
    })
  }
  raw(store).query(`UPDATE session SET time_updated = $at WHERE id = $id`).run({ at: options.at, id })
}

/**
 * Store has no (and shouldn't have a) public API for turning the clock or counting rows,
 * so the assertions ask the DB directly
 */
function raw(store: Store): {
  query(sql: string): { run(args?: unknown): void; all(args?: unknown): unknown[] }
} {
  return (store as unknown as { db: ReturnType<typeof raw> }).db
}

function count(store: Store, table: string): number {
  const rows = raw(store).query(`SELECT COUNT(*) AS n FROM ${table}`).all() as Array<{ n: number }>
  return rows[0]?.n ?? 0
}

/** The one-week-ago cutoff */
const WEEK_AGO = NOW - 7 * DAY

describe("Computing what to delete", () => {
  test("old sessions go on the list, new ones don't", () => {
    const store = new Store(":memory:")
    seed(store, "old", { at: NOW - 30 * DAY })
    seed(store, "fresh", { at: NOW - 1 * DAY })
    const sweep = store.staleHistory(WEEK_AGO)
    expect(sweep.ids).toEqual(["old"])
    expect(sweep.sessions).toBe(1)
  })

  test("★ the current session is kept however old — after resuming a three-week-old session, cleanup must not pull the ground from under it", () => {
    const store = new Store(":memory:")
    seed(store, "current", { at: NOW - 21 * DAY })
    seed(store, "other", { at: NOW - 21 * DAY })
    const sweep = store.staleHistory(WEEK_AGO, ["current"])
    expect(sweep.ids).toEqual(["other"])
  })

  test("★ subagents spawned by the current session stay too — they may still be running, and that session is their memory", () => {
    const store = new Store(":memory:")
    seed(store, "current", { at: NOW - 21 * DAY })
    // the subagent's session is three weeks old too, well past the cutoff, but age isn't
    // the criterion here — if the parent stays, it stays
    seed(store, "scout", { at: NOW - 21 * DAY, parent: "current" })
    const sweep = store.staleHistory(WEEK_AGO, ["current"])
    expect(sweep.ids).toEqual([])
  })

  test("★ sessions spawned by an old conversation go with their parent — without it nobody can reach them", () => {
    const store = new Store(":memory:")
    seed(store, "old", { at: NOW - 30 * DAY })
    // the child is a day newer than its parent (it was the last thing that conversation
    // did), and its own age isn't what's judged: once the parent is on the list it has to
    // go along
    seed(store, "old-scout", { at: NOW - 29 * DAY, parent: "old" })
    const sweep = store.staleHistory(WEEK_AGO)
    expect(sweep.ids.toSorted()).toEqual(["old", "old-scout"])
    expect(sweep.sessions).toBe(1)
    expect(sweep.agents).toBe(1)
  })

  test("★ while the parent stays the child always stays — otherwise the main loop rereads a reference to nothing", () => {
    const store = new Store(":memory:")
    seed(store, "fresh", { at: NOW - 1 * DAY })
    seed(store, "fresh-scout", { at: NOW - 30 * DAY, parent: "fresh" })
    expect(store.staleHistory(WEEK_AGO).ids).toEqual([])
  })

  test("orphans whose parent is long gone are judged by their own age", () => {
    const store = new Store(":memory:")
    seed(store, "orphan", { at: NOW - 30 * DAY, parent: "long-gone" })
    seed(store, "young-orphan", { at: NOW - 1 * DAY, parent: "long-gone" })
    expect(store.staleHistory(WEEK_AGO).ids).toEqual(["orphan"])
  })

  test("conversations and subagent sessions are counted separately — one merged number would look like a miscount", () => {
    const store = new Store(":memory:")
    seed(store, "old", { at: NOW - 30 * DAY, messages: 3 })
    seed(store, "old-a", { at: NOW - 30 * DAY, parent: "old", messages: 5 })
    seed(store, "old-b", { at: NOW - 30 * DAY, parent: "old", messages: 4 })
    const sweep = store.staleHistory(WEEK_AGO)
    expect(sweep.sessions).toBe(1)
    expect(sweep.agents).toBe(2)
    expect(sweep.messages).toBe(12)
  })

  test("grouped by directory, most sessions first", () => {
    const store = new Store(":memory:")
    seed(store, "a1", { at: NOW - 30 * DAY, directory: "/one" })
    seed(store, "b1", { at: NOW - 30 * DAY, directory: "/two" })
    seed(store, "b2", { at: NOW - 30 * DAY, directory: "/two" })
    expect(store.staleHistory(WEEK_AGO).directories).toEqual([
      { directory: "/two", sessions: 2 },
      { directory: "/one", sessions: 1 },
    ])
  })

  test("oldest/newest look at conversations only, not subagent sessions — those dates help people place the year", () => {
    const store = new Store(":memory:")
    seed(store, "older", { at: NOW - 30 * DAY })
    seed(store, "newer", { at: NOW - 10 * DAY })
    // both go on the list with their parents, and each lies outside the conversations'
    // range — counting them would stretch it to 40 days ago … yesterday
    seed(store, "older-scout", { at: NOW - 40 * DAY, parent: "older" })
    seed(store, "newer-scout", { at: NOW - 1 * DAY, parent: "newer" })
    const sweep = store.staleHistory(WEEK_AGO)
    expect(sweep.agents).toBe(2)
    expect(sweep.oldest).toBe(NOW - 30 * DAY)
    expect(sweep.newest).toBe(NOW - 10 * DAY)
  })

  test("when nothing has expired the list is empty and has no dates", () => {
    const store = new Store(":memory:")
    seed(store, "fresh", { at: NOW - 1 * DAY })
    const sweep = store.staleHistory(WEEK_AGO)
    expect(sweep.ids).toEqual([])
    expect(sweep.oldest).toBeUndefined()
    expect(sweep.messages).toBe(0)
  })

  test("★ computes without deleting — this step is a list for people to review; the DB must not change", () => {
    const store = new Store(":memory:")
    seed(store, "old", { at: NOW - 30 * DAY })
    store.staleHistory(WEEK_AGO)
    expect(count(store, "session")).toBe(1)
    expect(store.getSession("old")).toBeDefined()
  })
})

describe("Actually deleting", () => {
  test("★ messages and parts go too — deleting only session rows leaves a pile of unreachable rows instead of a smaller DB", () => {
    const store = new Store(":memory:")
    seed(store, "old", { at: NOW - 30 * DAY, messages: 3 })
    seed(store, "fresh", { at: NOW - 1 * DAY, messages: 2 })
    const sweep = store.staleHistory(WEEK_AGO)
    expect(store.deleteSessions(sweep.ids)).toBe(1)
    expect(count(store, "session")).toBe(1)
    expect(count(store, "message")).toBe(2)
    expect(count(store, "part")).toBe(2)
    expect(store.listAll("fresh")).toHaveLength(2)
  })

  test("once deleted it no longer shows in /resume", () => {
    const store = new Store(":memory:")
    seed(store, "old", { at: NOW - 30 * DAY })
    seed(store, "fresh", { at: NOW - 1 * DAY })
    store.deleteSessions(store.staleHistory(WEEK_AGO).ids)
    expect(store.listSessions().map((session) => session.id)).toEqual(["fresh"])
  })

  test("an empty list does nothing", () => {
    const store = new Store(":memory:")
    seed(store, "fresh", { at: NOW - 1 * DAY })
    expect(store.deleteSessions([])).toBe(0)
    expect(count(store, "session")).toBe(1)
  })

  test("★ deleting hundreds of sessions at once doesn't blow up — SQLite caps the variable count, so it batches", () => {
    const store = new Store(":memory:")
    for (let index = 0; index < 450; index++) {
      seed(store, `old-${index}`, { at: NOW - 30 * DAY })
    }
    seed(store, "current", { at: NOW - 30 * DAY })
    const sweep = store.staleHistory(WEEK_AGO, ["current"])
    expect(sweep.ids).toHaveLength(450)
    expect(store.deleteSessions(sweep.ids)).toBe(450)
    expect(count(store, "session")).toBe(1)
  })

  test("VACUUM runs — without it the DB file wouldn't shrink by a single byte", () => {
    const store = new Store(":memory:")
    seed(store, "old", { at: NOW - 30 * DAY })
    store.deleteSessions(["old"])
    expect(store.vacuum()).toBeUndefined()
  })
})
