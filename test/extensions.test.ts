/**
 * External files must really be loaded, registered and executed; checking only the
 * interface types is not enough to guard this trust entry point.
 */
import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { Extensions } from "../src/extension/api.ts"
import { ToolRegistry } from "../src/tool/registry.ts"
import { createToolContext } from "../src/tool/context.ts"
test("external tools go through permission and before/after events; command notifications cannot inject terminal control", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alfa-extension-")), path = join(dir, "plugin.ts")
  const body = `import {z} from ${JSON.stringify(resolve("node_modules/zod/index.js"))}; export const apiVersion=1; export function activate(api){ api.registerTool({id:"x_echo",description:"Echo",parameters:z.object({text:z.string()}),execute:async a=>({output:a.text,metadata:{truncated:false}})});api.onTool("before",e=>api.ui.notify("before:"+e.tool));api.onTool("after",e=>api.ui.notify("after:"+e.tool));api.registerCommand("hello",a=>api.ui.notify("\\u001bhello "+a)); }`
  writeFileSync(path, body)
  try {
    const registry = new ToolRegistry(), lines: string[] = [], asks: string[] = []
    const host = new Extensions(registry, text => lines.push(text))
    await host.load([{ path, sha256: createHash("sha256").update(body).digest("hex") }])
    const ctx = createToolContext({cwd:dir,root:dir,sessionID:"s",ask:async r=>{asks.push(r.permission)},onProgress(){},onMetadata(){}},{messageID:"m",callID:"c",abortSignal:new AbortController().signal})
    expect((await registry.get("x_echo")!.execute({text:"ok"},ctx)).output).toBe("ok")
    expect(asks).toEqual(["extension"])
    expect(lines).toContain("before:x_echo");expect(lines).toContain("after:x_echo")
    expect(await host.command("/x:hello world")).toBe(true)
    expect(lines.at(-1)).toBe("hello world")
    writeFileSync(path, body + "\n// changed")
    await expect(new Extensions(new ToolRegistry(),()=>{}).load([{path,sha256:createHash("sha256").update(body).digest("hex")}])).rejects.toThrow("changed")
  } finally { rmSync(dir,{recursive:true,force:true}) }
})
