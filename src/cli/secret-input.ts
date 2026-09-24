/**
 * Read one line without echo (for pasting an API key).
 *
 * readline won't do: it echoes the key verbatim to the terminal, where it then stays in
 * the scrollback and in tmux's history, and gets captured in screenshots. So we go raw
 * mode and collect characters ourselves.
 *
 * ★ Echo must be turned off before the key prompt is printed, otherwise a fast paste by
 *   the user or the PTY lands in the gap while echo is still on.
 * Raw mode must be restored on **every** exit path, including exceptions and Ctrl-C —
 * miss one and the user's terminal is left not echoing what they type, Ctrl-C does
 * nothing, and the only way out is closing the window.
 */
const CTRL_C = "\u0003"
const CTRL_D = "\u0004"
const BACKSPACE = "\u007f"
const BACKSPACE_ALT = "\u0008"

export class InputCancelled extends Error {
  constructor() {
    super("cancelled")
    this.name = "InputCancelled"
  }
}

export interface SecretInputDeps {
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
}

/**
 * @param mask What each character is echoed as. An empty string means no echo at all
 *             (the default); "•" shows the length — the length is itself information,
 *             so by default it isn't given away.
 */
export async function readSecret(prompt: string, deps: SecretInputDeps = {}, mask = ""): Promise<string> {
  const input = deps.input ?? process.stdin
  const output = deps.output ?? process.stdout

  // Piped input: just read a line — there's no terminal to turn echo off, nor any need
  if (!input.isTTY) return readLineFromPipe(input)

  return new Promise<string>((resolve, reject) => {
    const wasRaw = input.isRaw ?? false
    let buffer = ""
    let settled = false

    const cleanup = () => {
      input.off("data", onData)
      try {
        if (!wasRaw) input.setRawMode?.(false)
      } catch {
        // The terminal is already gone
      }
      if (!wasRaw) input.pause()
    }

    const finish = (value: string) => {
      if (settled) return
      settled = true
      cleanup()
      output.write("\n")
      resolve(value)
    }

    const cancel = () => {
      if (settled) return
      settled = true
      cleanup()
      output.write("\n")
      reject(new InputCancelled())
    }

    const onData = (chunk: Buffer | string) => {
      // A paste arrives as one big chunk; walk it character by character rather than
      // treating the whole chunk as one key
      const chars = [...chunk.toString()]
      for (const [at, char] of chars.entries()) {
        if (char === CTRL_C) { typeAhead = ""; return cancel() }
        if (char === CTRL_D) return buffer.length === 0 ? cancel() : finish(buffer)
        if (char === "\r" || char === "\n") {
          typeAhead = chars.slice(at + 1).join("")
          return finish(buffer)
        }
        if (char === BACKSPACE || char === BACKSPACE_ALT) {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1)
            if (mask) output.write("\b \b")
          }
          continue
        }
        // Drop other control characters (fragments of escape sequences like arrow keys);
        // they don't belong in a key
        if (char < " ") continue
        buffer += char
        if (mask) output.write(mask)
      }
    }

    try {
      input.setRawMode?.(true)
    } catch {
      settled = true
      return reject(new Error("cannot disable echo on this terminal; refusing to read a secret with echo on"))
    }
    input.resume()
    input.on("data", onData)
    output.write(prompt)
    if (typeAhead) { const carried = typeAhead; typeAhead = ""; onData(carried) }
  })
}

function readLineFromPipe(input: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve) => {
    let buffer = ""
    input.setEncoding("utf8")
    const onData = (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf("\n")
      if (newline === -1) return
      input.off("data", onData)
      input.off("end", onEnd)
      resolve(buffer.slice(0, newline).trim())
    }
    const onEnd = () => resolve(buffer.trim())
    input.on("data", onData)
    input.once("end", onEnd)
    input.resume()
  })
}

/** A plain echoed line of input, for non-secret fields like provider name, baseURL. */
export async function readLine(prompt: string, deps: SecretInputDeps = {}): Promise<string> {
  const input = deps.input ?? process.stdin
  const output = deps.output ?? process.stdout
  if (!input.isTTY) return readLineFromPipe(input)
  output.write(prompt)
  return readSecretEcho(input, output)
}

/**
 * The characters a read **didn't use up**.
 *
 * ── ★ Why they must be kept ──
 * In raw mode a single `data` event often brings more than one character: a paste,
 * packet coalescing over SSH, or just typing a bit fast will all do it. The old approach
 * resolved on reading a newline, and **the characters after the newline in the same
 * chunk were simply dropped** — so wherever two questions come back to back
 * (onboarding, the card shown on first entering a folder), pasting both answers in
 * together meant the second question received nothing and silently took the default.
 *
 * ⚠ On that card, the second question is exactly "trust this folder?", and its default
 *   is "trust" — meaning this character-dropping bug failed open on a security prompt.
 *
 * Terminals have type-ahead anyway (typing before it's your turn to answer); keeping it
 * is the correct behavior.
 */
let typeAhead = ""

function readSecretEcho(input: NodeJS.ReadStream, output: NodeJS.WriteStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw ?? false
    let buffer = ""
    let settled = false

    const cleanup = () => {
      input.off("data", onData)
      try {
        if (!wasRaw) input.setRawMode?.(false)
      } catch {
        /* The terminal is already gone */
      }
      if (!wasRaw) input.pause()
    }

    const onData = (chunk: Buffer | string) => {
      const chars = [...chunk.toString()]
      for (const [at, char] of chars.entries()) {
        if (char === CTRL_C) {
          if (settled) return
          settled = true
          // On cancel, drop the rest: what the user pressed means "forget it", not "give
          // these characters to the next question"
          typeAhead = ""
          cleanup()
          output.write("\n")
          return reject(new InputCancelled())
        }
        if (char === "\r" || char === "\n") {
          if (settled) return
          settled = true
          // ★ Characters **after** the newline are kept for the next read. See typeAhead
          typeAhead = chars.slice(at + 1).join("")
          cleanup()
          output.write("\n")
          return resolve(buffer.trim())
        }
        if (char === BACKSPACE || char === BACKSPACE_ALT) {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1)
            output.write("\b \b")
          }
          continue
        }
        if (char < " ") continue
        buffer += char
        output.write(char)
      }
    }

    try {
      input.setRawMode?.(true)
    } catch {
      settled = true
      return reject(new Error("cannot read from this terminal"))
    }
    input.resume()
    input.on("data", onData)
    // Feed in first the characters the previous question didn't use up. Done **after**
    // attaching the listener, so they go down exactly the same path as real input —
    // echo, backspace and newline handling can't differ in a single place
    if (typeAhead.length > 0) {
      const carried = typeAhead
      typeAhead = ""
      onData(carried)
    }
  })
}
