import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { captureWarnings } from "../src/util/warnings.ts"

const MODULE = pathToFileURL(join(import.meta.dir, "..", "src", "util", "warnings.ts")).href

/**
 * This can only be verified with a child process: the default warning print happens in
 * the native layer, and patching `process.stderr.write` in the same process does not
 * catch it (tried it; even console.error doesn't catch it). The only evidence that
 * counts is **whether that line actually shows up on another process's stderr**.
 */
async function stderrOf(body: string): Promise<string> {
  const proc = Bun.spawn(["bun", "-e", body], { stdout: "pipe", stderr: "pipe" })
  const [err] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  return err
}

const OVERFLOW = `clearTimeout(setTimeout(() => {}, 9_999_999_999)); await Bun.sleep(30)`

describe("process warnings stay off the terminal", () => {
  test("control: without it installed, the warning prints to stderr with its stack", async () => {
    const err = await stderrOf(OVERFLOW)
    expect(err).toContain("TimeoutOverflowWarning")
  }, 15_000)

  test("once installed, not one character of the same warning appears", async () => {
    const err = await stderrOf(`import { captureWarnings } from ${JSON.stringify(MODULE)}\ncaptureWarnings()\n${OVERFLOW}`)
    expect(err).not.toContain("TimeoutOverflowWarning")
    expect(err.trim()).toBe("")
  }, 15_000)

  test("installing twice still adds one listener — each extra would duplicate the log", () => {
    const before = process.listenerCount("warning")
    captureWarnings()
    captureWarnings()
    const after = process.listenerCount("warning")
    expect(after).toBeLessThanOrEqual(before + 1)
  })
})
