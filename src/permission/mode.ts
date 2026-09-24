/**
 * The three modes are kept for config compatibility. auto keeps host-level access and
 * lets the AI decide ordinary operations; major risks and failed reviews go back to the
 * agent, with no confirmation box for the user — this is not a return to the old judge's
 * "ask whenever it touches the network or crosses directories".
 * default lets ordinary operations the rules approve go straight through; confirm asks
 * every time even for those. Neither mode adds a hidden deny tier outside those rules.
 * ★ An AI approval is valid for this one operation only; leaving auto restores the
 * original rules and leaves no invisible grant behind.
 */

import { t } from "../i18n/index.ts"

export type PermissionMode = "confirm" | "default" | "auto"

/** shift-tab cycle order. Strict → loose, fixed direction, so muscle memory can form. */
export const MODES: readonly PermissionMode[] = ["confirm", "default", "auto"] as const

/**
 * The gate's own safe default; once everything is wired up, the product entry point
 * explicitly selects the main path, auto.
 */
export const DEFAULT_MODE: PermissionMode = "default"

interface ModeInfo {
  /** Canonical mode name shown in the live status bar */
  label: string
  /** One-line explanation shown by /permission and after explicit command changes */
  hint: string
}

/**
 * Display text for the modes.
 *
 * **Fetched fresh every time**, not made a module-level constant: the UI language can
 * be changed at runtime with /language, and a constant table frozen at import time
 * won't follow — a slip like that only surfaces on some line after the language
 * switch, and is hard to trace back to its cause.
 *
 * The mode names (confirm/default/auto) themselves are not translated: they are the
 * argument to `/permission <mode>`, and once translated the user couldn't type them.
 */
export function modeInfo(mode: PermissionMode): ModeInfo {
  switch (mode) {
    case "confirm":
      return { label: t.modeConfirm, hint: t.modeConfirmHint }
    case "default":
      return { label: t.modeDefault, hint: t.modeDefaultHint }
    case "auto":
      return { label: t.modeAuto, hint: t.modeAutoHint }
  }
}

export function isPermissionMode(value: string): value is PermissionMode {
  return (MODES as readonly string[]).includes(value)
}

/**
 * What the user typed → a mode. The command line keeps no historical aliases; the
 * project is unreleased, and a clean vocabulary matters more than compatibility for
 * users who don't exist.
 */
export function normalizeMode(value: string): PermissionMode | undefined {
  const trimmed = value.trim().toLowerCase()
  if (isPermissionMode(trimmed)) return trimmed
  return undefined
}

/** The next mode. Wraps back to the start at the end. */
export function nextMode(mode: PermissionMode): PermissionMode {
  const at = MODES.indexOf(mode)
  return MODES[(at + 1) % MODES.length]!
}
