/**
 * Deciding whether a file is binary.
 *
 * Two passes: an extension denylist (fast, catches the vast majority) + sampling the
 * first 4KB (the fallback, catches files without an extension). The aim isn't
 * precision, it's to keep a 50MB .so from being stuffed whole into the model's context.
 */
import { openSync, readSync, closeSync } from "node:fs"
import { extname } from "node:path"

const BINARY_EXTENSIONS = new Set([
  // executables and object files
  ".exe", ".dll", ".so", ".dylib", ".a", ".o", ".obj", ".bin", ".wasm", ".class", ".pyc", ".pyo",
  // archives
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war", ".zst",
  // images / audio and video
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff", ".avif", ".heic",
  ".mp3", ".mp4", ".wav", ".flac", ".ogg", ".avi", ".mov", ".mkv", ".webm",
  // documents / fonts / databases
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".db", ".sqlite", ".sqlite3", ".mdb",
])

const SAMPLE_BYTES = 4096
/** If the share of non-printable bytes exceeds this, it's judged binary. */
const NONPRINTABLE_RATIO = 0.3

export function isBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.has(extname(path).toLowerCase())
}

export function isBinaryFile(path: string): boolean {
  if (isBinaryPath(path)) return true

  let fd: number
  try {
    fd = openSync(path, "r")
  } catch {
    return false
  }

  try {
    const buf = Buffer.alloc(SAMPLE_BYTES)
    const read = readSync(fd, buf, 0, SAMPLE_BYTES, 0)
    if (read === 0) return false

    let nonPrintable = 0
    for (let i = 0; i < read; i++) {
      const byte = buf[i]!
      if (byte === 0) return true // a NUL is an instant veto
      // Allow \t \n \r and printable ASCII; >=0x80 is taken as UTF-8 multibyte and
      // not counted
      const printable = byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) || byte >= 128
      if (!printable) nonPrintable++
    }
    return nonPrintable / read > NONPRINTABLE_RATIO
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}
