#!/usr/bin/env bun
/**
 * LLM-layer probe — skips the main loop, feeds one user message + the full tool set
 * directly, and prints the normalized LLMEvents one by one.
 *
 *   bun run script/llm.ts "list the ts files in the current directory"
 *   ALFA_MODEL=gateway/your-model-id bun run script/llm.ts "..."
 *
 * The one reason this script exists: to verify that "the same backend, via two provider
 * paths, produces event sequences of the same shape downstream". A normalization layer
 * verified against only one provider is as good as unverified.
 */
import { createToolContext } from "../src/tool/context.ts"
import { registerBuiltins } from "../src/tool/builtin.ts"
import { ToolRegistry } from "../src/tool/registry.ts"
import { findWorkspaceRoot } from "../src/fs/workspace.ts"
import { buildRegistry, defaultModelSpec } from "../src/llm/setup.ts"
import { loadConfig } from "../src/config/config.ts"
import { loadAuth } from "../src/config/auth.ts"
import { stream } from "../src/llm/stream.ts"
import { parseModelRef } from "../src/llm/registry.ts"
import type { LLMEvent } from "../src/llm/types.ts"

const prompt = Bun.argv.slice(2).join(" ") || "List the TypeScript files under src/llm and tell me what each one does."
const config = loadConfig()
const auth = loadAuth()
const spec = process.env["ALFA_MODEL"] ?? defaultModelSpec({ config, auth })
if (!spec) {
  console.error("no model configured — run: alfa auth login")
  process.exit(1)
}

const registry = new ToolRegistry()
registerBuiltins(registry)

const cwd = process.cwd()
const controller = new AbortController()
process.on("SIGINT", () => controller.abort())

console.error(`\x1b[2mmodel: ${spec}\x1b[0m`)

const counts = new Map<string, number>()
const started = performance.now()
let firstToken: number | undefined

const handle = stream(buildRegistry({ config, auth }), {
  model: parseModelRef(spec),
  system: ["You are a terse coding assistant. Use tools when they help. Do not explain what you are about to do."],
  messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
  tools: registry.list(),
  makeToolContext: (call) =>
    createToolContext(
      {
        cwd,
        root: findWorkspaceRoot(cwd),
        sessionID: "probe",
        async ask(input) {
          console.error(`\x1b[2m  [ask] ${input.permission}: ${input.patterns.join(" | ")} → auto-allow\x1b[0m`)
        },
        onProgress() {},
        onMetadata() {},
      },
      { messageID: "probe", callID: call.callID, abortSignal: call.abortSignal },
    ),
  abortSignal: controller.signal,
})

for await (const event of handle.events) {
  counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
  if (!firstToken && (event.type === "text-delta" || event.type === "reasoning-delta")) {
    firstToken = performance.now() - started
  }
  print(event)
}

console.error(
  `\n\x1b[2m—— first token ${firstToken?.toFixed(0) ?? "n/a"}ms · total ${(performance.now() - started).toFixed(0)}ms\x1b[0m`,
)
console.error("\x1b[2m—— event counts " + JSON.stringify(Object.fromEntries([...counts].toSorted())) + "\x1b[0m")

function print(event: LLMEvent): void {
  switch (event.type) {
    case "text-delta":
      process.stdout.write(event.text)
      break
    case "reasoning-delta":
      process.stdout.write(`\x1b[2m${event.text}\x1b[0m`)
      break
    case "text-end":
    case "reasoning-end":
      process.stdout.write("\n")
      break
    case "tool-input-start":
      console.log(`\n\x1b[36m▸ ${event.tool}\x1b[0m \x1b[2m(${event.callID})\x1b[0m`)
      break
    case "tool-call":
      console.log(`\x1b[36m  input:\x1b[0m ${JSON.stringify(event.input).slice(0, 200)}`)
      break
    case "tool-result":
      console.log(`\x1b[32m  ✓\x1b[0m ${event.output.split("\n").slice(0, 3).join(" ⏎ ").slice(0, 200)}`)
      break
    case "tool-error":
      console.log(`\x1b[31m  ✗ ${event.error}\x1b[0m`)
      break
    case "step-finish":
      console.log(
        `\n\x1b[2m[step-finish] finish=${event.finishReason} in=${event.tokens.input} out=${event.tokens.output} cacheR=${event.tokens.cache.read}\x1b[0m`,
      )
      break
    case "error":
      console.error(`\x1b[31m[error] ${event.error.message}\x1b[0m`)
      break
    default:
      break
  }
}
