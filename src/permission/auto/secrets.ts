/**
 * Which paths hold secrets, for auto mode.
 *
 * Reading one isn't forbidden — a user debugging a database connection may well need
 * `.env` read — but it means the secret goes into the conversation and on to the model
 * provider, so it is never on the fast path: the classifier scores it (leak 2) and the
 * policy lets it through when the task clearly needs it.
 *
 * ★ Two lists, because the default table (rules.ts) only knows file *names* inside a
 *   workspace (`*.env`, `*.pem`, `*id_rsa*` …) while auto mode reaches the whole account,
 *   where secrets live at well-known *locations* whose names say nothing: `~/.npmrc`,
 *   `~/.config/gh/hosts.yml`, `~/.kube/config`. Commit bec5743 removed the hard list
 *   that used to catch those, and `head ~/.aws/credentials` then ran without any review
 *   at all; this is what replaces it for auto.
 *
 * alfa's own config and data directories count too (auth.json holds every provider key;
 * the session database holds whatever was ever pasted), except tool-output, which is
 * where long command output is saved for the agent to read back.
 */
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { canonicalPath, within } from "../../fs/guard.ts"
import { configDir, dataDir } from "../../util/xdg.ts"
import { DEFAULTS, evaluate } from "../rules.ts"

const ACCOUNT_SECRETS =
  /(?:^|\/)(?:\.ssh|\.aws|\.gnupg|\.azure|\.config\/gcloud)(?:\/|$)|(?:^|\/)(?:\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.config\/gh\/hosts\.yml|\.docker\/config\.json|\.kube\/config)$/

/**
 * @param path Workspace-relative or absolute (as permission patterns are), or a shell
 *   argument; `~` is expanded. Relative paths resolve against `base` for the location
 *   checks.
 */
export function isSecretPath(path: string, base: string): boolean {
  const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path
  if (evaluate("read", expanded, DEFAULTS) !== "allow") return true
  const absolute = resolve(base, expanded)
  // ★ Both spellings: a symlink in the workspace named `notes.txt` that points at
  //   ~/.ssh/id_ed25519 is only caught on the resolved side. And both cases: on macOS
  //   and Windows `.ENV` opens `.env`, while the patterns are written in lower case. On
  //   a case-sensitive system the folded check only errs toward review
  return [absolute, canonicalPath(absolute)].some((candidate) => secretLocation(candidate) || secretLocation(candidate.toLowerCase(), true))
}

function secretLocation(absolute: string, folded = false): boolean {
  if (evaluate("read", absolute, DEFAULTS) !== "allow") return true
  if (ACCOUNT_SECRETS.test(absolute)) return true
  const fold = (path: string) => (folded ? path.toLowerCase() : path)
  const config = fold(canonicalPath(configDir()))
  const data = fold(canonicalPath(dataDir()))
  if (within(absolute, config) || within(absolute, fold(configDir()))) return true
  const inData = within(absolute, data) || within(absolute, fold(dataDir()))
  return inData && !within(absolute, join(data, "tool-output")) && !within(absolute, join(fold(dataDir()), "tool-output"))
}
