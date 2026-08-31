/**
 * 后台任务。
 *
 * 这一组真的起进程 —— 因为要测的东西全都在进程边界上:游标、当场就死的那条路、
 * 杀不杀得干净。用假对象测的话,通过的会是"我对 spawn 的想象"。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveShell } from "../src/env/shell.ts"
import { BashTool } from "../src/tool/bash.ts"
import { __resetForTest, kill, killAll, list, nameFor, ownedBy, read, setJobObserver, start, MAX_JOBS } from "../src/tool/bash/jobs.ts"
import { createToolContext } from "../src/tool/context.ts"
import { JobTool } from "../src/tool/job.ts"
import type { AgentJobs, JobSnapshot } from "../src/tool/background.ts"

let root: string
let counter = 0

const ctx = () =>
  createToolContext(
    {
      cwd: root,
      root,
      sessionID: "test",
      async ask() {},
      onProgress() {},
      onMetadata() {},
    },
    { messageID: "m", callID: `job${counter++}`, abortSignal: new AbortController().signal },
  )

const run = (command: string) => start({ command, workdir: root, shell: resolveShell({ platform: "linux", env: { SHELL: "/bin/sh" } }) })

/** 等到断言成立,或者超时。轮询比 sleep 一个猜出来的秒数稳 */
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("timed out waiting for a condition")
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "apc-jobs-"))
  __resetForTest()
})

afterEach(async () => {
  await killAll()
  __resetForTest()
  rmSync(root, { recursive: true, force: true })
})

describe("起", () => {
  test("长命的进程立刻回话,不站在那儿等", async () => {
    const started = Date.now()
    const result = await run("sleep 30")
    expect(result.kind).toBe("started")
    // 只等了那几百毫秒的观察期,不是 30 秒
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(list()[0]!.status).toBe("running")
  })

  test("★ 当场就死的报成失败,不能报成「已启动」", async () => {
    // 打错一个字母的命令会在几十毫秒内以非 0 退出。报成"起来了"的话,
    // 模型会安心去干别的,五分钟后才发现根本没起来
    const result = await run("definitely-not-a-real-command-xyz")
    expect(result.kind).toBe("exited")
    expect(result.job.exit).not.toBe(0)
    expect(result.output).toContain("not found")
  })

  test("秒退但成功的,也照实说成结束了", async () => {
    const result = await run("echo hello")
    expect(result.kind).toBe("exited")
    expect(result.job.exit).toBe(0)
    expect(result.output).toContain("hello")
  })

  test("起太多要拦 —— 一个在循环里起任务的模型能把机器压垮", async () => {
    for (let i = 0; i < MAX_JOBS; i++) await run("sleep 30")
    expect(run("sleep 30")).rejects.toThrow(/Too many background jobs/)
  })
})

describe("读", () => {
  test("★ 游标:每次只给新的那一段", async () => {
    // 两句都排在观察期(SETTLE_MS)之后 —— 观察期内的输出会被 start() 自己带走,
    // 那是刻意的(打错的命令要当场知道),但会盖住这里要测的东西
    const started = await run("sleep 0.8; echo one; sleep 0.8; echo two; sleep 30")
    expect(started.kind).toBe("started")
    const job = started.job

    const first = await read(job.id, 3_000)
    expect(first.output).toContain("one")
    expect(first.output).not.toContain("two")

    // 第一次读完,没有新东西之前再读就是空的 —— 不重念
    const empty = await read(job.id)
    expect(empty.output).toBe("")

    const second = await read(job.id, 3_000)
    expect(second.output).toContain("two")
    expect(second.output).not.toContain("one")
  })

  test("wait:等到有输出才回来,不用猜 sleep 几秒", async () => {
    const job = (await run("sleep 1; echo listening on 3000; sleep 30")).job
    const started = Date.now()
    const result = await read(job.id, 5_000)
    expect(result.output).toContain("listening on 3000")
    expect(result.timedOut).toBe(false)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("wait 到点了也要回来,并说清是等超时了", async () => {
    const job = (await run("sleep 30")).job
    const result = await read(job.id, 200)
    expect(result.timedOut).toBe(true)
    expect(result.job.status).toBe("running")
  })

  test("★ 等着的时候进程退出,要立刻唤醒 —— 不是傻等到超时", async () => {
    const job = (await run("sleep 0.3")).job
    const started = Date.now()
    const result = await read(job.id, 10_000)
    expect(result.job.status).toBe("exited")
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("退出之后记录还在 —— 「没这个任务」和「它失败了」是两个答案", async () => {
    const started = await run("echo bye; exit 3")
    // 观察期内说的话由 start() 带走(模型在 bash 的结果里已经看到了)
    expect(started.output).toContain("bye")

    const result = await read(started.job.id)
    expect(result.job.status).toBe("exited")
    expect(result.job.exit).toBe(3)
    // 已经读过的不重念,但记录还在 —— 这正是"它失败了"和"没这个任务"的区别
    expect(result.output).toBe("")
  })

  test("不认识的 id 报错报清楚", async () => {
    expect(read("nope")).rejects.toThrow(/No background job named/)
  })
})

describe("停", () => {
  test("kill 之后进程真的没了", async () => {
    const job = (await run("sleep 30")).job
    await kill(job.id)
    expect(list()[0]!.status).toBe("exited")
  })

  test("★ killAll 要杀整个进程组 —— 孙进程不能活下来", async () => {
    // 外层 shell 死了但孙子还在,是 kill.ts 里记着的那条逃生路径
    const job = (await run("sh -c 'sleep 30' & wait")).job
    await until(() => list().length === 1)
    const killed = await killAll()
    expect(killed).toBe(1)
    await until(() => list()[0]!.status === "exited")
    expect(list()[0]!.id).toBe(job.id)
  })

  test("已经退出的再 kill 不报错", async () => {
    const job = (await run("echo done")).job
    await until(() => list()[0]!.status === "exited")
    const result = await kill(job.id)
    expect(result.job.status).toBe("exited")
  })

  test("★ 真停掉了就不带那句「但是」—— 它只在没确认干净时出现", async () => {
    const job = (await run("sleep 30")).job
    const result = await kill(job.id)
    expect(result.job.status).toBe("exited")
    expect(result.detail).toBeUndefined()
  })
})

// ─────────────────────────────────────────────── 「停了」这句话得是真的

describe("★ job kill 不许报一个没发生的成功", () => {
  /**
   * 一个**停不掉**的任务表。
   *
   * 真机上撞出来的是 Windows 那条(taskkill 拒绝访问、或者只杀掉了树顶),而在
   * Linux 上 SIGKILL 杀不掉任何东西 —— 所以这里从注入的那一侧造这个状态:
   * AgentJobs 本来就是注入进来的接口(见 tool/background.ts),它回什么,
   * `job` 工具就得照着说什么。
   */
  const stubborn = (over: Partial<JobSnapshot> = {}): AgentJobs => {
    const snapshot: JobSnapshot = {
      id: "dev",
      kind: "process",
      command: "npm run dev",
      workdir: "/repo",
      status: "running",
      startedAt: 1,
      pending: 0,
      ...over,
    }
    return {
      start: async () => snapshot,
      resume: async () => snapshot,
      list: () => [snapshot],
      has: (id) => id === snapshot.id,
      read: async () => ({ job: snapshot, output: "", timedOut: false }),
      kill: async () => ({ job: snapshot, output: "", timedOut: false, detail: "taskkill exited with 1" }),
      report: () => undefined,
      claimReport: () => undefined,
    }
  }

  const withAgents = (agents: AgentJobs) =>
    createToolContext(
      {
        cwd: root,
        root,
        sessionID: "test",
        agents,
        async ask() {},
        onProgress() {},
        onMetadata() {},
      },
      { messageID: "m", callID: `job${counter++}`, abortSignal: new AbortController().signal },
    )

  test("★ 停不掉就说停不掉 —— 一个不可信的成功消息比一个失败消息糟得多", async () => {
    const result = await JobTool.execute({ action: "kill", id: "dev" }, withAgents(stubborn()))
    expect(result.output).toContain("Could NOT stop dev")
    expect(result.output).toContain("taskkill exited with 1")
    expect(result.output).toMatch(/still running/i)
    expect(result.metadata["killed"]).toBe(false)
    expect(result.title).toContain("still running")
  })

  test("★ 记录标成完成、但没杀干净:照旧说「停了」,后面挂上那句「但是」", async () => {
    const agents = stubborn({ status: "exited", exit: 0, endedAt: 2 })
    const result = await JobTool.execute({ action: "kill", id: "dev" }, withAgents(agents))
    expect(result.output).toContain("Stopped dev")
    expect(result.output).toContain("taskkill exited with 1")
    // 而且要说清下一步怎么自己确认 —— 端口在不在是唯一能查的东西
    expect(result.output).toMatch(/port/i)
    expect(result.metadata["killed"]).toBe(true)
  })
})

describe("留痕", () => {
  test("起落都通知界面 —— 看不见的后台进程就是看不见的自动化", async () => {
    const seen: string[] = []
    setJobObserver((event) => seen.push(`${event.kind}:${event.job.id}`))

    const job = (await run("sleep 30")).job
    expect(seen).toContain(`started:${job.id}`)

    await kill(job.id)
    await until(() => seen.some((line) => line.startsWith("exited:")))
    expect(seen).toContain(`exited:${job.id}`)
  })

  test("当场就死的不报「起来了」,只报结束", async () => {
    const seen: string[] = []
    setJobObserver((event) => seen.push(event.kind))
    await run("exit 1")
    expect(seen).not.toContain("started")
    expect(seen).toContain("exited")
  })
})

describe("bash background: true", () => {
  test("走的是同一条授权路,回来的是一个任务 id", async () => {
    const asked: string[] = []
    const tool = createToolContext(
      {
        cwd: root,
        root,
        sessionID: "test",
        async ask(input) {
          asked.push(...input.patterns)
        },
        onProgress() {},
        onMetadata() {},
      },
      { messageID: "m", callID: `bg${counter++}`, abortSignal: new AbortController().signal },
    )

    const result = await BashTool.execute({ command: "sleep 30", background: true }, tool)
    // ★ 后台不是绕开门卫的后门:命令照旧被授权了一次
    expect(asked).toEqual(["sleep 30"])
    expect(result.output).toContain("Started background job")
    expect(result.metadata["alive"]).toBe(true)
    expect(list()).toHaveLength(1)
  })

  test("当场死掉的那条路,bash 也要说成失败", async () => {
    const result = await BashTool.execute({ command: "exit 7", background: true }, ctx())
    expect(result.output).toContain("exited immediately")
    expect(result.metadata["alive"]).toBe(false)
    expect(result.metadata["exit"]).toBe(7)
  })

  test("不带 background 还是老样子:站着等它跑完", async () => {
    const result = await BashTool.execute({ command: "echo sync" }, ctx())
    expect(result.output).toContain("sync")
    expect(list()).toHaveLength(0)
  })
})

describe("★ 名字要能说清自己是谁", () => {
  const name = (command: string) => {
    __resetForTest()
    return nameFor(command)
  }

  test("跑的是什么比拿什么跑重要", () => {
    expect(name("npm run dev")).toBe("dev")
    expect(name("bun test --watch")).toBe("test")
    expect(name("cargo watch -x run")).toBe("watch")
    expect(name("go build ./...")).toBe("build")
    expect(name("pnpm run build:prod")).toBe("build-prod")
  })

  test("脚本去掉路径和扩展名", () => {
    expect(name("./scripts/deploy.sh")).toBe("deploy")
    expect(name("python3 manage.py runserver")).toBe("manage")
  })

  test("不是运行器就取命令本身", () => {
    expect(name("sleep 30")).toBe("sleep")
    expect(name("tail -f /var/log/syslog")).toBe("tail")
  })

  test("前面挂环境变量 / sudo 不算数", () => {
    expect(name("PORT=3000 npm run dev")).toBe("dev")
    expect(name("sudo systemctl restart nginx")).toBe("systemctl")
  })

  test("★ 后面是一坨代码就退回运行器,不能拿引号当名字", () => {
    expect(name(`bun -e 'Bun.serve({port:3000})'`)).toBe("bun")
    expect(name(`sh -c "while true; do echo hi; done"`)).toBe("sh")
  })

  test("★ 名字不回收 —— 模型手里可能还攥着上一个", () => {
    __resetForTest()
    expect(nameFor("npm run dev")).toBe("dev")
    expect(nameFor("npm run dev")).toBe("dev-2")
    expect(nameFor("npm run dev")).toBe("dev-3")
  })

  test("真起一个任务,拿到的就是这个名字", async () => {
    const result = await run("sleep 30")
    expect(result.job.id).toBe("sleep")
  })
})

describe("★ 谁起的要记着", () => {
  test("子 agent 起的进程带着 owner —— 它的起落不该报进用户那段对话", async () => {
    const result = await start({
      command: "sleep 5",
      workdir: root,
      shell: resolveShell(),
      owner: "调查agent",
    })
    expect(result.job.owner).toBe("调查agent")
    // 主 agent 自己起的没有,界面照旧留收据
    const mine = await start({ command: "sleep 5", workdir: root, shell: resolveShell() })
    expect(mine.job.owner).toBeUndefined()
  })
})

describe("★ 子 agent 碰不到主 agent 的进程", () => {
  test("list 按 owner 过滤:主 agent 看得见全部,子 agent 只看得见自己起的", async () => {
    await start({ command: "sleep 5", workdir: root, shell: resolveShell() })
    await start({ command: "sleep 6", workdir: root, shell: resolveShell(), owner: "调查agent" })
    expect(list().length).toBe(2)
    expect(list("调查agent").map((job) => job.command)).toEqual(["sleep 6"])
  })

  test("★ 不是自己起的就当不存在 —— 共用一个读游标,读一下就把别人的输出取走了", async () => {
    const mine = await start({ command: "sleep 5", workdir: root, shell: resolveShell() })
    expect(ownedBy(mine.job.id, undefined)).toBe(true)
    expect(ownedBy(mine.job.id, "调查agent")).toBe(false)
  })

  test("killAll 可以只收某一个子 agent 起的那些", async () => {
    await start({ command: "sleep 5", workdir: root, shell: resolveShell() })
    await start({ command: "sleep 6", workdir: root, shell: resolveShell(), owner: "调查agent" })
    expect(await killAll("调查agent")).toBe(1)
    expect(list().filter((job) => job.status === "running").length).toBe(1)
  })
})
