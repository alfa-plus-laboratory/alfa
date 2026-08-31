/**
 * `/history-clean`:删掉躺在本机的老会话。
 *
 * 这里盯的全是「删多了」那一侧的错 —— 删少了下次再删一遍就是了,删多了没有
 * 第二次机会:
 *   - 把用户脚下这一场删掉(接回一场老会话之后顺手清理)
 *   - 把还在跑的子 agent 那几场删掉 → 循环下一轮重读历史时那一场是空的
 *   - 只删了 session 行,消息和 part 留在库里 → 库不但没小,还多了一堆够不着的行
 *   - 一场对话只被删掉一半 → 半截历史照旧会被读进模型,比整场删掉糟得多
 */
import { describe, expect, test } from "bun:test"
import { Store } from "../src/session/store.ts"

const DAY = 86_400_000
/** 一个定死的"现在"。断言不能跟着钟走 */
const NOW = 1_700_000_000_000

/** 造一场说过话的会话。时间给死值 —— 年龄是这一整个文件的判据 */
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

/** Store 没有(也不该有)拨时钟和数行数的公开 API,断言直接问库 */
function raw(store: Store): {
  query(sql: string): { run(args?: unknown): void; all(args?: unknown): unknown[] }
} {
  return (store as unknown as { db: ReturnType<typeof raw> }).db
}

function count(store: Store, table: string): number {
  const rows = raw(store).query(`SELECT COUNT(*) AS n FROM ${table}`).all() as Array<{ n: number }>
  return rows[0]?.n ?? 0
}

/** 一周前那条线 */
const WEEK_AGO = NOW - 7 * DAY

describe("算要删什么", () => {
  test("老的进清单,新的不进", () => {
    const store = new Store(":memory:")
    seed(store, "old", { at: NOW - 30 * DAY })
    seed(store, "fresh", { at: NOW - 1 * DAY })
    const sweep = store.staleHistory(WEEK_AGO)
    expect(sweep.ids).toEqual(["old"])
    expect(sweep.sessions).toBe(1)
  })

  test("★ 手上这一场再老也不动 —— 接回一场三周前的会话,清理清的不该是脚下这块地", () => {
    const store = new Store(":memory:")
    seed(store, "current", { at: NOW - 21 * DAY })
    seed(store, "other", { at: NOW - 21 * DAY })
    const sweep = store.staleHistory(WEEK_AGO, ["current"])
    expect(sweep.ids).toEqual(["other"])
  })

  test("★ 手上这一场派出去的子 agent 跟着留 —— 它可能还在跑,那一场正是它的记忆", () => {
    const store = new Store(":memory:")
    seed(store, "current", { at: NOW - 21 * DAY })
    // 子 agent 的会话是刚建的,但年龄不是这里的判据 —— 爹留着它就得留着
    seed(store, "scout", { at: NOW - 21 * DAY, parent: "current" })
    const sweep = store.staleHistory(WEEK_AGO, ["current"])
    expect(sweep.ids).toEqual([])
  })

  test("★ 老对话派出去的那几场跟着爹一起走 —— 爹没了它们谁也够不着", () => {
    const store = new Store(":memory:")
    seed(store, "old", { at: NOW - 30 * DAY })
    // 儿子自己还"新"(是那场对话最后干的活儿),但爹进了名单它就得跟着
    seed(store, "old-scout", { at: NOW - 29 * DAY, parent: "old" })
    const sweep = store.staleHistory(WEEK_AGO)
    expect(sweep.ids.toSorted()).toEqual(["old", "old-scout"])
    expect(sweep.sessions).toBe(1)
    expect(sweep.agents).toBe(1)
  })

  test("★ 爹还在,儿子一定留 —— 主循环重读那一场时会撞见指着空处的引用", () => {
    const store = new Store(":memory:")
    seed(store, "fresh", { at: NOW - 1 * DAY })
    seed(store, "fresh-scout", { at: NOW - 30 * DAY, parent: "fresh" })
    expect(store.staleHistory(WEEK_AGO).ids).toEqual([])
  })

  test("爹早就不在了的孤儿,按自己的年龄判", () => {
    const store = new Store(":memory:")
    seed(store, "orphan", { at: NOW - 30 * DAY, parent: "long-gone" })
    seed(store, "young-orphan", { at: NOW - 1 * DAY, parent: "long-gone" })
    expect(store.staleHistory(WEEK_AGO).ids).toEqual(["orphan"])
  })

  test("对话和子 agent 那几场分开数 —— 合成一个数会让人以为程序算错了", () => {
    const store = new Store(":memory:")
    seed(store, "old", { at: NOW - 30 * DAY, messages: 3 })
    seed(store, "old-a", { at: NOW - 30 * DAY, parent: "old", messages: 5 })
    seed(store, "old-b", { at: NOW - 30 * DAY, parent: "old", messages: 4 })
    const sweep = store.staleHistory(WEEK_AGO)
    expect(sweep.sessions).toBe(1)
    expect(sweep.agents).toBe(2)
    expect(sweep.messages).toBe(12)
  })

  test("按目录分组,场数多的排前面", () => {
    const store = new Store(":memory:")
    seed(store, "a1", { at: NOW - 30 * DAY, directory: "/one" })
    seed(store, "b1", { at: NOW - 30 * DAY, directory: "/two" })
    seed(store, "b2", { at: NOW - 30 * DAY, directory: "/two" })
    expect(store.staleHistory(WEEK_AGO).directories).toEqual([
      { directory: "/two", sessions: 2 },
      { directory: "/one", sessions: 1 },
    ])
  })

  test("最老/最新只看对话,子 agent 那几场不参与 —— 那两个日期是给人认年份的", () => {
    const store = new Store(":memory:")
    seed(store, "older", { at: NOW - 30 * DAY })
    seed(store, "newer", { at: NOW - 10 * DAY })
    const sweep = store.staleHistory(WEEK_AGO)
    expect(sweep.oldest).toBe(NOW - 30 * DAY)
    expect(sweep.newest).toBe(NOW - 10 * DAY)
  })

  test("什么都没到期时,清单是空的而且没有日期", () => {
    const store = new Store(":memory:")
    seed(store, "fresh", { at: NOW - 1 * DAY })
    const sweep = store.staleHistory(WEEK_AGO)
    expect(sweep.ids).toEqual([])
    expect(sweep.oldest).toBeUndefined()
    expect(sweep.messages).toBe(0)
  })

  test("★ 只算不删 —— 这一步是给人看的清单,库不该动", () => {
    const store = new Store(":memory:")
    seed(store, "old", { at: NOW - 30 * DAY })
    store.staleHistory(WEEK_AGO)
    expect(count(store, "session")).toBe(1)
    expect(store.getSession("old")).toBeDefined()
  })
})

describe("真删", () => {
  test("★ 消息和 part 跟着走 —— 只删 session 行的话,库不但没小还多了一堆够不着的行", () => {
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

  test("删完之后 /resume 里就没有它了", () => {
    const store = new Store(":memory:")
    seed(store, "old", { at: NOW - 30 * DAY })
    seed(store, "fresh", { at: NOW - 1 * DAY })
    store.deleteSessions(store.staleHistory(WEEK_AGO).ids)
    expect(store.listSessions().map((session) => session.id)).toEqual(["fresh"])
  })

  test("空清单什么都不做", () => {
    const store = new Store(":memory:")
    seed(store, "fresh", { at: NOW - 1 * DAY })
    expect(store.deleteSessions([])).toBe(0)
    expect(count(store, "session")).toBe(1)
  })

  test("★ 一次删几百场也不炸 —— SQLite 的变量个数有上限,所以要分批", () => {
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

  test("VACUUM 跑得起来 —— 不跑的话库文件一个字节都不会变小", () => {
    const store = new Store(":memory:")
    seed(store, "old", { at: NOW - 30 * DAY })
    store.deleteSessions(["old"])
    expect(store.vacuum()).toBeUndefined()
  })
})
