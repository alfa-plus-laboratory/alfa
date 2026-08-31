/**
 * per-path 互斥锁。
 *
 * 临界区必须包住 read → match → ask(可能阻塞几十秒等人按键)→ write 全程。
 * 不包住 ask 的话,用户正在看 A 的 diff 时 B 已经把文件改了,A 批准后写回去
 * 就是基于陈旧内容的丢失更新。
 *
 * ⚠ 已知代价:
 * - Map 不清理,长会话里会缓慢泄漏(每个碰过的文件一个 entry)。M1 接受。
 * - 等待有 60s 超时。M1 是串行 agent 不会触发;一旦模型开始并行调 edit,
 *   超时报错好过界面永久卡住不知道在等什么。
 */
const locks = new Map<string, Promise<unknown>>()

const WAIT_TIMEOUT_MS = 60_000

export class LockTimeoutError extends Error {
  constructor(path: string) {
    super(`Timed out after ${WAIT_TIMEOUT_MS / 1000}s waiting for a lock on "${path}". Another edit may be awaiting user approval.`)
    this.name = "LockTimeoutError"
  }
}

export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(path) ?? Promise.resolve()

  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  locks.set(
    path,
    previous.then(() => current),
  )

  try {
    await withTimeout(previous, path)
    return await fn()
  } finally {
    release()
    // 只有当自己是队尾时才清理,避免把后来者的链断掉
    if (locks.get(path) === current) locks.delete(path)
  }
}

async function withTimeout(promise: Promise<unknown>, path: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LockTimeoutError(path)), WAIT_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 仅用于测试。 */
export function __clearLocksForTest(): void {
  locks.clear()
}
