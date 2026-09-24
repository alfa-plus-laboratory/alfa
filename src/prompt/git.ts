/**
 * Repository snapshot — tells the model "what this repo looks like right now": which
 * branch it's on, what uncommitted changes there are, what the last few commits were
 * doing.
 *
 * ── Why it isn't in <env> ──
 * The env block goes into the system prompt, and system is the longest cacheable prefix
 * of the whole request (the two breakpoints are in llm/to-model-messages.ts). Branch,
 * working-tree state and recent commits happen to be the three things that change most
 * often in a session — every commit the model makes changes them. Putting them in
 * system would mean every commit re-bills the several thousand tokens of tools + system
 * at full price, and the bit of freshness that buys, the model gets by running one
 * `git status` itself.
 *
 * So it takes a different route: like project memory, it's attached to the first
 * message of a session (see agent/loop.ts). History is append-only — the attached text
 * never changes by a single character afterwards, so the prefix is stable and the cache
 * unaffected.
 *
 * ── The price: it goes stale, and it's the model's own actions that make it stale ──
 * So the very first sentence of the block has to say plainly "this is a snapshot; if it
 * needs to be accurate, run git yourself". Without that sentence, the model will answer
 * "am I done with my changes" using the status from the moment of startup — a status
 * that doesn't even contain the files it just wrote.
 */
import { isGitRepo } from "../fs/workspace.ts"

/**
 * At most how many changed lines to list. Beyond that it's no longer "what state is this
 * repo in" but a list it should go and look at itself
 */
const MAX_STATUS = 20
/** Recent commits. 5 shows what this branch is up to; more is telling history */
const MAX_COMMITS = 5
/** Per-line cap. Commit titles can get very long, and each line here is only a hint */
const MAX_LINE = 120
/**
 * Time limit for a single git command.
 *
 * In a huge repo `git status` can take several seconds, and this code runs after the
 * user presses enter and before the request goes out — every second stuck here is a
 * second the user spends staring at an unresponsive UI.
 * A timeout counts as nothing: missing one piece of background won't stop it working;
 * getting stuck will.
 */
const TIMEOUT_MS = 2000

export interface GitSnapshot {
  /** Branch name; the short sha when detached */
  head: string
  detached: boolean
  /** PR target branch. Absent if it can't be inferred — a guess is worse than silence */
  mainBranch?: string
  /** porcelain lines, already cut to MAX_STATUS */
  status: string[]
  /**
   * Total line count before truncation. When it differs from status.length, the block
   * has to say so
   */
  statusTotal: number
  commits: string[]
}

/**
 * Take a snapshot. Not a repo, git not installed, a command timed out — all return
 * undefined, and the caller then leaves the whole block out.
 */
export function collectGitSnapshot(root: string): GitSnapshot | undefined {
  // Glance at .git before doing anything: in a non-repo directory, running four git
  // commands just gets four failures, and alfa starting in a non-repo directory is
  // common (see the fallback in fs/workspace.ts)
  if (!isGitRepo(root)) return undefined

  // symbolic-ref rather than rev-parse --abbrev-ref: the latter errors out in a fresh
  // repo with no commits yet, and "just ran git init" is exactly the moment someone most
  // needs the current state spelled out
  const branch = run(["symbolic-ref", "--quiet", "--short", "HEAD"], root)
  const detached = branch === undefined
  const head = branch ?? run(["rev-parse", "--short", "HEAD"], root)
  if (head === undefined) return undefined // both failed = not a usable repo here

  const raw = run(["status", "--porcelain"], root) ?? ""
  const all = raw.split("\n").map(clip).filter((line) => line.length > 0)

  const log = run(["log", `--format=%h %s`, "-n", String(MAX_COMMITS)], root) ?? ""

  const main = mainBranch(root)
  return {
    head,
    detached,
    ...(main ? { mainBranch: main } : {}),
    status: all.slice(0, MAX_STATUS),
    statusTotal: all.length,
    commits: log.split("\n").map(clip).filter((line) => line.length > 0),
  }
}

/**
 * Where a PR should be opened against.
 *
 * Ask origin/HEAD first — that's the default branch according to the remote itself, the
 * only authoritative answer. It's often missing (shallow clones and manually added
 * remotes don't set it), so fall back to whether main / master exists locally.
 * If neither works, this line isn't written: a guessed target branch would have the
 * model open the PR in the wrong place.
 */
function mainBranch(root: string): string | undefined {
  const remote = run(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], root)
  if (remote) return remote.replace(/^origin\//, "")
  for (const name of ["main", "master"]) {
    if (run(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], root)) return name
  }
  return undefined
}

/**
 * Assemble the section attached to the first message.
 *
 * The opening two sentences are **the most important part of the whole block**: it's a
 * snapshot, it goes stale, and if accuracy matters, run it yourself. Everything else is
 * a fact git can be asked for again; only those two sentences are not.
 */
export function renderGitSnapshot(snapshot: GitSnapshot): string {
  const lines = [
    "<git-status>",
    "A snapshot of this repository, taken when the session started. It is never refreshed —",
    "your own edits and commits go straight past it. Run git yourself whenever the current",
    "state matters.",
    "",
    snapshot.detached
      ? `Current branch: (detached HEAD at ${snapshot.head})`
      : `Current branch: ${snapshot.head}`,
  ]
  if (snapshot.mainBranch) lines.push(`Main branch: ${snapshot.mainBranch}`)

  lines.push("")
  if (snapshot.statusTotal === 0) {
    lines.push("Working tree clean at that moment.")
  } else {
    lines.push(`Uncommitted changes (${snapshot.statusTotal}):`, ...snapshot.status)
    // What's cut must be stated. A status that looks like 20 changes but is really 300
    // is more likely to lead it to a wrong call than no status at all ("that's all of
    // it, let's commit it together")
    const hidden = snapshot.statusTotal - snapshot.status.length
    if (hidden > 0) lines.push(`[... ${hidden} more file${hidden === 1 ? "" : "s"} not listed]`)
  }

  if (snapshot.commits.length > 0) {
    lines.push("", "Recent commits:", ...snapshot.commits)
  }
  lines.push("</git-status>")
  return lines.join("\n")
}

/** Take one and assemble it. No repo → undefined — the caller leaves the whole block out */
export function gitContextBlock(root: string): string | undefined {
  const snapshot = collectGitSnapshot(root)
  return snapshot ? renderGitSnapshot(snapshot) : undefined
}

/**
 * Run one read-only git command and get its trimmed stdout. Non-zero exit, timeout, git
 * not installed — all undefined. This whole block is a bonus; no single failure should
 * keep a session from starting.
 *
 * ★ GIT_OPTIONAL_LOCKS=0: by default `git status` refreshes the index along the way,
 *   which takes .git/index.lock. The user may well be in the middle of a rebase in
 *   another terminal, while we've only come to take a look — a read-only glance
 *   shouldn't fight anyone for a lock, let alone write into their repo.
 */
function run(args: string[], cwd: string): string | undefined {
  try {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
      timeout: TIMEOUT_MS,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    })
    if (!proc.success) return undefined
    // ★ Trim only the tail, **never** the head. porcelain's first two columns are status
    //   codes, and " M" and "M " are two different things (modified but not staged /
    //   staged) — trim the whole string and the first line's leading space is gone, so
    //   the first file in the list always shows as staged. That mistake throws no error;
    //   it just has it go ahead and commit a file it believes it has already added
    const text = proc.stdout.toString().trimEnd()
    return text.trim().length > 0 ? text : undefined
  } catch {
    return undefined
  }
}

function clip(line: string): string {
  const text = line.trimEnd()
  return text.length > MAX_LINE ? text.slice(0, MAX_LINE - 1) + "…" : text
}
