/**
 * The startup logo comes from the website's fixed pixel grid, not from a font. This
 * guards the outline and the screen-clearing boundary: if the outline drifts, the two
 * products stop looking like the same brand; if the clear includes 3J, the user's
 * scrollback beyond the previous screen silently disappears too.
 */
import { describe, expect, test } from "bun:test"
import { brandMark, CLEAR_VIEWPORT, clearInteractiveViewport } from "../src/cli/brand.ts"
import { displayWidth } from "../src/cli/width.ts"

describe("interactive startup", () => {
  test("★ the website's 12-cell α is packed as-is into six rows of half-block characters", () => {
    expect(brandMark()).toEqual([
      "   ▄▄▄▄ ▄▄",
      " ▄█▀  ▀███",
      " ██     ██",
      " ██     ██",
      " ▀█▄  ▄███",
      "   ▀▀▀▀ ▀▀▀▀",
    ])
    expect(brandMark().every((line) => displayWidth(line) <= 12)).toBe(true)
  })

  test("clears only the current viewport and homes the cursor, never deleting scrollback", () => {
    const sent: string[] = []
    clearInteractiveViewport({ passthrough: (sequence) => sent.push(sequence) })
    expect(sent).toEqual(["\u001b[2J\u001b[H"])
    expect(CLEAR_VIEWPORT).not.toContain("[3J")
  })
})
