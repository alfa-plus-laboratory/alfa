/**
 * Monotonic, sortable IDs.
 *
 * There are only two requirements: strictly monotonic within a process, and lexical
 * order == time order. The main loop rebuilds history by sorting on (time_created, id);
 * the order of parts inserted within the same millisecond must not jitter, or tool_call
 * and tool_result get paired wrong.
 *
 * Layout: <12-char ms timestamp, base36, zero-padded left> + <4-char same-ms counter,
 * base36> + <14 random chars>
 *
 * When several processes write the same database, a collision on the same ms and same
 * counter is caught by the random tail — a deliberate trade-off: no ulid/uuid dependency,
 * and no cross-process coordination either.
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
    // Overflow within one millisecond (takes ~1.68 million in theory) — borrow the next
    // millisecond, so it stays monotonic and never goes backwards
    if (seq > SEQ_MAX) {
      lastMs = now + 1
      seq = 0
    }
  } else if (now > lastMs) {
    lastMs = now
    seq = 0
  } else {
    // System clock went backwards: hold lastMs, only advance the counter, never produce
    // an ID smaller than a previous one
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

/** Tests only: reset the module's counter state. */
export function __resetIdStateForTest(): void {
  lastMs = 0
  seq = 0
}
