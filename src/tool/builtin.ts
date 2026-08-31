/**
 * 内置工具注册。
 *
 * M1 之后新增工具只改这一个文件 —— 这是「工具可插拔」那条边界的落点。
 * 将来接自有能力(记忆层、远端主机纳管)时,是在这里再挂一个 source,
 * 而不是去动循环。
 */
import { AskTool } from "./ask.ts"
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
    .register(BashTool)
    .register(GrepTool)
    .register(GlobTool)
    .register(TodoTool)
    // 后台跑着的东西由它来看和停:bash 起的进程,和 task 派出去的子 agent。
    // 见 tool/background.ts —— 那两种在这里是同一栏东西
    .register(JobTool)
    // 派一个自己出去干活。见 agent/subagent.ts
    .register(TaskTool)
    // 到了岔路口停下来问一句。见 tool/ask.ts
    .register(AskTool)
    // 跨会话活着的项目记忆。见 tool/memory.ts
    .register(MemoryTool)
    // 它自己看一眼还剩多少上下文。见 tool/context-window.ts
    .register(ContextTool)
    // 按需打开一份打法。目录在 system prompt 里,正文在这儿取。见 prompt/skills.ts
    .register(SkillTool)
    // ── 出网的两个 ──
    // 它们回来的东西一律当**不可信输入**处理,统一走 tool/untrusted.ts。
    // 那不是这两个工具各自的洁癖,是这个程序对"外面来的字"的唯一态度
    .register(WebFetchTool)
    .register(WebSearchTool)
}
