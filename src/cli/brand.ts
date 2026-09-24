/**
 * The interactive opening has to be recognizably the same thing as the alfaPlus website,
 * so we don't stand in a font's `a` or `α` for it: change the font, terminal or platform
 * and the outline changes. This keeps the website's 12-cell `alfa-base` dot matrix and
 * packs every two rows into one half-block character, which neither alters the outline nor
 * lets the logo eat twelve lines.
 *
 * ★ The clear-screen sequence is only called by a host that really owns a TTY keyboard.
 * Moving it up into main() pours control codes into `-p`, pipes and logs; switching to 3J
 * would also wipe scrollback the user may still need.
 */
import type { LiveRegion } from "./live.ts"

export const CLEAR_VIEWPORT = "\u001b[2J\u001b[H"

const ALFA_BASE = [
  "............",
  "...####.##..",
  "..##..####..",
  ".##....###..",
  ".##.....##..",
  ".##.....##..",
  ".##.....##..",
  ".##.....##..",
  ".##....###..",
  "..##..####..",
  "...####.####",
  "............",
] as const

export function brandMark(): string[] {
  const lines: string[] = []
  for (let row = 0; row < ALFA_BASE.length; row += 2) {
    const top = ALFA_BASE[row]!
    const bottom = ALFA_BASE[row + 1]!
    let line = ""
    for (let col = 0; col < top.length; col++) {
      const upper = top[col] === "#"
      const lower = bottom[col] === "#"
      line += upper ? (lower ? "█" : "▀") : lower ? "▄" : " "
    }
    lines.push(line.trimEnd())
  }
  return lines
}

export function clearInteractiveViewport(region: Pick<LiveRegion, "passthrough">): void {
  region.passthrough(CLEAR_VIEWPORT)
}
