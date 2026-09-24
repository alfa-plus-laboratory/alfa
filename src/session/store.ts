/**
 * Session persistence. Raw SQL on bun:sqlite, no ORM.
 *
 * Why storage from the very first version (rather than an in-memory array):
 * the main loop's correctness depends on the constraint "re-read the full history from
 * storage every turn" — only then do compaction, interrupt cleanup and external rewrites
 * of history take effect immediately, and only then is the loop itself idempotent and
 * recoverable. An in-memory array would run too, but that amounts to turning "storage is
 * the single source of truth" into "memory is the source of truth", and adding
 * persistence later would mean rewriting the loop.
 *
 * ⚠ Timing convention: every write must complete within the same tick; the main loop
 *   only reads at turn boundaries.
 *
 *   This assumption was originally annotated "will break once concurrent tool calls or
 *   background jobs are added". Background jobs now really exist (subagents, see
 *   agent/subagent.ts): they write to the same database **at the same time** as the main
 *   loop. Explicit transactions are still unnecessary, because each session has only one
 *   writer — a subagent writes its own session, the main loop writes the user's, and the
 *   two are kept apart by session_id. SQLite itself (WAL + busy_timeout) takes care of
 *   serializing concurrent writes.
 *
 *   What really needs care is **two writers on the same session**: the day we build
 *   something like "two agents relaying the same conversation", this comment has to be
 *   worked out again.
 */
import { Database } from "bun:sqlite"

import { ensureDirSync } from "../fs/dir.ts"
import { join } from "node:path"
import { dataDir } from "../util/xdg.ts"
import { MessageSchema, PartSchema, type Message, type MessageWithParts, type Part } from "./schema.ts"

const DDL = `
CREATE TABLE IF NOT EXISTS session (
  id            TEXT PRIMARY KEY,
  title         TEXT    NOT NULL DEFAULT '',
  directory     TEXT    NOT NULL,
  time_created  INTEGER NOT NULL,
  time_updated  INTEGER NOT NULL,
  -- Parent session of subagent runs (see agent/subagent.ts). They are still stored in
  -- full (the main loop re-reads history from here every turn), but they **don't count
  -- as "sessions you can resume"**: the user wants to pick up their own session, not a
  -- small job sent out ten minutes ago to count three files. So listing filters on this
  parent_id     TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS session_updated_idx ON session(time_updated DESC);

CREATE TABLE IF NOT EXISTS message (
  id             TEXT PRIMARY KEY,
  session_id     TEXT    NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  role           TEXT    NOT NULL CHECK (role IN ('user','assistant')),
  parent_id      TEXT,
  finish         TEXT,
  time_created   INTEGER NOT NULL,
  time_completed INTEGER,
  data           TEXT    NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS message_session_idx ON message(session_id, time_created, id);

CREATE TABLE IF NOT EXISTS part (
  id           TEXT    PRIMARY KEY,
  message_id   TEXT    NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  session_id   TEXT    NOT NULL,
  type         TEXT    NOT NULL,
  tool_call_id TEXT,
  tool_name    TEXT,
  tool_status  TEXT,
  time_created INTEGER NOT NULL,
  data         TEXT    NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS part_message_idx ON part(message_id, time_created, id);
CREATE INDEX IF NOT EXISTS part_session_idx ON part(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS part_toolcall_idx
  ON part(message_id, tool_call_id) WHERE tool_call_id IS NOT NULL;
`

/**
 * The public face of a session. The picker and `--continue` only look at these fields and
 * never touch the messages themselves.
 */
export interface SessionInfo {
  id: string
  title: string
  /** The working directory at the time */
  directory: string
  timeCreated: number
  timeUpdated: number
  /** Message count. Answers "how long did this session go on" */
  messages: number
  /** The user's first message. How the session is recognized */
  preview: string
}

/**
 * What one cleanup would remove. **Only a list** — whoever computes it does not delete;
 * see staleHistory().
 *
 * Split into two counts, "conversations" and "subagent sessions", because to the user
 * they are not the same kind of thing at all: the former are ones they chatted in
 * themselves, the latter grew by themselves in the background after the user pressed
 * Enter once. Merge them into one number, "47 sessions to delete", and someone who has
 * only chatted ten times will think the program miscounted.
 */
export interface HistorySweep {
  /** Every session id to delete (conversations + the subagent sessions they dispatched) */
  ids: string[]
  /** How many of them the user opened themselves */
  sessions: number
  /** How many of them are subagent sessions */
  agents: number
  messages: number
  /**
   * Which directories are involved, with a session count each. Sorted by count, descending
   * — the first thing someone cleaning up looks for is "which project is taking it up"
   */
  directories: Array<{ directory: string; sessions: number }>
  /** When the oldest/newest one was last active. Absent for an empty list */
  oldest?: number
  newest?: number
}

export class Store {
  private db: Database
  /**
   * Where the database file is. After cleanup we report "how much was freed" — which can
   * only come from stat-ing this file
   */
  readonly file: string

  constructor(path?: string) {
    const file = path ?? defaultDbPath()
    this.file = file
    if (file !== ":memory:") ensureDirSync(dataDir())
    this.db = new Database(file, { create: true, strict: true })
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = NORMAL")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.db.exec(DDL)
    this.migrate()
  }

  /**
   * Add columns.
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing to a table that **already exists** — an old
   * database does not grow a column just because the DDL gained one. So every added
   * column needs a matching ALTER here, decided by "skip if it can be found", not by
   * swallowing exceptions with try/catch: swallow them and a real disk error is also taken
   * as "this column already exists", only to blow up on the first read.
   */
  private migrate(): void {
    // Legacy summary columns remain inert: removing a display feature must not rewrite history.
    const columns = this.db.query(`PRAGMA table_info(session)`).all() as Array<{ name: string }>

    // Every session in an old database was opened by the user, so a default of NULL is
    // exactly right: an all-NULL column means the "continue" list loses not one entry
    if (!columns.some((column) => column.name === "parent_id")) {
      this.db.exec(`ALTER TABLE session ADD COLUMN parent_id TEXT`)
    }
  }

  close(): void {
    this.db.close()
  }

  // ───────────────────────────────────────────── session

  /**
   * @param parentID set = this is a subagent's session and stays out of the "continue"
   *   list. See agent/subagent.ts
   */
  createSession(id: string, directory: string, parentID?: string): void {
    const now = Date.now()
    this.db
      .query(
        `INSERT INTO session (id, title, directory, time_created, time_updated, parent_id)
         VALUES ($id, '', $directory, $now, $now, $parentID)
         ON CONFLICT(id) DO UPDATE SET time_updated = $now`,
      )
      .run({ id, directory, now, parentID: parentID ?? null })
  }

  /** Reserving the fallback also records that the one title attempt has been made. */
  claimTitle(id: string, fallback: string): boolean {
    return this.db.query("UPDATE session SET title = $fallback WHERE id = $id AND title = ''").run({ id, fallback }).changes === 1
  }

  finishTitle(id: string, fallback: string, title: string): void {
    this.db.query("UPDATE session SET title = $title WHERE id = $id AND title = $fallback").run({ id, fallback, title })
  }

  touchSession(id: string): void {
    this.db.query(`UPDATE session SET time_updated = $now WHERE id = $id`).run({ id, now: Date.now() })
  }

  /**
   * Sessions that can be continued, newest first.
   *
   * ── Why filter by directory ──
   * A session grows around one directory: its history is full of that repo's paths,
   * diffs, commands. Continue a session from elsewhere here and the context the model sees
   * does not match the files it can now touch, while the out-of-bounds guard blocks by the
   * current cwd — so it starts "reading a file that clearly exists and saying it can't be
   * found".
   *
   * ── Why an inner JOIN on message ──
   * Every startup first creates a session row (message's foreign key points at it), so the
   * database holds a pile of "opened but never said a word" empty shells. List them and
   * the picker's first screen is all empty rows. A session with no message has nothing to
   * join against, so it never makes it into the result.
   */
  listSessions(options: { directory?: string; limit?: number } = {}): SessionInfo[] {
    const rows = this.db
      .query(
        `SELECT s.id, s.title, s.directory, s.time_created, s.time_updated,
                COUNT(m.id) AS messages
         FROM session s
         JOIN message m ON m.session_id = s.id
         WHERE s.parent_id IS NULL
         ${options.directory === undefined ? "" : "AND s.directory = $directory"}
         GROUP BY s.id
         ORDER BY s.time_updated DESC
         LIMIT $limit`,
      )
      .all({
        ...(options.directory === undefined ? {} : { directory: options.directory }),
        limit: options.limit ?? 50,
      }) as Array<{
      id: string
      title: string
      directory: string
      time_created: number
      time_updated: number
      messages: number
    }>

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      directory: row.directory,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
      messages: row.messages,
      preview: this.firstUserText(row.id),
    }))
  }

  // ───────────────────────────────────────────── cleanup

  /**
   * History older than before, **computed, not deleted**. Deleting is deleteSessions().
   *
   * ── Why computing and deleting are separate ──
   * Deleting a conversation is irreversible, and the only chance for someone to notice
   * "wait, there's something in there I still want" before pressing the button is to write
   * out what will be deleted and show it to them first (same reason as `/reset`). A y/N
   * prompt does not give that chance — it does not say what is being deleted.
   *
   * ── Three rules for what is spared ──
   * 1. Whatever is in `keep` stays. The session currently open must never be deleted
   *    however old it is — a user resumes a session from three weeks ago, then cleans up,
   *    and what gets cleaned is the very ground under their feet.
   * 2. **Subagents dispatched by the current session stay with it**. They may still be
   *    running, and their sessions are exactly the history the loop re-reads every turn —
   *    deleting them pulls the memory out from under an agent that is still working.
   * 3. Subagent sessions **go with their parent** and are not judged by their own age:
   *    work dispatched from an old conversation is unreachable even if kept (it is not in
   *    `/resume`; see parentID in createSession). Conversely, while the parent is still
   *    there they are always kept — the main loop re-reading that session would run into
   *    references pointing at nothing.
   *
   * ⚠ Those whose parent is already gone (orphans left behind by older versions) are
   *   judged by their own age: they are unreachable, and "clean up history" exists for
   *   exactly this kind of thing.
   */
  staleHistory(before: number, keep: readonly string[] = []): HistorySweep {
    const rows = this.db.query(`SELECT id, parent_id, directory, time_updated FROM session`).all() as Array<{
      id: string
      parent_id: string | null
      directory: string
      time_updated: number
    }>

    const alive = new Set(rows.map((row) => row.id))
    const spared = new Set(keep)
    // Rule 2. A subagent cannot start subagents (see agent/subagent.ts), so there is only
    // one level and one pass is enough — if that boundary ever changes, this has to
    // become a transitive closure
    for (const row of rows) if (row.parent_id !== null && spared.has(row.parent_id)) spared.add(row.id)

    const doomed = new Set<string>()
    for (const row of rows) {
      if (spared.has(row.id)) continue
      // Has a parent that is still there: not judged in this pass — it follows its
      // parent below
      if (row.parent_id !== null && alive.has(row.parent_id)) continue
      if (row.time_updated >= before) continue
      doomed.add(row.id)
    }
    // Rule 3: once the parent is on the list, its children follow
    for (const row of rows) {
      if (spared.has(row.id) || row.parent_id === null) continue
      if (doomed.has(row.parent_id)) doomed.add(row.id)
    }

    const counts = new Map(
      (
        this.db.query(`SELECT session_id, COUNT(*) AS n FROM message GROUP BY session_id`).all() as Array<{
          session_id: string
          n: number
        }>
      ).map((row) => [row.session_id, row.n] as const),
    )

    const byDirectory = new Map<string, number>()
    let sessions = 0
    let agents = 0
    let messages = 0
    let oldest: number | undefined
    let newest: number | undefined
    for (const row of rows) {
      if (!doomed.has(row.id)) continue
      messages += counts.get(row.id) ?? 0
      if (row.parent_id !== null) {
        agents++
        continue
      }
      sessions++
      byDirectory.set(row.directory, (byDirectory.get(row.directory) ?? 0) + 1)
      if (oldest === undefined || row.time_updated < oldest) oldest = row.time_updated
      if (newest === undefined || row.time_updated > newest) newest = row.time_updated
    }

    return {
      ids: [...doomed],
      sessions,
      agents,
      messages,
      directories: [...byDirectory]
        .map(([directory, count]) => ({ directory, sessions: count }))
        .toSorted((a, b) => b.sessions - a.sessions || a.directory.localeCompare(b.directory)),
      ...(oldest !== undefined ? { oldest } : {}),
      ...(newest !== undefined ? { newest } : {}),
    }
  }

  /**
   * Delete these sessions by id, together with their messages and parts. Returns how many
   * rows were actually deleted.
   *
   * Messages and parts are carried off by **foreign-key cascade** (see the two ON DELETE
   * CASCADE in the DDL, and `PRAGMA foreign_keys = ON` in the constructor) — with three
   * hand-written DELETEs, the day a fourth table is added one gets missed, and the missed
   * one raises no error; it just slowly grows.
   *
   * The whole batch runs in **one transaction**: if it crashes midway, a conversation
   * should not be left with half its messages — such half-history is much worse than
   * deleting the whole session, since it still gets read into the model.
   */
  deleteSessions(ids: readonly string[]): number {
    if (ids.length === 0) return 0
    let deleted = 0
    this.db.transaction(() => {
      // SQLite caps the number of variables (999 by default), so feed them in batches
      for (let at = 0; at < ids.length; at += 400) {
        const batch = ids.slice(at, at + 400)
        const holes = batch.map((_, index) => `$id${index}`).join(", ")
        const params = Object.fromEntries(batch.map((id, index) => [`id${index}`, id]))
        // ★ Count first, then delete — **run().changes won't do**: the messages and parts
        //   carried off by the cascade are counted in changes too, and reporting from it
        //   turns into "deleted 1350 sessions" — when the database only holds 450
        const rows = this.db.query(`SELECT COUNT(*) AS n FROM session WHERE id IN (${holes})`).all(params) as Array<{
          n: number
        }>
        deleted += rows[0]?.n ?? 0
        this.db.query(`DELETE FROM session WHERE id IN (${holes})`).run(params)
      }
    })()
    return deleted
  }

  /**
   * Give the holes left by deletion back to the file system.
   *
   * Without this, the database file **does not shrink by a single byte** — SQLite just
   * marks those pages reusable. And someone cleaning up history most likely came precisely
   * because of "why is it so big"; a file still at 40MB after deleting makes them feel the
   * command did nothing at all.
   *
   * @returns the reason it failed. When another alfa instance is writing, the exclusive
   *   lock can't be taken, and that is not an error — the data is already deleted; the file
   *   just couldn't be shrunk this time, maybe next time
   */
  vacuum(): string | undefined {
    try {
      this.db.exec("VACUUM")
      // ★ The WAL has to be truncated too. The database runs in WAL mode (see the
      //   constructor), and the few hundred KB just deleted most likely still sit in
      //   sessions.db-wal at this point — VACUUM alone and `du` doesn't budge, while the
      //   user came precisely because of "why is it so big"
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /** The most recently active session in a directory. That is what `--continue` resumes. */
  latestSession(directory: string): SessionInfo | undefined {
    return this.listSessions({ directory, limit: 1 })[0]
  }

  getSession(id: string): SessionInfo | undefined {
    return (
      this.db
        .query(
          `SELECT s.id, s.title, s.directory, s.time_created, s.time_updated,
                  (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS messages
           FROM session s WHERE s.id = $id`,
        )
        .all({ id }) as Array<{
        id: string
        title: string
        directory: string
        time_created: number
        time_updated: number
          messages: number
      }>
    ).map((row) => ({
      id: row.id,
      title: row.title,
      directory: row.directory,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
      messages: row.messages,
      preview: this.firstUserText(row.id),
    }))[0]
  }

  /**
   * The user's first message. The picker relies on it to
   * recognize the session.
   *
   * The **first** message rather than the last: a session starts from that message, so it
   * best answers "which one is this". The last one is usually an uninformative reply like
   * "continue" or "ok".
   */
  private firstUserText(sessionID: string): string {
    const row = this.db
      .query(
        `SELECT p.data FROM part p
         JOIN message m ON m.id = p.message_id
         WHERE p.session_id = $sessionID AND m.role = 'user' AND p.type = 'text'
           AND COALESCE(json_extract(p.data, '$.synthetic'), 0) = 0
         ORDER BY m.time_created ASC, p.time_created ASC
         LIMIT 1`,
      )
      .get({ sessionID }) as { data: string } | null
    if (!row) return ""
    const part = PartSchema.parse(JSON.parse(row.data))
    return part.type === "text" ? part.text : ""
  }

  // ───────────────────────────────────────────── message

  upsertMessage(message: Message): void {
    const { id, sessionID, role, timeCreated } = message
    this.db
      .query(
        `INSERT INTO message (id, session_id, role, parent_id, finish, time_created, time_completed, data)
         VALUES ($id, $sessionID, $role, $parentID, $finish, $timeCreated, $timeCompleted, $data)
         ON CONFLICT(id) DO UPDATE SET
           parent_id      = excluded.parent_id,
           finish         = excluded.finish,
           time_completed = excluded.time_completed,
           data           = excluded.data`,
      )
      .run({
        id,
        sessionID,
        role,
        parentID: message.role === "assistant" ? message.parentID : null,
        finish: message.role === "assistant" ? (message.finish ?? null) : null,
        timeCreated,
        timeCompleted: message.role === "assistant" ? (message.timeCompleted ?? null) : null,
        data: JSON.stringify(message),
      })
  }

  getMessage(id: string): Message | undefined {
    const row = this.db.query(`SELECT data FROM message WHERE id = $id`).get({ id }) as { data: string } | null
    return row ? MessageSchema.parse(JSON.parse(row.data)) : undefined
  }

  // ───────────────────────────────────────────── part

  upsertPart(part: Part): void {
    const toolCallID = part.type === "tool" ? part.callID : null
    const toolName = part.type === "tool" ? part.tool : null
    const toolStatus = part.type === "tool" ? part.state.status : null
    this.db
      .query(
        `INSERT INTO part (id, message_id, session_id, type, tool_call_id, tool_name, tool_status, time_created, data)
         VALUES ($id, $messageID, $sessionID, $type, $toolCallID, $toolName, $toolStatus, $timeCreated, $data)
         ON CONFLICT(id) DO UPDATE SET
           tool_status = excluded.tool_status,
           data        = excluded.data`,
      )
      .run({
        id: part.id,
        messageID: part.messageID,
        sessionID: part.sessionID,
        type: part.type,
        toolCallID,
        toolName,
        toolStatus,
        timeCreated: part.timeCreated,
        data: JSON.stringify(part),
      })
  }

  /**
   * Find an existing tool part by callID — given the order streaming events arrive in,
   * a partID is not guaranteed to be at hand.
   */
  findToolPart(messageID: string, callID: string): Part | undefined {
    const row = this.db
      .query(`SELECT data FROM part WHERE message_id = $messageID AND tool_call_id = $callID`)
      .get({ messageID, callID }) as { data: string } | null
    return row ? PartSchema.parse(JSON.parse(row.data)) : undefined
  }

  listParts(messageID: string): Part[] {
    const rows = this.db
      .query(`SELECT data FROM part WHERE message_id = $messageID ORDER BY time_created ASC, id ASC`)
      .all({ messageID }) as Array<{ data: string }>
    return rows.map((r) => PartSchema.parse(JSON.parse(r.data)))
  }

  /**
   * Delete all parts of a message. Called before a retry, so half-written parts and resent
   * parts don't pile up on top of each other.
   */
  clearParts(messageID: string): void {
    this.db.query(`DELETE FROM part WHERE message_id = $messageID`).run({ messageID })
  }

  // ───────────────────────────────────────────── history

  /**
   * Read the full history, ascending by (time_created, id). The main loop calls this once
   * per turn.
   */
  listAll(sessionID: string): MessageWithParts[] {
    const messages = this.db
      .query(`SELECT data FROM message WHERE session_id = $sessionID ORDER BY time_created ASC, id ASC`)
      .all({ sessionID }) as Array<{ data: string }>

    const parts = this.db
      .query(
        `SELECT message_id, data FROM part WHERE session_id = $sessionID ORDER BY time_created ASC, id ASC`,
      )
      .all({ sessionID }) as Array<{ message_id: string; data: string }>

    const byMessage = new Map<string, Part[]>()
    for (const row of parts) {
      const list = byMessage.get(row.message_id)
      const parsed = PartSchema.parse(JSON.parse(row.data))
      if (list) list.push(parsed)
      else byMessage.set(row.message_id, [parsed])
    }

    return messages.map((row) => {
      const info = MessageSchema.parse(JSON.parse(row.data))
      return { info, parts: byMessage.get(info.id) ?? [] }
    })
  }
}

function defaultDbPath(): string {
  return join(dataDir(), "sessions.db")
}
