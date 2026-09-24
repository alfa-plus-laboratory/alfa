/**
 * Default permission rules. Layers are last-wins: user configuration and remembered
 * approvals can override these defaults. There is deliberately no separate hard-deny
 * table; exact command-string matches were bypassable and made the advertised modes
 * disagree with the access the user had selected.
 */
import { match } from "./wildcard.ts"

export type Action = "allow" | "ask" | "deny"

export interface Rule {
  permission: string
  pattern: string
  action: Action
}

export type Ruleset = Rule[]

/**
 * Side-effect-free read-only commands that, if not allowed, would cause approval
 * fatigue within the first minute.
 *
 * ⚠ The test for getting into this table is "a command **by this name** has no side
 *   effects", not "its common usage has no side effects". Two entries used to be here
 *   and were removed, because they fail that test:
 *
 *     awk    — it is a language. `awk 'BEGIN{system("…")}'` is its normal usage, not a
 *              bypass.
 *     sed -n — GNU sed's `e` command and `s///e` flag **really do execute** (verified),
 *              and `w` really writes files. `-n` only turns off auto-print; it stops
 *              neither.
 *
 *   A few names remain in the table but start other programs when given a certain flag
 *   (find -exec, rg --pre, sort --compress-program …). Removing the name can't fix
 *   those — without those flags they genuinely are read-only commands used every day.
 *   They are blocked by EXEC_FLAGS in scan(): a hit means forceAsk, bypassing the allow
 *   here. **The test lives in two places because one is about the name and the other
 *   about the arguments.**
 */
const READONLY_BASH = [
  "ls *", "pwd *", "cat *", "head *", "tail *", "wc *", "file *", "stat *", "which *", "echo *",
  "date *", "env *", "printenv *", "whoami *", "hostname *", "uname *", "df *", "du *", "tree *",
  "grep *", "rg *", "find *", "sort *", "uniq *", "diff *", "cmp *", "basename *", "dirname *",
  "git status *", "git diff *", "git log *", "git show *", "git branch *", "git remote *",
  "git rev-parse *", "git blame *", "git describe *", "git ls-files *", "git stash list *",
]

/**
 * The project's own work: build, test, check, format.
 *
 * ── Why this table has to exist ──
 * Narrowing bash to "ask by default" created a huge gray zone, and whatever sits in it
 * gets asked. Sent to the permission judge (a model at the door, since retired), that
 * put something nervous, several hundred milliseconds per call and unsteady in its
 * answers on a path walked dozens of times a day; sent to the user, it's an approval
 * card dozens of times a day. **Asking should be the last line of defense, not the
 * default handler for the gray zone.** (This is default mode's table; auto mode
 * deliberately doesn't reuse it, see permission/auto/fastpath.ts.)
 *
 * The blast radius of this tier is the project itself, and what it runs are commands
 * the project declares itself (package.json scripts, Makefile targets). opencode just
 * goes `"*": "allow"` wholesale, Claude Code relies on a broad whitelist + persisted
 * rules — the "smoothness" of both comes from **not asking at all**, not from asking
 * more cleverly.
 *
 * Note this table does not override scan.ts's force: a subshell, redirect, privilege
 * escalation or network access in the command still gets asked — the danger isn't in
 * the command name, it's in the structure around it.
 */
const PROJECT_BASH = [
  "npm test *", "npm run *", "pnpm test *", "pnpm run *", "yarn test *", "yarn run *",
  "bun test *", "bun run *", "bunx tsc *",
  "pytest *", "python -m pytest *", "python3 -m pytest *", "tox *", "nox *",
  "make *",
  "cargo test *", "cargo build *", "cargo check *", "cargo clippy *", "cargo fmt *", "cargo bench *",
  "go test *", "go build *", "go vet *", "go fmt *", "gofmt *",
  "tsc *", "eslint *", "prettier *", "biome *",
  "ruff *", "black *", "isort *", "mypy *", "flake8 *", "pylint *",
  "jest *", "vitest *", "mocha *", "phpunit *", "rspec *",
]

/**
 * The ones in the table above that reach outside the project. last-wins, so they are
 * written after it.
 *
 * `npm run test` and `npm run deploy` share a prefix, but one runs tests on your own
 * machine and the other pushes things out into the world — the latter is the textbook
 * case of "heavy consequences, so a human should give the nod".
 */
const PROJECT_BASH_EXCEPTIONS = [
  "npm run *deploy*", "npm run *publish*", "npm run *release*", "npm run *push*",
  "pnpm run *deploy*", "pnpm run *publish*", "pnpm run *release*",
  "yarn run *deploy*", "yarn run *publish*", "yarn run *release*",
  "bun run *deploy*", "bun run *publish*", "bun run *release*",
  "make deploy*", "make publish*", "make release*", "make install*", "make uninstall*",
  "cargo publish*", "go install*",
]

/**
 * The default rules table. Order is priority (later overrides earlier).
 *
 * Main differences from opencode:
 *   - they open everything with `"*": "allow"`; we narrow bash to ask + whitelists
 *     (read-only + the project's own work);
 *   - their list of sensitive file names for read only has *.env / *.env.*, missing
 *     .envrc / *.pem / *.key.
 *   - edit is allow for us just as for them — but **a diff is forced every time**,
 *     leaving no window for a silent bad edit.
 */
export const DEFAULTS: Ruleset = [
  // Fallback: without this, every new tool added later would start popping up prompts
  { permission: "*", pattern: "*", action: "allow" },

  // ── read: allowed by default; secret files inside the workspace get asked ──
  //
  // ⚠ Every entry must start with *. The pattern is matched against the **whole
  //   relative path**, so writing ".envrc" only hits the one at the repo root and misses
  //   "config/.envrc" in a subdirectory. A leaky rule like that throws no error; it just
  //   never matches — a silent failure.
  { permission: "read", pattern: "*", action: "allow" },
  ...[
    "*.env", "*.env.*", "*.envrc", "*secret*", "*credential*",
    "*.pem", "*.key", "*.p12", "*.pfx", "*.jks",
    "*id_rsa*", "*id_ed25519*", "*id_ecdsa*", "*id_dsa*",
  ].map((pattern): Rule => ({ permission: "read", pattern, action: "ask" })),
  // Template files hold no real values; blocking them is pure harassment
  ...["*.env.example", "*.env.sample", "*.env.template", "*.pem.example"].map(
    (pattern): Rule => ({ permission: "read", pattern, action: "allow" }),
  ),

  // ── edit / write: allowed by default (the user decides), diff always visible ──
  { permission: "edit", pattern: "*", action: "allow" },
  // Changing CI config = changing a machine that executes things on its own
  { permission: "edit", pattern: "*.github/workflows/*", action: "ask" },
  { permission: "edit", pattern: "*.git/*", action: "ask" },
  ...["*.env", "*.env.*", "*.envrc", "*.pem", "*.key", "*id_rsa*", "*id_ed25519*"].map(
    (pattern): Rule => ({ permission: "edit", pattern, action: "ask" }),
  ),

  // ── bash: ask by default; read-only commands + the project's own work are allowed ──
  { permission: "bash", pattern: "*", action: "ask" },
  ...READONLY_BASH.map((pattern): Rule => ({ permission: "bash", pattern, action: "allow" })),
  ...PROJECT_BASH.map((pattern): Rule => ({ permission: "bash", pattern, action: "allow" })),
  // last-wins: the lines above allowed whole categories; this pulls the ones among them
  // that reach outside the project back to asking.
  // "Publish" and "run the tests" share an npm run prefix, but they are nothing alike
  ...PROJECT_BASH_EXCEPTIONS.map((pattern): Rule => ({ permission: "bash", pattern, action: "ask" })),

  // ── Search: allow ──
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },

  // ── Plan: allow ──
  // It only writes a checklist into the UI and touches nothing on disk or the network.
  // It's listed here not to "allow" it (the fallback rule already does) but so that
  // "turning it off" has a clear place to be written
  { permission: "todo", pattern: "*", action: "allow" },

  // ── Project memory: allow ──
  // It only writes small files under that one directory in the workspace, and the names
  // are normalized, so it can't get out. Listed here for the same reason as todo —
  // anyone who wants to switch off "it remembering things on its own" entirely needs
  // somewhere to write that
  { permission: "memory", pattern: "*", action: "allow" },

  // ── A look at its own context: allow ──
  // It only reads a number inside the process. Listed here for the same reason — it is
  // only an option if it can be turned off
  { permission: "context", pattern: "*", action: "allow" },
  { permission: "environment", pattern: "*", action: "allow" },

  // ── Stop and ask you something: allow ──
  // It touches nothing; it just waits for a person. Listed here because "I don't want to
  // be interrupted, decide for yourself" is a perfectly legitimate rule, and it needs
  // somewhere to be written (once it's deny, this tool isn't even sent to the model —
  // see gate.disabled)
  { permission: "ask", pattern: "*", action: "allow" },

  // ── Send out a subagent: allow ──
  // Every step it takes still goes through this table (the same gate, the same "don't
  // ask again"), so the question here is a different one: whether to let it hand out
  // work itself at all. Anyone who wants an agent that "gets by on its one own life"
  // writes deny here
  { permission: "task", pattern: "*", action: "allow" },

  // ── Cross-cutting guards ──
  { permission: "extension", pattern: "*", action: "ask" },

  // ── Network: ask ──
  //
  // These two **deliberately** have no whitelist. Every other ask comes with an allow
  // table (read-only commands, the project's own work); not here, because the risk of
  // going online isn't in "which site", it's in **who decided to go there**: the URL
  // may come from the previous page, an issue, a README, and the words in those places
  // weren't written by the user. Having every first trip out pass before the user's eyes
  // is the only thing that separates "an injected address" from "a page the user wants
  // to see".
  // Once always has been clicked for a domain, it stops asking (see narrowAlways in
  // gate.ts).
  { permission: "webfetch", pattern: "*", action: "ask" },
  { permission: "websearch", pattern: "*", action: "ask" },

  // ── MCP: ask ──
  //
  // The target is written `server/tool`, so always can be clicked for a single tool, or
  // written as `github/*` — the unit in the user's head is "this server", not "this
  // function".
  //
  // This one too **deliberately** has no whitelist, and for a harder reason than the
  // network pair: what an MCP tool can do is known only to whoever wrote it. Annotations
  // such as the readOnlyHint that MCP carries are **self-reported by the server**; using
  // them as grounds to allow means letting the party under review write the review's
  // conclusion.
  //
  // ⚠ This line is load-bearing. The table opens with `"*": "*" → allow`, so without it
  //   every MCP call would be **allowed**, silently. evaluate's own "ask" fallback only
  //   applies when no rule matches at all, and that first rule always matches.
  { permission: "mcp", pattern: "*", action: "ask" },
]

// ════════════════════════════════════════════════ Evaluation

/**
 * Several rulesets layered in order; **the last matching rule wins**.
 *
 * Why last-wins rather than first-wins / most-specific-wins:
 * user config written later is guaranteed to override the built-in defaults, with no
 * need to understand an implicit notion like "specificity". The cost is that write order
 * within a single ruleset matters — wildcards first, exceptions after.
 */
export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Action {
  let result: Action | undefined
  for (const ruleset of rulesets) {
    for (const rule of ruleset) {
      if (rule.permission !== permission && rule.permission !== "*") continue
      if (!match(rule.pattern, pattern)) continue
      result = rule.action
    }
  }
  return result ?? "ask" // fallback: stay conservative when no rule matches
}

/**
 * Normalize the config's `{ bash: "ask", read: { "*": "allow", "*.env": "deny" } }` into
 * an ordered Ruleset.
 *
 * ⚠ Preserving order is a hard requirement. The engine hoists numeric keys of JS
 *   objects, so the caller must first get the written order via Object.entries, and
 *   must not stuff it back into an object in some middle layer.
 */
export function fromConfig(config: Record<string, Action | Record<string, Action>>): Ruleset {
  const rules: Ruleset = []
  for (const [permission, value] of Object.entries(config)) {
    if (typeof value === "string") {
      rules.push({ permission, pattern: "*", action: value })
      continue
    }
    for (const [pattern, action] of Object.entries(value)) {
      rules.push({ permission, pattern, action })
    }
  }
  return rules
}
