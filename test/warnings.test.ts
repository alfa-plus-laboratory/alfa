import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { captureWarnings } from "../src/util/warnings.ts"

const MODULE = pathToFileURL(join(import.meta.dir, "..", "src", "util", "warnings.ts")).href

/**
 * 必须起子进程才验得了:告警的默认打印发生在原生层,同一个进程里补
 * `process.stderr.write` 是拦不住的(试过,连 console.error 都拦不住)。
 * 唯一算数的证据是**另一个进程的 stderr 上到底有没有那行字**。
 */
async function stderrOf(body: string): Promise<string> {
  const proc = Bun.spawn(["bun", "-e", body], { stdout: "pipe", stderr: "pipe" })
  const [err] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  return err
}

const OVERFLOW = `clearTimeout(setTimeout(() => {}, 9_999_999_999)); await Bun.sleep(30)`

describe("进程告警不落终端", () => {
  test("对照组:不装的话,告警连着栈直接打在 stderr 上", async () => {
    const err = await stderrOf(OVERFLOW)
    expect(err).toContain("TimeoutOverflowWarning")
  }, 15_000)

  test("装上之后,同一条告警一个字都不出现", async () => {
    const err = await stderrOf(`import { captureWarnings } from ${JSON.stringify(MODULE)}\ncaptureWarnings()\n${OVERFLOW}`)
    expect(err).not.toContain("TimeoutOverflowWarning")
    expect(err.trim()).toBe("")
  }, 15_000)

  test("装两次也只有一个监听器 —— 多一个就多一份重复的日志", () => {
    const before = process.listenerCount("warning")
    captureWarnings()
    captureWarnings()
    const after = process.listenerCount("warning")
    expect(after).toBeLessThanOrEqual(before + 1)
  })
})
