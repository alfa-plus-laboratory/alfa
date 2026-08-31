/**
 * 二进制文件判定。
 *
 * 两道:扩展名黑名单(快,挡住绝大多数)+ 前 4KB 采样(兜底,挡住没扩展名的)。
 * 目的不是精确,是防止把一个 50MB 的 .so 整个塞进模型上下文。
 */
import { openSync, readSync, closeSync } from "node:fs"
import { extname } from "node:path"

const BINARY_EXTENSIONS = new Set([
  // 可执行与目标文件
  ".exe", ".dll", ".so", ".dylib", ".a", ".o", ".obj", ".bin", ".wasm", ".class", ".pyc", ".pyo",
  // 压缩包
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war", ".zst",
  // 图片 / 音视频
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff", ".avif", ".heic",
  ".mp3", ".mp4", ".wav", ".flac", ".ogg", ".avi", ".mov", ".mkv", ".webm",
  // 文档 / 字体 / 数据库
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".db", ".sqlite", ".sqlite3", ".mdb",
])

const SAMPLE_BYTES = 4096
/** 不可打印字节占比超过这个数就判定为二进制。 */
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
      if (byte === 0) return true // NUL 一票否决
      // 允许 \t \n \r 与可打印 ASCII;>=0x80 认为是 UTF-8 多字节,不计入
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
