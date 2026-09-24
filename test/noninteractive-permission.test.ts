/**
 * A missing approval channel is not a human decision. Exercise the real -p permission
 * path and the next model request so a UI-only wording fix cannot hide a stale error.
 * The local model stub asks for a harmless marker write that must never execute.
 */
import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

test("noninteractive approval failure reaches the model as unavailable without running the tool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alfa-no-approval-")), root = join(dir, "workspace")
  const bodies: any[] = []
  const server = Bun.serve({ port: 0, async fetch(request) {
    const body: any = await request.json(); bodies.push(body)
    const done = body.messages.some((message: any) => message.role === "tool")
    const delta = done ? { content: "Fixture finished." } : { tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf blocked > marker" }) } }] }
    const chunks = [
      { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] },
      { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ]
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  try {
    mkdirSync(root)
    const config = join(dir, "config", "alfa"), provider = `fixture-${crypto.randomUUID()}`
    mkdirSync(config, { recursive: true })
    writeFileSync(join(config, "config.json"), JSON.stringify({ check: false, language: { interface: "en" }, providers: { [provider]: { type: "openai-chat", baseURL: server.url.href, noKey: true, models: { fixture: {} } } } }))
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith("ALFA_") || key.startsWith("APCODE_")) delete env[key]
    Object.assign(env, { XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), ALFA_NO_UPDATE: "1" })
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli/main.ts"), "-c", root, "-m", `${provider}/fixture`, "--permission", "confirm", "--no-color", "-p", "Write the marker fixture using bash."], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text()
    const timeout = setTimeout(() => child.kill(), 15_000)
    try {
      expect({ exit: await child.exited, stderr: await stderr }).toEqual({ exit: 0, stderr: "" })
      expect(await stdout).toContain("approval unavailable; operation not executed")
    } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill() }
    expect(existsSync(join(root, "marker"))).toBe(false)
    expect(bodies).toHaveLength(2)
    const result = bodies[1].messages.find((message: any) => message.role === "tool").content
    expect(result).toContain("Approval unavailable for bash")
    expect(result).toContain("no interactive input")
    expect(result).toContain("This is not a user rejection")
    expect(result).not.toContain("The user rejected this action")
  } finally { await server.stop(true); rmSync(dir, { recursive: true, force: true }) }
}, 20_000)
