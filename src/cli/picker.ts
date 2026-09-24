/**
 * Session picking uses the bottom live area; no switch to the alternate screen.
 * --resume and /resume share rows and keys; without a TTY it returns "nothing picked"
 * right away — we can't wait for a keyboard inside a pipe.
 */
import type { Keyboard } from "./keyboard.ts"
import type { Key } from "./keys.ts"
import type { LiveRegion } from "./live.ts"
import type { SessionInfo } from "../session/store.ts"
import { pickKey, renderList } from "./sessions.ts"

export interface PickerDeps {
  sessions: SessionInfo[]
  keyboard?: Keyboard
  region: LiveRegion
  /** Base for relative times. All rows on one screen use the same "now" */
  now?: number
  /** The session we're already in (for `/resume`; none at startup) */
  currentID?: string
}

/**
 * Pick a session. Returns undefined when the user cancels, there's no TTY, or the list
 * is empty.
 */
export async function pickSession(deps: PickerDeps): Promise<SessionInfo | undefined> {
  if (deps.sessions.length === 0 || !deps.keyboard?.usable || !deps.region.active) return undefined

  const now = deps.now ?? Date.now()
  let selected = 0

  const paint = () => {
    deps.region.set(
      renderList(deps.sessions, {
        selected,
        width: deps.region.width,
        // The live area takes at most half the screen: a picker that pushes all the
        // output above off screen amounts to "what I was just looking at is gone"
        height: Math.max(3, Math.floor(deps.region.rows / 2) - 3),
        now,
        ...(deps.currentID ? { currentID: deps.currentID } : {}),
      }),
    )
  }

  return new Promise<SessionInfo | undefined>((resolve) => {
    let settled = false
    let release: (() => void) | undefined

    const finish = (choice: SessionInfo | undefined) => {
      if (settled) return
      settled = true
      release?.()
      // Erase the list once picked: it's a one-off question, and left on screen it
      // would mix with the session content that follows
      deps.region.clear()
      resolve(choice)
    }

    const onKey = (key: Key) => {
      const result = pickKey(key)
      switch (result.kind) {
        case "move":
          selected = clamp(selected + result.delta, deps.sessions.length)
          return paint()
        case "accept":
          return finish(deps.sessions[selected])
        case "cancel":
          return finish(undefined)
        case "pass":
          return
      }
    }

    release = deps.keyboard!.push(onKey)
    // Can't get raw mode? Don't force it: reading line by line would take the user's
    // next sentence as the choice
    if (!deps.keyboard!.attached) return finish(undefined)
    paint()
  })
}

function clamp(next: number, length: number): number {
  return Math.max(0, Math.min(length - 1, next))
}
