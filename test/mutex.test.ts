/**
 * Per-path file lock (fs/mutex.ts).
 *
 * The cleanup in its `finally` once compared against the wrong promise and never ran, so
 * every path ever edited kept an entry for the rest of the session. These tests pin both
 * halves: the entry does go away, and going away never lets two holders in at once.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { __clearLocksForTest, __lockCountForTest, withFileLock } from "../src/fs/mutex.ts"

afterEach(() => __clearLocksForTest())

describe("file lock", () => {
  test("★ the entry is dropped once the last holder releases", async () => {
    await withFileLock("/a", async () => {})
    await withFileLock("/b", async () => {})
    expect(__lockCountForTest()).toBe(0)
  })

  test("★ holders of the same path still run one at a time, and the entry goes after both", async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve))
    const first = withFileLock("/same", async () => {
      order.push("first in")
      await gate
      order.push("first out")
    })
    const second = withFileLock("/same", async () => {
      order.push("second in")
    })
    await Bun.sleep(10)
    expect(order).toEqual(["first in"])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(["first in", "first out", "second in"])
    expect(__lockCountForTest()).toBe(0)
  })

  test("a failing holder still releases the path", async () => {
    await expect(withFileLock("/c", async () => { throw new Error("boom") })).rejects.toThrow("boom")
    await withFileLock("/c", async () => {})
    expect(__lockCountForTest()).toBe(0)
  })
})
