/**
 * 单调可排序 ID。
 *
 * 要求只有两条:同进程内严格单调、字典序 == 时间序。主循环靠 (time_created, id)
 * 排序还原历史,同一毫秒内插入的 part 顺序不能抖,否则 tool_call 和 tool_result
 * 会配错对。
 *
 * 结构:<12位毫秒时间戳 base36 左补零> + <4位同毫秒计数器 base36> + <14位随机>
 *
 * 多进程写同一个库时,同毫秒同计数器的碰撞靠随机尾兜底 —— 这是刻意的取舍:
 * 不引 ulid/uuid 依赖,也不做跨进程协调。
 */

const TIME_LEN = 12
const SEQ_LEN = 4
const RAND_LEN = 14
const SEQ_MAX = 36 ** SEQ_LEN - 1

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"

let lastMs = 0
let seq = 0

function pad(value: number, len: number): string {
  return value.toString(36).padStart(len, "0")
}

function randomTail(): string {
  const bytes = new Uint8Array(RAND_LEN)
  crypto.getRandomValues(bytes)
  let out = ""
  for (const b of bytes) out += ALPHABET[b % 36]
  return out
}

function next(prefix: string): string {
  const now = Date.now()
  if (now === lastMs) {
    seq = seq + 1
    // 同一毫秒内溢出(理论上要 168 万次)—— 借下一毫秒,保证单调不回退
    if (seq > SEQ_MAX) {
      lastMs = now + 1
      seq = 0
    }
  } else if (now > lastMs) {
    lastMs = now
    seq = 0
  } else {
    // 系统时钟回拨:守住 lastMs,只推进计数器,绝不产出比之前小的 ID
    seq = seq + 1
  }
  return `${prefix}_${pad(lastMs, TIME_LEN)}${pad(seq, SEQ_LEN)}${randomTail()}`
}

export type SessionID = string
export type MessageID = string
export type PartID = string

export const newSessionID = (): SessionID => next("ses")
export const newMessageID = (): MessageID => next("msg")
export const newPartID = (): PartID => next("prt")

/** 仅用于测试:重置模块内计数器状态。 */
export function __resetIdStateForTest(): void {
  lastMs = 0
  seq = 0
}
