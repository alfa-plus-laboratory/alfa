/**
 * What our own environment variables are called.
 *
 * The prefix is `ALFA_`, lined up with the command name, the config directory and the
 * `.alfa/` in projects — it used to be `APCODE_` (and before that `AGENTPLUS_CODE_`),
 * and **neither is recognized anymore**. Not keeping the old names working is
 * deliberate: a program that still has old variables lying around on a few old
 * machines has two sets of truth at once, and sooner or later someone steps into the
 * gap between them.
 * An old config we don't recognize counts as never configured, the same state as a
 * fresh install.
 *
 * The prefix appears only here, once. Scatter it around and the next rename is another
 * round of grep.
 */

/** Which prefix to write now. It's what the hint text prints */
export const ENV_PREFIX = "ALFA_"

export type EnvSource = Record<string, string | undefined>

/**
 * Read one of our own environment variables. Pass the suffix (`MODEL`, `KEY_GATEWAY`),
 * without the prefix.
 *
 * An empty string counts as unset: `ALFA_MODEL=` means "I don't want it", not "the model
 * name is the empty string".
 */
export function readEnv(name: string, source: EnvSource = process.env): string | undefined {
  return source[ENV_PREFIX + name] || undefined
}

/**
 * Whether this variable is set; if so, return its full name. Used for the "can't
 * remember it, because an environment variable overrides it" message
 */
export function envNameInUse(name: string, source: EnvSource = process.env): string | undefined {
  return source[ENV_PREFIX + name] ? ENV_PREFIX + name : undefined
}
