/**
 * `@` 引用:索引、排序,和它在补全里的入口。
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

describe("文件索引", () => {
  test("扫出来的路径是相对工作区的", async () => {
    const index = new FileIndex(repo())
    await index.refresh()
    expect(index.ready).toBe(true)
    expect(values(index.search("README"))).toEqual(["@README.md"])
  })

  test("★ 文件名开头命中的排在路径里命中的前面", async () => {
    // 打 `chat` 想要的是那个叫 chat 的文件,不是某个路径里带 chat 的
    const index = new FileIndex(repo())
    await index.refresh()
    expect(values(index.search("chat"))[0]).toBe("@src/tui/panes/chat.ts")
  })

  test("同名文件按路径长短排 —— 浅的更可能是要找的那个", async () => {
    const index = new FileIndex(repo())
    await index.refresh()
    expect(values(index.search("app.ts")).slice(0, 2)).toEqual(["@src/app.ts", "@src/tui/app.ts"])
  })

  test("查询里带斜杠就只比路径", async () => {
    const index = new FileIndex(repo())
    await index.refresh()
    const found = values(index.search("tui/"))
    expect(found).toContain("@src/tui/app.ts")
    expect(found).not.toContain("@src/app.ts")
  })

  test("目录也是候选,而且带结尾斜杠", async () => {
    const index = new FileIndex(repo())
    await index.refresh()
    expect(values(index.search("panes"))).toContain("@src/tui/panes/")
  })

  test("★ 已经打全的那个目录不再列出来 —— 补上去一个字都不会变", async () => {
    const index = new FileIndex(repo())
    await index.refresh()
    const found = values(index.search("src/tui/"))
    expect(found).not.toContain("@src/tui/")
    expect(found).toContain("@src/tui/app.ts")
  })

  test("空查询给最浅的那几个", async () => {
    const index = new FileIndex(repo())
    await index.refresh()
    expect(values(index.search("", 2))).toEqual(["@README.md", "@package.json"])
  })

  test("还没扫完时给空,不阻塞", () => {
    // 同步调用,不 await refresh —— 界面每帧都会走这条路
    const index = new FileIndex(repo())
    expect(index.search("app")).toEqual([])
  })

  test("目录补完不带空格,文件补完带", async () => {
    const index = new FileIndex(repo())
    await index.refresh()
    expect(index.search("panes").find((one) => one.value.endsWith("/"))?.more).toBeUndefined()
    expect(index.search("README")[0]!.more).toBe(true)
  })
})

describe("补全里的 @", () => {
  const files = (query: string): CompletionItem[] =>
    ["src/app.ts", "src/tui/app.ts"]
      .filter((path) => path.includes(query))
      .map((path) => ({ value: "@" + path, hint: "", more: true }))

  test("★ 一句话中间的 @ 也认 —— 它是词,不是命令", () => {
    const text = "看一下 @src/tu"
    const found = complete(text, text.length, files)
    expect(found).toBeDefined()
    expect(found!.from).toBe(text.indexOf("@"))
    expect(values(found!.items)).toEqual(["@src/tui/app.ts"])
  })

  test("补进去只替换那个词,前后原样", () => {
    const text = "看一下 @src/tu"
    const found = complete(text, text.length, files)!
    expect(apply(text, found, found.items[0]!)).toBe("看一下 @src/tui/app.ts ")
  })

  test("换行之后的 @ 照样认(斜杠命令则不认)", () => {
    const text = "第一行\n@src/app"
    expect(complete(text, text.length, files)).toBeDefined()
    expect(complete("/help\n/he", 9, files)).toBeUndefined()
  })

  test("没给文件源就当没有 @ —— 不是报错,是没这个功能", () => {
    expect(complete("@src/app", 8)).toBeUndefined()
  })

  test("一条都没匹配上就不弹框", () => {
    expect(complete("@zzzz", 5, files)).toBeUndefined()
  })

  test("裸一个 @ 也弹 —— 它就是「给我看看有什么」", () => {
    expect(complete("@", 1, files)).toBeDefined()
  })

  test("邮箱地址那种 @ 不会误弹(前面没有空白就不是词首)", () => {
    // a@b 里的 @ 不在词首,往回扫到的词是 "a@b",不以 @ 开头
    expect(complete("mail a@b", 8, files)).toBeUndefined()
  })
})
