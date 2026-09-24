/**
 * A task choosing its subagent's model, effort and tools.
 *
 * Same fake-stream approach as subagent.test.ts; what's asserted is what reaches the
 * request (which model, which effort, which tools, which system) and what gets refused
 * before a name is spent.
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { SubagentJobs } from "../src/agent/subagent.ts"
import { Store } from "../src/session/store.ts"
import { newSessionID } from "../src/session/id.ts"
import { __resetNamesForTest } from "../src/tool/background.ts"
import type { LLMEvent, LLMRequest, ModelInfo, ModelRef, ReasoningEffort } from "../src/llm/types.ts"
import type { ToolContext, ToolDef } from "../src/tool/types.ts"
import { JobTool } from "../src/tool/job.ts"
import { TaskTool } from "../src/tool/task.ts"
import { LLMRegistry, resolveTypedModel } from "../src/llm/registry.ts"
import { anthropicProvider } from "../src/llm/providers/anthropic.ts"
import { openAICompatProvider } from "../src/llm/providers/openai-compat.ts"

const info = (ref: ModelRef, promptProfile?: ModelInfo["promptProfile"]): ModelInfo => ({
  ref, limit: { context: 200_000, output: 32_000 }, supportsThinking: true, promptTemplate: "default",
  cacheInInput: true, ...(promptProfile ? { promptProfile } : {}),
})
const MAIN = { providerID: "p", modelID: "big" }

const say: LLMEvent[] = [
  { type: "step-start" },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", text: "done" },
  { type: "text-end", id: "t" },
  { type: "step-finish", finishReason: "stop", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
]

const tool = (id: string): ToolDef<any> => ({ id, description: id, parameters: z.object({}), execute: async () => ({ output: "", metadata: { truncated: false } }) })
/** Already sorted, as the registry hands it out. The codex profile swaps edit/write for apply_patch */
const toolsFor = (model?: ModelInfo) =>
  (model?.promptProfile === "openai-codex" ? ["apply_patch", "bash", "glob", "grep", "read"] : ["bash", "edit", "glob", "grep", "read", "write"]).map(tool)

function harness(options: { effort?: () => ReasoningEffort | undefined; resolveModel?: boolean; failWith?: string; claimOnExit?: boolean } = {}) {
  __resetNamesForTest()
  const store = new Store(":memory:")
  const parent = newSessionID()
  store.createSession(parent, "/repo")
  const requests: LLMRequest[] = []
  const systems: string[] = []
  const agents = new SubagentJobs({
    store,
    model: () => MAIN,
    info: () => info(MAIN),
    tools: toolsFor,
    system: (model) => {
      systems.push(model?.spec ?? "main")
      return ["TEMPLATE", "SUBAGENT"]
    },
    ...(options.resolveModel === false ? {} : {
      resolveModel: (spec: string) => {
        if (!spec.startsWith("p/") && !spec.startsWith("codex/")) throw new Error(`Unknown model "${spec}". Models configured here: p/small`)
        const [providerID, modelID] = spec.split("/") as [string, string]
        const ref = { providerID, modelID }
        return { spec, ref, info: info(ref, providerID === "codex" ? "openai-codex" : undefined) }
      },
    }),
    ...(options.effort ? { effort: options.effort } : {}),
    directory: "/repo",
    session: () => parent,
    makeToolContext: (job, call): ToolContext => ({
      cwd: "/repo", root: "/repo", sessionID: job.sessionID, messageID: call.messageID, callID: call.callID,
      abortSignal: call.abortSignal, ask: async () => {}, onProgress: () => {}, metadata: () => {},
    }),
    // Like deliverReport in cli/main.ts: the host claims whatever report it is told about
    ...(options.claimOnExit ? { observer: (event: { kind: string; job: { id: string } }) => { if (event.kind === "exited") delivered.push(agents.claimReport(event.job.id)) } } : {}),
    stream(request) {
      requests.push(request)
      const failure = options.failWith
      return { info: info(request.model), events: (async function* () {
        if (failure) {
          yield { type: "step-start" as const }
          yield { type: "error" as const, error: new Error(failure) }
          return
        }
        for (const event of say) yield event
      })() }
    },
  })
  const delivered: Array<string | undefined> = []
  return { agents, requests, systems, delivered }
}

async function settled(agents: SubagentJobs, id: string): Promise<void> {
  const until = Date.now() + 2_000
  while (Date.now() < until) {
    if (agents.list().find((job) => job.id === id)?.status === "exited") return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const context = (agents: SubagentJobs, preview?: { text?: string }): ToolContext => ({
  cwd: "/repo", root: "/repo", sessionID: "s", messageID: "m", callID: "c", abortSignal: new AbortController().signal,
  ask: async (request) => { if (preview) preview.text = String(request.metadata?.["preview"]) },
  onProgress: () => {}, metadata: () => {}, agents,
})

describe("tools", () => {
  /**
   * ★ This is the read-only investigation that could not be sent out before: without the
   *   filter, "only read" was a request in the brief, not a limit.
   */
  test("★ the subagent's requests carry only the named tools, in registry order", async () => {
    const h = harness()
    const job = await h.agents.start({ name: "scout", prompt: "look", tools: ["read", "grep", "glob"] })
    await settled(h.agents, job.id)
    // Registry order, not the order they were named in: the tool list is the earliest
    // cache prefix, and two scouts naming the same tools differently must share it
    expect(h.requests[0]!.tools.map((one) => one.id)).toEqual(["glob", "grep", "read"])
  })

  test("without tools it gets everything it had before", async () => {
    const h = harness()
    const job = await h.agents.start({ name: "worker", prompt: "fix it" })
    await settled(h.agents, job.id)
    expect(h.requests[0]!.tools.map((one) => one.id)).toEqual(["bash", "edit", "glob", "grep", "read", "write"])
  })

  /**
   * ★ Refused before a name is claimed: names are never recycled, and a typo would
   *   otherwise turn the corrected retry into "scout-2".
   */
  test("★ an unknown tool is refused with the real list, and no name is spent", async () => {
    const h = harness()
    await expect(h.agents.start({ name: "scout", prompt: "look", tools: ["read", "search"] })).rejects.toThrow(/"search".*read/)
    const job = await h.agents.start({ name: "scout", prompt: "look", tools: ["read"] })
    expect(job.id).toBe("scout")
  })

  test("task and ask can't be granted, and an empty list is refused rather than read as 'all'", async () => {
    const h = harness()
    await expect(h.agents.start({ name: "a", prompt: "x", tools: ["read", "task"] })).rejects.toThrow(/never gets task/)
    await expect(h.agents.start({ name: "a", prompt: "x", tools: [] })).rejects.toThrow(/at least one tool/)
  })

  /** apply_patch exists only on the codex profile; the names are checked against the job's own model */
  test("tool names are checked against the chosen model's list, not the main model's", async () => {
    const h = harness()
    await expect(h.agents.start({ name: "a", prompt: "x", tools: ["apply_patch"] })).rejects.toThrow(/"apply_patch"/)
    const job = await h.agents.start({ name: "b", prompt: "x", model: "codex/gpt", tools: ["apply_patch", "read"] })
    await settled(h.agents, job.id)
    expect(h.requests[0]!.tools.map((one) => one.id)).toEqual(["apply_patch", "read"])
  })
})

describe("model and effort", () => {
  test("a chosen model is used for the request and for the system prompt", async () => {
    const h = harness()
    const job = await h.agents.start({ name: "scout", prompt: "look", model: "p/small" })
    await settled(h.agents, job.id)
    expect(h.requests[0]!.model).toEqual({ providerID: "p", modelID: "small" })
    expect(h.systems).toContain("p/small")
    expect(h.agents.list()[0]!.setup).toEqual({ model: "p/small" })
  })

  test("a bad model name fails the start, with what is configured", async () => {
    const h = harness()
    await expect(h.agents.start({ name: "scout", prompt: "look", model: "q/nope" })).rejects.toThrow(/p\/small/)
    expect(h.agents.list()).toHaveLength(0)
  })

  test("a host without model resolution refuses a chosen model instead of ignoring it", async () => {
    const h = harness({ resolveModel: false })
    await expect(h.agents.start({ name: "scout", prompt: "look", model: "p/small" })).rejects.toThrow(/not available/)
  })

  /**
   * Inherited effort is read at each start, like the model: a woken subagent follows an
   * /effort changed since its last run. A chosen one stays fixed.
   */
  test("effort: chosen is fixed, inherited follows the conversation", async () => {
    let current: ReasoningEffort | undefined = "high"
    const h = harness({ effort: () => current })
    const chosen = await h.agents.start({ name: "a", prompt: "x", effort: "low" })
    await settled(h.agents, chosen.id)
    const inherited = await h.agents.start({ name: "b", prompt: "x" })
    await settled(h.agents, inherited.id)
    current = undefined
    await h.agents.resume(inherited.id, "again")
    await settled(h.agents, inherited.id)
    expect(h.requests.map((request) => request.effort)).toEqual(["low", "high", undefined])
  })
})

describe("the task tool", () => {
  /**
   * ★ A woken subagent's history was produced under its setup; switching model or tools
   *   re-sends all of it at full price. Refused, not silently ignored — ignoring it would
   *   leave the main agent believing the scout now runs on the cheap model.
   */
  test("★ refuses a new setup on resume", async () => {
    const h = harness()
    await TaskTool.execute({ name: "scout", prompt: "look" }, context(h.agents))
    await settled(h.agents, "scout")
    await expect(TaskTool.execute({ resume: "scout", prompt: "more", model: "p/small" }, context(h.agents))).rejects.toThrow(/only apply when starting/)
    await expect(TaskTool.execute({ resume: "scout", prompt: "more", tools: ["read"] }, context(h.agents))).rejects.toThrow(/only apply when starting/)
  })

  /**
   * ★ A mistyped model name only fails at the provider, within the settle window. The
   *   host's own delivery used to claim that report first (settle announced the exit
   *   synchronously), and the task call — where the main agent reads why it didn't start
   *   — got "It said nothing." instead of the provider's error.
   */
  test("★ a subagent that fails on the spot reports the real error to the task call, not to the host", async () => {
    const h = harness({ failWith: "404 model: MiniMax-M2.2 not found", claimOnExit: true })
    const result = await TaskTool.execute({ name: "scout", prompt: "look", model: "p/typo" }, context(h.agents))
    expect(result.output).toContain("MiniMax-M2.2 not found")
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The host was still told it ended — it just found the report already delivered
    expect(h.delivered).toEqual([undefined])
  })

  /** "Can only read" and "can run anything" are different things to approve */
  test("the approval card shows the setup, and job list reports it", async () => {
    const h = harness()
    const preview: { text?: string } = {}
    await TaskTool.execute({ name: "scout", prompt: "look", model: "p/small", effort: "low", tools: ["read", "grep"] }, context(h.agents, preview))
    expect(preview.text).toContain("model: p/small · effort: low · tools: read, grep")
    const list = await JobTool.execute({ action: "list" } as never, context(h.agents))
    expect(list.output).toContain("[model p/small; effort low; tools read,grep]")
  })
})

describe("a model name typed by the model", () => {
  const registry = () => new LLMRegistry()
    .register(anthropicProvider({ id: "mm", apiKey: "k", baseURL: "https://api.minimaxi.com/anthropic/v1", models: { "MiniMax-M2.5": {}, "MiniMax-M2.7": {} } }))
    .register(openAICompatProvider({ id: "local", noKey: true, baseURL: "http://localhost:1/v1" }))
  const current = { spec: "mm/MiniMax-M2.7", ref: { providerID: "mm", modelID: "MiniMax-M2.7" } }

  test("a bare name stays on the current provider; a qualified one picks another", () => {
    expect(resolveTypedModel(registry(), "MiniMax-M2.5", current).spec).toBe("mm/MiniMax-M2.5")
    expect(resolveTypedModel(registry(), "local/org/any-model", current).ref).toEqual({ providerID: "local", modelID: "org/any-model" })
  })

  /**
   * ★ The live run that prompted this: asked for M2.5, the model typed "MiniMax-M2.2".
   *   Refused up front with the real list, instead of starting a subagent that the
   *   provider then 404s.
   */
  test("★ a name outside a provider's declared list is refused with the list", () => {
    expect(() => resolveTypedModel(registry(), "MiniMax-M2.2", current)).toThrow(/not one of the models configured for mm[\s\S]*mm\/MiniMax-M2\.5/)
  })

  /**
   * ★ The live run: provider id `MINIMAX` in config, the model typed "MiniMax/MiniMax-M3".
   *   Matched case-sensitively it became `MINIMAX/MiniMax/MiniMax-M3` and three parallel
   *   tasks failed. Case alone never names a different model.
   */
  test("★ a case-only difference resolves to the configured spelling; a different name still fails", () => {
    expect(resolveTypedModel(registry(), "MM/minimax-m2.5", current).spec).toBe("mm/MiniMax-M2.5")
    expect(resolveTypedModel(registry(), "minimax-m2.7", current).spec).toBe("mm/MiniMax-M2.7")
    expect(resolveTypedModel(registry(), "LOCAL/Some-Model", current).spec).toBe("local/Some-Model")
    expect(() => resolveTypedModel(registry(), "Mm/MiniMax-M2.2", current)).toThrow(/not one of the models configured for mm/)
  })

  test("a provider without a declared list is taken at its word; an unknown provider is refused", () => {
    expect(resolveTypedModel(registry(), "local/whatever", current).spec).toBe("local/whatever")
    expect(() => resolveTypedModel(registry(), "nope/x", current)).toThrow(/Leave "model" out to use your own \(mm\/MiniMax-M2\.7\)/)
  })
})
