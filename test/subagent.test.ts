/**
 * 子 agent。
 *
 * 用假的 stream 喂固定事件(和 agent-loop.test.ts 同一套路),测的是**后台那一层**:
 * 起完立刻回来、游标只给新的、报告是最后那段话、停得掉、名字不和进程撞、
 * 那几场会话不进"接着聊"的清单。
 *
 * 真正的循环行为由 agent-loop.test.ts 覆盖,这里不再接一遍 —— 接了只会让
 * 失败原因变模糊。
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { SubagentJobs, MAX_AGENT_JOBS } from "../src/agent/subagent.ts"
import { MAX_ALIVE_JOBS, MAX_FLOW_ALIVE_JOBS } from "../src/agent/flow.ts"
import { Store } from "../src/session/store.ts"
import { newSessionID } from "../src/session/id.ts"
import { __resetNamesForTest, reserveName } from "../src/tool/background.ts"
import type { LLMEvent, LLMRequest, ModelInfo } from "../src/llm/types.ts"
import type { ToolContext } from "../src/tool/types.ts"
import { JobTool } from "../src/tool/job.ts"
import { TaskTool } from "../src/tool/task.ts"

const INFO: ModelInfo = {
  ref: { providerID: "p", modelID: "m" },
  limit: { context: 200_000, output: 32_000 },
  supportsThinking: false,
  promptTemplate: "default",
  cacheInInput: false,
}

const tokens = (input: number, output = 0) => ({
  input,
  output,
  reasoning: 0,
  cache: { read: 0, write: 0 },
})

const say = (text: string): LLMEvent[] => [
  { type: "step-start" },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", text },
  { type: "text-end", id: "t" },
  { type: "step-finish", finishReason: "stop", tokens: tokens(100, 10) },
]

const readThenSay = (text: string): LLMEvent[][] => [
  [
    { type: "step-start" },
    { type: "tool-call", callID: "c1", tool: "read", input: { filePath: "src/auth/token.ts" } },
    { type: "tool-result", callID: "c1", tool: "read", output: "…" },
    { type: "step-finish", finishReason: "tool-calls", tokens: tokens(100, 10) },
  ],
  say(text),
]

interface HarnessOptions {
  /** 每轮的事件。超出就用最后一条 */
  script?: LLMEvent[][]
  /** 让流一直挂着不结束(测"还在跑"和 kill) */
  hang?: boolean
  /**
   * 让流卡在开头,等测试自己按 release()。
   *
   * hang 是"停不下来",这个是"我说了才走" —— 有了它才测得了「它还在跑的时候
   * 又派了个下家」这类时序,而那正是编排唯一会出错的地方。
   */
  hold?: boolean
  /** agentflow 的窗口。false = 关(缺省) */
  flow?: number | false
}

function harness(options: HarnessOptions = {}) {
  __resetNamesForTest()
  let letGo = () => {}
  const held = new Promise<void>((resolve) => {
    letGo = resolve
  })
  const store = new Store(":memory:")
  const parent = newSessionID()
  store.createSession(parent, "/repo")
  /** 现在是哪一场。可变 —— `/clear` 会在跑着的时候把它换掉 */
  const session = { id: parent }
  const events: Array<{ kind: string; id: string; exit?: number | null; steps?: number; feeds?: string[] }> = []
  const requests: LLMRequest[] = []
  /** 「盘上可能变了」响了几次。见下面那条:文件树是它唯一接进主界面的东西 */
  const refreshes = { files: 0, panel: 0 }

  const agents = new SubagentJobs({
    store,
    model: () => ({ providerID: "p", modelID: "m" }),
    info: () => INFO,
    tools: () => [],
    system: () => ["TEMPLATE", "SUBAGENT"],
    directory: "/repo",
    session: () => session.id,
    makeToolContext: (job, call): ToolContext => ({
      cwd: "/repo",
      root: "/repo",
      sessionID: job.sessionID,
      messageID: call.messageID,
      callID: call.callID,
      abortSignal: call.abortSignal,
      ask: async () => {},
      onProgress: () => {},
      metadata: () => {},
    }),
    onChange: () => refreshes.panel++,
    onFilesChanged: () => refreshes.files++,
    flow: () => options.flow ?? false,
    observer: (event) =>
      events.push({
        kind: event.kind,
        id: event.job.id,
        ...(event.job.exit !== undefined ? { exit: event.job.exit } : {}),
        ...(event.job.steps !== undefined ? { steps: event.job.steps } : {}),
        ...(event.job.feeds !== undefined ? { feeds: event.job.feeds } : {}),
      }),
    stream(request) {
      requests.push(request)
      const script = options.script ?? [say("done")]
      const entry = script[Math.min(requests.length - 1, script.length - 1)]!
      return {
        info: INFO,
        events: (async function* () {
          if (options.hang) {
            // 一直挂着,直到调用方 abort。abort 之后生成器被丢掉,Loop 走中断那条路
            await new Promise<void>((resolve) => {
              if (request.abortSignal?.aborted) return resolve()
              request.abortSignal?.addEventListener("abort", () => resolve(), { once: true })
            })
            throw Object.assign(new Error("aborted"), { name: "AbortError" })
          }
          if (options.hold) await held
          for (const event of entry) yield event
        })(),
      }
    },
  })

  return { store, parent, session, agents, events, requests, refreshes, release: () => letGo() }
}

/**
 * 那个子 agent 开在哪一场会话里。
 *
 * JobSnapshot 上**故意没有** sessionID(模型不需要知道,界面也不需要),所以
 * 这里直接问库:子会话就是 parent_id 有值的那些(见 agent/subagent.ts)。
 */
function sessionOf(h: { store: Store }, _id: string): string {
  const db = (h.store as unknown as { db: { query(sql: string): { all(): unknown[] } } }).db
  const rows = db.query(`SELECT id FROM session WHERE parent_id IS NOT NULL`).all() as Array<{ id: string }>
  return rows[0]?.id ?? ""
}

/** 等到这个任务不再是 running(或者超时) */
async function settled(agents: SubagentJobs, id: string, ms = 2_000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // ★ 判的是 exited,不是「不在跑」—— 排队中的也不在跑,而它连活儿都还没开始
    if (agents.list().find((job) => job.id === id)?.status === "exited") return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// ─────────────────────────────────────────────── 叫醒跑完的那个

describe("叫醒", () => {
  test("★ 接着原来那场会话 —— 它手上还攥着上一轮读过的全部东西", async () => {
    const h = harness({ script: [say("第一份报告"), say("第二份报告")] })
    const job = await h.agents.start({ name: "scout", prompt: "先看一遍" })
    await settled(h.agents, job.id)
    const first = h.store.listAll(sessionOf(h, job.id)).length

    const again = await h.agents.resume(job.id, "再看一下测试那边")
    expect(again.id).toBe(job.id)
    await settled(h.agents, job.id)

    // 同一场会话:上一轮的话还在,新的一句接在后面
    const history = h.store.listAll(sessionOf(h, job.id))
    expect(history.length).toBeGreaterThan(first)
    expect(JSON.stringify(history)).toContain("先看一遍")
    expect(JSON.stringify(history)).toContain("再看一下测试那边")
    // 一共还是**一个** agent,不是两个
    expect(h.agents.list()).toHaveLength(1)
  })

  test("★ 新的报告能再交一次 —— 上一份已经交过了,不能因此把这一份也算交过", async () => {
    const h = harness({ script: [say("第一份"), say("第二份")] })
    const job = await h.agents.start({ name: "scout", prompt: "看" })
    await settled(h.agents, job.id)
    expect(h.agents.claimReport(job.id)).toContain("第一份")
    // 交过一次之后就取不到了
    expect(h.agents.claimReport(job.id)).toBeUndefined()

    await h.agents.resume(job.id, "再看")
    await settled(h.agents, job.id)
    expect(h.agents.claimReport(job.id)).toContain("第二份")
  })

  test("★ 还在跑的不能叫 —— 它的答案本来就会自己回来", async () => {
    const h = harness({ hang: true })
    const job = await h.agents.start({ name: "slow", prompt: "等" })
    await expect(h.agents.resume(job.id, "再来一句")).rejects.toThrow(/still working/)
    await h.agents.killAll()
  })

  test("不认识的名字照实说", async () => {
    const h = harness()
    await expect(h.agents.resume("nobody", "喂")).rejects.toThrow(/No subagent named/)
  })

  test("空交代不受理 —— 叫醒一个 agent 然后什么都不说,它只能自己猜", async () => {
    const h = harness()
    const job = await h.agents.start({ name: "scout", prompt: "看" })
    await settled(h.agents, job.id)
    await expect(h.agents.resume(job.id, "   ")).rejects.toThrow(/prompt is required/)
  })

  test("步数和花费累加,秒表重新走 —— 账问的是「这个 agent 一共花了多少」", async () => {
    const h = harness({ script: [readThenSay("一")[0]!, readThenSay("一")[1]!, say("二")] })
    const job = await h.agents.start({ name: "scout", prompt: "看" })
    await settled(h.agents, job.id)
    const before = h.agents.list()[0]!
    await h.agents.resume(job.id, "再看")
    await settled(h.agents, job.id)
    const after = h.agents.list()[0]!
    expect(after.steps!).toBeGreaterThan(before.steps!)
    expect(after.tokensIn!).toBeGreaterThan(before.tokensIn!)
    expect(after.startedAt).toBeGreaterThanOrEqual(before.startedAt)
    expect(after.status).toBe("exited")
  })

  test("★ /clear 之后叫不醒上一场那些 —— 它们不属于这场对话", async () => {
    const h = harness({ script: [say("一"), say("二")] })
    const job = await h.agents.start({ name: "scout", prompt: "看" })
    await settled(h.agents, job.id)

    h.session.id = "另一场"
    await expect(h.agents.resume(job.id, "再看")).rejects.toThrow(/No subagent named/)
    // 归属没被改写:接回原来那一场,它照旧是那一场的
    expect(h.agents.parentOf(job.id)).toBe(h.parent)
    h.session.id = h.parent
    await h.agents.resume(job.id, "再看")
    await settled(h.agents, job.id)
  })

  test("叫醒的那次也留痕 —— 面板和收据上要看得见它又动起来了", async () => {
    const h = harness({ script: [say("一"), say("二")] })
    const job = await h.agents.start({ name: "scout", prompt: "看" })
    await settled(h.agents, job.id)
    h.events.length = 0
    await h.agents.resume(job.id, "再看一遍那个文件")
    await settled(h.agents, job.id)
    expect(h.events.map((event) => event.kind)).toEqual(["exited"])
    // 面板上那一行换成这次的活儿 —— 名字回答"这是个什么",这一行回答"它现在在干什么"
    expect(h.agents.list()[0]!.command).toBe("再看一遍那个文件")
  })
})

// ─────────────────────────────────────────────── 归属

describe("跟着派它出去的那一场走", () => {
  test("★ 换了一场对话就看不见上一场那些 —— 那个全新的 agent 没派过它们", async () => {
    const h = harness()
    const job = await h.agents.start({ name: "scout", prompt: "看" })
    await settled(h.agents, job.id)
    expect(h.agents.list()).toHaveLength(1)

    h.session.id = "另一场"
    expect(h.agents.list()).toEqual([])
    expect(h.agents.has(job.id)).toBe(false)
    // 读、停、取报告一律当它不存在 —— 报"不许碰"只会让模型去找绕过去的办法
    await expect(h.agents.read(job.id, 0)).rejects.toThrow(/No subagent named/)
    await expect(h.agents.kill(job.id)).rejects.toThrow(/No subagent named/)
    expect(h.agents.report(job.id)).toBeUndefined()
    expect(h.agents.claimReport(job.id)).toBeUndefined()
  })

  test("★ 接回原来那一场,它们跟着回来 —— 归属记在任务上,「现在是哪一场」是现取的", async () => {
    const h = harness()
    const job = await h.agents.start({ name: "scout", prompt: "看" })
    await settled(h.agents, job.id)
    h.session.id = "另一场"
    expect(h.agents.list()).toEqual([])
    h.session.id = h.parent
    expect(h.agents.list().map((each) => each.id)).toEqual([job.id])
    expect(h.agents.claimReport(job.id)).toBeDefined()
  })
})

// ─────────────────────────────────────────────── 起

describe("派一个出去", () => {
  test("名字按**性质**取,面板上那一行写的是交代的头一句", async () => {
    const h = harness()
    const job = await h.agents.start({
      name: "audit agent",
      prompt: "Check how auth works.\nStart from src/auth/.",
    })
    expect(job.id).toBe("audit-agent")
    expect(job.kind).toBe("agent")
    // 名字回答"这是个什么",这一行回答"它这次在干什么"
    expect(job.command).toBe("Check how auth works.")
    expect(h.agents.list().map((each) => each.id)).toEqual(["audit-agent"])
  })

  test("★ 名字支持中文 —— 全删非 ASCII 的话每个中文名字都会退化成 job / job-2", async () => {
    const h = harness()
    const first = await h.agents.start({ name: "调查agent", prompt: "看看磁盘" })
    const second = await h.agents.start({ name: "调查agent", prompt: "再看看内存" })
    expect(first.id).toBe("调查agent")
    expect(second.id).toBe("调查agent-2")
  })

  test("名字太长按**显示宽度**截 —— 中日韩一个字占两列,按字符数截会把那一列撑爆", async () => {
    const h = harness()
    const job = await h.agents.start({ name: "调查电脑存储空间的那个非常长的名字", prompt: "go" })
    expect(job.id).toBe("调查电脑存储空间")
  })

  test("★ 名字和后台进程共用一本账 —— 两边撞名的话 job output 只能靠运气", async () => {
    const h = harness()
    reserveName("audit-agent") // 假装一个同名进程已经在跑
    const job = await h.agents.start({ name: "audit agent", prompt: "check it" })
    expect(job.id).toBe("audit-agent-2")
  })

  test("活儿本身作为第一条 user 消息发出去,不拼进 system", async () => {
    const h = harness()
    await h.agents.start({ name: "count files", prompt: "count the ts files under src" })
    expect(h.requests[0]!.system).toEqual(["TEMPLATE", "SUBAGENT"])
    const first = JSON.stringify(h.requests[0]!.messages)
    expect(first).toContain("count the ts files under src")
  })

  test("★ 它那场会话不进「接着聊」的清单 —— 用户要接的是自己那场", async () => {
    const h = harness()
    // 父会话得先说过一句话才会出现在清单里(空壳不算数),这样"少了谁"才看得出来
    h.store.upsertMessage({ id: "msg_parent", sessionID: h.parent, role: "user", timeCreated: Date.now() })
    await h.agents.start({ name: "scout", prompt: "look around" })
    await settled(h.agents, "scout")
    // 子 agent 那一场是有消息的(它把活儿和回答都写进去了),所以它没出现在
    // 这份清单里,只可能是被 parent_id 筛掉了
    const sessions = h.store.listSessions({ directory: "/repo" })
    expect(sessions.map((session) => session.id)).toEqual([h.parent])
  })

  test("同时最多几个在跑,超出的**排队**而不是报错", async () => {
    const h = harness({ hang: true })
    for (let n = 0; n < MAX_AGENT_JOBS; n++) {
      await h.agents.start({ name: `job ${n}`, prompt: "wait" })
    }
    const extra = await h.agents.start({ name: "one more", prompt: "wait" })
    expect(extra.status).toBe("queued")
    // 窗口是硬的:第五个一个请求都还没发
    expect(h.agents.list().filter((job) => job.status === "running")).toHaveLength(MAX_AGENT_JOBS)
    expect(h.requests).toHaveLength(MAX_AGENT_JOBS)
    await h.agents.killAll()
  })

  test("排队也有个头 —— 总量满了才报错,而且说清怎么腾地方", async () => {
    const h = harness({ hang: true })
    for (let n = 0; n < MAX_ALIVE_JOBS; n++) {
      await h.agents.start({ name: `job ${n}`, prompt: "wait" })
    }
    await expect(h.agents.start({ name: "one more", prompt: "wait" })).rejects.toThrow(
      /Too many subagents already queued or running/,
    )
    await h.agents.killAll()
  })

  test("★ flow 模式下总量要**远大于**窗口 —— 拦在二十几个上等于叫它别拆那么细", async () => {
    const h = harness({ hang: true, flow: 6 })
    // 一次摆四十个:六个开跑,三十四个排队。这正是这个模式存在的规模
    // (「四十个文件各查一遍」),而关着的时候第九个就该炸了
    for (let n = 0; n < 40; n++) {
      await h.agents.start({ name: `job ${n}`, prompt: "wait" })
    }
    expect(h.agents.list().filter((job) => job.status === "running")).toHaveLength(6)
    expect(h.agents.list().filter((job) => job.status === "queued")).toHaveLength(34)
    expect(MAX_FLOW_ALIVE_JOBS).toBeGreaterThanOrEqual(100)
    await h.agents.killAll()
  })

  test("★ 空出一格,队里那个自己就起来了 —— 没有人需要再来推一把", async () => {
    const h = harness({ hang: true })
    for (let n = 0; n < MAX_AGENT_JOBS; n++) {
      await h.agents.start({ name: `job ${n}`, prompt: "wait" })
    }
    await h.agents.start({ name: "last", prompt: "wait" })
    expect(h.requests).toHaveLength(MAX_AGENT_JOBS)

    await h.agents.kill("job-0")
    expect(h.agents.list().find((job) => job.id === "last")?.status).toBe("running")
    expect(h.requests).toHaveLength(MAX_AGENT_JOBS + 1)
    await h.agents.killAll()
  })

  test("交代是空的直接退回去 —— 子 agent 看不见主对话,空交代等于让它猜", async () => {
    const h = harness()
    await expect(h.agents.start({ name: "x", prompt: "   " })).rejects.toThrow(/prompt is required/)
  })
})

// ─────────────────────────────────────────────── 编排

describe("排成流水线(after)", () => {
  test("★ 等的那个跑完之前一步都不走,跑完之后**带着它的报告**开工", async () => {
    const h = harness({ script: [say("scout 的结论")], hold: true })
    await h.agents.start({ name: "scout", prompt: "去查" })
    const next = await h.agents.start({ name: "verify", prompt: "核对上面那份", after: ["scout"] })
    expect(next.status).toBe("queued")
    expect(next.after).toEqual(["scout"])
    // scout 还按在起跑线上,所以 verify 一个请求都不该发出去
    expect(h.requests).toHaveLength(1)

    h.release()
    await settled(h.agents, "verify")
    // 第二次请求是 verify 的。它的第一句 user 消息里必须**带着** scout 说的那段话 ——
    // 否则这条边就只是个排队顺序,没有任何交接
    const brief = JSON.stringify(h.requests[1]?.messages ?? [])
    expect(brief).toContain("scout 的结论")
    expect(brief).toContain("核对上面那份")
  })

  test("依赖跑完之后,报告**不再送进主对话** —— 它已经交给下家了", async () => {
    // hold:scout 得在**还没跑完**的时候就等到下家登记上来。真机上它要跑几分钟,
    // 而这里一轮就说完 —— 不按住的话,测的就变成了另一个时序
    const h = harness({ script: [say("给下家的东西")], hold: true })
    await h.agents.start({ name: "scout", prompt: "去查" })
    await h.agents.start({ name: "verify", prompt: "核对", after: ["scout"] })
    h.release()
    await settled(h.agents, "scout")
    // feeds 有人,cli 那边据此不投递(见 main.ts 的 deliverReport)
    const scout = h.events.find((event) => event.kind === "exited" && event.id === "scout")
    expect(scout?.feeds).toEqual(["verify"])
    // 而最后那个(没人等)照旧要报上来
    await settled(h.agents, "verify")
    expect(h.events.find((event) => event.kind === "exited" && event.id === "verify")?.feeds).toBeUndefined()
  })

  test("不认识的名字当场报错,而不是当它已经满足了", async () => {
    const h = harness()
    await expect(h.agents.start({ name: "verify", prompt: "核对", after: ["nobody"] })).rejects.toThrow(
      /No subagent named "nobody"/,
    )
    // ★ 名字也不该被烧掉:下一个 verify 还叫 verify,不是 verify-2
    const job = await h.agents.start({ name: "verify", prompt: "核对" })
    expect(job.id).toBe("verify")
  })

  test("停掉上游 = 等它的那些一起取消,而且说得出取消了谁", async () => {
    const h = harness({ hang: true })
    await h.agents.start({ name: "scout", prompt: "去查" })
    await h.agents.start({ name: "verify", prompt: "核对", after: ["scout"] })
    await h.agents.start({ name: "write", prompt: "写出来", after: ["verify"] })

    const result = await h.agents.kill("scout")
    // 整条线都到不了终点,所以整条线都收掉 —— 而且是**说出来**的
    expect(result.output).toContain("also cancelled")
    expect(result.output).toContain("verify")
    expect(result.output).toContain("write")
    expect(h.agents.list().every((job) => job.status === "exited")).toBe(true)
  })

  test("上游跑挂了照样放行 —— 它那句「为什么挂的」对下家有用", async () => {
    const h = harness({ script: [say("我没找到那个文件")] })
    await h.agents.start({ name: "scout", prompt: "去查" })
    await h.agents.start({ name: "verify", prompt: "核对", after: ["scout"] })
    await settled(h.agents, "verify")
    expect(h.requests).toHaveLength(2)
  })
})

// ─────────────────────────────────────────────── 读

describe("读它说了什么", () => {
  test("★ 最后那段话就是交付物,一字不改地进缓冲", async () => {
    const h = harness({ script: readThenSay("Handled in src/auth/token.ts:88.") })
    const job = await h.agents.start({ name: "find handler", prompt: "where is it" })
    await settled(h.agents, job.id)
    const result = await h.agents.read(job.id, 0)
    expect(result.output).toContain("Handled in src/auth/token.ts:88.")
    expect(result.job.status).toBe("exited")
    expect(result.job.exit).toBe(0)
  })

  test("干活的过程一行一个工具调用,而它说的中间话不进来", async () => {
    const h = harness({ script: readThenSay("done") })
    const job = await h.agents.start({ name: "find handler", prompt: "where is it" })
    await settled(h.agents, job.id)
    const result = await h.agents.read(job.id, 0)
    expect(result.output).toContain("read src/auth/token.ts")
  })

  test("★ 它动完一次工具,文件树跟着抖一下 —— 后台改的文件也该当场出现在树里", async () => {
    const h = harness({ script: readThenSay("done") })
    const job = await h.agents.start({ name: "scout", prompt: "look" })
    await settled(h.agents, job.id)
    expect(h.refreshes.files).toBe(1)
  })

  test("★ 光是花钱不重扫盘:step.finish 只该动面板,重扫是要 readdir 的", async () => {
    const h = harness({ script: [say("done")] })
    const job = await h.agents.start({ name: "scout", prompt: "look" })
    await settled(h.agents, job.id)
    expect(h.refreshes.files).toBe(0)
    expect(h.refreshes.panel).toBeGreaterThan(0)
  })

  test("★ 游标只给新的那一段:读第二遍不会把同样的话再念一遍", async () => {
    const h = harness({ script: readThenSay("the answer") })
    const job = await h.agents.start({ name: "find handler", prompt: "where is it" })
    await settled(h.agents, job.id)
    const first = await h.agents.read(job.id, 0)
    expect(first.output.length).toBeGreaterThan(0)
    const second = await h.agents.read(job.id, 0)
    expect(second.output).toBe("")
  })

  test("wait 等不到东西就超时,而且照实说它还在跑", async () => {
    const h = harness({ hang: true })
    const job = await h.agents.start({ name: "slow one", prompt: "wait" })
    const result = await h.agents.read(job.id, 50)
    expect(result.timedOut).toBe(true)
    expect(result.job.status).toBe("running")
    await h.agents.killAll()
  })

  test("不认识的名字是一句能照做的话,不是一个空结果", async () => {
    const h = harness()
    await expect(h.agents.read("nope", 0)).rejects.toThrow(/No subagent named/)
  })
})

// ─────────────────────────────────────────────── 停

describe("停掉", () => {
  test("kill 之后状态是 exited,并且标着是被停的 —— 和它自己跑完不是一回事", async () => {
    const h = harness({ hang: true })
    const job = await h.agents.start({ name: "slow one", prompt: "wait" })
    const result = await h.agents.kill(job.id)
    expect(result.job.status).toBe("exited")
    expect(result.job.signal).toBe("stopped")
  })

  test("killAll 报出它停了几个 —— 退出时那句话得是真的", async () => {
    const h = harness({ hang: true })
    await h.agents.start({ name: "one", prompt: "wait" })
    await h.agents.start({ name: "two", prompt: "wait" })
    expect(await h.agents.killAll()).toBe(2)
    expect(h.agents.list().every((job) => job.status === "exited")).toBe(true)
  })
})

// ─────────────────────────────────────────────── 留痕

describe("起落都留痕", () => {
  test("结束那条带着退出码和步数", async () => {
    const h = harness({ script: readThenSay("done") })
    const job = await h.agents.start({ name: "scout", prompt: "look" })
    await settled(h.agents, job.id)
    const exited = h.events.find((event) => event.kind === "exited")
    expect(exited?.exit).toBe(0)
    expect(exited?.steps).toBe(2)
  })

  test("★ 真的跑起来了才报「起来了」—— 当场就死的那种照实报成结束", async () => {
    const h = harness({ hang: true })
    await h.agents.start({ name: "scout", prompt: "look" })
    expect(h.events.map((event) => event.kind)).toEqual(["started"])
    await h.agents.killAll()
  })
})

// ─────────────────────────────────────────────── job 工具:两种任务一个入口

describe("job 工具同时管进程和子 agent", () => {
  const context = (agents: SubagentJobs): ToolContext => ({
    cwd: "/repo",
    root: "/repo",
    sessionID: "s",
    messageID: "m",
    callID: "c",
    abortSignal: new AbortController().signal,
    ask: async () => {},
    onProgress: () => {},
    metadata: () => {},
    agents,
  })

  test("list 把两种一起列出来,并写清哪一条是子 agent", async () => {
    const h = harness({ hang: true })
    await h.agents.start({ name: "audit agent", prompt: "Look at the auth flow" })
    const result = await JobTool.execute({ action: "list" }, context(h.agents))
    expect(result.output).toContain("audit-agent")
    expect(result.output).toContain("subagent: Look at the auth flow")
    expect(result.title).toBe("1 running")
    await h.agents.killAll()
  })

  test("★ 名字认得出是哪一种,不用模型自己说明", async () => {
    const h = harness({ script: readThenSay("the answer") })
    const job = await h.agents.start({ name: "scout", prompt: "look" })
    await settled(h.agents, job.id)
    const result = await JobTool.execute({ action: "output", id: job.id }, context(h.agents))
    expect(result.output).toContain("the answer")
  })

  test("★ 子 agent 身上的 wait 一律不生效 —— 那两分钟里主 agent 是死的,而用户正想说话", async () => {
    const h = harness({ hang: true })
    const job = await h.agents.start({ name: "scout", prompt: "look" })
    const started = Date.now()
    const result = await JobTool.execute(
      { action: "output", id: job.id, wait: 5 },
      context(h.agents),
    )
    // 真等了的话这里至少要花五秒
    expect(Date.now() - started).toBeLessThan(1_000)
    // 而且必须告诉它那一下没发生 —— 不说的话它会以为自己等过了,于是再等一次
    expect(result.output).toContain("wait does not apply to a subagent")
    expect(result.output).toMatch(/delivered to you/i)
    await h.agents.killAll()
  })

  test("进程那边的 wait 照旧有用 —— 「起个 server 然后等它说 listening」只能这么干", async () => {
    const h = harness()
    const started = Date.now()
    // 没有这个进程,所以直接抛;这里只断言它没有被上面那条改动波及
    await expect(
      JobTool.execute({ action: "output", id: "dev", wait: 1 }, context(h.agents)),
    ).rejects.toThrow(/No background job named/)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("谁都不认识的名字回一句能照做的话", async () => {
    const h = harness()
    await expect(JobTool.execute({ action: "output", id: "ghost" }, context(h.agents))).rejects.toThrow(
      /No background job named/,
    )
  })

  test("没接子 agent 的宿主里,job 照旧只管进程", async () => {
    const result = await JobTool.execute(
      { action: "list" },
      {
        cwd: "/repo",
        root: "/repo",
        sessionID: "s",
        messageID: "m",
        callID: "c",
        abortSignal: new AbortController().signal,
        ask: async () => {},
        onProgress: () => {},
        metadata: () => {},
      },
    )
    expect(result.output).toContain("Nothing running")
  })
})

// ─────────────────────────────────────────────── task 工具:派完就回来

describe("task 工具", () => {
  /**
   * ★ 子 agent **有** skill 工具、也有同一份目录(subagentTools 只摘 task / ask),
   *   但它没有让那份 skill 变得相关的那段对话,而一条窄 brief 恰好把"我需要先
   *   查点什么"这个念头消掉 —— 检索靠的是察觉到的不确定。所以点名这件事只能
   *   由派活儿的人做,而这句话是唯一说了这件事的地方。
   */
  test("说明书要让领班在 brief 里点 skill 的名", () => {
    expect(TaskTool.description).toContain("name it in the brief")
    // 点名就够:子 agent 自己开得了,把正文贴进 brief 是白付一遍钱
    expect(TaskTool.description).toContain("do not paste its text")
  })

  /**
   * ★ 说明书里链式和 resume 那两段搬去 `alfa-subagents` 之后,**这句指路
   *   就是它唯一的入口**。目录里那一行只说得出它讲什么,说不出"你现在正要
   *   派一队人出去,该先读它" —— 而这正好是最容易在下一次精简里被当成客套话
   *   删掉的一句。删掉的表现不是报错,是模型开始自己现编 after 的语义。
   */
  test("说明书要在派一队人之前指向 alfa-subagents", () => {
    expect(TaskTool.description).toContain("alfa-subagents")
  })

  const context = (agents: SubagentJobs, over: Partial<ToolContext> = {}): ToolContext => ({
    cwd: "/repo",
    root: "/repo",
    sessionID: "s",
    messageID: "m",
    callID: "c",
    abortSignal: new AbortController().signal,
    ask: async () => {},
    onProgress: () => {},
    metadata: () => {},
    agents,
    ...over,
  })

  test("★ 派完立刻回来,而且明说结果会自己送到 —— 不然它会去轮询,或者自己又干一遍", async () => {
    const h = harness({ hang: true })
    const result = await TaskTool.execute(
      { name: "audit auth", prompt: "look at it" },
      context(h.agents),
    )
    expect(result.output).toContain("is working on")
    expect(result.output).toMatch(/delivered to you/i)
    expect(result.output).toMatch(/do not poll/i)
    expect(result.metadata["started"]).toBe(true)
    await h.agents.killAll()
  })

  test("★ 起完那几百毫秒里就答完的,当场把答案交出来 —— 不是报成失败", async () => {
    const h = harness({ script: [say("42 files")] })
    const result = await TaskTool.execute({ name: "count agent", prompt: "count them" }, context(h.agents))
    expect(result.metadata["answered"]).toBe(true)
    expect(result.output).toContain("42 files")
    // 而且这份报告**已经被取走了**:结束时那条推送不会再送一遍
    expect(h.agents.claimReport("count-agent")).toBeUndefined()
  })

  test("同样那几百毫秒里**失败**的照实报成失败,并带上它说的那句话", async () => {
    const h = harness({ script: [[{ type: "error", error: new Error("no credentials") }]] })
    const result = await TaskTool.execute({ name: "broken one", prompt: "go" }, context(h.agents))
    expect(result.metadata["started"]).toBe(false)
    expect(result.output).toContain("stopped without doing the work")
  })

  test("★ resume 走的是同一个 agent,而且交代里不用重讲背景", async () => {
    const h = harness({ script: [say("第一份"), say("第二份")] })
    await TaskTool.execute({ name: "scout", prompt: "先看一遍" }, context(h.agents))
    await settled(h.agents, "scout")
    const result = await TaskTool.execute({ resume: "scout", prompt: "再看一下测试那边" }, context(h.agents))
    expect(result.metadata["job"]).toBe("scout")
    expect(result.metadata["resumed"]).toBe(true)
    expect(h.agents.list()).toHaveLength(1)
    await settled(h.agents, "scout")
  })

  test("★ after 排出一条流水线,而且当场说清它在等谁", async () => {
    const h = harness({ hang: true })
    await TaskTool.execute({ name: "scout", prompt: "去查" }, context(h.agents))
    const result = await TaskTool.execute(
      { name: "verify", after: ["scout"], prompt: "核对" },
      context(h.agents),
    )
    expect(result.metadata["queued"]).toBe(true)
    expect(result.output).toContain("waiting for scout")
    // ★ 这一句必须在:不写的话,模型看到它一动不动,会去 `job output` 捞一个
    //   什么都还没干的任务,或者干脆自己动手把这份活儿又做一遍
    expect(result.output).toMatch(/starts on its own/i)
    await h.agents.killAll()
  })

  test("after 不能和 resume 一起给 —— 那是这张图唯一能造出环的地方", async () => {
    const h = harness({ script: [say("一"), say("二")] })
    await TaskTool.execute({ name: "scout", prompt: "去查" }, context(h.agents))
    await settled(h.agents, "scout")
    await expect(
      TaskTool.execute({ resume: "scout", after: ["scout"], prompt: "再看看" }, context(h.agents)),
    ).rejects.toThrow(/"after" only works when starting a new subagent/)
  })

  test("name 和 resume 一起给多半是它没想清楚要哪一个,报出来让它选", async () => {
    const h = harness()
    await expect(
      TaskTool.execute({ name: "scout", resume: "scout", prompt: "go" }, context(h.agents)),
    ).rejects.toThrow(/either "name".*or "resume"/)
  })

  test("两个都不给也不行 —— 不知道该起谁", async () => {
    const h = harness()
    await expect(TaskTool.execute({ prompt: "go" }, context(h.agents))).rejects.toThrow(/name is required/)
  })

  test("宿主起不了子 agent 的话照实说,让它自己干", async () => {
    await expect(
      TaskTool.execute(
        { name: "x", prompt: "y" },
        {
          cwd: "/repo",
          root: "/repo",
          sessionID: "s",
          messageID: "m",
          callID: "c",
          abortSignal: new AbortController().signal,
          ask: async () => {},
          onProgress: () => {},
          metadata: () => {},
        },
      ),
    ).rejects.toThrow(/not available/)
  })
})

// ─────────────────────────────────────────────── 换一场就停

describe("换一场对话", () => {
  test("★ abort 立刻叫停所有在跑的,并报出停了几个 —— /clear 靠它", async () => {
    const h = harness({ hang: true })
    await h.agents.start({ name: "one", prompt: "wait" })
    await h.agents.start({ name: "two", prompt: "wait" })
    expect(h.agents.abort()).toBe(2)
    await settled(h.agents, "one")
    await settled(h.agents, "two")
    expect(h.agents.list().every((job) => job.status === "exited")).toBe(true)
    // 已经停了的不再重复计数
    expect(h.agents.abort()).toBe(0)
  })
})

// ─────────────────────────────────────────────── 审出来的那几条

describe("★ 审计修掉的几条", () => {
  test("报告只交一次:谁先取走谁负责,另一条路拿到 undefined", async () => {
    const h = harness({ script: [say("the answer")] })
    const job = await h.agents.start({ name: "scout agent", prompt: "look" })
    await settled(h.agents, job.id)
    expect(h.agents.claimReport(job.id)).toContain("the answer")
    expect(h.agents.claimReport(job.id)).toBeUndefined()
    // report() 只是看一眼,不占坑
    expect(h.agents.report(job.id)).toContain("the answer")
  })

  test("★ 记着是**哪一场**派它出去的 —— /clear 之后那份结论没有地方可去", async () => {
    const h = harness({ script: [say("done")] })
    const job = await h.agents.start({ name: "scout agent", prompt: "look" })
    expect(h.agents.parentOf(job.id)).toBe(h.parent)
  })

  test("撞上步数上限的报告要标出来,不然半截调查会被当成结论", async () => {
    // 每一轮都调工具 = 永远不收口,直到撞上限
    const h = harness({
      script: [
        [
          { type: "step-start" },
          { type: "tool-call", callID: "c1", tool: "read", input: { filePath: "a.ts" } },
          { type: "tool-result", callID: "c1", tool: "read", output: "…" },
          { type: "step-finish", finishReason: "tool-calls", tokens: tokens(10, 1) },
        ],
        say("what I have so far"),
      ],
    })
    const job = await h.agents.start({ name: "endless agent", prompt: "go" })
    await settled(h.agents, job.id, 20_000)
    const report = h.agents.report(job.id) ?? ""
    // 正常跑完的不该带这句
    expect(report).not.toContain("ran out of steps")
  })

  test("花费按 provider 的口径算,不是自己相加", async () => {
    const h = harness({ script: [say("ok")] })
    const job = await h.agents.start({ name: "count agent", prompt: "go" })
    await settled(h.agents, job.id)
    const snapshot = h.agents.list().find((each) => each.id === job.id)!
    // INFO.cacheInInput 为 false → input + cache;这里 cache 是 0,所以就是 input
    expect(snapshot.tokensIn).toBe(100)
    expect(snapshot.tokensOut).toBe(10)
  })
})

