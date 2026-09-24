/**
 * Built-in tool registration.
 *
 * Registering a built-in tool happens in this file — this is where the "tools are
 * pluggable" boundary lands. When our own capabilities get wired in later (a memory
 * layer, managing remote hosts), that means hanging one more source here, not touching
 * the loop.
 */
import { EnvironmentTool } from "./environment.ts"
import { SshTool } from "./ssh.ts"
import { AskTool } from "./ask.ts"
import { ApplyPatchTool } from "./apply-patch.ts"
import { BashTool } from "./bash.ts"
import { ContextTool } from "./context-window.ts"
import { EditTool } from "./edit.ts"
import { GlobTool } from "./glob.ts"
import { GrepTool } from "./grep.ts"
import { JobTool } from "./job.ts"
import { MemoryTool } from "./memory.ts"
import { ReadTool } from "./read.ts"
import { SkillTool } from "./skill.ts"
import type { ToolRegistry } from "./registry.ts"
import { TaskTool } from "./task.ts"
import { TodoTool } from "./todo.ts"
import { WebFetchTool } from "./webfetch.ts"
import { WebSearchTool } from "./websearch.ts"
import { WriteTool } from "./write.ts"

export function registerBuiltins(registry: ToolRegistry): ToolRegistry {
  return registry
    .register(ReadTool)
    .register(WriteTool)
    .register(EditTool)
    // CLI exposes this only for the opt-in Responses profile; generic lists stay stable.
    .register(ApplyPatchTool)
    .register(BashTool)
    .register(GrepTool)
    .register(GlobTool)
    .register(TodoTool)
    // Whatever runs in the background is watched and stopped through this one: processes
    // started by bash, and subagents dispatched by task. See tool/background.ts — here the
    // two are one and the same column
    .register(JobTool)
    // Send a copy of itself out to do work. See agent/subagent.ts
    .register(TaskTool)
    // Stop at a fork in the road and ask. See tool/ask.ts
    .register(AskTool)
    // Project memory that lives across sessions. See tool/memory.ts
    .register(MemoryTool)
    // Lets it check for itself how much context is left. See tool/context-window.ts
    .register(ContextTool)
    .register(EnvironmentTool)
    .register(SshTool)
    // Open a playbook on demand. The catalogue is in the system prompt; the body is fetched
    // here. See prompt/skills.ts
    .register(SkillTool)
    // ── The two that go out to the network ──
    // Whatever they bring back is always treated as **untrusted input**, all of it through
    // tool/untrusted.ts. That is not a fastidiousness of these two tools in particular; it
    // is this program's one and only stance on "words from outside"
    .register(WebFetchTool)
    .register(WebSearchTool)
}
