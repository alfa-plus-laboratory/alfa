/**
 * 凭据持久化。
 *
 * ── 关于"凭据不落文件"这条早期约束 ──
 * 第一版刻意只从环境变量读,理由写的是"能写进文件的 key 早晚会被 commit"。
 * 那个说法不准确:真正的风险是**把 key 写进项目目录**,而不是"任何文件"。
 * 存在家目录、0600、项目里永远看不到,是 gh / aws / opencode 的通行做法。
 *
 * 所以这里保留的是原顾虑里真正有效的那部分,变成三条硬规矩:
 *
 * 1. **只写家目录下的绝对路径**,永远不碰 cwd。项目里不可能出现这个文件,
 *    也就不可能被 git add。
 * 2. **创建时就是 0600**,不是先建再 chmod —— 那中间有一个别人能读到的窗口。
 *    目录也是 0700。读的时候发现权限被放宽了要出声。
 * 3. **密钥单独一个文件**。config.json 里一个字节的密钥都没有,所以它可以
 *    放心地版本化、贴给同事、进 dotfiles 仓库。
 *
 * 另外:任何时候都不打印完整密钥,只打印掩码。没有 --show-key 之类的开关。
 */
import { chmodSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { ensureDirSync } from "../fs/dir.ts"
import { dirname, join } from "node:path"
import { dataDir } from "../util/xdg.ts"

export interface Credential {
  apiKey: string
}

/** provider id → 凭据 */
export type AuthStore = Record<string, Credential>

export function authPath(): string {
  return join(dataDir(), "auth.json")
}

export function loadAuth(path = authPath()): AuthStore {
  if (!existsSync(path)) return {}

  warnIfWorldReadable(path)

  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 不要把损坏的文件当成"没有凭据"静默忽略 —— 那样用户看到的是
    // "no credentials",完全猜不到是文件坏了。
    // 不写程序名:这个文件在 cli 层之下,拿不到用户实际敲的那个名字(见 cli/program.ts),
    // 而写死一个可能不存在的名字比不写更糟
    throw new Error(`${path} is not valid JSON. Fix it, or delete it and log in again.`)
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}

  const out: AuthStore = {}
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue
    const apiKey = (value as Record<string, unknown>)["apiKey"]
    if (typeof apiKey === "string" && apiKey.length > 0) out[id] = { apiKey }
  }
  return out
}

export function saveAuth(store: AuthStore, path = authPath()): void {
  writeSecret(path, JSON.stringify(store, null, 2) + "\n")
}

export function setCredential(id: string, credential: Credential, path = authPath()): AuthStore {
  const store = loadAuth(path)
  store[id] = credential
  saveAuth(store, path)
  return store
}

export function removeCredential(id: string, path = authPath()): boolean {
  const store = loadAuth(path)
  if (!(id in store)) return false
  delete store[id]
  saveAuth(store, path)
  return true
}

// ─────────────────────────────────────────────── 落盘

/**
 * 原子写 + 创建即 0600。
 *
 * 先写临时文件再 rename:中途崩了原文件还是完整的,不会留下半个 JSON
 * 把所有凭据一起弄丢。mode 走 writeFileSync 的参数而不是事后 chmod ——
 * 事后改的话,从创建到 chmod 之间文件是 0644,同机器上别的用户读得到。
 */
function writeSecret(path: string, contents: string): void {
  const dir = dirname(path)
  ensureDirSync(dir, { mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, contents, { mode: 0o600 })
    renameSync(tmp, path)
    // umask 可能把 0600 又放宽了,复核一次
    chmodSync(path, 0o600)
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      // 清不掉临时文件不影响主流程
    }
    throw new Error(`Cannot write ${path}: ${(error as Error).message}`)
  }
}

function warnIfWorldReadable(path: string): void {
  let mode: number
  try {
    mode = statSync(path).mode
  } catch {
    return
  }
  if ((mode & 0o077) === 0) return
  process.stderr.write(
    `warning: ${path} is readable by other users (mode ${(mode & 0o777).toString(8)}). ` +
      `Fix with: chmod 600 ${path}\n`,
  )
}

// ─────────────────────────────────────────────── 展示

/**
 * 密钥掩码。首 6 尾 4,中间省略。
 *
 * 保留两端是为了让用户能认出"这是哪一个 key"(前缀区分 provider,后缀区分
 * 同一家的多把),又不足以拼回原值。太短的一律全遮 —— 短 key 露两端就等于露完。
 */
export function maskKey(key: string): string {
  if (key.length < 16) return "*".repeat(Math.max(4, key.length))
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}
