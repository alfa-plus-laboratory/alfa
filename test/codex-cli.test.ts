/**
 * Adapter tests cannot detect a missing builtin or CLI profile filter. Launch the real
 * entry point with isolated config/data and a local Responses stub so the exposed tools,
 * prompt, execution, replay and report are checked together without provider credentials.
 */
import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

test("CLI Codex profile exposes native patch and reports execution while generic keeps edit/write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alfa-codex-cli-"))
  const provider = `fixture-${crypto.randomUUID()}`
  const bodies: any[] = []
  const operation = { type: "create_file", path: "created.ts", diff: "+export const created = true\n" }
  const server = Bun.serve({ port: 0, async fetch(request) {
    const body: any = await request.json()
    bodies.push(body)
    const patch = body.model === "codex-fixture" && !body.input.some((item: any) => item.type === "apply_patch_call_output")
    const item = { id: "ap_cli_fixture", call_id: "call_cli_fixture", type: "apply_patch_call", operation }
    const events = [
      { type: "response.created", response: { id: `resp_cli_${bodies.length}`, created_at: 1, model: body.model } },
      ...(patch ? [
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } },
        { type: "response.output_item.done", output_index: 0, item: { ...item, status: "completed" } },
      ] : [
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_cli_fixture", phase: "final_answer" } },
        { type: "response.output_text.delta", output_index: 0, item_id: "msg_cli_fixture", delta: "CLI fixture complete." },
        { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_cli_fixture", phase: "final_answer" } },
      ]),
      { type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } } } },
    ]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  try {
    const env = { ...process.env }
    // Named provider overrides otherwise silently replace the fixture's local endpoint.
    for (const key of Object.keys(env)) if (key.startsWith("ALFA_") || key.startsWith("APCODE_")) delete env[key]
    Object.assign(env, { XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), ALFA_NO_UPDATE: "1", NO_COLOR: "1" })
    const config = join(dir, "config", "alfa")
    mkdirSync(config, { recursive: true })
    const roots = [join(dir, "codex"), join(dir, "generic")]
    for (const root of roots) mkdirSync(root)
    writeFileSync(join(config, "config.json"), JSON.stringify({
      permission: "default", check: false, language: { interface: "en" },
      folders: Object.fromEntries(roots.map(root => [root, { trust: "trusted", seenAt: "2026-01-01" }])),
      providers: { [provider]: { type: "openai-responses", baseURL: server.url.href, noKey: true, models: { "codex-fixture": { promptProfile: "openai-codex" }, "generic-fixture": {} } } },
    }))
    for (const [index, model] of ["codex-fixture", "generic-fixture"].entries()) {
      const report = join(dir, `${model}.json`)
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli/main.ts"), "-c", roots[index]!, "-m", `${provider}/${model}`, "--no-color", "--report", report, "-p", model === "codex-fixture" ? "Create created.ts exporting created = true using apply_patch." : "Say CLI fixture complete."], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text()
      const timeout = setTimeout(() => child.kill(), 15_000)
      try {
        const exit = await child.exited
        const stderr = await errors
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
        expect(await output).toContain("CLI fixture complete.")
      } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill() }
      const metrics = JSON.parse(readFileSync(report, "utf8"))
      expect(metrics.requests.length).toBe(index === 0 ? 2 : 1)
      expect(metrics.approvals).toBe(0)
      expect(new Set(metrics.requests.map((record: any) => record.requestId)).size).toBe(metrics.requests.length)
      for (const record of metrics.requests) {
        expect(record.requestId).toBeString()
        expect(record.execution).toMatchObject({ requestKind: "main", sessionId: metrics.sessionID, rootSessionId: metrics.sessionID, depth: 0 })
        expect(record.execution.runId).toBeString()
        expect(record.cache).toBeDefined()
      }
    }
    const codex = bodies.filter(body => body.model === "codex-fixture"), generic = bodies.find(body => body.model === "generic-fixture")
    expect(codex).toHaveLength(2)
    for (const body of codex) {
      expect(body.store).toBe(false)
      expect(body.tools).toContainEqual({ type: "apply_patch" })
      expect(body.tools.some((tool: any) => tool.name === "edit" || tool.name === "write")).toBe(false)
      expect(JSON.stringify(body.input)).toContain("A progress update is not a final answer.")
    }
    expect(codex[1].input.find((item: any) => item.type === "apply_patch_call")).toMatchObject({ call_id: "call_cli_fixture", operation })
    expect(codex[1].input.find((item: any) => item.type === "apply_patch_call_output")).toMatchObject({ call_id: "call_cli_fixture", status: "completed" })
    expect(readFileSync(join(roots[0]!, "created.ts"), "utf8")).toBe("export const created = true\n")
    expect(existsSync(join(roots[1]!, "created.ts"))).toBe(false)
    expect(generic.store).toBe(false)
    expect(generic.tools.some((tool: any) => tool.name === "edit")).toBe(true)
    expect(generic.tools.some((tool: any) => tool.name === "write")).toBe(true)
    expect(generic.tools.some((tool: any) => tool.type === "apply_patch" || tool.name === "apply_patch")).toBe(false)
    expect(JSON.stringify(generic.input)).not.toContain("A progress update is not a final answer.")
  } finally { await server.stop(true); rmSync(dir, { recursive: true, force: true }) }
}, 40_000)
