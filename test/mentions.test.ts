/**
 * `@` mentions: the index, the ranking, and their entry point in completion.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { apply, complete, type CompletionItem } from "../src/cli/commands.ts"
import { FileIndex } from "../src/cli/mentions.ts"

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "apc-mentions-"))
  mkdirSync(join(root, "src", "tui", "panes"), { recursive: true })
  mkdirSync(join(root, "test"), { recursive: true })
  writeFileSync(join(root, "README.md"), "#\n")
  writeFileSync(join(root, "package.json"), "{}\n")
  writeFileSync(join(root, "src", "app.ts"), "\n")
  writeFileSync(join(root, "src", "tui", "app.ts"), "\n")
  writeFileSync(join(root, "src", "tui", "panes", "chat.ts"), "\n")
  writeFileSync(join(root, "test", "app.test.ts"), "\n")
  return root
}

const values = (items: CompletionItem[]) => items.map((item) => item.value)

describe("file index", () => {
  test("scanned paths are workspace-relative", async () => {
    const index = new FileIndex(repo())
    await index.refresh()
    expect(index.ready).toBe(true)
    expect(values(index.search("README"))).toEqual(["@README.md"])
  })

  test("★ filename-prefix matches rank above matches elsewhere in the path", async () => {
    // typing `chat` means the file named chat, not some path that happens to contain chat
    const index = new FileIndex(repo())
    await index.refresh()
    expect(values(index.search("chat"))[0]).toBe("@src/tui/panes/chat.ts")
  })

  test("same-named files sort by path length — the shallower one is more likely the target", async () => {
    const index = new FileIndex(repo())
    await index.refresh()
    expect(values(index.search("app.ts")).slice(0, 2)).toEqual(["@src/app.ts", "@src/tui/app.ts"])
  })

  test("a query containing a slash matches against the path only", async () => {
    const index = new FileIndex(repo())
    await index.refresh()
    const found = values(index.search("tui/"))
    expect(found).toContain("@src/tui/app.ts")
    expect(found).not.toContain("@src/app.ts")
  })

  test("directories are candidates too, with a trailing slash", async () => {
    const index = new FileIndex(repo())
    await index.refresh()
    expect(values(index.search("panes"))).toContain("@src/tui/panes/")
  })

  test("★ a fully typed directory isn't listed again — completing it would change nothing", async () => {
    const index = new FileIndex(repo())
    await index.refresh()
    const found = values(index.search("src/tui/"))
    expect(found).not.toContain("@src/tui/")
    expect(found).toContain("@src/tui/app.ts")
  })

  test("an empty query returns the shallowest entries", async () => {
    const index = new FileIndex(repo())
    await index.refresh()
    expect(values(index.search("", 2))).toEqual(["@README.md", "@package.json"])
  })

  test("returns empty before the scan finishes, without blocking", () => {
    // synchronous call, no await on refresh — the UI takes this path on every frame
    const index = new FileIndex(repo())
    expect(index.search("app")).toEqual([])
  })

  test("completing a directory adds no trailing space, completing a file does", async () => {
    const index = new FileIndex(repo())
    await index.refresh()
    expect(index.search("panes").find((one) => one.value.endsWith("/"))?.more).toBeUndefined()
    expect(index.search("README")[0]!.more).toBe(true)
  })
})

describe("@ in completion", () => {
  const files = (query: string): CompletionItem[] =>
    ["src/app.ts", "src/tui/app.ts"]
      .filter((path) => path.includes(query))
      .map((path) => ({ value: "@" + path, hint: "", more: true }))

  test("★ an @ mid-sentence is recognized — it's a word, not a command", () => {
    const text = "看一下 @src/tu"
    const found = complete(text, text.length, files)
    expect(found).toBeDefined()
    expect(found!.from).toBe(text.indexOf("@"))
    expect(values(found!.items)).toEqual(["@src/tui/app.ts"])
  })

  test("completion replaces only that word, leaving the rest as is", () => {
    const text = "看一下 @src/tu"
    const found = complete(text, text.length, files)!
    expect(apply(text, found, found.items[0]!)).toBe("看一下 @src/tui/app.ts ")
  })

  test("an @ after a newline is still recognized (a slash command is not)", () => {
    const text = "第一行\n@src/app"
    expect(complete(text, text.length, files)).toBeDefined()
    expect(complete("/help\n/he", 9, files)).toBeUndefined()
  })

  test("no file source means no @ — not an error, just no such feature", () => {
    expect(complete("@src/app", 8)).toBeUndefined()
  })

  test("no popup when nothing matches", () => {
    expect(complete("@zzzz", 5, files)).toBeUndefined()
  })

  test("a bare @ pops up too — it means 'show me what's there'", () => {
    expect(complete("@", 1, files)).toBeDefined()
  })

  test("an email-style @ doesn't trigger (without preceding whitespace it's not a word start)", () => {
    // the @ in a@b is not at a word start; scanning back gives the word "a@b", which
    // doesn't start with @
    expect(complete("mail a@b", 8, files)).toBeUndefined()
  })
})
