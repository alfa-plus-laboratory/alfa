/**
 * Raw bytes → key events.
 *
 * In raw mode stdin hands you an unprocessed byte stream: an arrow key is the three
 * characters `ESC [ A`, Ctrl-A is 0x01, Alt-B is `ESC b`. You have to recognize them
 * yourself.
 *
 * ── The one genuinely hard part: a sequence can arrive cut in two ──
 * The terminal doesn't guarantee that one read delivers one whole sequence. With an
 * arrow key held down, or a big chunk of text pasted in, `ESC [` and `A` landing in two
 * chunks is routine. So the decoder is **incremental**: whatever it can fully recognize
 * it emits, and whatever it can't it hands back untouched as `rest`, to be joined with
 * the next chunk.
 *
 * Getting this wrong is very misleading — everything is fine normally, and only during
 * fast input and pastes do a few garbage characters pop out, which looks like a
 * terminal problem.
 */

export interface Key {
  /**
   * Normalized key name. A plain character key is the character itself (possibly a
   * multi-byte "中"), function keys are lowercase words like "up" / "home" / "enter" /
   * "backspace", and a paste block is "paste".
   */
  name: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  /** The original text when name === "paste" */
  text?: string
  /** Position and action when name === "mouse" (column and row both 0-based) */
  mouse?: MouseEvent
}

export interface MouseEvent {
  x: number
  y: number
  /**
   * left/middle/right are buttons, wheel-up/down is the wheel; none = no button named
   * (a legacy release, which doesn't say which, or motion with no button held)
   */
  button: "left" | "middle" | "right" | "wheel-up" | "wheel-down" | "none"
  action: "press" | "release" | "drag"
  ctrl: boolean
  meta: boolean
  shift: boolean
}

export interface DecodeResult {
  keys: Key[]
  /** The unrecognized tail, handed back untouched */
  rest: string
  /**
   * The tail is a lone ESC.
   *
   * It's ambiguous: it may be the user pressing Esc, or the start of a sequence that has
   * only just begun to arrive. There's no telling — all we can do is wait a moment and
   * see whether anything follows (see the ESC timeout in keyboard.ts).
   */
  pendingEscape: boolean
}

const ESC = "\u001b"
const PASTE_START = "\u001b[200~"
const PASTE_END = "\u001b[201~"

/** The CSI final byte picks the meaning; `~` sequences also depend on the first param. */
const CSI_FINAL: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  E: "clear",
  F: "end",
  H: "home",
  Z: "tab", // Shift-Tab
}

const CSI_TILDE: Record<string, string> = {
  "1": "home",
  "2": "insert",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
  "7": "home",
  "8": "end",
}

/**
 * xterm's modifier encoding: parameter value - 1 is a bitmask. 1=Shift 2=Alt 4=Ctrl.
 * E.g. `ESC [ 1 ; 5 C` = Ctrl-Right (5-1 = 4).
 */
function modifiers(param: string | undefined): { ctrl: boolean; meta: boolean; shift: boolean } {
  const mask = param ? Number(param) - 1 : 0
  if (!Number.isFinite(mask) || mask <= 0) return { ctrl: false, meta: false, shift: false }
  return { shift: (mask & 1) !== 0, meta: (mask & 2) !== 0, ctrl: (mask & 4) !== 0 }
}

function plain(name: string): Key {
  return { name, ctrl: false, meta: false, shift: false }
}

export function decodeKeys(input: string): DecodeResult {
  const keys: Key[] = []
  let index = 0

  while (index < input.length) {
    const rest = input.slice(index)

    // ── Bracketed paste. One block of raw text; its newlines are text, not submits ──
    if (rest.startsWith(PASTE_START)) {
      const end = rest.indexOf(PASTE_END)
      // Incomplete: hand the whole block back and wait for the next chunk — pasting
      // 200 lines of code always arrives in several pieces
      if (end === -1) return { keys, rest, pendingEscape: false }
      keys.push({ ...plain("paste"), text: rest.slice(PASTE_START.length, end) })
      index += end + PASTE_END.length
      continue
    }
    // ⚠ A rest of length 1 (just an ESC) is also a prefix of PASTE_START, but it must
    //   fall through to the lone-ESC branch below, or pendingEscape is always false and
    //   the Esc key stops working altogether
    if (rest.length >= 2 && isPrefixOf(rest, PASTE_START)) return { keys, rest, pendingEscape: false }

    const char = rest[0]!

    if (char === ESC) {
      // A lone ESC: ambiguous, let the layer above decide with a timeout
      if (rest.length === 1) return { keys, rest, pendingEscape: true }

      const second = rest[1]!

      // ── Legacy (X10 / 1000) mouse reports: ESC [ M followed by three raw bytes ──
      //
      // ⚠ We must recognize it even though we ask for SGR. Mouse tracking is turned
      //   on by `?1000h`; `?1006h` only **requests** the switch to SGR format — a
      //   terminal that doesn't know 1006 reports anyway, in exactly this old format.
      //   And it looks like an ordinary CSI (`ESC [ M`); once it's eaten as a CSI,
      //   **the three bytes after it get typed into the input box as visible
      //   characters**. What the user sees: click the chat box once and a string of
      //   garbage pops out.
      //
      //   The coordinates are (byte - 32). Past column 223 the encoding itself is
      //   unreliable; in that case better to treat it as "clicked on the last column"
      //   than let the bytes leak out.
      if (second === "[" && rest[2] === "M") {
        // Wait until all three bytes are here — half a sequence emitted is garbage
        if (rest.length < 6) return { keys, rest, pendingEscape: false }
        keys.push(legacyMouse(rest.charCodeAt(3), rest.charCodeAt(4), rest.charCodeAt(5)))
        index += 6
        continue
      }

      // SGR 1006 mouse report: ESC [ < b ; x ; y M|m
      //
      // Must be recognized before ordinary CSI. 1006 starts with `<` precisely to set
      // itself apart from other CSIs.
      if (second === "[" && rest[2] === "<") {
        const match = /^\u001b\[<([0-9;]+)([Mm])/.exec(rest)
        if (!match) {
          // Parameters not all in yet, wait for the next chunk
          if (/^\u001b\[<[0-9;]*$/.test(rest)) return { keys, rest, pendingEscape: false }
          index += 3
          continue
        }
        const key = mouse(match[1] ?? "", match[2] === "M")
        if (key) keys.push(key)
        index += match[0].length
        continue
      }

      // CSI: ESC [ params final-byte
      if (second === "[") {
        const match = /^\u001b\[([0-9;]*)([A-Za-z~u])/.exec(rest)
        if (!match) {
          // Parameters not all in yet (something like `ESC [ 1 ;`), wait
          if (/^\u001b\[[0-9;]*$/.test(rest)) return { keys, rest, pendingEscape: false }
          // Unrecognized sequence: drop the whole thing — better than typing it into
          // the input box as a string of visible characters
          index += 2
          continue
        }
        keys.push(csi(match[1] ?? "", match[2]!))
        index += match[0].length
        continue
      }

      // SS3: arrow keys in application keypad mode, ESC O A
      if (second === "O") {
        if (rest.length === 2) return { keys, rest, pendingEscape: false }
        const name = CSI_FINAL[rest[2]!]
        keys.push(plain(name ?? "unknown"))
        index += 3
        continue
      }

      // Alt + key. Alt-Backspace (ESC DEL) deletes a word, used a lot
      if (second === "\u007f" || second === "\b") {
        keys.push({ name: "backspace", ctrl: false, meta: true, shift: false })
        index += 2
        continue
      }
      if (second === "\r" || second === "\n") {
        // Legacy encoding of Alt-Enter / Shift-Enter — insert a newline, don't submit
        keys.push({ name: "enter", ctrl: false, meta: true, shift: false })
        index += 2
        continue
      }
      keys.push({ name: second.toLowerCase(), ctrl: false, meta: true, shift: second !== second.toLowerCase() })
      index += 1 + second.length
      continue
    }

    // ── Single-byte control keys ──
    const code = char.charCodeAt(0)
    if (code === 0x0d) {
      keys.push(plain("enter"))
      index += 1
      continue
    }
    if (code === 0x0a) {
      // Ctrl-J. In a terminal it shares its code with LF — just right for "insert newline"
      keys.push({ name: "j", ctrl: true, meta: false, shift: false })
      index += 1
      continue
    }
    if (code === 0x09) {
      keys.push(plain("tab"))
      index += 1
      continue
    }
    if (code === 0x7f || code === 0x08) {
      keys.push(plain("backspace"))
      index += 1
      continue
    }
    if (code >= 1 && code <= 26) {
      keys.push({ name: String.fromCharCode(code + 96), ctrl: true, meta: false, shift: false })
      index += 1
      continue
    }
    // ── Ctrl plus these four symbols ──
    //
    // Their code points come **after** the letter range (0x1c–0x1f), not within 1..26.
    // Without this block, `ctrl-]` arrives as 0x1d and is eaten by the "ignore other
    // control characters" line below — any binding on it does nothing and reports
    // nothing (it happened once, with a ctrl-] the UI advertised). Nothing binds these
    // four at present; decoding them keeps the next binding from failing silently.
    // (0x1b is ESC, already handled separately above.)
    const SYMBOL: Record<number, string> = { 0x1c: "\\", 0x1d: "]", 0x1e: "^", 0x1f: "_" }
    const symbol = SYMBOL[code]
    if (symbol !== undefined) {
      keys.push({ name: symbol, ctrl: true, meta: false, shift: false })
      index += 1
      continue
    }
    if (code < 0x20) {
      index += 1 // ignore other control characters
      continue
    }

    // ── Ordinary characters. Take them by code point, not by UTF-16 unit ──
    const point = rest.codePointAt(0)!
    // A lone high surrogate = a character cut in half, wait for the next chunk
    if (point >= 0xd800 && point <= 0xdbff && rest.length === 1) {
      return { keys, rest, pendingEscape: false }
    }
    const literal = String.fromCodePoint(point)
    keys.push(plain(literal))
    index += literal.length
  }

  return { keys, rest: "", pendingEscape: false }
}

function csi(params: string, final: string): Key {
  const parts = params.split(";")
  const mods = modifiers(parts[1])

  if (final === "~") {
    const name = CSI_TILDE[parts[0] ?? ""] ?? "unknown"
    return { name, ...mods }
  }
  // CSI-u (kitty protocol): ESC [ 13;2 u = Shift-Enter. Modern terminals use it to
  // tell Enter / Shift-Enter / Ctrl-Enter apart, and that is exactly the "newline or
  // submit" distinction we need
  if (final === "u") {
    const point = Number(parts[0])
    if (point === 13) return { name: "enter", ...mods }
    if (Number.isFinite(point) && point > 0) return { name: String.fromCodePoint(point), ...mods }
    return { name: "unknown", ...mods }
  }
  const name = CSI_FINAL[final]
  if (name === "tab") return { name: "tab", ctrl: false, meta: false, shift: true }
  return { name: name ?? "unknown", ...mods }
}

/**
 * Legacy report (three bytes after ESC [ M). The button bits mean the same as in SGR,
 * except all three numbers are offset by 32, and there is **no separate release
 * event** — low two bits == 3 means "some button was released" without saying which.
 *
 * Its only reason to exist is **keeping those three bytes out of the input box**.
 * Functionally it's a notch below SGR (coordinates past column 223 are unreliable), but
 * leaked bytes are garbage you see on the spot, while slightly-off coordinates just
 * make a click land a bit off.
 */
function legacyMouse(rawButton: number, rawX: number, rawY: number): Key {
  const b = rawButton - 32
  const wheel = (b & 64) !== 0
  const low = b & 3
  const released = !wheel && low === 3

  const button: MouseEvent["button"] = wheel
    ? (b & 1) === 0
      ? "wheel-up"
      : "wheel-down"
    : low === 0
      ? "left"
      : low === 1
        ? "middle"
        : low === 2
          ? "right"
          : "none"

  const mods = { ctrl: (b & 16) !== 0, meta: (b & 8) !== 0, shift: (b & 4) !== 0 }
  return {
    name: "mouse",
    ...mods,
    mouse: {
      // The terminal reports 1-based, then +32; clamp out-of-range values instead of
      // letting them go negative
      x: Math.max(0, rawX - 33),
      y: Math.max(0, rawY - 33),
      button,
      action: wheel ? "press" : released ? "release" : (b & 32) !== 0 ? "drag" : "press",
      ...mods,
    },
  }
}

/**
 * SGR 1006 button bits: the low two bits are the button number, 4/8/16 are modifiers,
 * 32 is drag, 64 is wheel.
 */
function mouse(params: string, pressed: boolean): Key | undefined {
  const [b, x, y] = params.split(";").map(Number)
  if (b === undefined || x === undefined || y === undefined) return undefined
  if (!Number.isFinite(b) || !Number.isFinite(x) || !Number.isFinite(y)) return undefined

  const wheel = (b & 64) !== 0
  const drag = (b & 32) !== 0
  const low = b & 3

  const button: MouseEvent["button"] = wheel
    ? low === 0
      ? "wheel-up"
      : "wheel-down"
    : low === 0
      ? "left"
      : low === 1
        ? "middle"
        : low === 2
          ? "right"
          : "none"

  return {
    name: "mouse",
    ctrl: (b & 16) !== 0,
    meta: (b & 8) !== 0,
    shift: (b & 4) !== 0,
    mouse: {
      // The terminal reports 1-based rows/columns; internally everything is 0-based
      x: x - 1,
      y: y - 1,
      button,
      action: wheel ? "press" : drag ? "drag" : pressed ? "press" : "release",
      ctrl: (b & 16) !== 0,
      meta: (b & 8) !== 0,
      shift: (b & 4) !== 0,
    },
  }
}

/** Whether text is a proper prefix of prefix (detects "sequence only half here"). */
function isPrefixOf(text: string, prefix: string): boolean {
  return text.length < prefix.length && prefix.startsWith(text)
}
