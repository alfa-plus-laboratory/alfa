/**
 * 工具注册表。
 *
 * 刻意保持纯净:这里**不做** AI SDK 形状的转换。计划里原本把 toAiSdkTools()
 * 放在这个文件,但那会让 src/tool 依赖 "ai",跟「工具层不认 SDK」这条边界
 * 冲突。转换放在 src/llm/adapt-tools.ts —— LLM 层同时认识两边,是唯一该
 * 承担翻译职责的地方。
 */
import type { ToolDef } from "./types.ts"

export class ToolRegistry {
  private tools = new Map<string, ToolDef<any>>()

  register(def: ToolDef<any>): this {
    if (this.tools.has(def.id)) throw new Error(`Tool "${def.id}" is already registered`)
    this.tools.set(def.id, def)
    return this
  }

  get(id: string): ToolDef<any> | undefined {
    return this.tools.get(id)
  }

  has(id: string): boolean {
    return this.tools.has(id)
  }

  /**
   * 按 id 字典序返回。
   *
   * ⚠ 排序不是洁癖:工具定义是 system prompt 之后最靠前的缓存前缀,顺序一抖
   *   整个 prompt cache 就 miss。Map 的插入序会随注册代码改动而变,必须排。
   */
  list(): ToolDef<any>[] {
    return [...this.tools.values()].toSorted((a, b) => a.id.localeCompare(b.id))
  }

  ids(): string[] {
    return this.list().map((t) => t.id)
  }
}
