/**
 * Images the user attaches to a message: `@shot.png`, a dragged-in path, or ctrl-v.
 *
 * ── Why this reads the file when `@` completion (mentions.ts) deliberately doesn't ──
 * For text, a mention only gets the path right; whether to read it, and how much, stays
 * the agent's call (see the header of mentions.ts). An image has no such second step:
 * no tool can put pixels in front of the model — `read` returns text. So for an image
 * the mention **is** the attachment, and it is attached here, next to the user's own
 * line, before the turn starts.
 *
 * ── Which paths count ──
 * `@path` (relative to the working directory, or absolute) and — without `@` — an
 * absolute or `~/` path: that is what dragging a file onto a terminal or pasting a
 * copied path produces. A bare relative name does not count: "fix the logo.png
 * rendering" talks about a file, it doesn't show one. Quotes and backslash-escaped
 * spaces are how terminals hand over names with spaces (every macOS screenshot has
 * them). A path that doesn't exist is skipped without a word: "draw @logo.png" may be
 * asking for the file to be made.
 *
 * Chinese and Japanese put no space between words, so a dragged path often lands glued
 * to the question: `这是什么/Users/me/shot.png`. The bare pattern reads that as one token
 * starting with 这 — neither `@` nor local — so the path is taken from the first `@` or
 * local-path start that follows a non-ASCII character (see unglue). It really happened:
 * the image stayed behind, the model got a bare path, ran `ls` on it and said it
 * couldn't see pictures.
 *
 * ── A pasted `data:` URL becomes a file ──
 * "Copy image address" on most Google Images results gives a `data:image/…;base64,` URL,
 * not a link. Sent as text it is tens of KB of tokens the model can't view — it tried to
 * decode it by retyping the base64 into a shell and corrupted it. So the paste is saved
 * like a ctrl-v screenshot and replaced by its `@path` (saveDataImages): one road for
 * every image, visible in the line before sending.
 *
 * ── Type by bytes, not by extension ──
 * The extension only picks candidates; the magic number decides the media type. A
 * `.png` that is really a JPEG (screenshot tools do this) sent under the wrong type is a
 * 400 whose message doesn't say which image.
 *
 * ── Size ──
 * 3.75 MB raw is 5 MB as base64 — Anthropic's per-image cap, the tightest of the three
 * protocols. Over it, macOS shrinks the image with `sips` (always installed) to 1568 px
 * on the long edge, the size Claude would scale it to anyway; elsewhere it is refused
 * with the reason. A full-screen Retina screenshot is routinely over the cap, so without
 * the shrink the most common image a coding user pastes would be the one that fails.
 *
 * ⚠ The text is sent unchanged, `@path` included. The model needs the name to know which
 *   image the sentence is about, and the user's line in history must stay what they typed.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** One attached image, ready to be stored as a file part */
export interface ImageFile {
  /** Absolute path it was read from */
  path: string
  filename: string
  mediaType: string
  /** `data:` URL — what the file part stores and the SDK accepts as-is */
  url: string
  /** Size actually attached (after any shrink) */
  bytes: number
  resized: boolean
}

export type ImageProblem =
  | { kind: "not-image"; path: string }
  | { kind: "too-large"; path: string; bytes: number }
  | { kind: "too-many"; limit: number }

/** 5 MB of base64 — see the header */
export const MAX_IMAGE_BYTES = 3_750_000
/** Past this many, a line is more likely a pasted directory listing than a question */
export const MAX_IMAGES = 20
const SHRINK_TO = 1568

const EXT = "(?:png|jpe?g|gif|webp)"
/** 'path' or "path" — how some terminals hand over a dragged name with spaces */
const QUOTED = new RegExp(`(@?)(['"])([^'"\\n]+?\\.${EXT})\\2`, "gi")
/**
 * An unquoted token: backslash escapes continue it (`Screen\ Shot.png`). It ends at the
 * first image extension followed by something that can't continue an ASCII path — so
 * `@a.png看一下` and `@a.png, then` both stop at `.png`, while `a.png.bak` is no match.
 * A trailing `.` counts as the end of a sentence only when nothing follows it.
 */
const BARE = new RegExp(
  `(^|[\\s(\\[{<（【「『“‘])(@?)((?:\\\\.|[^\\s\\\\'"])+?\\.${EXT})(?=$|[^A-Za-z0-9_.\\-/\\\\]|\\.(?:$|\\s))`,
  "gi",
)

/**
 * The image paths a line refers to, in the order they appear, as written (not resolved).
 * Pure: whether each one exists is collectImages' question.
 */
export function imageReferences(text: string, platform: NodeJS.Platform = process.platform): string[] {
  const found: Array<{ at: number; raw: string }> = []
  // Quoted ones first, then blanked out so the bare pattern can't find half of one again
  const rest = text.replace(QUOTED, (match, at: string, _quote: string, path: string, offset: number) => {
    if (at || looksLocal(path)) found.push({ at: offset, raw: path })
    return " ".repeat(match.length)
  })
  for (const match of rest.matchAll(BARE)) {
    const at = match[2] ?? ""
    const raw = platform === "win32" ? match[3]! : match[3]!.replace(/\\(.)/g, "$1")
    const offset = match.index! + match[1]!.length
    if (at || looksLocal(raw)) {
      found.push({ at: offset, raw })
      continue
    }
    const glued = unglue(raw)
    if (glued) found.push({ at: offset + glued.index, raw: glued.path })
  }
  return found.sort((a, b) => a.at - b.at).map((one) => one.raw)
}

/** A non-ASCII character, then `@` or where a local path starts. See the header */
const GLUED = /[^\x00-\x7f](?:@|(?=\/|~\/|file:\/\/|[A-Za-z]:[\\/]))/u

function unglue(raw: string): { index: number; path: string } | undefined {
  const match = GLUED.exec(raw)
  if (!match) return undefined
  const index = match.index + match[0].length
  const path = raw.slice(index)
  return path ? { index, path } : undefined
}

/** Absolute, home-relative, a file URL or a Windows drive path: something a drag produces */
function looksLocal(raw: string): boolean {
  return raw.startsWith("/") || raw.startsWith("~/") || raw.startsWith("file://") || /^[A-Za-z]:[\\/]/.test(raw)
}

export interface CollectOptions {
  cwd: string
  home?: string
  platform?: NodeJS.Platform
  /** Shrink an oversized image; returns the path of a smaller copy, or undefined. Injectable for tests */
  shrink?(path: string): Promise<string | undefined>
}

/** Read every image the line refers to. Missing paths are skipped (see the header) */
export async function collectImages(text: string, options: CollectOptions): Promise<{ images: ImageFile[]; problems: ImageProblem[] }> {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const shrink = options.shrink ?? (platform === "darwin" ? sipsShrink : undefined)
  const images: ImageFile[] = []
  const problems: ImageProblem[] = []
  const seen = new Set<string>()
  for (const raw of imageReferences(text, platform)) {
    const path = resolvePath(raw, options.cwd, home)
    if (!path || seen.has(path)) continue
    seen.add(path)
    try {
      if (!statSync(path).isFile()) continue
    } catch {
      continue
    }
    if (images.length >= MAX_IMAGES) {
      problems.push({ kind: "too-many", limit: MAX_IMAGES })
      break
    }
    let bytes = readFileSync(path)
    const mediaType = sniff(bytes)
    if (!mediaType) {
      problems.push({ kind: "not-image", path })
      continue
    }
    let resized = false
    if (bytes.length > MAX_IMAGE_BYTES) {
      const smaller = shrink ? await shrink(path) : undefined
      if (smaller) {
        try {
          const shrunk = readFileSync(smaller)
          if (shrunk.length <= MAX_IMAGE_BYTES && sniff(shrunk) === mediaType) {
            bytes = shrunk
            resized = true
          }
        } finally {
          rmSync(smaller, { force: true })
        }
      }
      if (!resized) {
        problems.push({ kind: "too-large", path, bytes: bytes.length })
        continue
      }
    }
    images.push({
      path,
      filename: basename(path),
      mediaType,
      url: `data:${mediaType};base64,${bytes.toString("base64")}`,
      bytes: bytes.length,
      resized,
    })
  }
  return { images, problems }
}

function resolvePath(raw: string, cwd: string, home: string): string | undefined {
  try {
    if (raw.startsWith("file://")) return fileURLToPath(raw)
  } catch {
    return undefined
  }
  if (raw === "~" || raw.startsWith("~/")) return join(home, raw.slice(2))
  return isAbsolute(raw) ? raw : resolve(cwd, raw)
}

/** Media type from the first bytes. undefined = not one of the four the providers take */
export function sniff(bytes: Uint8Array): string | undefined {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png"
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (ascii(0, 4) === "GIF8") return "image/gif"
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp"
  return undefined
}

/** macOS only. `-Z` keeps the aspect ratio and never enlarges */
async function sipsShrink(path: string): Promise<string | undefined> {
  const out = join(tmpdir(), `alfa-shrink-${process.pid}-${Date.now()}-${basename(path)}`)
  try {
    const proc = Bun.spawn(["sips", "-Z", String(SHRINK_TO), path, "--out", out], { stdout: "ignore", stderr: "ignore" })
    return (await proc.exited) === 0 ? out : undefined
  } catch {
    return undefined
  }
}

// ─────────────────────────────────────────────── ctrl-v

export type ClipboardResult = { path: string } | { error: "no-image" } | { error: "unsupported"; hint: string }

/** How long a pasted screenshot is kept on disk. The image itself lives on in the session */
const CLIPBOARD_KEEP_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Save the clipboard's image as a PNG in `dir` and return its path.
 *
 * ── Why ctrl-v and a file, not cmd-v and bytes ──
 * A terminal pastes text only: with an image on the clipboard, cmd-v sends nothing at
 * all. ctrl-v reaches the program as a key, and the host asks the OS for the image
 * itself. It is written to a file and the input gets `@<path>`, so a pasted screenshot
 * travels the same road as a typed one — visible in the line before sending, sent with
 * it, found again by the up arrow — instead of a second, invisible attachment channel
 * that a queued or recalled line would lose.
 */
export async function saveClipboardImage(dir: string, platform: NodeJS.Platform = process.platform): Promise<ClipboardResult> {
  mkdirSync(dir, { recursive: true })
  sweep(dir)
  const path = clipboardPath(dir, "png")
  const wrote = platform === "darwin" ? await macClipboard(path) : platform === "win32" ? await windowsClipboard(path) : await linuxClipboard(path)
  if (wrote !== true) {
    rmSync(path, { force: true })
    return wrote
  }
  try {
    if (statSync(path).size > 0 && sniff(readFileSync(path).subarray(0, 16)) === "image/png") return { path }
  } catch {
    // fall through: nothing usable was written
  }
  rmSync(path, { force: true })
  return { error: "no-image" }
}

async function macClipboard(path: string): Promise<true | ClipboardResult> {
  // The path goes in as an argument, never spliced into the script: a quote in it
  // would otherwise end the AppleScript string
  const script = [
    "on run argv",
    "set png to (the clipboard as «class PNGf»)",
    "set f to open for access (POSIX file (item 1 of argv)) with write permission",
    "set eof f to 0",
    "write png to f",
    "close access f",
    "end run",
  ]
  const code = await run(["osascript", ...script.flatMap((line) => ["-e", line]), path])
  return code === 0 ? true : code === undefined ? { error: "unsupported", hint: "osascript" } : { error: "no-image" }
}

async function windowsClipboard(path: string): Promise<true | ClipboardResult> {
  const script =
    "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; " +
    "$i = [System.Windows.Forms.Clipboard]::GetImage(); if ($i -eq $null) { exit 3 }; " +
    "$i.Save($env:ALFA_CLIPBOARD_OUT, [System.Drawing.Imaging.ImageFormat]::Png)"
  // -STA: the clipboard API refuses to work from a multi-threaded apartment
  const code = await run(["powershell", "-NoProfile", "-STA", "-Command", script], { ALFA_CLIPBOARD_OUT: path })
  return code === 0 ? true : code === undefined ? { error: "unsupported", hint: "powershell" } : { error: "no-image" }
}

async function linuxClipboard(path: string): Promise<true | ClipboardResult> {
  const wayland = Boolean(process.env["WAYLAND_DISPLAY"])
  const command = wayland ? ["wl-paste", "--no-newline", "--type", "image/png"] : ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"]
  try {
    const proc = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" })
    const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer())
    if ((await proc.exited) !== 0 || bytes.length === 0) return { error: "no-image" }
    await Bun.write(path, bytes)
    return true
  } catch {
    return { error: "unsupported", hint: wayland ? "wl-paste (wl-clipboard)" : "xclip" }
  }
}

/** Exit code, or undefined when the program isn't there at all */
async function run(command: string[], env?: Record<string, string>): Promise<number | undefined> {
  try {
    const proc = Bun.spawn(command, { stdout: "ignore", stderr: "ignore", ...(env ? { env: { ...process.env, ...env } } : {}) })
    return await proc.exited
  } catch {
    return undefined
  }
}

// ─────────────────────────────────────────────── pasted data: URLs

/**
 * `data:image/…;base64,…` — see the header. ⚠ No whitespace inside: base64's alphabet
 * includes letters, so allowing a space or newline would swallow the words after the URL
 * ("…AAAA= what is this") into the image and corrupt its tail.
 */
const DATA_URL = /data:image\/[\w.+-]+;base64,([A-Za-z0-9+/]+={0,2})/gi

export function hasDataImage(text: string): boolean {
  DATA_URL.lastIndex = 0
  return DATA_URL.test(text)
}

const EXTENSION: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }

/**
 * Save every `data:` image in the text to `dir` and put its `@path` in its place. One
 * that doesn't decode to one of the four image types stays as text: it isn't something
 * a provider would take, and deleting what the user pasted would be worse. Size is left
 * to collectImages, which shrinks or refuses with a receipt, as for any other file.
 */
export function saveDataImages(text: string, dir: string, home: string = homedir()): string {
  if (!hasDataImage(text)) return text
  let swept = false
  return text.replace(DATA_URL, (match: string, base64: string, offset: number) => {
    const bytes = Buffer.from(base64, "base64")
    const mediaType = sniff(bytes)
    if (!mediaType) return match
    if (!swept) {
      mkdirSync(dir, { recursive: true })
      sweep(dir)
      swept = true
    }
    const path = clipboardPath(dir, EXTENSION[mediaType]!)
    try {
      writeFileSync(path, bytes)
    } catch {
      return match
    }
    // Spaced off from its neighbors, so the path can't run into the words around it
    const before = offset > 0 && !/\s/.test(text[offset - 1]!) ? " " : ""
    const after = offset + match.length < text.length && !/\s/.test(text[offset + match.length]!) ? " " : ""
    return `${before}@${displayPath(path, home)}${after}`
  })
}

let pasted = 0

/** Named `clipboard-…` so sweep takes pasted data URLs too. The counter keeps two in one line apart */
function clipboardPath(dir: string, extension: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\..*/, "")
  return join(dir, `clipboard-${stamp}-${Date.now() % 1000}-${pasted++}.${extension}`)
}

/** Old pastes go on the next paste; no timer for a directory that's touched this rarely */
function sweep(dir: string): void {
  const deadline = Date.now() - CLIPBOARD_KEEP_MS
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("clipboard-")) continue
      const file = join(dir, name)
      try {
        if (statSync(file).mtimeMs < deadline) rmSync(file, { force: true })
      } catch {
        // gone already, or not ours to delete
      }
    }
  } catch {
    // an unreadable directory only means nothing gets swept
  }
}

/** `~/…` when under home: the path goes into the input box, where shorter is kinder */
export function displayPath(path: string, home: string = homedir()): string {
  return path.startsWith(home + "/") ? `~${path.slice(home.length)}` : path
}
