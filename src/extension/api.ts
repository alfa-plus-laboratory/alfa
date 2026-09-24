/**
 * v1 extensions are explicitly trusted host code, not scripts inside a sandbox. ★ The
 * project directory is never scanned automatically.
 * Pinning the entry point by hash stops an approved entry from changing silently; the
 * dependency tree still falls within the extension author's trust scope.
 * Events and commands keep a small interface; the core loop doesn't depend on the
 * extensions' lifecycle.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { isAbsolute } from "node:path"
import { pathToFileURL } from "node:url"
import type { ToolRegistry } from "../tool/registry.ts"
import type { ToolContext, ToolDef, ToolResult } from "../tool/types.ts"
export const EXTENSION_API_VERSION = 1 as const
export interface ToolEvent { tool: string; input: unknown; context: ToolContext; result?: ToolResult; error?: unknown }
export interface ExtensionAPI {
  version: 1
  registerTool<A>(tool: ToolDef<A>): void
  onTool(phase: "before" | "after", listener: (event: ToolEvent) => void | Promise<void>): void
  registerCommand(name: string, handler: (args: string) => void | Promise<void>): void
  ui: { notify(text: string): void }
}
export interface ExtensionEntry { path: string; sha256: string }
export class Extensions {
  private commands = new Map<string, (args: string) => void | Promise<void>>()
  constructor(private registry: ToolRegistry, private notify: (text: string) => void) {}
  async load(entries: ExtensionEntry[]): Promise<void> {
    for (const entry of entries) {
      if (!isAbsolute(entry.path)) throw new Error("Extension paths must be absolute")
      const hash = createHash("sha256").update(readFileSync(entry.path)).digest("hex")
      if (hash !== entry.sha256) throw new Error(`Extension changed; review and update its hash before loading: ${entry.path}`)
      const module = await import(pathToFileURL(entry.path).href)
      if (module.apiVersion !== 1 || typeof module.activate !== "function") throw new Error(`Extension requires apiVersion=1 and activate(api): ${entry.path}`)
      await module.activate({
        version: 1,
        registerTool: (def: ToolDef<any>) => {
          if (!/^x_[a-z0-9_]+$/.test(def.id)) throw new Error("Extension tool IDs must start with x_ and use lowercase letters, digits or underscores")
          this.registry.register({ ...def, execute: async (args, ctx) => {
            await ctx.ask({ permission: "extension", patterns: [def.id] })
            return def.execute(args, ctx)
          } })
        },
        onTool: (phase: "before" | "after", listener: (event: ToolEvent) => void | Promise<void>) => this.registry.onTool(phase, listener),
        registerCommand: (name: string, handler: (args: string) => void | Promise<void>) => {
          if (!/^[a-z0-9-]+$/.test(name) || this.commands.has(name)) throw new Error(`Invalid or duplicate extension command: ${name}`)
          this.commands.set(name, handler)
        },
        ui: { notify: (text: string) => this.notify(text.replace(/[\u001b\u0000-\u0008\u000b-\u001f\u007f]/g, "")) },
      } satisfies ExtensionAPI)
      this.notify(`Trusted extension loaded: ${entry.path} (host privileges)`)
    }
  }
  async command(text: string): Promise<boolean> {
    const match = /^\/x:([a-z0-9-]+)(?:\s+(.*))?$/s.exec(text)
    if (!match) return false
    const handler = this.commands.get(match[1]!)
    if (!handler) throw new Error(`Unknown extension command: ${match[1]}`)
    await handler(match[2] ?? "")
    return true
  }
}
