/**
 * The example registers just one command and has no external dependencies. After reviewing
 * it, pin the entry point by SHA-256, and only then enable it.
 */
import type { ExtensionAPI } from "../src/extension/api.ts"
export const apiVersion = 1
export function activate(api: ExtensionAPI): void {
  api.registerCommand("hello", name => api.ui.notify(`Hello ${name || "developer"}`))
  api.onTool("after", event => {
    if (event.error) api.ui.notify(`Tool failed: ${event.tool}`)
  })
}
