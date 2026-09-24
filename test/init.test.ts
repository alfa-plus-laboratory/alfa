/**
 * The two halves of `/init`: the folder (created by code) and the prompt (handed to the
 * model).
 *
 * The one that matters most is the "doesn't overwrite an existing README" case: a
 * command that wipes out what the user wrote is one the user only runs into once, and
 * never dares press again — and typecheck can't catch that kind of bug; only a test can.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ALFA_DIR, AGENTS_FILE, initPrompt, initScaffold } from "../src/prompt/init.ts"
import { discoverInstructions } from "../src/prompt/instructions.ts"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "apc-init-"))
})
afterEach(() => {
  // the read-only-directory case changed permissions; restore them first, or rm itself
  // fails
  try {
    chmodSync(dir, 0o755)
  } catch {}
  rmSync(dir, { recursive: true, force: true })
})

describe("initScaffold", () => {
  test("creates .alfa/README.md and reports what it created", () => {
    const result = initScaffold(dir)
    expect(result.created).toEqual([`${ALFA_DIR}/README.md`])
    expect(result.failed).toBeUndefined()
    const readme = readFileSync(join(dir, ALFA_DIR, "README.md"), "utf8")
    // the three reserved locations are written in the doc, and they are a promise — what
    // actually lands has to match
    expect(readme).toContain("memory/")
    expect(readme).toContain("skills/")
    expect(readme).toContain("config.json")
  })

  test("a second run creates nothing and reports nothing created", () => {
    initScaffold(dir)
    const again = initScaffold(dir)
    expect(again.created).toEqual([])
    expect(again.failed).toBeUndefined()
  })

  test("doesn't overwrite an existing README", () => {
    mkdirSync(join(dir, ALFA_DIR))
    writeFileSync(join(dir, ALFA_DIR, "README.md"), "我自己写的")
    initScaffold(dir)
    expect(readFileSync(join(dir, ALFA_DIR, "README.md"), "utf8")).toBe("我自己写的")
  })

  test("when creation fails it gives a reason instead of throwing", () => {
    const readonly = join(dir, "ro")
    mkdirSync(readonly)
    chmodSync(readonly, 0o500)
    const result = initScaffold(readonly)
    // root bypasses file permissions (common in CI containers); in that environment it
    // does succeed
    if (result.failed === undefined) expect(result.created).toEqual([`${ALFA_DIR}/README.md`])
    else expect(result.failed.length).toBeGreaterThan(0)
    chmodSync(readonly, 0o755)
  })

  test("the scaffold isn't loaded into the prompt as an instructions file", () => {
    initScaffold(dir)
    // .alfa/README.md is about alfa itself, not how this project works. If it got loaded
    // into the system prompt, every session would burn a few hundred tokens describing an
    // empty folder
    expect(discoverInstructions({ cwd: dir, root: dir, home: dir, configDirectory: join(dir, "cfg") })).toEqual([])
  })
})

describe("initPrompt", () => {
  test("names where to write, and excludes .alfa/", () => {
    const prompt = initPrompt({ root: "/repo", existing: false })
    expect(prompt).toContain(join("/repo", AGENTS_FILE))
    expect(prompt).toContain(`${ALFA_DIR}/`)
    expect(prompt).toContain("do not commit")
  })

  test("when one exists, the wording is 'improve', not 'write'", () => {
    const fresh = initPrompt({ root: dir, existing: false })
    const existing = initPrompt({ root: dir, existing: true })
    expect(fresh).toContain("from scratch")
    expect(existing).toContain("improve it in place")
    expect(existing).not.toContain("from scratch")
  })

  test("the user's note goes in the last paragraph", () => {
    const prompt = initPrompt({ root: dir, existing: false, note: "重点看后端" })
    expect(prompt).toContain("重点看后端")
    expect(prompt.trimEnd().endsWith("重点看后端")).toBe(true)
  })

  test("no note, no empty 'keep this in mind:' line", () => {
    expect(initPrompt({ root: dir, existing: false })).not.toContain("keep this in mind")
  })
})

describe("fits the reading half of instructions files", () => {
  test("once the model writes per the prompt, the next discovery finds it", () => {
    initScaffold(dir)
    // the model's step can't really run in a test, so we hand-write what it should
    // produce — this case watches that "an AGENTS.md written at the root really does get
    // picked up by discoverInstructions"
    writeFileSync(join(dir, AGENTS_FILE), "build with bun run build")
    const found = discoverInstructions({ cwd: dir, root: dir, home: dir, configDirectory: join(dir, "cfg") })
    expect(found).toHaveLength(1)
    expect(found[0]!.scope).toBe("project")
    expect(found[0]!.content).toContain("bun run build")
  })

  test("the path in the prompt is where discovery looks", () => {
    const prompt = initPrompt({ root: dir, existing: false })
    const path = join(dir, AGENTS_FILE)
    expect(prompt).toContain(path)
    writeFileSync(path, "x")
    expect(existsSync(path)).toBe(true)
    expect(discoverInstructions({ cwd: dir, root: dir, home: dir, configDirectory: join(dir, "cfg") })).toHaveLength(1)
  })
})
