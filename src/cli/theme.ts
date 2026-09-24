/**
 * Colors. The **only** file allowed to import picocolors.
 *
 * Keeping it in one place isn't fastidiousness: color must be switchable off in three
 * ways — --no-color / NO_COLOR / non-TTY — and with it scattered around, there's always
 * one spot that slips through and spits escape sequences into pipes and logs.
 *
 * picocolors checks NO_COLOR and isTTY by itself, but **doesn't know our --no-color
 * flag**, so this wraps it in a switch that can be flipped at runtime.
 */
import pc from "picocolors"

/**
 * The set of formatters that always emits color.
 *
 * Under a non-TTY, picocolors' default export **degrades wholesale to identity
 * functions**, so setColorEnabled(true) can't turn color on at all. That's not just a
 * matter of tests being unable to assert on colors: `… | less -R` is real usage, and
 * when the user says "I want color, period", we have to be able to deliver. The switch
 * is owned by the enabled flag below, and by nothing else.
 */
const paints = pc.createColors(true)

let enabled = pc.isColorSupported

export function setColorEnabled(value: boolean): void {
  enabled = value
}

export function colorEnabled(): boolean {
  return enabled
}

type Paint = (text: string) => string

const paint = (fn: Paint): Paint => (text) => (enabled ? fn(text) : text)

/**
 * Follows Pi's layering of semantic colors; the terminal theme sets no background, and
 * message backgrounds are painted only once light/dark is explicitly chosen.
 */
export type ThemeName = "terminal" | "dark" | "light"
let selectedTheme: ThemeName = "terminal"
export function setTheme(value: ThemeName): void { selectedTheme = value }
export function currentTheme(): ThemeName { return selectedTheme }
type Role = "accent" | "muted" | "border" | "success" | "error" | "user" | "tool" | "selection"
const palettes = {
  dark: { accent: 109, muted: 250, border: 68, success: 150, error: 174, user: 237, tool: 235, selection: 60 },
  light: { accent: 24, muted: 240, border: 67, success: 28, error: 124, user: 254, tool: 255, selection: 153 },
} as const
function semantic(role: Role): Paint {
  return text => {
    if (!enabled) return text
    const background = role === "user" || role === "tool" || role === "selection"
    if (selectedTheme === "terminal") {
      if (background) return role === "selection" ? paints.inverse(text) : text
      return ({ accent: paints.cyan, muted: paints.gray, border: paints.blue, success: paints.green, error: paints.red } as Record<string, Paint>)[role]!(text)
    }
    const color = palettes[selectedTheme][role]
    if (!background) return `\u001b[38;5;${color}m${text}\u001b[39m`
    const fg = selectedTheme === "dark" ? 253 : 235
    return `\u001b[48;5;${color}m\u001b[38;5;${fg}m${text}\u001b[39m\u001b[49m`
  }
}

export const theme = {
  accent: semantic("accent"),
  muted: semantic("muted"),
  border: semantic("border"),
  success: semantic("success"),
  error: semantic("error"),
  user: semantic("user"),
  tool: semantic("tool"),
  selection: semantic("selection"),
  dim: paint(paints.dim),
  bold: paint(paints.bold),
  italic: paint(paints.italic),
  underline: paint(paints.underline),
  strike: paint(paints.strikethrough),
  /**
   * Inline code.
   *
   * Foreground color rather than background: on light-themed terminals a background
   * color is either invisible or smears into a block, and we don't know what theme this
   * project's users run. The semantic accent color follows the theme; a warning is
   * always "a symbol at line start + the whole line yellow", while inline code is a few
   * words mid-sentence — the two can't be confused.
   */
  code: semantic("accent"),
  red: semantic("error"),
  green: semantic("success"),
  yellow: paint(paints.yellow),
  blue: paint(paints.blue),
  cyan: semantic("accent"),
  magenta: paint(paints.magenta),
  gray: semantic("muted"),
  inverse: paint(paints.inverse),
}

/**
 * 256-color foreground.
 *
 * ── Why go around picocolors and write the sequence ourselves ──
 * It only offers the basic 16 colors, while a "green to red" gradient needs a dozen or
 * more steps — 16 colors don't have those in-between shades, and substituting yellow
 * gives three jumps, not a gradient. 256 colors is an xterm extension dating from 1999,
 * recognized today even by Windows Terminal and tmux; a terminal that really doesn't
 * know it ignores it as an unknown SGR and falls back to the default foreground, rather
 * than spitting the sequence out as garbage.
 *
 * ★ It's still governed by setColorEnabled — that is the whole reason this file exists:
 *   turning color off must happen cleanly, in one place.
 */
export function color256(code: number): Paint {
  // ⚠ ESC is written as \u001b, never as a bare control character — a bare one is
  //   invisible in diff / grep / editors
  const prefix = `\u001b[38;5;${code}m`
  return (text) => (enabled ? prefix + text + "\u001b[39m" : text)
}

/**
 * Escape sequences must be stripped before computing visible width, or alignment goes
 * off.
 *
 * ESC must be written as the \u001b escape, never as a bare control character — a
 * bare one is invisible in diff, grep and editors, and if it ever got broken nobody
 * would notice (this repo has been bitten by that once already).
 */
const ANSI = /\u001b\[[0-9;]*m/g
export function visibleLength(text: string): number {
  return text.replace(ANSI, "").length
}
