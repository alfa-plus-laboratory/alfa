/**
 * The background job table.
 *
 * ── Why this layer has to exist ──
 * The bash tool is "start a process → stand there waiting → get all the output". That
 * shape blocks three things done every day:
 *
 *   start a dev server, then hit it  — the server never exits on its own; it just waits
 *                                      until the timeout kills it
 *   run a watch mode                 — same as above
 *   run a three-minute build         — hits the 120s timeout; all it learns is "timed
 *                                      out", not whether it succeeded
 *
 * What they share is that **a process's lifetime and a tool call's lifetime are not the
 * same length**. So here the process is split off from the call: the call only does
 * "start" and "ask", and the process lives on this table, alive across turns and across
 * conversations.
 *
 * ── The cursor is the point, not a freebie ──
 * Every job remembers "how far the model has already seen". Without a cursor, every ask
 * for output would reread everything from start to finish — a server that has run for
 * ten minutes would blow up the context by the second ask, and 99% of it would be what
 * the model already read last time.
 *
 * ── Who collects the bodies ──
 * The record is not destroyed when the process exits: the model may well come asking for
 * the result after it exits, and "no such job" and "the job failed" are two completely
 * different answers. Records stay until alfa's own process exits (see killAll, hooked
 * onto the CLI's shutdown).
 *
 * ⚠ This layer **knows nothing about permissions**. Authorization has already been done
 *   in the bash tool (down the same path as foreground commands, with the same rule
 *   table); this only manages processes.
 */
import { spawn, type ChildProcess } from "node:child_process"
import type { Shell } from "../../env/shell.ts"
import { buildChildEnv } from "../../env/whitelist.ts"
import { streamDecoder } from "../../util/decode.ts"
import {
  __resetNamesForTest,
  reserveName,
  slugName,
  type JobReadResult,
  type JobReader,
  type JobSnapshot,
} from "../background.ts"
import { killGroup, type KillOutcome } from "./kill.ts"
import { OutputCollector } from "./output.ts"

export type { JobSnapshot }

/**
 * Max concurrent jobs. Guards against runaways, not resource use — a model starting jobs
 * in a loop can bring the machine down
 */
export const MAX_JOBS = 8
/**
 * How long to wait after starting before replying. See start(): these few hundred ms buy
 * "a mistyped command is known on the spot"
 */
const SETTLE_MS = 500
/**
 * How long to wait after stopping before reporting status. See kill(): this number
 * decides whether that sentence is accurate
 */
const KILL_SETTLE_MS = 1_000
/** Max chars kept in memory per job. The collector still spills the full output to disk */
const MAX_KEEP_CHARS = 200_000

interface Job {
  id: string
  command: string
  workdir: string
  owner?: string
  proc: ChildProcess
  collector: OutputCollector
  /** All output produced so far (bounded by the collector's ring buffer cap) */
  seen: string
  /** Length already handed to the model. Next time only the new part is given */
  cursor: number
  /** The user's slash-command view advances independently from the model's context */
  userCursor: number
  status: "running" | "exited"
  startedAt: number
  endedAt?: number
  exit?: number | null
  signal?: string
  /** Those waiting for new output. All woken on new output or when the process exits */
  waiters: Array<() => void>
  /**
   * Those waiting for **exit**. Must be kept separate from waiters: mixed together, the
   * process printing a single log line would wake whoever is "waiting for it to exit" —
   * and that is exactly how start() tells "died on the spot" from "up and running".
   */
  exitWaiters: Array<() => void>
}

const jobs = new Map<string, Job>()

/**
 * Notify the UI when a job starts or ends. An invisible background process is invisible
 * automation
 */
export type JobObserver = (event: { kind: "started" | "exited"; job: JobSnapshot }) => void
let observer: JobObserver | undefined

export function setJobObserver(fn: JobObserver | undefined): void {
  observer = fn
}

export class TooManyJobsError extends Error {
  constructor() {
    super(
      `Too many background jobs already running (${MAX_JOBS}). ` +
        `Stop one with the job tool (action "kill") before starting another.`,
    )
    this.name = "TooManyJobsError"
  }
}

export class UnknownJobError extends Error {
  constructor(id: string) {
    super(`No background job named "${id}". Use the job tool with action "list" to see the names.`)
    this.name = "UnknownJobError"
  }
}

export interface StartInput {
  command: string
  workdir: string
  /** The same shell the foreground path resolved (see env/shell.ts) */
  shell: Shell
  /** Which subagent started it. Omitted if the main agent did; see JobSnapshot.owner */
  owner?: string
}

export type StartResult =
  /** Started, and still alive */
  | { kind: "started"; job: JobSnapshot; output: string }
  /**
   * It did start, but exited on the spot.
   *
   * ★ This path must be kept separate from started. `npm run dvv` (one letter mistyped)
   *   dies with exit 1 within 50ms; report it as "job t1 started" and the model happily
   *   goes off to do other things, comes back five minutes later to ask, and only then
   *   finds it never came up — while the error message was right there from the first
   *   second.
   */
  | { kind: "exited"; job: JobSnapshot; output: string }

export async function start(input: StartInput): Promise<StartResult> {
  if (running().length >= MAX_JOBS) throw new TooManyJobsError()

  const id = nameFor(input.command)
  const { env } = buildChildEnv()
  const proc = spawn(input.shell.file, input.shell.argsFor(input.command), {
    cwd: input.workdir,
    env: { ...env, ...input.shell.env },
    stdio: ["ignore", "pipe", "pipe"],
    // Separate process group. Without it the process tree can't be killed cleanly (see
    // kill.ts) — and background jobs need this more than foreground commands: they live
    // longer and fork more things. Windows has no such concept (there detached means
    // "open a console window of its own"); that is left to taskkill /T
    detached: input.shell.detached,
    windowsHide: true,
  })

  const job: Job = {
    id,
    command: input.command,
    workdir: input.workdir,
    ...(input.owner ? { owner: input.owner } : {}),
    proc,
    collector: new OutputCollector(`job_${id}`),
    seen: "",
    cursor: 0,
    userCursor: 0,
    status: "running",
    startedAt: Date.now(),
    waiters: [],
    exitWaiters: [],
  }
  jobs.set(id, job)

  // ★ One decoder per stream; see util/decode.ts for why
  const pump = (decode: (chunk: Buffer | string) => string) => (chunk: Buffer) => {
    const text = decode(chunk)
    job.collector.push(text)
    job.seen += text
    // The memory cap is on the same order as the collector's ring buffer. Past it, cut
    // from the front and move the cursor along — otherwise the cut part would count as
    // "already read", when in fact nobody ever saw it
    if (job.seen.length > MAX_KEEP_CHARS) {
      const over = job.seen.length - MAX_KEEP_CHARS
      job.seen = job.seen.slice(over)
      job.cursor = Math.max(0, job.cursor - over)
      job.userCursor = Math.max(0, job.userCursor - over)
    }
    wake(job)
  }
  proc.stdout?.on("data", pump(streamDecoder()))
  proc.stderr?.on("data", pump(streamDecoder()))

  const settle = (code: number | null, signal: NodeJS.Signals | null) => {
    if (job.status === "exited") return
    job.status = "exited"
    job.endedAt = Date.now()
    job.exit = code
    if (signal) job.signal = signal
    wake(job)
    observer?.({ kind: "exited", job: snapshot(job) })
  }
  proc.once("close", settle)
  // spawn itself failed (shell missing): treat it as an exit; stderr carries the error out
  proc.once("error", () => settle(null, null))

  // ── Wait a moment before replying ──
  await Promise.race([exited(job), delay(SETTLE_MS)])

  const output = drain(job)
  if (job.status === "exited") return { kind: "exited", job: snapshot(job), output }

  observer?.({ kind: "started", job: snapshot(job) })
  return { kind: "started", job: snapshot(job), output }
}

/**
 * @param owner list only the ones this subagent started. **The main agent (not passed)
 *   sees everything** — it has to be able to answer "what is still running on this
 *   machine right now".
 *
 * ★ Not the other way round: a subagent can neither see nor touch the main agent's
 *   processes. Sharing one table also means sharing one read cursor, so a subagent
 *   casually running `job output dev` would **take away** the output the main agent
 *   hasn't read yet — the main agent's next read gets "nothing new", and that output
 *   never comes back.
 */
export function list(owner?: string): JobSnapshot[] {
  return [...jobs.values()].filter((job) => owner === undefined || job.owner === owner).map(snapshot)
}

/**
 * Whether this job falls under owner. See list(): the main agent manages all of them, a
 * subagent only the ones it started
 */
export function ownedBy(id: string, owner?: string): boolean {
  const job = jobs.get(id)
  if (!job) return false
  return owner === undefined || job.owner === owner
}

export function get(id: string): JobSnapshot | undefined {
  const job = jobs.get(id)
  return job ? snapshot(job) : undefined
}

/**
 * Same shape as the subagent side — so the `job` tool doesn't need two sets of branches
 * for two kinds of job
 */
export type ReadResult = JobReadResult

/**
 * Take the new output.
 *
 * With waitMs > 0 and nothing new, wait — until there is output, the process exits, or it
 * times out. This turns "start a server then curl it" from "sleep for a guessed number of
 * seconds" into one deterministic call.
 */
export async function read(id: string, waitMs = 0, reader: JobReader = "model"): Promise<ReadResult> {
  const job = jobs.get(id)
  if (!job) throw new UnknownJobError(id)

  let timedOut = false
  if (waitMs > 0 && cursor(job, reader) >= job.seen.length && job.status === "running") {
    timedOut = !(await waitForChange(job, waitMs))
  }
  return { job: snapshot(job), output: drain(job, reader), timedOut }
}

export async function kill(id: string, reader: JobReader = "model"): Promise<ReadResult> {
  const job = jobs.get(id)
  if (!job) throw new UnknownJobError(id)
  let outcome: KillOutcome = { stopped: true }
  if (job.status === "running") outcome = await killGroup(job.proc)
  // When killGroup returns, the close event may not have been dispatched yet; wait a
  // moment for settle to finish.
  // ★ One second rather than two hundred ms: this number decides **whether the sentence
  //   we report is accurate**, and `job kill` is something the user triggers, only a few
  //   times per session — saving eight hundred ms to report a "stopped" that may not be
  //   true is a bad deal however you count it
  await Promise.race([exited(job), delay(KILL_SETTLE_MS)])
  return {
    job: snapshot(job),
    output: drain(job, reader),
    timedOut: false,
    // Record marked done ≠ it's really gone. A reason is reported unless both hold
    ...(job.status === "exited" && outcome.detail === undefined ? {} : { detail: outcome.detail ?? "" }),
  }
}

/**
 * Kill them all. Called before the process exits.
 *
 * Otherwise a dev server started in its own process group gets adopted by init and keeps
 * running — the user thinks they quit, but actually left processes strewn everywhere,
 * with the port still taken.
 */
export async function killAll(owner?: string): Promise<number> {
  const alive = [...jobs.values()].filter(
    (job) => job.status === "running" && (owner === undefined || job.owner === owner),
  )
  await Promise.all(alive.map((job) => killGroup(job.proc)))
  return alive.length
}

/** Tests only: clear this table (doesn't kill processes; that's up to the caller) */
export function __resetForTest(): void {
  jobs.clear()
  __resetNamesForTest()
  observer = undefined
}

// ─────────────────────────────────────────────── naming

/**
 * Name a job after its command.
 *
 * ── Why not j1 j2 j3 ──
 * A number has to be **memorized** to know who it refers to. With three running, "j2
 * died" sends both a person and the model back to look up what j2 was; "`dev` died" needs
 * no lookup. The name is the one thing in this field that gets referenced over and over
 * (reading output, stopping it, reporting status); it should say by itself who it is.
 *
 * ── Which word to take ──
 * What is being run matters more than what runs it: the point of `npm run dev` is dev,
 * not npm; the point of `cargo watch -x run` is watch. So on hitting a **runner** such as
 * npm/bun/cargo/go/docker, take one more word further along; otherwise take the command
 * itself.
 *
 * ── Names are not recycled, and share one ledger with subagents ──
 * After a job finishes, a new job with the same name does not get that same name (it gets
 * dev-2). The model may still be holding the previous one's name; with a reused name it
 * would read the new process's output with the old conclusion in hand — and that kind of
 * mistake raises no error, it just yields an answer that looks reasonable. Allocation
 * lives in tool/background.ts, because in the `job` tool's eyes processes and subagents
 * are the same column of things, and their names can't be numbered separately.
 */
export function nameFor(command: string): string {
  return reserveName(slugName(pick(command)))
}

/** These run other things — they aren't the point themselves; the word after them is */
const RUNNERS = new Set([
  "npm", "pnpm", "yarn", "bun", "npx", "bunx", "deno", "node", "python", "python3", "ruby", "php",
  "go", "cargo", "make", "just", "task", "mvn", "gradle", "docker", "podman", "kubectl", "poetry",
  "uv", "pdm", "rake", "dotnet", "swift", "zig", "sudo", "env", "nohup", "time", "watch", "xargs",
])
/** Nor are these words after a runner: the point of `npm run dev` is its third word */
const FILLER = new Set(["run", "exec", "x", "run-script", "start-script", "--"])

function pick(command: string): string {
  const tokens = command.trim().split(/\s+/).filter((token) => token.length > 0)
  let at = 0
  /** The last runner recognized. Fall back to it when everything after is junk */
  let runner = ""

  while (at < tokens.length) {
    const token = tokens[at]!
    // `FOO=bar cmd`: an assignment is not a command
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      at++
      continue
    }
    if (token.startsWith("-") || FILLER.has(token)) {
      at++
      continue
    }
    const base = bare(token)
    if (RUNNERS.has(base) && at + 1 < tokens.length) {
      runner = base
      at++
      continue
    }
    // Quotes, pipes, code snippets and such: no good as a name, fall back to the runner
    if (!/^[A-Za-z0-9._:@\/-]+$/.test(token) || token.length > 24) return runner || base
    return base
  }
  return runner
}

/** Strip the path and common extensions: `./scripts/deploy.sh` → `deploy` */
function bare(token: string): string {
  const last = token.split("/").filter((part) => part.length > 0).pop() ?? token
  return last.replace(/\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php|exe)$/i, "")
}

// ─────────────────────────────────────────────── internals

function running(): Job[] {
  return [...jobs.values()].filter((job) => job.status === "running")
}

function snapshot(job: Job): JobSnapshot {
  return {
    id: job.id,
    kind: "process",
    command: job.command,
    ...(job.owner !== undefined ? { owner: job.owner } : {}),
    workdir: job.workdir,
    status: job.status,
    startedAt: job.startedAt,
    ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
    ...(job.exit !== undefined ? { exit: job.exit } : {}),
    ...(job.signal !== undefined ? { signal: job.signal } : {}),
    pending: Math.max(0, job.seen.length - job.cursor),
  }
}

/** Take the part after the cursor and advance the cursor. */
function cursor(job: Job, reader: JobReader): number {
  return reader === "user" ? job.userCursor : job.cursor
}

/** Take the part after this reader's cursor without consuming it for the other reader. */
function drain(job: Job, reader: JobReader = "model"): string {
  const out = job.seen.slice(cursor(job, reader))
  if (reader === "user") job.userCursor = job.seen.length
  else job.cursor = job.seen.length
  return out
}

function wake(job: Job): void {
  const waiters = job.waiters
  job.waiters = []
  for (const resolve of waiters) resolve()
  if (job.status !== "exited") return
  const leaving = job.exitWaiters
  job.exitWaiters = []
  for (const resolve of leaving) resolve()
}

/** @returns true = something happened (new output or exit), false = timed out waiting */
function waitForChange(job: Job, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), ms)
    timer.unref?.()
    job.waiters.push(() => finish(true))
  })
}

function exited(job: Job): Promise<void> {
  if (job.status === "exited") return Promise.resolve()
  return new Promise((resolve) => job.exitWaiters.push(resolve))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
