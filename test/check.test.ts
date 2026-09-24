/**
 * The automatic check before wrapping up.
 *
 * Two groups: recognizing (detectChecker / worthChecking) and running (runCheck). The
 * first group is pure functions; the second really spawns processes — using `sh -c` to
 * produce four outcomes: exit code, output, command not found, timeout, because **the
 * UI handles these four completely differently**, and lumping them into one boolean is
 * exactly where "the checker is broken but it says the code has problems" comes from.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkReminder, detectChecker, runCheck, worthChecking, type Checker } from "../src/agent/check.ts"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "apc-check-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const touch = (...parts: string[]) => {
  const path = join(root, ...parts)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, "")
  return path
}

describe("detecting what this project should run", () => {
  test("tsconfig + local tsc → tsc --noEmit", () => {
    touch("tsconfig.json")
    touch("node_modules", ".bin", "tsc")
    const checker = detectChecker(root)
    expect(checker?.id).toBe("tsc")
    expect(checker?.command).toContain("--noEmit")
    expect(checker?.extensions).toContain(".ts")
  })

  test("★ tsconfig but no local tsc — runs nothing, never fetches one from the network", () => {
    touch("tsconfig.json")
    expect(detectChecker(root)).toBeUndefined()
  })

  test("Cargo.toml → cargo check;go.mod → go build", () => {
    touch("Cargo.toml")
    expect(detectChecker(root)?.id).toBe("cargo")
    rmSync(join(root, "Cargo.toml"))
    touch("go.mod")
    expect(detectChecker(root)?.id).toBe("go")
  })

  test("★ a non-POSIX shell needs tsc.cmd — PowerShell can't run the extensionless sh script", () => {
    touch("tsconfig.json")
    touch("node_modules", ".bin", "tsc")
    // Only the sh script, no .cmd: the check can't run on that machine, so treat it as
    // absent — a "check failed" line every turn is worse than no check at all
    expect(detectChecker(root, undefined, { posix: false })).toBeUndefined()

    touch("node_modules", ".bin", "tsc.cmd")
    expect(detectChecker(root, undefined, { posix: false })?.command).toBe("node_modules\\.bin\\tsc.cmd --noEmit")
    expect(detectChecker(root, undefined, { posix: true })?.command).toBe("node_modules/.bin/tsc --noEmit")
  })

  test("nothing detected means no check — the feature quietly doesn't exist", () => {
    expect(detectChecker(root)).toBeUndefined()
  })

  test("a configured command is used as is; false turns the check off entirely", () => {
    touch("tsconfig.json")
    touch("node_modules", ".bin", "tsc")
    expect(detectChecker(root, "bun run typecheck")?.command).toBe("bun run typecheck")
    // A custom command doesn't know which extensions it covers, so it runs whatever
    // was touched
    expect(detectChecker(root, "bun run typecheck")?.extensions).toEqual([])
    expect(detectChecker(root, false)).toBeUndefined()
  })
})

describe("whether it's worth running", () => {
  const tsc: Checker = { id: "tsc", command: "tsc --noEmit", extensions: [".ts", ".tsx"] }

  test("a README-only change doesn't run it — the user is the one waiting those seconds", () => {
    expect(worthChecking(tsc, ["/repo/README.md"])).toBe(false)
  })
  test("touching one .ts file runs it", () => {
    expect(worthChecking(tsc, ["/repo/README.md", "/repo/src/a.ts"])).toBe(true)
  })
  test("nothing changed, nothing runs", () => {
    expect(worthChecking(tsc, [])).toBe(false)
  })
  test("custom command: runs whenever any file was touched", () => {
    expect(worthChecking({ id: "check", command: "x", extensions: [] }, ["/repo/README.md"])).toBe(true)
  })
})

describe("running it", () => {
  const checker = (command: string): Checker => ({ id: "test", command, extensions: [] })

  test("exit code 0 = clean", async () => {
    const outcome = await runCheck(checker("true"), { root })
    expect(outcome.status).toBe("ok")
    expect(outcome.output).toBe("")
  })

  test("non-zero = problems, output returned verbatim (stderr included)", async () => {
    const outcome = await runCheck(checker("echo 'a.ts(1,1): error TS1005' >&2; exit 2"), { root })
    expect(outcome.status).toBe("problems")
    expect(outcome.code).toBe(2)
    expect(outcome.output).toContain("error TS1005")
  })

  test("★ command not found = checker not installed, not a problem in the code", async () => {
    const outcome = await runCheck(checker("definitely-not-a-real-command-xyz"), { root })
    expect(outcome.status).toBe("unavailable")
    expect(outcome.reason).toContain("not found")
  })

  test("a timeout also counts as not run — a stuck checker must not read as a failed build", async () => {
    const outcome = await runCheck(checker("sleep 5"), { root, timeoutMs: 150 })
    expect(outcome.status).toBe("unavailable")
    expect(outcome.reason).toBe("timeout")
  })

  test("already aborted: no process is started", async () => {
    const controller = new AbortController()
    controller.abort()
    const outcome = await runCheck(checker("true"), { root, signal: controller.signal })
    expect(outcome.status).toBe("unavailable")
    expect(outcome.reason).toBe("interrupted")
  })

  test("aborted mid-run", async () => {
    const controller = new AbortController()
    const running = runCheck(checker("sleep 5"), { root, signal: controller.signal })
    controller.abort()
    expect((await running).status).toBe("unavailable")
  })

  test("★ keeps the head, drops the tail — the compiler's first error is often the root cause", async () => {
    const outcome = await runCheck(checker("seq 1 500; exit 1"), { root })
    expect(outcome.output.startsWith("1\n2\n3")).toBe(true)
    expect(outcome.output).toContain("more lines")
    expect(outcome.output.split("\n").length).toBeLessThan(60)
  })

  test("runs in the workspace root, not the process cwd", async () => {
    const outcome = await runCheck(checker("test \"$(pwd)\" = \"$(cd . && pwd)\" && ls tsconfig.json"), { root })
    // No tsconfig → non-zero. What we really want to prove is that it looks in root
    expect(outcome.status).toBe("problems")
    touch("tsconfig.json")
    expect((await runCheck(checker("ls tsconfig.json"), { root })).status).toBe("ok")
  })
})

describe("the reminder fed back to the model", () => {
  const tsc: Checker = { id: "tsc", command: "tsc --noEmit", extensions: [".ts"] }

  test("includes the command and the raw output", () => {
    const text = checkReminder(tsc, "a.ts(1,1): error TS1005")
    expect(text).toContain("tsc --noEmit")
    expect(text).toContain("error TS1005")
  })

  test("★ all three points present: not from the user, check whether you caused it, speak up if you can't fix it", () => {
    const text = checkReminder(tsc, "boom")
    expect(text).toContain("not by the user")
    expect(text).toContain("Pre-existing")
    expect(text).toContain("Never silently work around")
  })
})
