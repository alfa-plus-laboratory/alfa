/**
 * Context usage and compaction.
 *
 * What's watched here are a few kinds of **silent failure** — all of them look like "the
 * numbers seem about right":
 *   - the breakdown doesn't add up to the total in the header → the user trusts neither
 *     number
 *   - folded history still counts toward usage → the gauge doesn't budge after compaction
 *   - the fold point doesn't take effect → the model still gets the full history, and
 *     compacting was for nothing (with no error of any kind)
 *   - the 100% line computed two different ways in two places → the status line says 87%
 *     while the provider is already reporting an overflow
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import {
  contextReport,
  ContextMeter,
  estimateTokens,
  sliceHistory,
  SLICE_KEYS,
  toolTokens,
} from "../src/agent/context.ts"
import { applyCompaction, chooseTail, createCompactor, describeSession, withFileLedger } from "../src/agent/compact.ts"
import { compactionIndex, toLLMMessages } from "../src/agent/to-model-messages.ts"
import { isSettled } from "../src/agent/loop.ts"
import { billedFromHistory, usable } from "../src/agent/tokens.ts"
import {
  gauge,
  gradientGauge,
  rampPaint,
  renderContextReport,
  sliceLabel,
} from "../src/cli/context.ts"
import { setColorEnabled } from "../src/cli/theme.ts"
import { displayWidth } from "../src/cli/width.ts"
import { setInterfaceLanguage } from "../src/i18n/index.ts"
import { ContextTool } from "../src/tool/context-window.ts"
import { SkillTool } from "../src/tool/skill.ts"
import { createToolContext } from "../src/tool/context.ts"
import type { ContextView } from "../src/tool/types.ts"
import type { LLMEvent, LLMRequest, ModelInfo } from "../src/llm/types.ts"
import type { MessageWithParts, Part } from "../src/session/schema.ts"
import { Store } from "../src/session/store.ts"
import { registerBuiltins } from "../src/tool/builtin.ts"
import { ToolRegistry } from "../src/tool/registry.ts"

setColorEnabled(false)
setInterfaceLanguage("en")

/** An empty spend snapshot. The display tests don't care about it */
const ZERO_SPENT = { total: 0, input: 0, output: 0 }

const INFO: ModelInfo = {
  ref: { providerID: "anthropic", modelID: "test" },
  limit: { context: 1_000_000, output: 32_000 },
  limitSource: "default",
  supportsThinking: true,
  promptTemplate: "anthropic",
  cacheInInput: false,
}

// ─────────────────────────────────────────────── building history

let seq = 0
function base(role: "user" | "assistant"): MessageWithParts["info"] {
  const id = `m${++seq}`
  return role === "user"
    ? { id, sessionID: "s", role, timeCreated: seq }
    : { id, sessionID: "s", role, parentID: "u", providerID: "anthropic", modelID: "test", cost: 0, timeCreated: seq }
}

function message(role: "user" | "assistant", ...parts: Array<Partial<Part> & { type: Part["type"] }>): MessageWithParts {
  const info = base(role)
  return {
    info,
    parts: parts.map(
      (part, index) =>
        ({
          id: `${info.id}-p${index}`,
          sessionID: "s",
          messageID: info.id,
          timeCreated: seq,
          ...part,
        }) as Part,
    ),
  }
}

const said = (text: string) => message("user", { type: "text", text })
const replied = (text: string) => message("assistant", { type: "text", text })
const ran = (tool: string, input: unknown, output: string) =>
  message("assistant", {
    type: "tool",
    callID: `c${++seq}`,
    tool,
    state: { status: "completed", input, output, metadata: {}, time: { start: 1, end: 2 } },
  })

// ─────────────────────────────────────────────── estimation

/**
 * ★ Both split-out rows must be **subtracted** from the row they came from, not added on.
 *
 * This report's total is compared against the window, and the breakdown must sum to it —
 * counting a row twice doesn't just make the numbers ugly, it makes them lie: the user
 * trims things based on an inflated system row and finds nothing changed.
 */
describe("skills catalog and MCP tools get their own rows", () => {
  const info = {
    limit: { context: 200_000, output: 8_000 },
  } as unknown as Parameters<typeof contextReport>[0]["info"]

  const fakeTool = (id: string) => ({
    id,
    description: "x".repeat(400),
    parameters: z.object({}),
    async execute() {
      return { output: "", metadata: { truncated: false } }
    },
  })

  test("the catalog is split out of system without changing the total", () => {
    const catalogue = "# Skills\n\n- `one` — does a thing"
    const system = ["prefix", `tail with the catalogue inside\n\n${catalogue}`]
    const withSkills = contextReport({ history: [], system, tools: [], skills: catalogue, info })
    const without = contextReport({ history: [], system, tools: [], info })

    const sum = (r: typeof withSkills) => r.slices.reduce((n, one) => n + one.tokens, 0)
    expect(sum(withSkills)).toBe(sum(without))
    const skills = withSkills.slices.find((one) => one.key === "skills")!.tokens
    expect(skills).toBeGreaterThan(0)
    expect(withSkills.slices.find((one) => one.key === "system")!.tokens).toBe(
      without.slices.find((one) => one.key === "system")!.tokens - skills,
    )
  })

  test("MCP tools are not counted in our own tools row", () => {
    const tools = [fakeTool("read"), fakeTool("mcp__github__create_issue"), fakeTool("mcp__db__query")]
    const report = contextReport({ history: [], system: [], tools, info })
    const mcp = report.slices.find((one) => one.key === "mcp")!.tokens
    const own = report.slices.find((one) => one.key === "tools")!.tokens
    expect(mcp).toBeGreaterThan(0)
    expect(own).toBeGreaterThan(0)
    // two MCP tools against one built-in tool: the third-party row should be bigger
    expect(mcp).toBeGreaterThan(own)

    const onlyOwn = contextReport({ history: [], system: [], tools: [fakeTool("read")], info })
    expect(onlyOwn.slices.find((one) => one.key === "mcp")!.tokens).toBe(0)
    expect(onlyOwn.slices.find((one) => one.key === "tools")!.tokens).toBe(own)
  })
})

describe("token estimation", () => {
  test("the empty string is 0, anything else is above 0", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("hello")).toBeGreaterThan(0)
  })

  test("★ CJK text is counted per character, not by dividing the length — dividing underestimates Chinese sessions threefold", () => {
    const chinese = "上下文窗口还剩多少"
    const latin = "how much context is left"
    expect(estimateTokens(chinese)).toBeGreaterThanOrEqual(chinese.length)
    // the same nine "words": the English string has far more characters, but the token
    // counts should be in the same ballpark
    expect(estimateTokens(latin)).toBeLessThan(latin.length)
  })

  test("monotonic in length: longer text never estimates lower", () => {
    expect(estimateTokens("abc".repeat(100))).toBeGreaterThan(estimateTokens("abc".repeat(10)))
  })

  test("tool definitions are counted and non-zero — the largest fixed cost after system", () => {
    const tools = registerBuiltins(new ToolRegistry()).list()
    expect(toolTokens(tools)).toBeGreaterThan(200)
  })
})

// ─────────────────────────────────────────────── the breakdown

describe("breakdown", () => {
  test("each part goes to its own row", () => {
    const history = [said("改一下 live.ts"), ran("read", { filePath: "live.ts" }, "x".repeat(4_000)), replied("好了")]
    const { slices, messages } = sliceHistory(history)
    expect(messages).toBe(3)
    expect(slices.get("user")!.tokens).toBeGreaterThan(0)
    expect(slices.get("reply")!.tokens).toBeGreaterThan(0)
    expect(slices.get("call")!.tokens).toBeGreaterThan(0)
    // tool output is the biggest chunk in a long session; this assertion is about that
    expect(slices.get("result")!.tokens).toBeGreaterThan(slices.get("user")!.tokens)
  })

  /**
   * ★ An opened skill is charged to skills, not to result.
   *
   * There's a row in the UI called skills, and readers naturally take it as "how much did
   * skills cost me in total". The whole selling point of the skills design is "the
   * catalog is cheap, bodies load on demand" — a row that only counts the catalog would
   * hide exactly the number that verifies that claim (the body, twenty times one catalog
   * line) inside result.
   */
  test("★ an opened skill is charged to skills, not result", () => {
    const body = "这份 skill 的正文,写着这个项目怎么发版。".repeat(60)
    const { slices } = sliceHistory([
      said("发个版"),
      ran("skill", { name: "cut-a-release" }, body),
      ran("read", { filePath: "package.json" }, "x".repeat(400)),
    ])
    expect(slices.get("skills")!.tokens).toBeGreaterThan(estimateTokens(body) * 0.9)
    // read's output still stays in result — that's work, not prompt
    expect(slices.get("result")!.tokens).toBeGreaterThan(0)
    expect(slices.get("result")!.tokens).toBeLessThan(slices.get("skills")!.tokens / 5)
    // the call itself still sits in call: only the output moves, and the breakdown must
    // still sum to the total
    expect(slices.get("call")!.tokens).toBeGreaterThan(0)
  })

  test("★ the hard-coded tool id matches the real one — context.ts doesn't import it", () => {
    expect(SkillTool.id).toBe("skill")
  })

  test("★ a subagent's report doesn't count as 'your messages' — under agentflow it's the biggest chunk", () => {
    // in the DB it looks exactly like what the user typed: role user, a text part. The
    // only difference is a synthetic flag (see injectSynthetic in cli/main.ts)
    const report = (text: string) => message("user", { type: "text", text, synthetic: true })
    const long = "调查agent 交回来的一大段结论。".repeat(80)

    const { slices } = sliceHistory([said("升级一下这个子系统"), report(long), report(long)])
    expect(slices.get("handoff")!.tokens).toBeGreaterThan(0)
    // ★ This is that bug: both reports were once charged to the user, so the gauge read
    //   "你说的话 120k" (ctxUser, "your messages"), while the user had typed nine
    //   characters in all
    expect(slices.get("user")!.tokens).toBeLessThan(slices.get("handoff")!.tokens / 10)
  })

  test("the repo snapshot on the opening message doesn't count either — it shares a message with the user's own words", () => {
    const withSnapshot = message(
      "user",
      { type: "text", text: "现在是什么状态".repeat(1), synthetic: true },
      { type: "text", text: "看一下" },
    )
    const { slices } = sliceHistory([withSnapshot])
    expect(slices.get("env")!.tokens).toBeGreaterThan(0)
    expect(slices.get("user")!.tokens).toBeGreaterThan(0)
    // a message a real person spoke in is **not** an injection — counting all of it as
    // handoff would swallow the user's own words too
    expect(slices.get("handoff")).toBeUndefined()
  })

  test("★ the thinking row counts only what is actually sent — it once counted everything, inflating the gauge", () => {
    const thought = (text: string) => message("assistant", { type: "reasoning", text, signature: "sig" })
    const long = "想了很久很久的一段".repeat(50)

    // from this loop: counted
    const current = sliceHistory([said("go"), thought(long)])
    expect(current.slices.get("thinking")!.tokens).toBeGreaterThan(0)

    // from the previous loop: the model never receives it (see loopStartIndex in
    // to-model-messages.ts), so it shouldn't count
    const past = sliceHistory([said("first"), thought(long), said("second")])
    expect(past.slices.get("thinking")).toBeUndefined()
  })

  test("★ the breakdown sums to the header total — if not, neither number is trusted", () => {
    const report = contextReport({
      history: [said("hi"), ran("bash", { command: "ls" }, "a\nb\nc"), replied("done")],
      system: ["you are an agent"],
      tools: [],
      info: INFO,
    })
    const sum = report.slices.reduce((total, slice) => total + slice.tokens, 0)
    // after scaling each row is rounded, so allow each to be off by one
    expect(Math.abs(sum - report.used)).toBeLessThanOrEqual(report.slices.length)
  })

  test("★ a provider-reported total wins, and the breakdown is scaled to match", () => {
    const history = [said("hi"), replied("hello")]
    const bare = contextReport({ history, system: ["sys"], tools: [], info: INFO })
    const scaled = contextReport({ history, system: ["sys"], tools: [], info: INFO, reported: bare.used * 4 })
    expect(scaled.used).toBe(bare.used * 4)
    expect(scaled.estimated).toBe(false)
    expect(bare.estimated).toBe(true)
    const sum = scaled.slices.reduce((total, slice) => total + slice.tokens, 0)
    expect(Math.abs(sum - scaled.used)).toBeLessThanOrEqual(scaled.slices.length)
  })

  test("an empty session still renders: just system and tool definitions", () => {
    const report = contextReport({ history: [], system: ["sys"], tools: [], info: INFO })
    expect(report.messages).toBe(0)
    expect(report.slices.find((slice) => slice.key === "system")!.tokens).toBeGreaterThan(0)
    expect(report.free).toBe(report.budget - report.used)
  })
})

// ─────────────────────────────────────────────── the 100% line

describe("window budget", () => {
  test("a configured 64k output reserves the full amount, not silently capped at 32k", () => {
    expect(usable({ context: 200_000, output: 64_000 })).toBe(116_000)
  })
  test("★ a 1M window counts as full at 900k — large windows keep a proportional margin", () => {
    expect(usable({ context: 1_000_000, output: 32_000 })).toBe(900_000)
  })

  test("small windows keep an absolute margin: a tenth isn't enough for compaction itself", () => {
    // a tenth of 200k is only 20k, not enough for one compaction request, so it still
    // uses output + the compaction margin
    expect(usable({ context: 200_000, output: 32_000 })).toBe(148_000)
  })

  test("ratio is relative to budget, not limit — both places must measure the same way", () => {
    const meter = new ContextMeter(INFO)
    meter.assume(450_000)
    expect(meter.snapshot.budget).toBe(900_000)
    expect(meter.snapshot.ratio).toBeCloseTo(0.5, 5)
  })
})

describe("spend", () => {
  test("★ spend **accumulates**, usage **takes the latest** — swapping the two gets everything wrong", () => {
    const meter = new ContextMeter(INFO)
    // three steps in one turn: every step's input contains the whole history
    meter.observe({ input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } })
    meter.observe({ input: 2_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } })
    meter.observe({ input: 3_000, output: 300, reasoning: 0, cache: { read: 0, write: 0 } })
    // usage = the last step's input (not 6_000)
    expect(meter.snapshot.used).toBe(3_000)
    // spend = all three steps added up, output included
    expect(meter.snapshot.spent.total).toBe(1_000 + 2_000 + 3_000 + 100 + 200 + 300)
    expect(meter.snapshot.spent.input).toBe(6_000)
    expect(meter.snapshot.spent.output).toBe(600)
  })

  test("cache hits count as spent — cheap is not free", () => {
    const meter = new ContextMeter(INFO)
    meter.observe({ input: 500, output: 100, reasoning: 0, cache: { read: 9_000, write: 0 } })
    // a provider with cacheInInput=false: input and cache are reported separately and must
    // be added
    expect(meter.snapshot.spent.total).toBe(500 + 9_000 + 100)
  })

  test("★ compaction doesn't refund — a 'spent' figure that shrinks on compaction is lying", () => {
    const meter = new ContextMeter(INFO)
    meter.observe({ input: 400_000, output: 1_000, reasoning: 0, cache: { read: 0, write: 0 } })
    const before = meter.snapshot.spent.total
    meter.drop() // after compaction: usage is invalidated
    meter.assume(9_000)
    expect(meter.snapshot.used).toBe(9_000)
    expect(meter.snapshot.spent.total).toBe(before)
    // only a new session resets it to zero
    meter.resetSpend()
    expect(meter.snapshot.spent.total).toBe(0)
  })

  test("the report splits in / out / cache and explains why it exceeds the window", () => {
    const report = contextReport({
      history: [said("hi")],
      system: ["sys"],
      tools: [],
      info: INFO,
      spent: { input: 1_200_000, output: 40_000, reasoning: 0, cache: { read: 900_000, write: 0 } },
    })
    expect(report.spent.total).toBe(1_200_000 + 900_000 + 40_000)
    expect(report.spent.cached).toBe(900_000)
    const text = renderContextReport(report, "anthropic/test")
    expect(text).toContain("2.1M")
    expect(text).toContain("from cache")
    expect(text).toContain("re-sends the whole history")
  })

})

describe("meter", () => {
  test("uses the provider's number once reported, an estimate before that", () => {
    const meter = new ContextMeter(INFO)
    meter.assume(1_000)
    expect(meter.snapshot.estimated).toBe(true)
    expect(meter.snapshot.used).toBe(1_000)

    meter.observe({ input: 5_000, output: 100, reasoning: 0, cache: { read: 2_000, write: 0 } })
    expect(meter.snapshot.estimated).toBe(false)
    // a provider with cacheInInput=false: input and cache must be added
    expect(meter.snapshot.used).toBe(7_000)
  })

  test("★ the reported number no longer holds after compaction; drop falls back to the estimate", () => {
    const meter = new ContextMeter(INFO)
    meter.observe({ input: 800_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
    meter.assume(12_000)
    expect(meter.snapshot.used).toBe(800_000)
    meter.drop()
    expect(meter.snapshot.used).toBe(12_000)
    expect(meter.snapshot.estimated).toBe(true)
  })

  test("output isn't counted in usage — it's counted again as input next turn", () => {
    const meter = new ContextMeter(INFO)
    meter.observe({ input: 1_000, output: 90_000, reasoning: 0, cache: { read: 0, write: 0 } })
    expect(meter.snapshot.used).toBe(1_000)
  })

  test("★ switching models: the window follows, and the provider-reported number is discarded", () => {
    const meter = new ContextMeter(INFO)
    meter.observe({ input: 500_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
    meter.assume(9_000)
    expect(meter.snapshot.used).toBe(500_000)

    // a 1M window swapped for a 30k one
    meter.retarget({ ...INFO, limit: { context: 32_000, output: 8_000 } })
    expect(meter.snapshot.limit).toBe(32_000)
    // that 500k was counted by the previous model's tokenizer; dividing it by the new
    // window measures the same text with two different rulers
    expect(meter.snapshot.used).toBe(9_000)
    expect(meter.snapshot.estimated).toBe(true)
  })

  test("switching models doesn't refund — spent stays spent", () => {
    const meter = new ContextMeter(INFO)
    meter.observe({ input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } })
    meter.retarget({ ...INFO, limit: { context: 32_000, output: 8_000 } })
    expect(meter.snapshot.spent.total).toBe(1_100)
  })
})

// ─────────────────────────────────────────────── the compaction point

describe("compaction point", () => {
  const compacted = (text: string) => message("user", { type: "compact", text, folded: 3, tokensBefore: 100 })

  test("never compacted means starting from the beginning", () => {
    expect(compactionIndex([said("a"), replied("b")])).toBe(0)
  })

  test("★ history before the compaction point is no longer sent to the model", () => {
    const history = [said("很久以前"), replied("嗯"), compacted("到这里为止的交接"), said("接着干")]
    const messages = toLLMMessages(history)
    const flat = JSON.stringify(messages)
    expect(flat).not.toContain("很久以前")
    expect(flat).toContain("到这里为止的交接")
    expect(flat).toContain("接着干")
  })

  test("the summary goes in as user and says the original text is gone", () => {
    const messages = toLLMMessages([compacted("摘要正文"), said("继续")])
    expect(messages[0]!.role).toBe("user")
    const text = JSON.stringify(messages[0])
    expect(text).toContain("<session-summary>")
    expect(text).toContain("no longer available")
  })

  test("after two compactions only the last counts — the earlier summary is already inside the new one", () => {
    const history = [compacted("第一次"), said("中间"), compacted("第二次"), said("现在")]
    expect(compactionIndex(history)).toBe(2)
    const flat = JSON.stringify(toLLMMessages(history))
    expect(flat).not.toContain("第一次")
    expect(flat).toContain("第二次")
  })

  test("★ the gauge sees the same history as the model — folded messages never count toward usage", () => {
    const heavy = "x".repeat(40_000)
    const history = [said(heavy), replied(heavy), compacted("短摘要"), said("hi")]
    const report = contextReport({ history, system: [], tools: [], info: INFO })
    expect(report.folded).toBe(2)
    expect(report.messages).toBe(2)
    expect(report.used).toBeLessThan(estimateTokens(heavy))
  })
})

// ─────────────────────────────────────────────── keeping a tail

describe("recent turns kept verbatim", () => {
  /** Builds a compaction point whose keptFrom points at that message in history */
  const withTail = (text: string, keptFrom: string) =>
    message("user", { type: "compact", text, folded: 3, tokensBefore: 100, keptFrom })

  test("★ the summary comes first, the kept text after — it covers what happened earlier", () => {
    const older = said("很久以前")
    const keep = said("最近这句")
    const answer = replied("最近那个回答")
    const mark = withTail("到这里为止的交接", keep.info.id)
    const history = [older, keep, answer, mark]
    const messages = toLLMMessages(history)
    const flat = JSON.stringify(messages)
    expect(flat).not.toContain("很久以前")
    expect(flat).toContain("到这里为止的交接")
    expect(flat).toContain("最近这句")
    // order: summary first, original text after
    expect(JSON.stringify(messages[0])).toContain("到这里为止的交接")
    expect(JSON.stringify(messages[1])).toContain("最近这句")
  })

  // ★ When compacting twice in a row, the second keptFrom always lands **before** the
  //   first pin. The compact message caught in between gets turned by userContent into a
  //   whole block of "everything above has been replaced by the handoff summary below"
  //   and sent — so in the middle of live history the model reads "nothing you saw
  //   before counts anymore", followed by an old summary **already superseded by the
  //   current one**, and that old one still carries an authoritative "the original text
  //   is gone"
  test("★ an old compaction point inside the kept tail is removed, never sent again", () => {
    const older = said("很久以前")
    const first = message("user", { type: "compact", text: "第一版交接", folded: 2, tokensBefore: 100 })
    const between = said("两次压缩之间说的")
    const second = withTail("第二版交接", first.info.id)
    const flat = JSON.stringify(toLLMMessages([older, first, between, second]))

    expect(flat).toContain("第二版交接")
    expect(flat).toContain("两次压缩之间说的")
    // **not one word** of the old one should appear
    expect(flat).not.toContain("第一版交接")
    // the "everything above was replaced" line should also appear only once — the one
    // carried by the newest summary
    const notices = flat.split("This session was compacted").length - 1
    expect(notices).toBe(1)
  })

  test("messages after compaction come last", () => {
    const keep = said("留住的")
    const mark = withTail("交接", keep.info.id)
    const messages = toLLMMessages([said("老的"), keep, mark, said("压完之后说的")])
    expect(JSON.stringify(messages.at(-1))).toContain("压完之后说的")
  })

  test("old sessions without keptFrom fall back to keeping nothing, not guessing a position", () => {
    const history = [said("老的"), said("也老"), message("user", { type: "compact", text: "交接", folded: 2, tokensBefore: 1 })]
    const flat = JSON.stringify(toLLMMessages(history))
    expect(flat).not.toContain("老的")
    expect(flat).not.toContain("也老")
    expect(flat).toContain("交接")
  })

  test("keptFrom pointing at a missing message means nothing was kept — no guessing", () => {
    const history = [said("老的"), withTail("交接", "不存在的-id")]
    expect(JSON.stringify(toLLMMessages(history))).not.toContain("老的")
  })

  test("★ the gauge counts only truly folded messages as folded — kept ones still occupy the window", () => {
    const heavy = "x".repeat(40_000)
    const keep = said(heavy)
    const history = [said(heavy), keep, withTail("短摘要", keep.info.id)]
    const report = contextReport({ history, system: [], tools: [], info: INFO })
    expect(report.folded).toBe(1)
    expect(report.used).toBeGreaterThan(estimateTokens(heavy))
  })
})

describe("how long a tail to keep", () => {
  test("too-short history keeps nothing — this compaction shouldn't have happened anyway", () => {
    const live = [said("a"), replied("b")]
    expect(chooseTail(live, 100_000)).toBe(live.length)
  })

  test("★ the cut lands on a user message — cutting between an assistant and its tool result orphans the result", () => {
    const live = [
      said("最初"),
      replied("好"),
      ran("bash", { command: "x" }, "out"),
      replied("嗯"),
      said("接着说"),
      ran("read", { filePath: "a.ts" }, "内容"),
      replied("看完了"),
    ]
    const cut = chooseTail(live, 100_000)
    expect(cut).toBeLessThan(live.length)
    expect(live[cut]!.info.role).toBe("user")
  })

  test("★ a too-heavy tail is given up — compaction runs when the window is nearly full, so keeping it defeats the point", () => {
    const heavy = "y".repeat(200_000)
    const live = [said("最初"), replied("好"), replied("嗯"), replied("哦"), said("接着说"), ran("bash", {}, heavy)]
    expect(chooseTail(live, 20_000)).toBe(live.length)
  })
})

describe("edited files pinned by code", () => {
  const edited = (path: string) =>
    message("assistant", {
      type: "tool",
      callID: `c${path}`,
      tool: "edit",
      state: { status: "completed", input: { filePath: path }, output: "ok", metadata: {}, time: { start: 1, end: 2 } },
    })

  test("★ a path the model omits raises no error, so this line isn't left to the model", () => {
    const out = withFileLedger("GOAL: …", [edited("src/a.ts"), edited("src/b.ts"), edited("src/a.ts")])
    expect(out).toContain("GOAL: …")
    expect(out).toContain("src/a.ts")
    expect(out).toContain("src/b.ts")
    // deduplicated: a file edited three times is still one file
    expect(out.split("src/a.ts").length - 1).toBe(1)
  })

  test("no section added when no file was touched", () => {
    expect(withFileLedger("GOAL: …", [said("聊聊"), replied("好")])).toBe("GOAL: …")
  })

  test("a failed write doesn't count — that's 'tried', not 'edited'", () => {
    const failed = message("assistant", {
      type: "tool",
      callID: "cf",
      tool: "write",
      state: { status: "error", input: { filePath: "src/nope.ts" }, error: "EACCES", metadata: {}, time: { start: 1, end: 2 } },
    })
    expect(withFileLedger("GOAL: …", [failed])).toBe("GOAL: …")
  })
})

describe("a compaction point is not a message awaiting a reply", () => {
  /** One question, one answer, and the answer is to this very question */
  function answered(text: string): MessageWithParts[] {
    const user = said(text)
    const reply = replied("好")
    if (reply.info.role === "assistant") {
      reply.info.parentID = user.info.id
      reply.info.timeCompleted = 2
    }
    return [user, reply]
  }

  test("★ no extra turn after compacting — its input would be 'a summary, and no question'", () => {
    const history = answered("改一下 live.ts")
    expect(isSettled(history)).toBe(true)
    history.push(message("user", { type: "compact", text: "交接", folded: 2, tokensBefore: 1 }))
    expect(isSettled(history)).toBe(true)
  })

  test("a real user message after the compaction point does get answered", () => {
    const history = [
      ...answered("改一下"),
      message("user", { type: "compact", text: "交接", folded: 2, tokensBefore: 1 }),
      said("接着弄"),
    ]
    expect(isSettled(history)).toBe(false)
  })
})

describe("persisting compaction", () => {
  test("★ not a word of the original is deleted — hidden from the model is not hidden from the user", () => {
    const store = new Store(":memory:")
    store.createSession("s1", "/repo")
    store.upsertMessage({ id: "u1", sessionID: "s1", role: "user", timeCreated: 1 })
    store.upsertPart({
      id: "p1",
      sessionID: "s1",
      messageID: "u1",
      timeCreated: 1,
      type: "text",
      text: "原来那句话",
    })

    applyCompaction(store, "s1", "交接说明", { folded: 1, tokensBefore: 999 })
    const history = store.listAll("s1")
    // both are in the DB: the old message + the compaction point
    expect(history.length).toBe(2)
    expect(JSON.stringify(history[0])).toContain("原来那句话")
    // but what's sent to the model starts at the compaction point
    expect(compactionIndex(history)).toBe(1)
    const flat = JSON.stringify(toLLMMessages(history))
    expect(flat).not.toContain("原来那句话")
    expect(flat).toContain("交接说明")
    store.close()
  })
})

// ─────────────────────────────────────────────── the material fed to the compaction agent

describe("compaction material", () => {
  test("when it fits nothing is dropped, and all of it is wrapped in untrusted-data", () => {
    const material = describeSession([said("改一下 live.ts"), ran("read", { filePath: "live.ts" }, "内容"), replied("好了")], 50_000)
    expect(material.dropped).toBe(0)
    expect(material.text).toContain("<untrusted-data>")
    expect(material.text).toContain("改一下 live.ts")
    expect(material.text).toContain("好了")
  })

  test("★ when it doesn't fit, the middle is dropped and both ends kept — the start says the goal, the end the current state", () => {
    const history = [
      said("最初的要求:把渲染器改对"),
      replied("好"),
      ...Array.from({ length: 40 }, (_, i) => ran("bash", { command: `step ${i}` }, "y".repeat(4_000))),
      said("现在卡在哪一步了"),
    ]
    const material = describeSession(history, 4_000)
    expect(material.dropped).toBeGreaterThan(0)
    expect(material.text).toContain("最初的要求")
    expect(material.text).toContain("现在卡在哪一步了")
    // dropping things must be said out loud, or the model takes the first entry it sees as
    // the start of the session
    expect(material.text).toContain("did not fit")
  })

  test("the previous compaction's handoff is carried in verbatim — it is the start of this history", () => {
    const history = [message("user", { type: "compact", text: "上一版交接", folded: 9, tokensBefore: 1 }), said("接着干")]
    expect(describeSession(history, 50_000).text).toContain("上一版交接")
  })

  test("an empty session describes 0 entries — the compactor skips the request on exactly that", () => {
    expect(describeSession([], 50_000).entries).toBe(0)
  })
})

// ─────────────────────────────────────────────── the compaction agent

describe("compaction agent", () => {
  /** A fake stream: records the requests and emits a fixed text */
  function harness(text: string, fail?: Error) {
    const requests: LLMRequest[] = []
    const compact = createCompactor({
      stream(request) {
        requests.push(request)
        return {
          info: INFO,
          events: (async function* (): AsyncGenerator<LLMEvent> {
            if (fail) yield { type: "error", error: fail }
            else for (const chunk of text.split(" ")) yield { type: "text-delta", id: "t", text: chunk + " " }
          })(),
        }
      },
      model: () => ({ providerID: "anthropic", modelID: "test" }),
      language: () => "auto",
      budgetTokens: () => 50_000,
    })
    return { compact, requests }
  }

  const history = [said("修一下折行"), ran("read", { filePath: "a.ts" }, "内容"), replied("改好了")]

  test("★ the compaction request gets no tools — a runaway compaction would touch files when the user can least afford it", async () => {
    const { compact, requests } = harness("GOAL: ...")
    await compact(history)
    expect(requests[0]!.execution!.requestKind).toBe("compaction")
    expect(requests[0]!.execution!.sessionId).toBeUndefined()
    expect(requests[0]!.tools).toEqual([])
    expect(requests[0]!.activeTools).toEqual([])
    expect(() => requests[0]!.makeToolContext({ callID: "x", abortSignal: new AbortController().signal })).toThrow()
  })

  test("cleanup: strips a 'Here is the summary:' style preamble", async () => {
    const { compact } = harness("Here is the handoff: GOAL: 修渲染器")
    const result = await compact(history)
    expect(result.text.startsWith("GOAL")).toBe(true)
    expect(result.failed).toBeUndefined()
  })

  test("★ on error it returns the reason with empty text — callers must never pin an empty summary into history", async () => {
    const { compact } = harness("", new Error("429 slow down\nstack..."))
    const result = await compact(history)
    expect(result.text).toBe("")
    expect(result.failed).toContain("429")
  })

  test("user presses esc: reports 'interrupted', not 'timed out'", async () => {
    const controller = new AbortController()
    const { compact } = harness("x")
    controller.abort()
    const result = await compact(history, { signal: controller.signal })
    expect(result.failed).toBe("interrupted")
  })

  test("no history, no request", async () => {
    const { compact, requests } = harness("x")
    const result = await compact([])
    expect(requests.length).toBe(0)
    expect(result.failed).toContain("nothing")
  })

  test("★ what the user asks to preserve goes into the request verbatim — only they know what can't be lost", async () => {
    const { compact, requests } = harness("GOAL: …")
    await compact(history, { focus: "那三行 429 报错的原文" })
    expect(JSON.stringify(requests[0]!.messages)).toContain("那三行 429 报错的原文")
  })

  test("no focus, no extra section", async () => {
    const { compact, requests } = harness("GOAL: …")
    await compact(history)
    expect(requests[0]!.messages[0]!.content.length).toBe(1)
  })

  test("★ edited files are pinned into the handoff by code, whether or not the model wrote them", async () => {
    const edited = message("assistant", {
      type: "tool",
      callID: "ce",
      tool: "edit",
      state: {
        status: "completed",
        input: { filePath: "src/renderer.ts" },
        output: "ok",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    })
    const { compact } = harness("GOAL: 改渲染器")
    const result = await compact([said("改一下"), edited, replied("好了")])
    expect(result.text).toContain("src/renderer.ts")
    expect(result.text).toContain("GOAL: 改渲染器")
  })

  test("keeping a tail adds a system section and reports how many were kept and from where", async () => {
    const live = [
      said("最初"),
      replied("好"),
      replied("嗯"),
      replied("哦"),
      said("接着说"),
      replied("看完了"),
    ]
    const { compact, requests } = harness("GOAL: …")
    const result = await compact(live)
    expect(result.kept).toBe(2)
    expect(result.folded).toBe(4)
    expect(result.keptFrom).toBe(live[4]!.info.id)
    expect(JSON.stringify(requests[0]!.system)).toContain("stay in the conversation verbatim")
    // the kept messages stay out of the material — they follow the summary verbatim, so
    // restating them would be duplication
    expect(JSON.stringify(requests[0]!.messages)).not.toContain("接着说")
  })

  test("keeping nothing adds no system section — that sentence would be false without a tail", async () => {
    const { compact, requests } = harness("GOAL: …")
    const result = await compact(history)
    expect(result.kept).toBe(0)
    expect(result.keptFrom).toBeUndefined()
    expect(JSON.stringify(requests[0]!.system)).not.toContain("stay in the conversation verbatim")
  })
})

// ─────────────────────────────────────────────── drawing it

describe("rendering", () => {
  test("the gauge renders at both extremes with a constant width", () => {
    expect(gauge(0, 10)).toBe("░".repeat(10))
    expect(gauge(1, 10)).toBe("▓".repeat(10))
    // any amount draws one cell: zero cells would make people think it's broken
    expect(gauge(0.001, 10).startsWith("▓")).toBe(true)
    expect([...gauge(0.37, 10)].length).toBe(10)
  })

  test("★ gradient bar: one color per cell, green to dark red, and **not one extra column**", () => {
    setColorEnabled(true)
    try {
      const full = gradientGauge(1, 12)
      const codes = [...full.matchAll(/38;5;(\d+)m▓/g)].map((m) => Number(m[1]))
      expect(codes.length).toBe(12)
      // the head is pure green (46), the tail dark red (88) — even a short bar walks the
      // full color ramp
      expect(codes[0]).toBe(46)
      expect(codes[codes.length - 1]).toBe(88)
      expect(new Set(codes).size).toBeGreaterThan(8)
      // still 12 columns with color on
      expect(displayWidth(full)).toBe(12)
      // the cells not yet reached get no color — they mean "not there yet" and shouldn't
      // be colored
      const half = gradientGauge(0.5, 12)
      expect([...half.matchAll(/38;5;\d+m▓/g)].length).toBe(6)
      expect(displayWidth(half)).toBe(12)
    } finally {
      setColorEnabled(false)
    }
  })

  test("--no-color / pipes fall back to plain characters — escape sequences must never reach a pipe", () => {
    expect(gradientGauge(0.5, 8)).toBe("▓▓▓▓░░░░")
    expect(rampPaint(0.9)("90%")).toBe("90%")
  })

  test("every report row has a label, and a guessed window size is called out", () => {
    const report = contextReport({
      history: [said("hi"), ran("bash", { command: "ls" }, "out"), replied("ok")],
      system: ["sys"],
      tools: registerBuiltins(new ToolRegistry()).list(),
      info: INFO,
    })
    const text = renderContextReport(report, "anthropic/test")
    for (const label of ["system prompt", "tool definitions", "tool results", "free"]) {
      expect(text).toContain(label)
    }
    // limitSource=default: this number is a fallback value and must be labeled as such
    expect(text).toContain("did not report a window size")
    expect(text).toContain("/setting")
    expect(text).toContain("/compact")
  })

  test("empty rows are not listed — they would bury the rows that take up space", () => {
    const report = contextReport({ history: [said("hi")], system: ["sys"], tools: [], info: INFO })
    const text = renderContextReport(report, "anthropic/test")
    expect(text).not.toContain("thinking")
    expect(text).not.toContain("compacted summary")
  })
})

/**
 * Add a row and forget to give it a label, and that line is drawn blank **without an
 * error** — the report is silently missing a row while the total still adds up, and
 * nobody can tell.
 */
test("every slice has a non-empty label", () => {
  for (const key of SLICE_KEYS) {
    expect(sliceLabel(key).length).toBeGreaterThan(0)
  }
})

// ─────────────────────────────────────────────── the model looking at its own context

describe("★ context tool", () => {
  const view = (over: Partial<ContextView> = {}): ContextView => ({
    used: 306_000,
    budget: 900_000,
    limit: 1_000_000,
    estimated: false,
    messages: 47,
    folded: 12,
    slices: [
      { key: "system", tokens: 12_000 },
      { key: "result", tokens: 180_000 },
      { key: "memory", tokens: 0 },
      { key: "reply", tokens: 114_000 },
    ],
    ...over,
  })

  const run = (context?: () => ContextView | undefined) =>
    ContextTool.execute(
      {},
      createToolContext(
        {
          cwd: "/tmp",
          root: "/tmp",
          sessionID: "s",
          async ask() {},
          onProgress() {},
          onMetadata() {},
          ...(context ? { context } : {}),
        },
        { messageID: "m", callID: "c", abortSignal: new AbortController().signal },
      ),
    )

  test("reports total, free space and message count, with rows sorted largest first", async () => {
    const result = await run(() => view())
    expect(result.output).toContain("306k of 900k used (34%)")
    expect(result.output).toContain("594k free")
    expect(result.output).toContain("47 messages in context, 12 more already folded")
    // the biggest row comes first — it's the answer to "which part should go"
    const shown = result.output.slice(result.output.indexOf("What is filling it"))
    expect(shown.indexOf("tool results")).toBeLessThan(shown.indexOf("your replies"))
    // a zero row takes no space: a report full of zeros makes the reader hunt for what
    // matters
    expect(shown).not.toContain("project memory")
  })

  test("★ says when it's nearly full, and that compacting isn't something the model can do", async () => {
    const result = await run(() => view({ used: 800_000 }))
    expect(result.output).toContain("nearly full")
    expect(result.output).toContain("/compact")
    expect(result.output).toContain("cannot run it yourself")
  })

  test("no nagging while there's plenty of room — nagging every time is no nagging", async () => {
    expect((await run(() => view({ used: 90_000 }))).output).not.toContain("nearly full")
  })

  test("says whether the number is estimated or reported", async () => {
    expect((await run(() => view({ estimated: true }))).output).toContain("estimated locally")
    expect((await run(() => view())).output).toContain("reported by the provider")
  })

  test("★ when not wired up it says 'not available' instead of reporting an empty window", async () => {
    const result = await run(undefined)
    expect(result.output).toContain("not available")
    expect(result.output).not.toContain("0 of 0")
    expect(result.metadata["available"]).toBe(false)
  })
})

describe("this session's bill", () => {
  const info: ModelInfo = { ...INFO, cacheInInput: true }
  const tk = (input: number, output: number, read = 0) => ({
    input,
    output,
    reasoning: 0,
    cache: { read, write: 0 },
  })

  /**
   * ★ The message-level `tokens` stores **usage** (processor.ts:
   *   `message.tokens = this.contextTokens`, taken from the last step), not the bill. Use
   *   it as the bill and a turn that ran three steps is charged for only the last one.
   */
  test("★ rebuilding spend from history: scans step-finish parts, ignores message-level tokens", () => {
    const history = [
      {
        // put an obviously wrong number at message level, to make sure nobody takes the
        // shortcut of reading it
        info: { tokens: tk(999_999, 999_999) },
        parts: [
          { type: "step-finish", tokens: tk(100, 10) },
          { type: "text" },
          { type: "step-finish", tokens: tk(200, 20) },
        ],
      },
      { info: {}, parts: [{ type: "step-finish", tokens: tk(300, 30) }] },
    ]
    const billed = billedFromHistory(history as never)
    expect(billed.input).toBe(600)
    expect(billed.output).toBe(60)
  })

  test("no step-finish means zero — no crash", () => {
    expect(billedFromHistory([{ info: {}, parts: [{ type: "text" }] }] as never).input).toBe(0)
    expect(billedFromHistory([]).input).toBe(0)
  })

  test("★ resuming a session continues its spend instead of starting at zero", () => {
    const meter = new ContextMeter(info)
    meter.observe(tk(500, 50))
    meter.resetSpend(billedFromHistory([{ info: {}, parts: [{ type: "step-finish", tokens: tk(1000, 100) }] }] as never))
    expect(meter.spent.input).toBe(1000)
    // the new-session path still starts from zero
    meter.resetSpend()
    expect(meter.spent.input).toBe(0)
  })

  /**
   * ★ A subagent's bill goes into the total, but its **usage** must not replace the main
   *   conversation's usage — getting this wrong looks like: send out a subagent, and the
   *   main UI's context percentage suddenly jumps to that subagent's usage.
   */
  test("★ bill() only records spend, leaves context usage alone", () => {
    const meter = new ContextMeter(info)
    meter.observe(tk(1000, 100))
    expect(meter.real).toBe(1000)

    meter.bill(tk(50_000, 900))
    expect(meter.spent.input).toBe(51_000) // the bill went up
    expect(meter.real).toBe(1000) // usage didn't move
  })

  test("observe() still does both", () => {
    const meter = new ContextMeter(info)
    meter.observe(tk(1000, 100))
    meter.observe(tk(1800, 200))
    expect(meter.real).toBe(1800) // usage takes the latest
    expect(meter.spent.input).toBe(2800) // spend accumulates
  })
})

test("cache-hit link follows the measurement explanation and precedes compaction without extra cache rows", () => {
  setInterfaceLanguage("en")
  const report = contextReport({ history: [said("hi")], system: ["sys"], tools: [], info: INFO })
  const text = renderContextReport(report, "fixture/model")
  const lines = text.split("\n")
  const index = lines.findIndex(line => line.includes("/cache-hit"))
  expect(index).toBeGreaterThan(0)
  expect(lines[index - 1]).toContain("estimated")
  expect(lines[index + 1]).toContain("/compact")
  expect(text).not.toContain("Structural ceiling")
  expect(text).not.toContain("Actual hit")
  setInterfaceLanguage("auto")
})
