/**
 * Image input: finding the paths in a line, reading them, storing them on the message,
 * and what each wire protocol receives.
 *
 * Like effort.test.ts, the protocol assertions are on the **serialized body**: the SDKs
 * turn one file part into three different shapes, and a text-only model must get the
 * note, not a 400 on every later turn.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectImages, displayPath, hasDataImage, imageReferences, MAX_IMAGE_BYTES, saveDataImages, sniff } from "../src/cli/attachments.ts"
import { createToolContext } from "../src/tool/context.ts"
import { ReadTool } from "../src/tool/read.ts"
import { contextReport, IMAGE_TOKENS } from "../src/agent/context.ts"
import { Emitter, type UIEvent } from "../src/agent/events.ts"
import { Loop } from "../src/agent/loop.ts"
import { toLLMMessages } from "../src/agent/to-model-messages.ts"
import { LLMRegistry } from "../src/llm/registry.ts"
import { anthropicProvider } from "../src/llm/providers/anthropic.ts"
import { openAIProvider } from "../src/llm/providers/openai.ts"
import { openAICompatProvider } from "../src/llm/providers/openai-compat.ts"
import { stream } from "../src/llm/stream.ts"
import type { LLMMessage, ModelInfo } from "../src/llm/types.ts"
import { Store } from "../src/session/store.ts"
import { newSessionID } from "../src/session/id.ts"

/** The smallest valid PNG: 1×1 */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64")
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0])

let dir = ""
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "alfa-images-"))
  writeFileSync(join(dir, "shot.png"), PNG)
  writeFileSync(join(dir, "Screen Shot.png"), PNG)
  // A .png that is really a JPEG — screenshot tools do this
  writeFileSync(join(dir, "liar.png"), JPEG)
  writeFileSync(join(dir, "notes.png"), "not an image at all")
  writeFileSync(join(dir, "huge.png"), Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("which paths in a line count", () => {
  test("@ mentions, relative or absolute, in order", () => {
    expect(imageReferences("compare @before.png with @/tmp/after.jpg please")).toEqual(["before.png", "/tmp/after.jpg"])
  })

  /** A dragged-in file arrives as a bare absolute path; that's the whole point of accepting them */
  test("bare absolute and ~/ paths count, a bare relative name doesn't", () => {
    expect(imageReferences("看 /Users/me/Desktop/a.png 和 ~/b.webp")).toEqual(["/Users/me/Desktop/a.png", "~/b.webp"])
    expect(imageReferences("fix the logo.png rendering")).toEqual([])
  })

  test("how terminals hand over names with spaces: backslash escapes and quotes", () => {
    expect(imageReferences("/Users/me/Desktop/Screen\\ Shot\\ 1.png what is this")).toEqual(["/Users/me/Desktop/Screen Shot 1.png"])
    expect(imageReferences("'/Users/me/Screen Shot.png' and @\"my shot.jpeg\"")).toEqual(["/Users/me/Screen Shot.png", "my shot.jpeg"])
  })

  /**
   * ★ Chinese doesn't put a space after the path, and English puts a period after it —
   *   both must end the path at the extension, or the most natural way to write the
   *   question attaches nothing.
   */
  test("★ the path ends at the extension: CJK right after it, or a closing period", () => {
    expect(imageReferences("@shot.png看一下哪里不对")).toEqual(["shot.png"])
    expect(imageReferences("What's wrong in @shot.png.")).toEqual(["shot.png"])
    expect(imageReferences("@shot.png, @b.gif")).toEqual(["shot.png", "b.gif"])
    expect(imageReferences("@archive.png.bak @a.pngx")).toEqual([])
  })

  test("file:// URLs count", () => {
    expect(imageReferences("file:///Users/me/a%20b.png")).toEqual(["file:///Users/me/a%20b.png"])
  })

  /**
   * ★ The mirror of the test above: Chinese puts no space *before* the path either. It
   *   really happened with a dragged screenshot — the image stayed behind and the model,
   *   given a bare path, said it couldn't see pictures.
   */
  test("★ a path glued to CJK text before it still counts", () => {
    expect(imageReferences("这是什么/Users/me/Desktop/Screenshot\\ 2026-09-23\\ at\\ 17.18.35.png")).toEqual(["/Users/me/Desktop/Screenshot 2026-09-23 at 17.18.35.png"])
    expect(imageReferences("看一下@shot.png哪里不对")).toEqual(["shot.png"])
    expect(imageReferences("截图在这：~/Desktop/a.png")).toEqual(["~/Desktop/a.png"])
    // Only a local path or @ is taken out of the text; a glued relative name still isn't one
    expect(imageReferences("修一下logo.png的渲染")).toEqual([])
  })
})

describe("a pasted data: URL", () => {
  const b64 = PNG.toString("base64")

  test("is saved as a file and replaced by its @path, which then attaches", async () => {
    const out = saveDataImages(`这是什么data:image/png;base64,${b64}`, join(dir, "pasted"), dir)
    expect(out).toMatch(/^这是什么 @~\/pasted\/clipboard-[^ ]+\.png$/)
    const { images } = await collectImages(out, { cwd: dir, home: dir })
    expect(images.map((image) => image.mediaType)).toEqual(["image/png"])
    expect(images[0]!.url).toBe(`data:image/png;base64,${b64}`)
  })

  /**
   * ⚠ base64's alphabet includes letters. A pattern that crossed whitespace would decode
   *   "what is this" into the image's tail and leave the question out of the text.
   */
  test("⚠ the words after it stay words", () => {
    // A length divisible by 3 has no `=` padding, which would otherwise end the match on
    // its own and hide the bug
    const unpadded = Buffer.concat([PNG, Buffer.alloc((3 - (PNG.length % 3)) % 3)]).toString("base64")
    expect(unpadded.endsWith("=")).toBe(false)
    const out = saveDataImages(`data:image/png;base64,${unpadded} what is this`, join(dir, "pasted"), dir)
    expect(out).toMatch(/^@~\/pasted\/clipboard-[^ ]+\.png what is this$/)
  })

  test("the type comes from the bytes; something that isn't an image stays as text", () => {
    expect(saveDataImages(`data:image/png;base64,${JPEG.toString("base64")}`, join(dir, "pasted"), dir)).toMatch(/\.jpg$/)
    const notImage = `data:image/png;base64,${Buffer.from("hello").toString("base64")}`
    expect(saveDataImages(notImage, join(dir, "pasted"), dir)).toBe(notImage)
    expect(hasDataImage("no image here")).toBe(false)
  })
})

describe("read on an image", () => {
  /** The generic "binary file" error sent the model off to OCR a picture it had been given */
  test("says where the image is instead of just 'binary'", async () => {
    const context = createToolContext(
      { cwd: dir, root: dir, sessionID: "images", async ask() {}, onProgress() {}, onMetadata() {} },
      { messageID: "m", callID: "read-image", abortSignal: new AbortController().signal },
    )
    await expect(ReadTool.execute({ filePath: join(dir, "shot.png") }, context)).rejects.toThrow("already in their message as an image")
  })
})

describe("reading them", () => {
  test("attaches with the type from the bytes, not the extension", async () => {
    const { images, problems } = await collectImages("@shot.png and @liar.png", { cwd: dir })
    expect(problems).toEqual([])
    expect(images.map((image) => [image.filename, image.mediaType])).toEqual([["shot.png", "image/png"], ["liar.png", "image/jpeg"]])
    expect(images[0]!.url).toBe(`data:image/png;base64,${PNG.toString("base64")}`)
  })

  /** "draw @logo.png" may be asking for the file to be made — no complaint for that */
  test("a missing path is skipped silently; a non-image is reported", async () => {
    const { images, problems } = await collectImages("@missing.png @notes.png", { cwd: dir })
    expect(images).toEqual([])
    expect(problems).toEqual([{ kind: "not-image", path: join(dir, "notes.png") }])
  })

  test("names with spaces, ~ and duplicates", async () => {
    const escaped = join(dir, "Screen Shot.png").replace(/ /g, "\\ ")
    const { images } = await collectImages(`${escaped} ~/shot.png @shot.png`, { cwd: dir, home: dir })
    expect(images.map((image) => image.filename)).toEqual(["Screen Shot.png", "shot.png"])
  })

  /**
   * ★ Over the cap an image is shrunk if the platform can, refused with the reason if
   *   not — never sent as-is to be a 400.
   */
  test("★ oversized: shrunk when possible, otherwise reported and left out", async () => {
    const small = join(dir, "shrunk-copy.png")
    const shrunk = await collectImages("@huge.png", { cwd: dir, shrink: async () => { writeFileSync(small, PNG); return small } })
    expect(shrunk.images[0]).toMatchObject({ filename: "huge.png", resized: true, bytes: PNG.length })
    const refused = await collectImages("@huge.png", { cwd: dir, platform: "linux" })
    expect(refused.images).toEqual([])
    expect(refused.problems[0]).toMatchObject({ kind: "too-large" })
  })

  test("sniff knows the four types the providers take, and nothing else", () => {
    expect(sniff(PNG)).toBe("image/png")
    expect(sniff(JPEG)).toBe("image/jpeg")
    expect(sniff(Buffer.from("GIF89a"))).toBe("image/gif")
    expect(sniff(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp")
    expect(sniff(Buffer.from("%PDF-1.7"))).toBeUndefined()
  })

  test("a pasted screenshot's path is shown under ~", () => {
    expect(displayPath("/Users/me/.local/share/alfa/clipboard/c.png", "/Users/me")).toBe("~/.local/share/alfa/clipboard/c.png")
  })
})

describe("stored on the message", () => {
  test("file parts follow the text, in order, and reach the model", async () => {
    const store = new Store(":memory:")
    const sessionID = newSessionID()
    store.createSession(sessionID, "/tmp")
    const info: ModelInfo = { ref: { providerID: "p", modelID: "m" }, limit: { context: 200_000, output: 8_000 }, supportsThinking: false, promptTemplate: "default", cacheInInput: true }
    const seen: LLMMessage[][] = []
    const loop = new Loop({
      store, emitter: new Emitter<UIEvent>(), tools: () => [], system: () => ["S"],
      makeToolContext: () => { throw new Error("no tools") },
      stream(request) {
        seen.push(request.messages)
        return { info, events: (async function* () {
          yield { type: "step-start" as const }
          yield { type: "step-finish" as const, finishReason: "stop", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }
        })() }
      },
    })
    const url = `data:image/png;base64,${PNG.toString("base64")}`
    await loop.run({
      sessionID, model: info.ref, text: "compare @a.png @b.png", abortSignal: new AbortController().signal,
      attachments: [{ mediaType: "image/png", filename: "a.png", url }, { mediaType: "image/png", filename: "b.png", url }],
    })
    const parts = store.listAll(sessionID)[0]!.parts
    expect(parts.map((part) => part.type === "file" ? part.filename : part.type)).toEqual(["text", "a.png", "b.png"])
    expect(seen[0]![0]).toEqual({ role: "user", content: [
      { type: "text", text: "compare @a.png @b.png" },
      { type: "file", mediaType: "image/png", data: url, filename: "a.png" },
      { type: "file", mediaType: "image/png", data: url, filename: "b.png" },
    ] })

    // ★ Counted as a flat figure, not by its base64 — see IMAGE_TOKENS
    const report = contextReport({ history: store.listAll(sessionID), system: [], tools: [], info })
    expect(report.used).toBeLessThan(3 * IMAGE_TOKENS)
    expect(report.used).toBeGreaterThanOrEqual(2 * IMAGE_TOKENS)
    expect(toLLMMessages(store.listAll(sessionID))[0]!.role).toBe("user")
  })
})

describe("what each protocol receives", () => {
  const sse = (events: unknown[], done: boolean) =>
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""), { headers: { "content-type": "text/event-stream" } })
  const events = {
    anthropic: [
      { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ],
    responses: [
      { type: "response.created", response: { id: "r", model: "x", created_at: 1 } },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ],
    chat: [
      { id: "c", object: "chat.completion.chunk", created: 1, model: "x", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ],
  }
  const url = `data:image/png;base64,${PNG.toString("base64")}`
  async function body(protocol: "anthropic" | "responses" | "chat", images?: boolean): Promise<any> {
    let captured: any
    const server = Bun.serve({ port: 0, async fetch(req) {
      captured = await req.json()
      return sse(events[protocol], protocol !== "anthropic")
    } })
    try {
      const common = { id: "fx", apiKey: "k", baseURL: server.url.href, ...(images !== undefined ? { images } : {}) }
      const provider = protocol === "anthropic" ? anthropicProvider(common) : protocol === "responses" ? openAIProvider(common) : openAICompatProvider(common)
      const handle = stream(new LLMRegistry().register(provider), {
        model: { providerID: "fx", modelID: protocol === "anthropic" ? "claude-x" : "gpt-5.4" }, system: ["s"], tools: [],
        messages: [{ role: "user", content: [{ type: "text", text: "what is @shot.png" }, { type: "file", mediaType: "image/png", data: url, filename: "shot.png" }] }],
        makeToolContext: () => { throw new Error("no tools") }, abortSignal: new AbortController().signal,
      })
      for await (const _ of handle.events) {}
      return captured
    } finally { await server.stop(true) }
  }

  test("Anthropic: a base64 image block", async () => {
    const content = (await body("anthropic")).messages[0].content
    expect(content[1]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } })
  })

  test("Responses: an input_image", async () => {
    const content = (await body("responses")).input.find((item: any) => item.role === "user").content
    expect(content[1]).toMatchObject({ type: "input_image", image_url: url })
  })

  /**
   * ★ Default yes on every protocol and endpoint, not only Claude / OpenAI's own: a wrong
   *   no fails silently (the model says it can't see a picture it could have read), a
   *   wrong yes fails loudly and the failed turn names the switch. See ModelConfig.images
   */
  test("★ every endpoint defaults to images, third-party and non-Claude included", async () => {
    const registry = new LLMRegistry()
      .register(anthropicProvider({ id: "mm", apiKey: "k", baseURL: "https://api.minimaxi.com/anthropic/v1" }))
      .register(openAIProvider({ id: "ds", apiKey: "k", baseURL: "https://api.deepseek.com" }))
    expect(registry.resolve("mm/MiniMax-M2.7").info.images).toBe(true)
    expect(registry.resolve("ds/deepseek-flash").info.images).toBe(true)
  })

  test("Chat Completions: an image_url", async () => {
    const content = (await body("chat")).messages.find((m: any) => m.role === "user").content
    expect(content[1]).toMatchObject({ type: "image_url", image_url: { url } })
  })

  /**
   * ★ The way out for a text-only endpoint: the image stays in history, and without the
   *   note every later turn would 400 again. The note keeps the conversation going and
   *   says which image the model isn't seeing.
   */
  test("★ images: false gets the note on every protocol", async () => {
    for (const protocol of ["anthropic", "responses", "chat"] as const) {
      const captured = JSON.stringify(await body(protocol, false))
      expect(captured).not.toContain(PNG.toString("base64"))
      expect(captured).toContain("does not accept images")
      expect(captured).toContain("shot.png")
    }
  })
})
