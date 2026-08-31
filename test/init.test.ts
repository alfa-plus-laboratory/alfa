/**
 * `/init` 的两半:文件夹(代码建的)和提问(交给模型的)。
 *
 * 最要紧的一条在 "不覆盖已经在的 README" 那个用例上:一条会把用户写过的字
 * 冲掉的命令,用户只会遇到一次,之后再也不敢按 —— 而这种错 typecheck 拦不住,
 * 只有测试拦得住。
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
  // 只读目录的那个用例把权限改过,先还原,否则 rm 自己会失败
  try {
    chmodSync(dir, 0o755)
  } catch {}
  rmSync(dir, { recursive: true, force: true })
})

describe("initScaffold", () => {
  test("建出 .alfa/README.md,并报出建了什么", () => {
    const result = initScaffold(dir)
    expect(result.created).toEqual([`${ALFA_DIR}/README.md`])
    expect(result.failed).toBeUndefined()
    const readme = readFileSync(join(dir, ALFA_DIR, "README.md"), "utf8")
    // 三个保留位置写在文档里,它们是承诺 —— 落地时得对得上
    expect(readme).toContain("memory/")
    expect(readme).toContain("skills/")
    expect(readme).toContain("config.json")
  })

  test("再跑一次什么都不建,也不报建了", () => {
    initScaffold(dir)
    const again = initScaffold(dir)
    expect(again.created).toEqual([])
    expect(again.failed).toBeUndefined()
  })

  test("不覆盖已经在的 README", () => {
    mkdirSync(join(dir, ALFA_DIR))
    writeFileSync(join(dir, ALFA_DIR, "README.md"), "我自己写的")
    initScaffold(dir)
    expect(readFileSync(join(dir, ALFA_DIR, "README.md"), "utf8")).toBe("我自己写的")
  })

  test("建不出来时给出原因,而不是抛", () => {
    const readonly = join(dir, "ro")
    mkdirSync(readonly)
    chmodSync(readonly, 0o500)
    const result = initScaffold(readonly)
    // root 用户绕得过文件权限(CI 容器里很常见),那种环境下它是会成功的
    if (result.failed === undefined) expect(result.created).toEqual([`${ALFA_DIR}/README.md`])
    else expect(result.failed.length).toBeGreaterThan(0)
    chmodSync(readonly, 0o755)
  })

  test("建出来的东西不会被当成约定文件读进 prompt", () => {
    initScaffold(dir)
    // .alfa/README.md 讲的是 alfa 自己,不是这个项目怎么干活。它要是被
    // 装进 system prompt,每一场都白烧几百个 token 去讲一个空文件夹
    expect(discoverInstructions({ cwd: dir, root: dir, home: dir, configDirectory: join(dir, "cfg") })).toEqual([])
  })
})

describe("initPrompt", () => {
  test("点名写在哪,并把 .alfa/ 划出去", () => {
    const prompt = initPrompt({ root: "/repo", existing: false })
    expect(prompt).toContain(join("/repo", AGENTS_FILE))
    expect(prompt).toContain(`${ALFA_DIR}/`)
    expect(prompt).toContain("do not commit")
  })

  test("已经有一份时,措辞是「改」不是「写」", () => {
    const fresh = initPrompt({ root: dir, existing: false })
    const existing = initPrompt({ root: dir, existing: true })
    expect(fresh).toContain("from scratch")
    expect(existing).toContain("improve it in place")
    expect(existing).not.toContain("from scratch")
  })

  test("用户那句话跟到最后一段", () => {
    const prompt = initPrompt({ root: dir, existing: false, note: "重点看后端" })
    expect(prompt).toContain("重点看后端")
    expect(prompt.trimEnd().endsWith("重点看后端")).toBe(true)
  })

  test("没给话时不留一句空的「记住:」", () => {
    expect(initPrompt({ root: dir, existing: false })).not.toContain("keep this in mind")
  })
})

describe("和约定文件的读那一半接得上", () => {
  test("模型照着提问写完之后,下一次发现就能读到", () => {
    initScaffold(dir)
    // 模型那一步在测试里没法真跑,这里手写它该产出的东西 —— 这条用例盯的是
    // 「写在根上的 AGENTS.md 确实会被 discoverInstructions 捡起来」
    writeFileSync(join(dir, AGENTS_FILE), "build with bun run build")
    const found = discoverInstructions({ cwd: dir, root: dir, home: dir, configDirectory: join(dir, "cfg") })
    expect(found).toHaveLength(1)
    expect(found[0]!.scope).toBe("project")
    expect(found[0]!.content).toContain("bun run build")
  })

  test("提问里的路径就是发现那一半找的位置", () => {
    const prompt = initPrompt({ root: dir, existing: false })
    const path = join(dir, AGENTS_FILE)
    expect(prompt).toContain(path)
    writeFileSync(path, "x")
    expect(existsSync(path)).toBe(true)
    expect(discoverInstructions({ cwd: dir, root: dir, home: dir, configDirectory: join(dir, "cfg") })).toHaveLength(1)
  })
})
