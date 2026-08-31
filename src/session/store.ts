/**
 * 会话持久化。bun:sqlite 裸 SQL,不上 ORM。
 *
 * 为什么第一版就要有存储(而不是内存数组):
 * 主循环的正确性依赖「每轮从存储重读全量历史」这条约束 —— 只有这样,压缩、
 * 中断收尾、外部改写历史才能立刻生效,循环本身也才是幂等可恢复的。用内存
 * 数组也能跑,但那等于把「存储是唯一真值源」改成「内存是真值源」,以后加
 * 持久化要重写 loop。
 *
 * ⚠ 时序约定:所有写入必须在同一 tick 内完成,主循环只在 turn 边界读。
 *
 *   这条假设当初写着「将来加了并发工具调用或后台 job 就会失效」。后台 job
 *   现在真的有了(子 agent,见 agent/subagent.ts):它们和主循环**同时**在写
 *   同一个库。仍然不需要显式事务,理由是每一场会话只有一个写者 —— 子 agent
 *   写的是它自己那场,主循环写的是用户那场,两边在 session_id 上就分开了。
 *   SQLite 自己(WAL + busy_timeout)负责把并发的写序列化。
 *
 *   真要小心的是**同一场会话两个写者**:哪天做了"两个 agent 接力同一场对话"
 *   之类的东西,这条注释就该重新算一遍。
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
  summary       TEXT    NOT NULL DEFAULT '',
  -- 子 agent 那几场的父会话(见 agent/subagent.ts)。它们照旧完整落库(主循环
  -- 每轮要从这里重读历史),但**不算"能接着聊的会话"**:用户要接的是自己那场,
  -- 不是十分钟前派出去数了三个文件的小活儿。所以列会话时按这一列筛掉
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

/** 一场会话的门面。挑选界面和 `--continue` 只认这些字段,不碰消息本身。 */
export interface SessionInfo {
  id: string
  title: string
  /** 当时的工作目录 */
  directory: string
  timeCreated: number
  timeUpdated: number
  /** 摘要 agent 写的那段话。可能是空的(第一轮还没结束就退了) */
  summary: string
  /** 消息条数。回答"这场聊了多久" */
  messages: number
  /** 第一句用户说的话。摘要为空时靠它认人 */
  preview: string
}

/**
 * 一次清理要动掉的东西。**只是一份清单** —— 算它的人不删,见 staleHistory()。
 *
 * 分成"对话"和"子 agent 那几场"两个数,因为它们在用户眼里根本不是一种东西:
 * 前者是他自己聊过的,后者是他按一次回车之后后台自己长出来的。合成一个数写成
 * 「要删 47 场」,一个只聊过十次的人会以为程序算错了。
 */
export interface HistorySweep {
  /** 要删的全部会话 id(对话 + 它们派出去的子 agent 那几场) */
  ids: string[]
  /** 其中用户自己开的有几场 */
  sessions: number
  /** 其中子 agent 那几场有几场 */
  agents: number
  messages: number
  /** 涉及哪几个目录、各几场。按场数降序 —— 清理的人第一眼要找的是"哪个项目占的" */
  directories: Array<{ directory: string; sessions: number }>
  /** 最老/最新那一场上次说话是什么时候。空清单时没有 */
  oldest?: number
  newest?: number
}

export class Store {
  private db: Database
  /** 库文件在哪。清理完要报"腾出多少" —— 那只能靠 stat 这个文件 */
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
   * 加列。
   *
   * `CREATE TABLE IF NOT EXISTS` 对**已经存在**的表什么都不做 —— 老库不会因为
   * DDL 里多写了一列就长出这一列。所以每加一列都要在这里补一次 ALTER,
   * 按「查得到就跳过」判断,而不是靠 try/catch 吞异常:吞掉的话,真正的
   * 磁盘错误也会被当成「这列已经有了」,然后在第一次读的时候才炸。
   */
  private migrate(): void {
    const columns = this.db.query(`PRAGMA table_info(session)`).all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "summary")) {
      this.db.exec(`ALTER TABLE session ADD COLUMN summary TEXT NOT NULL DEFAULT ''`)
    }
    // 老库里的每一场都是用户自己开的,所以默认 NULL 正是对的:一列全 NULL
    // 意味着"接着聊"的清单一条都不会少
    if (!columns.some((column) => column.name === "parent_id")) {
      this.db.exec(`ALTER TABLE session ADD COLUMN parent_id TEXT`)
    }
  }

  close(): void {
    this.db.close()
  }

  // ───────────────────────────────────────────── session

  /**
   * @param parentID 有值 = 这是一场子 agent 的会话,不进"接着聊"的清单。
   *   见 agent/subagent.ts
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

  touchSession(id: string): void {
    this.db.query(`UPDATE session SET time_updated = $now WHERE id = $id`).run({ id, now: Date.now() })
  }

  /**
   * 能接着聊的会话,新的在前。
   *
   * ── 为什么按 directory 过滤 ──
   * 会话是围着一个目录长出来的:历史里全是那个仓库的路径、diff、命令。把别处
   * 的会话接到这里,模型看到的上下文和它现在能碰的文件对不上,而越界守卫又
   * 按当前 cwd 拦 —— 于是它会开始"读一个明明存在的文件却说找不到"。
   *
   * ── 为什么要 HAVING count > 0 ──
   * 每次启动都会先建一行 session(message 的外键指着它),所以库里躺着一堆
   * 「开了没说话」的空壳。把它们列出来,挑选界面第一屏全是空行。
   */
  listSessions(options: { directory?: string; limit?: number } = {}): SessionInfo[] {
    const rows = this.db
      .query(
        `SELECT s.id, s.title, s.directory, s.time_created, s.time_updated, s.summary,
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
      summary: string
      messages: number
    }>

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      directory: row.directory,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
      summary: row.summary,
      messages: row.messages,
      preview: this.firstUserText(row.id),
    }))
  }

  // ───────────────────────────────────────────── 清理

  /**
   * 早于 before 的历史,**只算不删**。删的是 deleteSessions()。
   *
   * ── 为什么算和删要分开 ──
   * 删一场对话是不可逆的,而唯一能让人在按下去之前发现"等等,那里面有我还想
   * 要的东西"的机会,就是先把要删的写出来给他看(和 `/reset` 同一条理由)。
   * 一个 y/N 提示给不了这个机会 —— 它没写出要删的是什么。
   *
   * ── 三条留人的规矩 ──
   * 1. `keep` 里的留着。手上正开着的那一场无论多老都不能删 —— 用户接回一场
   *    三周前的会话,接着就清理,清掉的正是他脚下站着的那块地。
   * 2. **手上这一场派出去的子 agent 跟着留**。它们可能还在跑,而它们那几场
   *    正是循环每轮要重读的历史 —— 删了等于把一个还在干活的 agent 的记忆抽掉。
   * 3. 子 agent 那几场**跟着它爹走**,不单独判年龄:一场老对话里派出去的活儿
   *    留下来也没人够得着(它们不进 `/resume`,见 createSession 的 parentID)。
   *    反过来,爹还在就一定留 —— 主循环重读那一场时会撞见指着空处的引用。
   *
   * ⚠ 爹已经不在了的(老版本删剩下的孤儿)按自己的年龄判:它们够不着,
   *   而"清理历史"清的正是这种东西。
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
    // 规矩 2。子 agent 起不了子 agent(见 agent/subagent.ts),所以只有一层,
    // 一遍就够 —— 哪天那条边界改了,这里要跟着改成传递闭包
    for (const row of rows) if (row.parent_id !== null && spared.has(row.parent_id)) spared.add(row.id)

    const doomed = new Set<string>()
    for (const row of rows) {
      if (spared.has(row.id)) continue
      // 有爹而且爹还在的,这一轮不判 —— 下面跟着爹走
      if (row.parent_id !== null && alive.has(row.parent_id)) continue
      if (row.time_updated >= before) continue
      doomed.add(row.id)
    }
    // 规矩 3:爹进了名单,儿子跟着进
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
   * 按 id 删掉这几场,连它们的消息和 part 一起。返回真的删掉了几行。
   *
   * 消息和 part 是**外键级联**带走的(见 DDL 里那两个 ON DELETE CASCADE,
   * 以及构造函数里的 `PRAGMA foreign_keys = ON`)—— 手写三条 DELETE 的话,
   * 哪天加了第四张表就会漏掉一张,而漏掉的那张不会报错,只会慢慢涨。
   *
   * 一整批走**一个事务**:中途崩掉的话,一场对话不该只剩下一半消息 —— 那种
   * 半截历史比整场删掉糟得多,它照旧会被读进模型。
   */
  deleteSessions(ids: readonly string[]): number {
    if (ids.length === 0) return 0
    let deleted = 0
    this.db.transaction(() => {
      // SQLite 的变量个数有上限(默认 999),分批塞
      for (let at = 0; at < ids.length; at += 400) {
        const batch = ids.slice(at, at + 400)
        const holes = batch.map((_, index) => `$id${index}`).join(", ")
        const params = Object.fromEntries(batch.map((id, index) => [`id${index}`, id]))
        // ★ 先数再删,**不能用 run().changes**:级联带走的消息和 part 也算在
        //   changes 里,拿它报数会变成"删掉了 1350 场会话"—— 而库里一共才 450 场
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
   * 把删出来的空洞还给文件系统。
   *
   * 不跑的话,库文件**一个字节都不会变小** —— SQLite 只是把那些页标成可复用。
   * 而清理历史的人多半正是冲着"它怎么这么大"来的,一个删完还是 40MB 的文件
   * 会让他觉得这条命令根本没干活。
   *
   * @returns 失败的理由。别的 alfa 实例正在写时拿不到独占锁,那不是错误 ——
   *   东西已经删掉了,只是这次没能把文件缩回去,下次再说
   */
  vacuum(): string | undefined {
    try {
      this.db.exec("VACUUM")
      // ★ 还要把 WAL 截掉。库开着 WAL(见构造函数),删掉的那几百 KB 这时候
      //   多半还躺在 sessions.db-wal 里 —— 只 VACUUM 的话,`du` 看上去纹丝不动,
      //   而用户是冲着"它怎么这么大"来的
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /** 某个目录下最近说过话的那场。`--continue` 就是它。 */
  latestSession(directory: string): SessionInfo | undefined {
    return this.listSessions({ directory, limit: 1 })[0]
  }

  getSession(id: string): SessionInfo | undefined {
    return (
      this.db
        .query(
          `SELECT s.id, s.title, s.directory, s.time_created, s.time_updated, s.summary,
                  (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS messages
           FROM session s WHERE s.id = $id`,
        )
        .all({ id }) as Array<{
        id: string
        title: string
        directory: string
        time_created: number
        time_updated: number
        summary: string
        messages: number
      }>
    ).map((row) => ({
      id: row.id,
      title: row.title,
      directory: row.directory,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
      summary: row.summary,
      messages: row.messages,
      preview: this.firstUserText(row.id),
    }))[0]
  }

  /**
   * 第一句用户说的话。摘要还没写出来时,挑选界面靠它认人。
   *
   * 取**第一句**而不是最后一句:一场会话是从那句话开始的,它最能回答
   * "这是哪一场"。最后一句往往是「继续」「好」这种没有信息量的应答。
   */
  private firstUserText(sessionID: string): string {
    const row = this.db
      .query(
        `SELECT p.data FROM part p
         JOIN message m ON m.id = p.message_id
         WHERE p.session_id = $sessionID AND m.role = 'user' AND p.type = 'text'
         ORDER BY m.time_created ASC, p.time_created ASC
         LIMIT 1`,
      )
      .get({ sessionID }) as { data: string } | null
    if (!row) return ""
    const part = PartSchema.parse(JSON.parse(row.data))
    return part.type === "text" ? part.text : ""
  }

  /**
   * 会话摘要。每轮结束由摘要 agent 整段重写。
   *
   * 存的是**成品文本**而不是每轮的片段:它本来就是一段被反复改写的话,
   * 存片段的话读出来还得再拼一次,而拼出来的东西和用户当时看到的不是同一份。
   */
  getSummary(id: string): string {
    const row = this.db.query(`SELECT summary FROM session WHERE id = $id`).get({ id }) as
      | { summary: string }
      | null
    return row?.summary ?? ""
  }

  setSummary(id: string, summary: string): void {
    this.db
      .query(`UPDATE session SET summary = $summary, time_updated = $now WHERE id = $id`)
      .run({ id, summary, now: Date.now() })
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

  /** 按 callID 找已存在的 tool part —— 流式事件到达顺序不保证带 partID。 */
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

  /** 删掉某条 message 的所有 part。重试前调用,避免半截 part 和重发 part 叠在一起。 */
  clearParts(messageID: string): void {
    this.db.query(`DELETE FROM part WHERE message_id = $messageID`).run({ messageID })
  }

  // ───────────────────────────────────────────── 历史

  /**
   * 读全量历史,按 (time_created, id) 升序。主循环每轮调一次。
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
