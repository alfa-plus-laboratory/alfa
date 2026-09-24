/**
 * The connection test shouldn't require the user to understand who fills in which part
 * of the "base URL". Real local HTTP requests here guard the probe order and the value
 * written to disk; testing only strings would miss "the candidate was computed right
 * but the second request was never sent".
 * ★ When the first response is not a 404, the address must never be switched —
 *   otherwise a single wrong key also hits the remote one extra time.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import type { Config } from "../src/config/config.ts"
import { verifyConfiguredModel } from "../src/cli/auth.ts"
import { alternateAnthropicBaseURL } from "../src/llm/base-url.ts"

const servers: Bun.Server<unknown>[] = []
afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.stop(true)
})

function anthropicStream(): Response {
  const events = [
    ["message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", content: [], model: "test", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ]
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}

function config(baseURL: string): Config {
  return { providers: { gateway: { type: "anthropic", baseURL, models: { test: {} } } } }
}

describe("Anthropic base URL auto-detection", () => {
  test("★ with a version already present only the unversioned candidate is generated — never a double v1", () => {
    expect(alternateAnthropicBaseURL("https://gateway.example/anthropic")).toBe("https://gateway.example/anthropic/v1")
    expect(alternateAnthropicBaseURL("https://gateway.example/anthropic/v1/")).toBe("https://gateway.example/anthropic")
    expect(alternateAnthropicBaseURL("https://gateway.example/anthropic/v1/messages")).toBe("https://gateway.example/anthropic/v1")
  })

  test("after a 404 on the root it tries /v1, and writes back to the draft only on success", async () => {
    const paths: string[] = []
    const server = Bun.serve({ port: 0, fetch(request) {
      const path = new URL(request.url).pathname
      paths.push(path)
      return path === "/v1/messages" ? anthropicStream() : Response.json({ error: { message: "not found" } }, { status: 404 })
    } })
    servers.push(server)
    const root = server.url.href.replace(/\/$/, "")
    const draft = config(root)
    const write = spyOn(process.stdout, "write").mockImplementation(() => true)
    const error = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      expect(await verifyConfiguredModel("gateway/test", draft, { gateway: { apiKey: "k" } })).toBe(true)
    } finally {
      write.mockRestore(); error.mockRestore()
    }
    expect(paths).toEqual(["/messages", "/v1/messages"])
    expect(draft.providers?.gateway?.baseURL).toBe(`${root}/v1`)
  })

  test("an existing /v1 isn't appended again; after a 404 it falls back to the unversioned endpoint", async () => {
    const paths: string[] = []
    const server = Bun.serve({ port: 0, fetch(request) {
      const path = new URL(request.url).pathname
      paths.push(path)
      return path === "/messages" ? anthropicStream() : Response.json({ error: { message: "not found" } }, { status: 404 })
    } })
    servers.push(server)
    const root = server.url.href.replace(/\/$/, "")
    const draft = config(`${root}/v1`)
    const write = spyOn(process.stdout, "write").mockImplementation(() => true)
    const error = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      expect(await verifyConfiguredModel("gateway/test", draft, { gateway: { apiKey: "k" } })).toBe(true)
    } finally {
      write.mockRestore(); error.mockRestore()
    }
    expect(paths).toEqual(["/v1/messages", "/messages"])
    expect(draft.providers?.gateway?.baseURL).toBe(root)
  })

  test("an auth failure doesn't switch paths", async () => {
    const paths: string[] = []
    const server = Bun.serve({ port: 0, fetch(request) {
      paths.push(new URL(request.url).pathname)
      return Response.json({ error: { message: "bad key" } }, { status: 401 })
    } })
    servers.push(server)
    const draft = config(server.url.href.replace(/\/$/, ""))
    const write = spyOn(process.stdout, "write").mockImplementation(() => true)
    const error = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      expect(await verifyConfiguredModel("gateway/test", draft, { gateway: { apiKey: "bad" } })).toBe(false)
    } finally {
      write.mockRestore(); error.mockRestore()
    }
    expect(paths).toEqual(["/messages"])
  })

  test("an interactive connection test reports through its host instead of writing to the terminal", async () => {
    const server = Bun.serve({ port: 0, fetch: () => anthropicStream() })
    servers.push(server)
    const lines: string[] = []
    const write = spyOn(process.stdout, "write").mockImplementation(() => true)
    const error = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      expect(await verifyConfiguredModel(
        "gateway/test",
        config(server.url.href.replace(/\/$/, "")),
        { gateway: { apiKey: "k" } },
        { write: text => lines.push(text), error: text => lines.push(text) },
      )).toBe(true)
      expect(write).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
      expect(lines.join("\n")).toContain("verifying gateway/test")
      expect(lines.join("\n")).toContain("ok")
    } finally {
      write.mockRestore(); error.mockRestore()
    }
  })
})
