#!/usr/bin/env bun
/**
 * 工具直连 harness —— 不经过 LLM,直接喂参数跑一个工具。
 *
 *   bun run script/tool.ts read '{"filePath":"package.json"}'
 *   bun run script/tool.ts grep '{"pattern":"export function"}'
 *   ALFA_NO_RG=1 bun run script/tool.ts grep '{"pattern":"export function"}'
 *
 * 权限一律自动放行(--deny 可改成一律拒绝,用来验错误路径)。
 */
import { createToolContext } from "../src/tool/context.ts"
import { registerBuiltins } from "../src/tool/builtin.ts"
import { ToolRegistry } from "../src/tool/registry.ts"
import { PermissionDeniedError } from "../src/tool/types.ts"
import { findWorkspaceRoot } from "../src/fs/workspace.ts"

const argv = Bun.argv.slice(2)
const deny = argv.includes("--deny")
const positional = argv.filter((a) => !a.startsWith("--"))
const [toolID, rawArgs = "{}"] = positional

if (!toolID) {
  console.error("usage: bun run script/tool.ts <tool> '<json-args>' [--deny]")
  process.exit(2)
}

const registry = new ToolRegistry()
registerBuiltins(registry)

const tool = registry.get(toolID)
if (!tool) {
  console.error(`unknown tool ${JSON.stringify(toolID)}. available: ${registry.ids().join(", ")}`)
  process.exit(2)
}

const parsed = tool.parameters.safeParse(JSON.parse(rawArgs))
if (!parsed.success) {
  console.error("invalid arguments:\n" + JSON.stringify(parsed.error.issues, null, 2))
  process.exit(2)
}

const cwd = process.cwd()
const controller = new AbortController()
process.on("SIGINT", () => controller.abort())

const ctx = createToolContext(
  {
    cwd,
    root: findWorkspaceRoot(cwd),
    sessionID: "harness",
    async ask(input) {
      const label = `${input.permission}: ${input.patterns.join(", ")}`
      if (deny) throw new PermissionDeniedError(input.permission, input.patterns[0] ?? "")
      console.error(`\x1b[2m[ask] ${label} → auto-allow\x1b[0m`)
    },
    onProgress(_callID, text) {
      console.error(`\x1b[2m[progress] ${text}\x1b[0m`)
    },
    onMetadata() {},
  },
  { messageID: "harness", callID: "harness", abortSignal: controller.signal },
)

try {
  const started = performance.now()
  const result = await tool.execute(parsed.data, ctx)
  const elapsed = (performance.now() - started).toFixed(0)
  console.log(result.output)
  console.error(
    `\x1b[2m—— ${result.title ?? toolID} · ${elapsed}ms · ${JSON.stringify(result.metadata)}\x1b[0m`,
  )
} catch (error) {
  console.error(`\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`)
  process.exit(1)
}
